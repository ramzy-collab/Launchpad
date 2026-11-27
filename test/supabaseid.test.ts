import { env } from "cloudflare:workers";
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, SignJWT } from "jose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { accounts, appAt, call, onOutbound, PAGE, publishZip, uniq } from "./helpers";

// Each person's identity sent to Supabase (spec step 6b).
const flag = (name: string, state: "on" | "off") =>
  env.DB.prepare("INSERT OR REPLACE INTO feature_flags (name, state, updated_at, updated_by) VALUES (?, ?, 0, 'test')").bind(name, state).run();

const ANON = "sb_publishable_abcdefghijklmnop1234";
const HOST = "abcdefghijklmnopqrst.supabase.co";
const REP = "rep@example.com";
const RULES = { default_role: "rep", records: { note: { prefix: "note:", read: { rep: "all" } } }, sources: { connectors: { db: { rep: "all" } } } };
const make = (json: Record<string, unknown>, as: string) => call("/_api/admin/connectors", { as, method: "POST", json });
const patch = (name: string, json: Record<string, unknown>, as: string) => call(`/_api/admin/connectors/${name}`, { as, method: "PATCH", json });
const code = async (res: Response) => (await res.json<{ error: { code: string; message: string } }>()).error;

async function setup() {
  const owner = `sb-${uniq()}@example.com`;
  await accounts(owner);
  expect((await make({ label: "DB", name: "db", key: ANON, hosts: HOST }, owner)).status).toBe(201);
  const ns = uniq();
  const files = { "index.html": PAGE(`<script>formelab.connectors.fetch("db", "/rest/v1/leads")</script>`), "formelab.json": JSON.stringify(RULES) };
  const res = await publishZip(owner, ns, "app", files, { allowed_emails: REP });
  expect(res.status, await res.clone().text()).toBe(201);
  const { site } = await res.json<{ site: { id: string } }>();
  expect((await call(`/_api/admin/sites/${site.id}`, { as: owner, method: "PATCH", json: { connectors: ["db"] } })).status).toBe(200);
  const origin = await appAt(ns, "app");
  const fetchDb = (as: string) => call(`${origin}/_api/connectors/db/fetch`, { as, mount: "/", method: "POST", json: { url: "/rest/v1/leads?select=*" } });
  const id = (await env.DB.prepare("SELECT id FROM connectors WHERE owner_email = ? AND name = 'db'").bind(owner).first<{ id: string }>())!.id;
  return { owner, site, fetchDb, id };
}

describe("each person's identity sent to Supabase", () => {
  beforeAll(async () => {
    await flag("connected_apps", "on");
    await flag("supabase_identity", "on");
  });
  afterAll(async () => {
    await flag("supabase_identity", "off");
  });
  afterEach(() => onOutbound(undefined));

  it("is only for Supabase addresses and publishable keys, and only while the feature is on", async () => {
    const { owner } = await setup();
    await flag("supabase_identity", "off");
    expect((await code(await patch("db", { identity: true }, owner))).code).toBe("not_available");
    await flag("supabase_identity", "on");
    expect((await patch("db", { identity: "yes" }, owner)).status).toBe(400);

    const other = `sb2-${uniq()}@example.com`;
    await accounts(other);
    await make({ label: "Other", name: "other", key: ANON, hosts: "api.example.test" }, other);
    expect((await code(await patch("other", { identity: true }, other))).message).toContain("can only call a Supabase project's address");
    const service = await new SignJWT({ role: "service_role" }).setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode("x".repeat(32)));
    for (const key of ["sb_secret_abcdefghijklmnop1234", service]) {
      expect((await code(await patch("db", { identity: true, key }, owner))).message).toContain("not its secret or service_role key");
    }
    const on = await patch("db", { identity: true }, owner);
    expect(on.status).toBe(200);
    expect(await on.json()).toMatchObject({ identity: true });
    // While it's on, the key and hosts can't be changed to ones that would skip row-level security.
    expect((await patch("db", { key: "sb_secret_abcdefghijklmnop1234" }, owner)).status).toBe(400);
    expect((await patch("db", { hosts: "api.example.test" }, owner)).status).toBe(400);
  });

  it("publishes an issuer per connector, and sends a 60-second token naming the person with every call", async () => {
    const { owner, site, fetchDb, id } = await setup();
    expect((await call(`/oidc/c/${id}/jwks.json`)).status).toBe(404); // not on yet
    await patch("db", { identity: true }, owner);

    const issuer = `https://example.com/oidc/c/${id}`;
    const disc = await call(`/oidc/c/${id}/.well-known/openid-configuration`);
    expect(disc.status).toBe(200);
    expect(await disc.json()).toMatchObject({ issuer, jwks_uri: `${issuer}/jwks.json`, id_token_signing_alg_values_supported: ["ES256"] });
    const jwks = await (await call(`/oidc/c/${id}/jwks.json`)).json<{ keys: { kid: string; d?: string }[] }>();
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]!.d).toBeUndefined(); // never the private half

    let sent: Request | null = null;
    onOutbound(async (req) => {
      sent = req.clone();
      // A service that echoes headers back: the token must not reach the app.
      return Response.json({ echoed: req.headers.get("authorization") });
    });
    const res = await fetchDb(REP);
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await res.json<{ text: string }>();
    expect(body.text).toContain("[redacted]");
    expect(body.text).not.toContain("eyJ");

    expect(sent!.url).toBe(`https://${HOST}/rest/v1/leads?select=*`);
    expect(sent!.headers.get("apikey")).toBe(ANON);
    const token = sent!.headers.get("authorization")!.replace(/^Bearer /, "");
    expect(decodeProtectedHeader(token)).toMatchObject({ alg: "ES256", kid: jwks.keys[0]!.kid });
    const { payload } = await jwtVerify(token, createLocalJWKSet(jwks as never), { issuer, audience: "authenticated" });
    expect(payload).toMatchObject({ sub: REP, email: REP, role: "authenticated", formelab_role: "rep", formelab_manages: false, formelab_app: site.id });
    expect(payload.exp! - payload.iat!).toBe(60);

    // The owner's calls say they manage the app.
    await fetchDb(owner);
    const mine = await jwtVerify(sent!.headers.get("authorization")!.replace(/^Bearer /, ""), createLocalJWKSet(jwks as never));
    expect(mine.payload).toMatchObject({ email: owner, formelab_manages: true, role: "authenticated" });
  });

  it("drops the key pair when turned off, and makes a new one when turned on again", async () => {
    const { owner, id } = await setup();
    await patch("db", { identity: true }, owner);
    const first = (await (await call(`/oidc/c/${id}/jwks.json`)).json<{ keys: { kid: string }[] }>()).keys[0]!.kid;
    await patch("db", { identity: false }, owner);
    expect((await call(`/oidc/c/${id}/jwks.json`)).status).toBe(404);
    await patch("db", { identity: true }, owner);
    const second = (await (await call(`/oidc/c/${id}/jwks.json`)).json<{ keys: { kid: string }[] }>()).keys[0]!.kid;
    expect(second).not.toBe(first);
  });

  it("refuses calls while the feature is off for the owner, rather than sending them without an identity", async () => {
    const { owner, fetchDb } = await setup();
    await patch("db", { identity: true }, owner);
    await flag("supabase_identity", "off");
    onOutbound(() => Response.json({}));
    const res = await fetchDb(REP);
    expect(res.status).toBe(403);
    await flag("supabase_identity", "on");
  });

  it("shows the switch and, once on, the issuer URL on the connector's page", async () => {
    const { owner, id, site } = await setup();
    const before = await (await call("/app/connected/db", { as: owner })).text();
    expect(before).toContain("Send each person's identity");
    expect(before).not.toContain(`/oidc/c/${id}`);
    await patch("db", { identity: true }, owner);
    const after = await (await call("/app/connected/db", { as: owner })).text();
    expect(after).toContain(`<code>https://example.com/oidc/c/${id}</code>`);
    expect(after).toContain("Custom OIDC");
    // The starter policies let in only the apps that use the connector, by id.
    expect(after).toContain(`using (auth.jwt() -&gt;&gt; &#39;formelab_app&#39; in (&#39;${site.id}&#39;));`);
    // An app's name is text editors can change: it never goes into the SQL, even with a line break in it.
    await env.DB.prepare("UPDATE sites SET title = ? WHERE id = ?").bind("Evil\ndrop table leads; --", site.id).run();
    const named = await (await call("/app/connected/db", { as: owner })).text();
    const sql = /<pre class="cx-code">([\s\S]*?)<\/pre>/g;
    const blocks = [...named.matchAll(sql)].map((m) => m[1]!).join("\n");
    expect(blocks).not.toContain("drop table");
    expect(named).toContain("Evil"); // shown, as text, outside the SQL
  });

  it("explains it in the guide while the feature is on, with no flag markers left over", async () => {
    const { owner } = await setup();
    const guide = await (await call("/_platform/guide.md", { as: owner })).text();
    expect(guide).toContain("**Supabase, person by person.**");
    expect(guide).not.toContain("<!-- flag:");
    await flag("supabase_identity", "off");
    const without = await (await call("/_platform/guide.md", { as: owner })).text();
    expect(without).not.toContain("Supabase, person by person");
    expect(without).toContain("Supabase is a custom connector here");
    await flag("supabase_identity", "on");
  });
});
