import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { call, OWNER, PAGE, publishHtml, r2Keys, uniq } from "./helpers";

const del = (email: string, as = OWNER) => call(`/_api/admin/users/${encodeURIComponent(email)}`, { as, method: "DELETE" });
const count = async (sql: string, ...binds: unknown[]) =>
  (await env.DB.prepare(sql).bind(...binds).first<{ n: number }>())!.n;

describe("admin: users", () => {
  it("lists users for admins only, with a Delete button except for the owner", async () => {
    const email = `list-${uniq()}@example.com`;
    await call("/_api/admin/whoami", { as: email });
    const list = await (await call("/_api/admin/users", { as: OWNER })).json<{ email: string }[]>();
    expect(list.map((u) => u.email)).toContain(email);
    expect((await call("/_api/admin/users", { as: email })).status).toBe(403);
    const html = await (await call("/app", { as: OWNER })).text();
    expect(html).toContain(`data-action="user-delete" data-email="${email}"`);
    expect(html).not.toContain(`data-action="user-delete" data-email="${OWNER}"`);
  });

  it("deletes a user and everything they own, and removes them from other people's lists", async () => {
    const gone = `gone-${uniq()}@example.com`;
    const ns = uniq();
    // Their own namespace with an app, data and a secret.
    const pub = await publishHtml(gone, ns, "mine", PAGE("theirs"));
    const { site } = await pub.json<{ site: { id: string } }>();
    await call(`https://${ns}.example.com/_api/kv/k`, { as: gone, mount: "/mine/", method: "PUT", body: '"v"' });
    await call(`https://${ns}.example.com/_api/secrets/s`, { as: gone, mount: "/mine/", method: "PUT", json: { value: "shh" } });
    await call("/_api/admin/tokens", { as: gone, method: "POST", json: { name: "t" } });
    // An app of the owner's shared with them, and a namespace they edit.
    const ownerNs = uniq();
    const shared = await (await publishHtml(OWNER, ownerNs, "shared", PAGE("x"), { allowed_emails: `${gone}, keep@example.com`, editors: gone })).json<{ site: { id: string } }>();
    await call(`/_api/admin/namespaces/${ownerNs}`, { as: OWNER, method: "PATCH", json: { editors: `${gone}, keep@example.com` } });

    const res = await del(gone);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, deletedNamespaces: 1, deletedSites: 1, removedFromShares: 2 });

    expect(await count("SELECT COUNT(*) AS n FROM users WHERE email = ?", gone)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM namespaces WHERE label = ?", ns)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM sites WHERE id = ?", site.id)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM kv WHERE site_id = ?", site.id)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM secrets WHERE site_id = ?", site.id)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM tokens WHERE owner_email = ?", gone)).toBe(0);
    expect(await r2Keys(`sites/${site.id}/`)).toEqual([]);

    const sharedRow = await env.DB.prepare("SELECT allowed_emails, editors FROM sites WHERE id = ?").bind(shared.site.id).first<{ allowed_emails: string; editors: string }>();
    expect(JSON.parse(sharedRow!.allowed_emails)).toEqual(["keep@example.com"]);
    expect(JSON.parse(sharedRow!.editors)).toEqual([]);
    const nsRow = await env.DB.prepare("SELECT editors FROM namespaces WHERE label = ?").bind(ownerNs).first<{ editors: string }>();
    expect(JSON.parse(nsRow!.editors)).toEqual(["keep@example.com"]);

    expect(await count("SELECT COUNT(*) AS n FROM audit WHERE action = 'user_delete' AND target = ?", gone)).toBe(1);
  });

  it("only admins can delete, and not themselves or the owner", async () => {
    const a = `a-${uniq()}@example.com`;
    const b = `b-${uniq()}@example.com`;
    await call("/_api/admin/whoami", { as: a });
    await call("/_api/admin/whoami", { as: b });
    expect((await del(b, a)).status).toBe(403);
    expect((await del(OWNER)).status).toBe(400);
    expect((await del(`missing-${uniq()}@example.com`)).status).toBe(404);
    expect((await call("/_api/admin/users/x@example.com", { as: OWNER, method: "DELETE", csrf: false })).status).toBe(403);
  });
});
