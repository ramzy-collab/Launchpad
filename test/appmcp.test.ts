import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { appAt, call, OWNER, PAGE, publishZip, uniq } from "./helpers";

// Each app's own address for AI tools, <app-host>/mcp (spec step 5).
const REP = "rep@example.com";
const REP2 = "rep2@example.com";
const NEW = "new@example.com";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const CRM = {
  default_role: "rep",
  manage_roles: ["manager"],
  records: {
    lead: { prefix: "lead:", fields: ["name", "assignedTo"], owner_field: "assignedTo", read: { manager: "all", rep: "own" }, write: { manager: "all", rep: "own" } },
  },
};
const CODE = PAGE(`<script>formelab.kv.set("lead:" + id, v)</script>`);
type Err = { error: { code: string } };

beforeAll(async () => {
  await env.DB.prepare("INSERT INTO feature_flags (name, state, updated_at) VALUES ('app_mcp', 'on', 0) ON CONFLICT(name) DO UPDATE SET state = 'on'").run();
});

async function app(rules: unknown = CRM, title = "Acme CRM") {
  const ns = uniq();
  const res = await publishZip(OWNER, ns, "crm", { "index.html": CODE, "formelab.json": JSON.stringify(rules) }, { allowed_emails: `${REP}, ${REP2}`, confirm_public: "true" });
  expect(res.status, await res.clone().text()).toBe(201);
  const { site } = await res.json<{ site: { id: string } }>();
  await env.DB.prepare("UPDATE sites SET title = ? WHERE id = ?").bind(title, site.id).run();
  const origin = await appAt(ns, "crm");
  const kv = (as: string, key: string, value: unknown) => call(`${origin}/_api/kv/${encodeURIComponent(key)}`, { as, mount: "/", method: "PUT", body: JSON.stringify(value) });
  const setRole = (as: string, email: string, role: string) => call(`${origin}/_api/roles/${encodeURIComponent(email)}`, { as, mount: "/", method: "PUT", json: { role } });
  return { id: site.id, origin, kv, setRole };
}

/** What a browser sends for a real page load (Fetch Metadata). */
const NAVIGATE = { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "sec-fetch-site": "cross-site" };

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const cookiesFrom = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

/** The whole OAuth dance against `origin` (an app host or Formelab): register, consent as `as`, exchange. */
async function connect(origin: string, as: string, opts: { access?: "read" | "write"; authorize?: string } = {}) {
  const reg = await call(`${origin}${origin.includes(".example.app") ? "/_platform/oauth/register" : "/oauth/register"}`, {
    method: "POST",
    json: { client_name: "Claude", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] },
  });
  expect(reg.status, await reg.clone().text()).toBe(201);
  const clientId = (await reg.json<{ client_id: string }>()).client_id;
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const authorize = opts.authorize ?? `${origin}/_platform/authorize`;
  const u = new URL(authorize);
  u.search = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", scope: "mcp", state: "s1", resource: `${origin}/mcp` }).toString();
  const page = await call(u.toString(), { as, headers: NAVIGATE });
  expect(page.status, `${page.headers.get("location")} ${await page.clone().text()}`).toBe(200);
  const html = await page.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)![1]!;
  const res = await call(u.origin + u.pathname, {
    as,
    method: "POST",
    headers: { ...NAVIGATE, "sec-fetch-site": "same-origin", cookie: cookiesFrom(page), "content-type": "application/x-www-form-urlencoded", origin },
    body: new URLSearchParams({ handle, decision: "approve", ...(opts.access ? { access: opts.access } : {}) }).toString(),
  });
  expect(res.status, await res.clone().text()).toBe(302);
  const code = new URL(res.headers.get("location")!).searchParams.get("code")!;
  const tok = await call(`${origin}${origin.includes(".example.app") ? "/_platform/oauth/token" : "/oauth/token"}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: `${origin}/mcp` }).toString(),
  });
  expect(tok.status, await tok.clone().text()).toBe(200);
  return { token: (await tok.json<{ access_token: string }>()).access_token, html, coop: page.headers.get("cross-origin-opener-policy") };
}

async function rpc(origin: string, token: string, method: string, params: Record<string, unknown> = {}) {
  return call(`${origin}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    json: { jsonrpc: "2.0", id: 1, method, params },
  });
}
const tools = async (origin: string, token: string) =>
  (await (await rpc(origin, token, "tools/list")).json<{ result: { tools: { name: string; title?: string }[] } }>()).result.tools;
const tool = async (origin: string, token: string, name: string, args: Record<string, unknown> = {}) => {
  const res = await rpc(origin, token, "tools/call", { name, arguments: args });
  const body = await res.json<{ result: { content: { text: string }[]; isError?: boolean } }>();
  return { error: !!body.result.isError, data: JSON.parse(body.result.content[0]!.text) as Record<string, unknown> };
};

describe("an app's own address for AI tools", () => {
  it("publishes OAuth metadata for the app itself, only when it has rules and the feature is on", async () => {
    const { origin } = await app();
    const meta = await call(`${origin}/.well-known/oauth-protected-resource/mcp`);
    expect(meta.status).toBe(200);
    expect(await meta.json()).toMatchObject({ resource: `${origin}/mcp`, authorization_servers: [origin] });
    const as = await (await call(`${origin}/.well-known/oauth-authorization-server`)).json<{ authorization_endpoint: string; token_endpoint: string }>();
    expect(as.authorization_endpoint).toBe(`${origin}/_platform/authorize`);
    expect(as.token_endpoint).toBe(`${origin}/_platform/oauth/token`);
    // No token: a challenge pointing at the app's metadata.
    const bare = await call(`${origin}/mcp`, { method: "POST", json: {} });
    expect(bare.status).toBe(401);

    // An app without rules has no address.
    const ns = uniq();
    await publishZip(OWNER, ns, "plain", { "index.html": PAGE("hi") });
    const plain = await appAt(ns, "plain");
    expect((await call(`${plain}/mcp`, { method: "POST", json: {} })).status).toBe(404);
    expect((await call(`${plain}/.well-known/oauth-protected-resource/mcp`)).status).toBe(404);
  });

  it("asks under the app's name, then gives each person tools for what their role allows", async () => {
    const { origin, kv } = await app();
    await kv(OWNER, "lead:1", { name: "Ada", assignedTo: REP });
    await kv(OWNER, "lead:2", { name: "Bo", assignedTo: REP2 });
    const { token, html } = await connect(origin, REP);
    expect(html).toContain("<h1>Connect Claude to Acme CRM?</h1>");
    expect(html).toContain(`uses Acme CRM as <b>${REP}</b>`);
    expect(html).toContain("Powered by <a");

    const list = await tools(origin, token);
    expect(list.map((t) => t.name).sort()).toEqual(["delete_lead", "get_lead", "list_lead", "save_lead"]);
    expect(list.find((t) => t.name === "list_lead")!.title).toBe("List my lead records");
    const leads = await tool(origin, token, "list_lead");
    expect((leads.data.records as { id: string }[]).map((r) => r.id)).toEqual(["1"]);
    expect((await tool(origin, token, "get_lead", { id: "2" })).data).toMatchObject({ error: { code: "not_found" } });
    expect((await tool(origin, token, "save_lead", { id: "2", value: { name: "Taken", assignedTo: REP } })).data).toMatchObject({ error: { code: "not_allowed" } });
    expect((await tool(origin, token, "save_lead", { id: "9", value: { name: "Mine", assignedTo: REP } })).error).toBe(false);
    expect((await tool(origin, token, "save_lead", { id: "9", value: { name: "Gone", assignedTo: REP2 } })).data).toMatchObject({ error: { code: "not_allowed" } });
  });

  it("follows role changes and removals on the very next call", async () => {
    const { origin, kv, setRole } = await app();
    await kv(OWNER, "lead:1", { name: "Ada", assignedTo: REP });
    await setRole(OWNER, NEW, "rep");
    const { token } = await connect(origin, NEW);
    expect(((await tool(origin, token, "list_lead")).data.records as unknown[]).length).toBe(0);
    await setRole(OWNER, NEW, "manager");
    expect(((await tool(origin, token, "list_lead")).data.records as unknown[]).length).toBe(1);
    await call(`${origin}/_api/roles/${encodeURIComponent(NEW)}`, { as: OWNER, mount: "/", method: "DELETE" });
    const after = await rpc(origin, token, "tools/list");
    expect(after.status).toBe(401); // the grant was revoked with the membership

    // Someone on the share list who loses an in-app role keeps their connection, back on default_role.
    await setRole(OWNER, REP, "manager");
    const rep = await connect(origin, REP);
    expect(((await tool(origin, rep.token, "list_lead")).data.records as unknown[]).length).toBe(1);
    await call(`${origin}/_api/roles/${encodeURIComponent(REP)}`, { as: OWNER, mount: "/", method: "DELETE" });
    expect((await tools(origin, rep.token)).find((t) => t.name === "list_lead")!.title).toBe("List my lead records");
  });

  it("keeps tokens to their own address", async () => {
    const a = await app();
    const b = await app();
    const { token } = await connect(a.origin, REP);
    // Another app refuses it.
    expect((await rpc(b.origin, token, "tools/list")).status).toBe(401);
    // Formelab's own connector refuses it.
    expect((await rpc("https://example.com", token, "tools/list")).status).toBe(401);
    // A Formelab connection doesn't work at the app.
    const formelab = await connect("https://example.com", REP, { authorize: "https://example.com/authorize" });
    expect((await rpc(a.origin, formelab.token, "tools/list")).status).toBe(401);
    // Connect your AI lists only the Formelab connection.
    const conns = await call("/_api/admin/connections", { as: REP });
    expect((await conns.json<unknown[]>()).length).toBe(1);
  });

  it("offers only reading on a read-only connection", async () => {
    const { origin } = await app();
    const { token } = await connect(origin, REP, { access: "read" });
    expect((await tools(origin, token)).map((t) => t.name).sort()).toEqual(["get_lead", "list_lead"]);
  });

  it("gives apps open to everyone general data tools", async () => {
    const { origin, kv } = await app({ everyone: "all" }, "Menu");
    await kv(OWNER, "dish:1", { name: "Pie" });
    const { token } = await connect(origin, REP);
    expect((await tools(origin, token)).map((t) => t.name).sort()).toEqual(["delete_data", "get_data", "list_data", "save_data"]);
    expect(((await tool(origin, token, "list_data")).data.rows as { key: string }[]).map((r) => r.key)).toEqual(["dish:1"]);
    expect((await tool(origin, token, "save_data", { key: "dish:2", value: { name: "Soup" } })).error).toBe(false);
    const log = await (await call(`/app/apps/${(await env.DB.prepare("SELECT id FROM sites WHERE title = 'Menu' ORDER BY created_at DESC").first<{ id: string }>())!.id}/activity`, { as: OWNER })).text();
    expect(log).toContain(REP);
  });

  it("turns away guests and people the app doesn't list", async () => {
    const { origin } = await app();
    const page = await call(`${origin}/_platform/authorize?client_id=x`, { as: NEW, headers: NAVIGATE });
    expect(page.status).toBe(403);
  });

  it("never lets the app's own scripts read the consent page or press Allow", async () => {
    const { origin } = await app();
    // fetch() from the app's page: same origin, but not a page load.
    const viaFetch = await call(`${origin}/_platform/authorize?client_id=x`, { as: REP, headers: { "sec-fetch-dest": "empty", "sec-fetch-mode": "cors", "sec-fetch-site": "same-origin" } });
    expect(viaFetch.status).toBe(403);
    expect(await viaFetch.text()).toContain("Open this page yourself");
    // No Fetch Metadata at all: refused too.
    expect((await call(`${origin}/_platform/authorize?client_id=x`, { as: REP })).status).toBe(403);
    // A POST not made from the page itself.
    const post = await call(`${origin}/_platform/authorize`, { as: REP, method: "POST", headers: { ...NAVIGATE, "content-type": "application/x-www-form-urlencoded" }, body: "handle=x&decision=approve" });
    expect(post.status).toBe(403);
    // The real page keeps popups opened by the app out.
    const { html, coop } = await connect(origin, REP);
    expect(html).toContain("Connect Claude to Acme CRM?");
    expect(coop).toBe("same-origin");
  });

  it("keeps app files off the reserved paths", async () => {
    const res = await publishZip(OWNER, uniq(), "x", { "index.html": PAGE("hi"), mcp: "nope" });
    expect(res.status).toBe(400);
    expect((await res.json<Err>()).error.code).toBe("reserved_path");
  });
});
