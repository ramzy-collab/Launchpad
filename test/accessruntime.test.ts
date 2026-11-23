import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { appAt, call, OWNER, PAGE, publishHtml, publishZip, uniq } from "./helpers";

// Access rules applied to formelab.kv calls inside the app (spec step 3).
const REP = "rep@example.com";
const REP2 = "rep2@example.com";
const EDITOR = "ed@example.com";
const CRM = {
  default_role: "rep",
  records: {
    lead: { prefix: "lead:", fields: ["name", "assignedTo"], owner_field: "assignedTo", read: { rep: "own" }, write: { rep: "own" } },
    settings: { prefix: "settings", read: { rep: "all", guest: "all" } },
  },
};
const CODE = PAGE(`<script>formelab.kv.get("settings"); formelab.kv.set("lead:" + id, v)</script>`);

type Err = { error: { code: string; message: string } };

async function app(rules: unknown, extra: Record<string, string> = {}) {
  const ns = uniq();
  const res = await publishZip(OWNER, ns, "crm", { "index.html": CODE, "formelab.json": JSON.stringify(rules) }, { allowed_emails: `${REP}, ${REP2}`, editors: EDITOR, ...extra });
  expect(res.status).toBe(201);
  const { site } = await res.json<{ site: { id: string } }>();
  const origin = await appAt(ns, "crm");
  const kv = (as: string | null, key = "", method = "GET", value?: unknown, cookie?: string) =>
    call(`${origin}/_api/kv${key ? `/${encodeURIComponent(key)}` : ""}`, {
      ...(as ? { as } : {}),
      mount: "/",
      method,
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      ...(cookie ? { headers: { cookie } } : {}),
    });
  return { ns, id: site.id, origin, kv };
}

const keys = async (res: Response) => (await res.json<{ key: string }[]>()).map((r) => r.key);

describe("access rules inside the app", () => {
  it("shows each person only what their role may read", async () => {
    const { kv } = await app(CRM);
    await kv(OWNER, "lead:1", "PUT", { name: "Ada", assignedTo: REP });
    await kv(OWNER, "lead:2", "PUT", { name: "Bo", assignedTo: REP2 });
    await kv(OWNER, "lead:3", "PUT", { name: "Cy", assignedTo: ` ${REP.toUpperCase()} ` });
    await kv(OWNER, "settings", "PUT", { theme: "dark" });
    await kv(OWNER, "secret", "PUT", 1);

    expect(await keys(await kv(REP))).toEqual(["lead:1", "lead:3", "settings"]);
    expect(await keys(await kv(REP2))).toEqual(["lead:2", "settings"]);
    expect(await (await kv(REP, "lead:1")).json()).toEqual({ value: { name: "Ada", assignedTo: REP } });
    // Someone else's record and keys no rule covers look missing.
    for (const key of ["lead:2", "secret"]) {
      const res = await kv(REP, key);
      expect(res.status).toBe(404);
      expect((await res.json<Err>()).error.code).toBe("not_found");
    }
    // Owner and editors see everything.
    expect(await keys(await kv(OWNER))).toEqual(["lead:1", "lead:2", "lead:3", "secret", "settings"]);
    expect(await keys(await kv(EDITOR))).toEqual(["lead:1", "lead:2", "lead:3", "secret", "settings"]);
  });

  it("lets people change only their own records, and keep them their own", async () => {
    const { kv } = await app(CRM);
    await kv(OWNER, "lead:2", "PUT", { name: "Bo", assignedTo: REP2 });

    expect((await kv(REP, "lead:9", "PUT", { name: "New", assignedTo: REP })).status).toBe(200);
    expect((await kv(REP, "lead:9", "PUT", { name: "Renamed", assignedTo: REP })).status).toBe(200);
    const giveAway = await kv(REP, "lead:9", "PUT", { name: "Renamed", assignedTo: REP2 });
    expect(giveAway.status).toBe(403);
    expect((await giveAway.json<Err>()).error).toMatchObject({ code: "not_allowed", message: 'You can only save records with your own email in "assignedTo".' });
    for (const [key, method, value] of [
      ["lead:2", "PUT", { name: "Taken", assignedTo: REP }],
      ["lead:2", "DELETE", undefined],
      ["settings", "PUT", { theme: "light" }],
      ["secret", "PUT", 1],
    ] as const) {
      const res = await kv(REP, key, method, value);
      expect(res.status, `${method} ${key}`).toBe(403);
      expect((await res.json<Err>()).error).toMatchObject({ code: "not_allowed", message: "You can't change this record." });
    }
    expect(await (await kv(OWNER, "lead:2")).json()).toEqual({ value: { name: "Bo", assignedTo: REP2 } });
    expect((await kv(REP, "lead:9", "DELETE")).status).toBe(200);
    // Editors change anything.
    expect((await kv(EDITOR, "lead:2", "PUT", { name: "Bo", assignedTo: EDITOR })).status).toBe(200);
  });

  it("gives public-link visitors the guest role, read-only", async () => {
    const { id, kv } = await app(CRM);
    await kv(OWNER, "lead:1", "PUT", { name: "Ada", assignedTo: REP });
    await kv(OWNER, "settings", "PUT", { theme: "dark" });
    const on = await call(`/_api/admin/sites/${id}`, { as: OWNER, method: "PATCH", json: { public_link: true } });
    const link = (await on.json<{ publicUrl: string }>()).publicUrl;
    const cookie = (await call(link)).headers.get("set-cookie")!.split(";")[0]!;
    expect(await keys(await kv(null, "", "GET", undefined, cookie))).toEqual(["settings"]);
    expect((await kv(null, "lead:1", "GET", undefined, cookie)).status).toBe(404);
    expect((await kv(null, "settings", "PUT", {}, cookie)).status).toBe(401);
  });

  it("lets everyone read and write with the one-line rule, whatever data_writes says", async () => {
    const { kv } = await app({ everyone: "all" }, { data_writes: "editors" });
    expect((await kv(REP, "vote:rep", "PUT", "pizza")).status).toBe(200);
    expect(await keys(await kv(REP2))).toEqual(["vote:rep"]);
  });

  it("reads rules from the live file once for apps published before they were kept", async () => {
    const { id, kv } = await app(CRM);
    await kv(OWNER, "secret", "PUT", 1);
    await env.DB.prepare("UPDATE sites SET rules = NULL WHERE id = ?").bind(id).run();
    expect((await kv(REP, "secret")).status).toBe(404);
    expect((await env.DB.prepare("SELECT rules FROM sites WHERE id = ?").bind(id).first<{ rules: string }>())!.rules).toBe(JSON.stringify(CRM));
  });

  it("refuses a new app without rules that uses data anyway, even for its owner", async () => {
    const ns = uniq();
    // The scan doesn't see formelab["kv"], so this publishes without rules.
    expect((await publishHtml(OWNER, ns, "sneaky", PAGE(`<script>formelab["kv"].set("x", 1)</script>`), {}, { newApp: true })).status).toBe(201);
    const origin = await appAt(ns, "sneaky");
    for (const [path, method] of [["kv/x", "PUT"], ["kv", "GET"], ["secrets/k/proxy", "POST"], ["ai/gemini", "POST"], ["sheets", "POST"]] as const) {
      const res = await call(`${origin}/_api/${path}`, { as: OWNER, mount: "/", method, body: method === "GET" ? undefined : '{"url":"https://api.test/"}' });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect((await res.json<Err>()).error.code).toBe("rules_required");
    }
    // Each person's own data isn't shared, so it still works.
    expect((await call(`${origin}/_api/me/kv/draft`, { as: OWNER, mount: "/", method: "PUT", body: "1" })).status).toBe(200);
  });

  it("can't be slipped past with a percent-encoded path", async () => {
    const ns = uniq();
    await publishHtml(OWNER, ns, "enc", PAGE(`<script>formelab["kv"].set("x", 1)</script>`), {}, { newApp: true });
    const origin = await appAt(ns, "enc");
    for (const path of ["%6Bv/x", "k%76/x", "%73heets"]) {
      const res = await call(`${origin}/_api/${path}`, { as: OWNER, mount: "/", method: path.includes("heets") ? "POST" : "PUT", body: '{"method":"GET","path":"x"}' });
      expect(res.status, path).not.toBe(200);
    }
    const id = (await env.DB.prepare("SELECT id FROM sites WHERE namespace = ? AND mount_path = 'enc'").bind(ns).first<{ id: string }>())!.id;
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM kv WHERE site_id = ?").bind(id).first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("checks ownership inside the write, so a record that isn't theirs is never replaced or deleted", async () => {
    const { id, kv } = await app(CRM);
    await kv(OWNER, "lead:5", "PUT", { name: "Eve", assignedTo: REP2 });
    expect((await kv(REP, "lead:5", "PUT", { name: "Mine now", assignedTo: REP })).status).toBe(403);
    expect((await kv(REP, "lead:5", "DELETE")).status).toBe(403);
    // A value that isn't an object has no owner: nobody but owners and editors can replace it.
    await kv(OWNER, "lead:6", "PUT", "just text");
    expect((await kv(REP, "lead:6", "PUT", { name: "x", assignedTo: REP })).status).toBe(403);
    const rows = await env.DB.prepare("SELECT key, value FROM kv WHERE site_id = ? ORDER BY key").bind(id).all<{ key: string; value: string }>();
    expect(rows.results).toEqual([
      { key: "lead:5", value: JSON.stringify({ name: "Eve", assignedTo: REP2 }) },
      { key: "lead:6", value: '"just text"' },
    ]);
  });

  it("pages past records someone can't see, never naming them in the cursor", async () => {
    const { kv } = await app(CRM);
    const big = "x".repeat(60 * 1024);
    for (let i = 10; i < 80; i++) await kv(OWNER, `lead:${i}`, "PUT", { name: big, assignedTo: REP2 }); // about 4.2 MB Rep A can't see
    await kv(OWNER, "lead:90", "PUT", { name: "Ada", assignedTo: REP });
    const res = await kv(REP, "");
    expect(res.headers.get("x-formelab-next")).toBeNull();
    expect(await keys(res)).toEqual(["lead:90"]);
  });

  it("keeps today's behavior for apps made before access rules", async () => {
    const ns = uniq();
    const id = (await (await publishHtml(OWNER, ns, "old", PAGE("hi"), { allowed_emails: REP })).json<{ site: { id: string } }>()).site.id;
    await env.DB.prepare("UPDATE sites SET rules_required = 0 WHERE id = ?").bind(id).run();
    const origin = await appAt(ns, "old");
    await call(`${origin}/_api/kv/x`, { as: OWNER, mount: "/", method: "PUT", body: "1" });
    expect(await (await call(`${origin}/_api/kv/x`, { as: REP, mount: "/" })).json()).toEqual({ value: 1 });
    expect((await call(`${origin}/_api/kv/x`, { as: REP, mount: "/", method: "PUT", body: "2" })).status).toBe(403); // data_writes "editors"
  });
});

describe("the data switch on the app's page", () => {
  it("gives way to a note for apps with rules", async () => {
    const { id } = await app(CRM);
    const html = await (await call(`/app/apps/${id}`, { as: OWNER })).text();
    expect(html).not.toContain('data-setting="dataWrites"');
    expect(html).toContain("access rules (formelab.json) decide it, for each kind of record");
  });
});
