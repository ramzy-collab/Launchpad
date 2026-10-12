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
    const html = await (await call("/admin/users", { as: OWNER })).text();
    expect(html).toContain(`data-action="user-delete" data-email="${email}"`);
    expect(html).not.toContain(`data-action="user-delete" data-email="${OWNER}"`);
  });

  it("deletes a user and everything they own, and removes them from other people's lists", async () => {
    const gone = `gone-${uniq()}@example.com`;
    const ns = uniq();
    // Their own namespace with an app, data and a secret.
    const pub = await publishHtml(gone, ns, "mine", PAGE("theirs"));
    const { site } = await pub.json<{ site: { id: string } }>();
    await call(`https://${ns}.example.app/_api/kv/k`, { as: gone, mount: "/mine/", method: "PUT", body: '"v"' });
    await call(`https://${ns}.example.app/_api/secrets/s`, { as: gone, mount: "/mine/", method: "PUT", json: { value: "shh" } });
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

  it("the admin area is for admins only, and shows the numbers", async () => {
    const res = await call("/admin", { as: OWNER });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Run Formelab");
    expect(html).toContain('<a href="/" aria-current="page">Overview</a>');
    expect(html).toContain('class="stat-label">People<');
    expect(html).not.toMatch(/\son[a-z]+=/i);
    for (const path of ["/", "/users", "/waitlist"]) {
      const url = `https://admin.example.com${path}`;
      expect((await call(url, { as: `nope-${uniq()}@example.com` })).status, path).toBe(404);
      const out = await call(url);
      expect(out.status, path).toBe(302);
      expect(out.headers.get("location"), path).toBe(`https://example.com/auth/app?return=${encodeURIComponent(url)}`);
    }
    // The admin API answers on the admin host too, for admins only.
    expect((await call("https://admin.example.com/_api/admin/users", { as: OWNER })).status).toBe(200);
    expect((await call("https://admin.example.com/_api/admin/users", { as: `nope-${uniq()}@example.com` })).status).toBe(403);
    // Non-admins don't get an Admin link in their own lab.
    expect(await (await call("/app", { as: `plain-${uniq()}@example.com` })).text()).not.toContain("admin.example.com");
  });

  it("admins can make and remove other admins, but not the owner or themselves", async () => {
    const helper = `helper-${uniq()}@example.com`;
    await call("/_api/admin/whoami", { as: helper });
    await env.DB.prepare("UPDATE users SET status = 'waitlisted' WHERE email = ?").bind(helper).run();
    const grant = await call(`/_api/admin/users/${encodeURIComponent(helper)}/admin`, { as: OWNER, method: "POST", json: { admin: true } });
    expect(grant.status).toBe(200);
    const row = await env.DB.prepare("SELECT is_admin, status FROM users WHERE email = ?").bind(helper).first<{ is_admin: number; status: string }>();
    expect(row).toEqual({ is_admin: 1, status: "active" }); // admins are let in too
    expect((await call("/admin/users", { as: helper })).status).toBe(200);

    // The new admin can't demote the owner or themselves; a non-admin can't change anything.
    expect((await call(`/_api/admin/users/${encodeURIComponent(OWNER)}/admin`, { as: helper, method: "POST", json: { admin: false } })).status).toBe(400);
    expect((await call(`/_api/admin/users/${encodeURIComponent(helper)}/admin`, { as: helper, method: "POST", json: { admin: false } })).status).toBe(400);
    expect((await call(`/_api/admin/users/${encodeURIComponent(helper)}/admin`, { as: `x-${uniq()}@example.com`, method: "POST", json: { admin: false } })).status).toBe(403);
    expect((await call(`/_api/admin/users/${encodeURIComponent(helper)}/admin`, { as: OWNER, method: "POST", json: { admin: "yes" } })).status).toBe(400);

    const revoke = await call(`/_api/admin/users/${encodeURIComponent(helper)}/admin`, { as: OWNER, method: "POST", json: { admin: false } });
    expect(revoke.status).toBe(200);
    expect((await call("/admin", { as: helper })).status).toBe(404);
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
