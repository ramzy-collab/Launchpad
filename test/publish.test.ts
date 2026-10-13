import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { call, OWNER, PAGE, publishHtml, publishZip, r2Keys, uniq, appAt } from "./helpers";

const HOSTS = ["api.test"];

type Published = { url: string; site: { id: string; mountPath: string; fileCount: number } };

describe("publish and serve", () => {
  it("publishes a single HTML file and serves it with <base> injected", async () => {
    const ns = uniq();
    const res = await publishHtml(OWNER, ns, "hello", PAGE("<p>hi</p>"), { title: "Hello" });
    expect(res.status).toBe(201);
    const body = await res.json<Published>();
    // Its own host: the name plus a 4-character code.
    expect(body.url).toMatch(/^https:\/\/hello-[a-z2-9]{4}\.example\.app\/$/);
    expect(body.url).toBe(`${await appAt(ns, "hello")}/`);

    const page = await call(body.url, { as: OWNER });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("cache-control")).toBe("no-cache");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    const html = await page.text();
    // The base comes first, then the tags that let the app be installed (pwa.test.ts).
    expect(html).toContain('<head><base href="/"><link rel="manifest" href="/_platform/manifest.webmanifest" crossorigin="use-credentials">');
    expect(html).toContain("<p>hi</p>");
    // The SDK is never injected automatically.
    expect(html).not.toContain("sdk.js");
  });

  it("injects <base href='/'> for root mounts and synthesizes <head> when missing", async () => {
    const ns = uniq();
    await publishHtml(OWNER, ns, "", "<!doctype html><html><body>bare</body></html>");
    const html = await (await call(`${await appAt(ns, "")}/`, { as: OWNER })).text();
    expect(html).toBe(
      `<!doctype html><html><head><base href="/"><link rel="manifest" href="/_platform/manifest.webmanifest" crossorigin="use-credentials"><meta name="apple-mobile-web-app-title" content="${ns}"></head><body>bare</body></html>`,
    );
  });

  it("publishes a zip, strips a single top-level folder, and serves assets with ETag caching", async () => {
    const ns = uniq();
    const res = await publishZip(OWNER, ns, "docs", {
      "my-app/index.html": PAGE("home"),
      "my-app/about/index.html": PAGE("about"),
      "my-app/contact.html": PAGE("contact"),
      "my-app/css/site.css": "body{}",
      "my-app/data.json": "{}",
      "my-app/LICENSE": "MIT",
    });
    expect(res.status).toBe(201);
    const { site } = await res.json<Published>();
    expect(site.fileCount).toBe(6);
    const base = await appAt(ns, "docs");

    const css = await call(`${base}/css/site.css`, { as: OWNER });
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(css.headers.get("cache-control")).toBe("public, max-age=300");
    const etag = css.headers.get("etag")!;
    expect(etag).toBeTruthy();
    const cached = await call(`${base}/css/site.css`, { as: OWNER, headers: { "if-none-match": etag } });
    expect(cached.status).toBe(304);

    expect((await (await call(`${base}/about`, { as: OWNER })).text())).toContain("about");
    expect((await (await call(`${base}/about/`, { as: OWNER })).text())).toContain("about");
    expect((await (await call(`${base}/contact`, { as: OWNER })).text())).toContain("contact");
    expect((await call(`${base}/data.json`, { as: OWNER })).headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect((await (await call(`${base}/LICENSE`, { as: OWNER })).text())).toBe("MIT");
    expect((await call(`${base}/missing`, { as: OWNER })).status).toBe(404);
    expect((await call(`${base}/missing.png`, { as: OWNER })).status).toBe(404);
  });

  it("redirects old addresses (<space>.APP_DOMAIN/<path>/ and <space>.DOMAIN/...) to the app's own host", async () => {
    const ns = uniq();
    await publishHtml(OWNER, ns, "tools/budget", PAGE("b"));
    const app = await appAt(ns, "tools/budget");
    expect(new URL(app).hostname).toMatch(/^tools-budget-[a-z2-9]{4}\.example\.app$/);
    const go = async (url: string) => {
      const res = await call(url);
      expect(res.status, url).toBe(301);
      return res.headers.get("location");
    };
    expect(await go(`https://${ns}.example.app/tools/budget?x=1`)).toBe(`${app}/?x=1`);
    expect(await go(`https://${ns}.example.app/tools/budget/`)).toBe(`${app}/`);
    expect(await go(`https://${ns}.example.app/tools/budget/css/a%20b.css?v=2`)).toBe(`${app}/css/a%20b.css?v=2`);
    expect(await go(`https://${ns}.example.com/tools/budget/page`)).toBe(`${app}/page`);
    // Nothing is served on the old hosts any more.
    expect((await call(`https://${ns}.example.app/nothing/`)).status).toBe(404);
    expect((await call(`https://${ns}.example.app/_api/me`, { as: OWNER, mount: "/tools/budget/" })).status).toBe(404);
    expect((await call(`https://nobody-${ns}.example.app/`)).status).toBe(404);
  });

  it("old addresses still pick the longest matching mount path", async () => {
    const ns = uniq();
    await publishHtml(OWNER, ns, "", PAGE("root"));
    await publishHtml(OWNER, ns, "a", PAGE("a"));
    await publishHtml(OWNER, ns, "a/b", PAGE("ab"));
    const to = async (p: string) => (await call(`https://${ns}.example.app${p}`)).headers.get("location");
    expect(await to("/")).toBe(`${await appAt(ns, "")}/`);
    expect(await to("/a/")).toBe(`${await appAt(ns, "a")}/`);
    expect(await to("/a/b/")).toBe(`${await appAt(ns, "a/b")}/`);
    expect(await to("/ab/")).toBe(`${await appAt(ns, "")}/ab/`); // "ab" is not under "a": the root app's ab/
    // Each app's own host serves only that app.
    expect(await (await call(`${await appAt(ns, "a")}/`, { as: OWNER })).text()).toContain(">a<");
    expect((await call(`${await appAt(ns, "a")}/b/`, { as: OWNER })).status).toBe(404);
  });

  it("SPA mode serves index.html for unknown extensionless paths only", async () => {
    const ns = uniq();
    await publishHtml(OWNER, ns, "app", PAGE("spa"), { spa: "true" });
    const app = await appAt(ns, "app");
    const deep = await call(`${app}/users/42`, { as: OWNER });
    expect(deep.status).toBe(200);
    expect(await deep.text()).toContain("spa");
    expect((await call(`${app}/logo.png`, { as: OWNER })).status).toBe(404);
  });

  it("replaces a site atomically and keeps KV and secrets", async () => {
    const ns = uniq();
    const first = await (await publishHtml(OWNER, ns, "r", PAGE("v1"))).json<Published>();
    const id = first.site.id;
    const v1 = (await env.DB.prepare("SELECT current_version FROM sites WHERE id = ?").bind(id).first<{ current_version: string }>())!.current_version;
    await env.DB.prepare("INSERT INTO kv (site_id, key, value, updated_at) VALUES (?, 'k', '1', 0)").bind(id).run();

    // A failed replacement (bad zip) leaves the old version live and untouched.
    const bad = await publishZip(OWNER, ns, "r", { "nope.html": "x" });
    expect(bad.status).toBe(400);
    const app = await appAt(ns, "r");
    expect(await (await call(`${app}/`, { as: OWNER })).text()).toContain("v1");

    const second = await publishHtml(OWNER, ns, "r", PAGE("v2"));
    expect(second.status).toBe(200);
    const body = await second.json<Published & { replaced: boolean }>();
    expect(body.replaced).toBe(true);
    expect(body.site.id).toBe(id);
    expect(await (await call(`${app}/`, { as: OWNER })).text()).toContain("v2");
    expect(body.url).toBe(`${app}/`); // a new version keeps the app's address
    const v2 = (await env.DB.prepare("SELECT current_version FROM sites WHERE id = ?").bind(id).first<{ current_version: string }>())!.current_version;
    expect(v2).not.toBe(v1); // a new version, in its own folder (ids start with the time, but two publishes can share a millisecond)
    expect(await env.DB.prepare("SELECT value FROM kv WHERE site_id = ?").bind(id).first()).toEqual({ value: "1" });
    // The old version's files are removed in the background.
    for (let i = 0; i < 100 && (await r2Keys(`sites/${id}/${v1}/`)).length; i++) await new Promise((r) => setTimeout(r, 20));
    expect(await r2Keys(`sites/${id}/${v1}/`)).toEqual([]);
    expect(await r2Keys(`sites/${id}/${v2}/`)).toEqual([`sites/${id}/${v2}/index.html`]);
  });

  it("returns 409 when publishing into someone else's namespace", async () => {
    const ns = uniq();
    await publishHtml(OWNER, ns, "", PAGE("mine"));
    const res = await publishHtml("intruder@example.com", ns, "x", PAGE("theirs"));
    expect(res.status).toBe(409);
    const { error } = await res.json<{ error: { code: string; hint: string } }>();
    expect(error.hint).toContain(OWNER);
    // Replacing an existing site also fails.
    expect((await publishHtml("intruder@example.com", ns, "", PAGE("theirs"))).status).toBe(409);
  });

  it("lets namespace editors publish", async () => {
    const ns = uniq();
    await publishHtml(OWNER, ns, "", PAGE("x"));
    const patch = await call(`/_api/admin/namespaces/${ns}`, { as: OWNER, method: "PATCH", json: { editors: ["ed@example.com"] } });
    expect(patch.status).toBe(200);
    expect((await publishHtml("ed@example.com", ns, "ed", PAGE("ed"))).status).toBe(201);
    // Editors cannot change the editor list or delete the namespace.
    expect((await call(`/_api/admin/namespaces/${ns}`, { as: "ed@example.com", method: "PATCH", json: { editors: [] } })).status).toBe(403);
    expect((await call(`/_api/admin/namespaces/${ns}`, { as: "ed@example.com", method: "DELETE" })).status).toBe(403);
  });

  it("validates namespace labels and mount paths", async () => {
    for (const label of ["www", "api", "admin", "mcp", "static", "platform", "-bad", "UPPER_", "a.b", ""]) {
      expect((await publishHtml(OWNER, label, "", PAGE("x"))).status, label).toBe(400);
    }
    for (const mount of ["_api", "a/../b", "a b", "healthz", "x/_platform"]) {
      expect((await publishHtml(OWNER, uniq(), mount, PAGE("x"))).status, mount).toBe(400);
    }
  });

  it("keeps sharing settings, title and spa when a new version is published", async () => {
    const ns = uniq();
    const first = await publishHtml(OWNER, ns, "kept", PAGE("v1"), {
      title: "Kept app",
      spa: "true",
      allowed_emails: "friend@example.com, other@example.com",
      editors: "ed@example.com",
    });
    expect(first.status).toBe(201);

    // Like the dashboard's Publish form: blank title and share-with, visibility select, no spa.
    const second = await publishHtml(OWNER, ns, "kept", PAGE("v2"), { title: "", allowed_emails: "", visibility: "restricted" });
    expect(second.status).toBe(200);
    const body = await second.json<Published & { replaced: boolean; note?: string }>();
    expect(body.replaced).toBe(true);
    expect(body.site).toMatchObject({
      title: "Kept app",
      spa: true,
      visibility: "restricted",
      allowedEmails: ["friend@example.com", "other@example.com"],
      editors: ["ed@example.com"],
    });
    expect(body.note).toContain("Kept this app's sharing settings");

    // An editor publishing a new version can't change sharing either.
    const third = await publishHtml("ed@example.com", ns, "kept", PAGE("v3"), { allowed_emails: "stranger@example.com", visibility: "all" });
    expect(third.status).toBe(200);
    expect((await third.json<Published>()).site).toMatchObject({ visibility: "restricted", allowedEmails: ["friend@example.com", "other@example.com"] });

    // The same list in another order isn't a change, so no note; a new title still applies.
    const fourth = await publishHtml(OWNER, ns, "kept", PAGE("v4"), { allowed_emails: "other@example.com, friend@example.com", title: "Renamed" });
    const b4 = await fourth.json<Published & { note?: string }>();
    expect(b4.note).toBeUndefined();
    expect(b4.site).toMatchObject({ title: "Renamed" });

    // The friend can still open the new version; update_site (PATCH) is how sharing changes.
    const page = await call(`${await appAt(ns, "kept")}/`, { as: "friend@example.com" });
    expect(await page.text()).toContain("v4");
    const patched = await call(`/_api/admin/sites/${body.site.id}`, { as: OWNER, method: "PATCH", json: { allowed_emails: "new@example.com" } });
    expect((await patched.json<{ allowedEmails: string[] }>()).allowedEmails).toEqual(["new@example.com"]);
  });

  it("supports the JSON publish body and PATCH settings", async () => {
    const ns = uniq();
    const res = await call("/_api/admin/sites", { as: OWNER, method: "POST", json: { html: PAGE("json"), namespace: ns, mount_path: "j", title: "J" } });
    expect(res.status).toBe(201);
    const { site } = await res.json<Published>();
    const patched = await call(`/_api/admin/sites/${site.id}`, { as: OWNER, method: "PATCH", json: { title: "New", hidden: true, spa: true } });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ title: "New", hidden: true, spa: true, visibility: "restricted" });
    // Hidden sites are still listed for people who manage them.
    const list = await (await call(`/_api/admin/sites?namespace=${ns}`, { as: OWNER })).json<{ id: string }[]>();
    expect(list.map((s) => s.id)).toContain(site.id);
    const others = await (await call(`/_api/admin/sites?namespace=${ns}`, { as: "viewer@example.com" })).json<{ id: string }[]>();
    expect(others.map((s) => s.id)).not.toContain(site.id);
  });
});

describe("security 3: restricted sites", () => {
  it("return 403 to viewers not on the allow-list, for files and /_api/*", async () => {
    const ns = uniq();
    const res = await publishHtml(OWNER, ns, "secret", PAGE("private"), { visibility: "restricted", allowed_emails: "friend@example.com" });
    expect(res.status).toBe(201);
    const url = `${await appAt(ns, "secret")}/`;

    const denied = await call(url, { as: "stranger@example.com" });
    expect(denied.status).toBe(403);
    expect(await denied.text()).not.toContain("private");
    expect((await call(url + "index.html", { as: "stranger@example.com" })).status).toBe(403);
    for (const path of ["me", "kv", "kv/x", "secrets"]) {
      const r = await call(`${await appAt(ns, "secret")}/_api/${path}`, { as: "stranger@example.com", mount: "/" });
      expect(r.status, path).toBe(403);
    }
    const proxy = await call(`${await appAt(ns, "secret")}/_api/secrets/x/proxy`, { as: "stranger@example.com", mount: "/", method: "POST", json: { url: "https://api.test/" } });
    expect(proxy.status).toBe(403);
    const put = await call(`${await appAt(ns, "secret")}/_api/kv/x`, { as: "stranger@example.com", mount: "/", method: "PUT", body: "1" });
    expect(put.status).toBe(403);

    for (const who of [OWNER, "friend@example.com"]) {
      expect((await call(url, { as: who })).status, who).toBe(200);
      expect((await call(`${await appAt(ns, "secret")}/_api/me`, { as: who, mount: "/" })).status, who).toBe(200);
    }
  });

  it("also admits site editors and namespace editors", async () => {
    const ns = uniq();
    await publishHtml(OWNER, ns, "", PAGE("private"), { visibility: "restricted", editors: "siteed@example.com" });
    await call(`/_api/admin/namespaces/${ns}`, { as: OWNER, method: "PATCH", json: { editors: "nsed@example.com" } });
    for (const who of ["siteed@example.com", "nsed@example.com"]) {
      expect((await call(`${await appAt(ns, "")}/`, { as: who })).status, who).toBe(200);
    }
  });

  it("hides restricted sites from the listings of people who can't see them", async () => {
    const ns = uniq();
    await publishHtml(OWNER, ns, "p", PAGE("x"), { visibility: "restricted" });
    const list = await (await call(`/_api/admin/sites?namespace=${ns}`, { as: "stranger@example.com" })).json<unknown[]>();
    expect(list).toEqual([]);
  });
});

describe("security 12: deleting a site", () => {
  it("removes its R2 objects, KV rows and secret rows", async () => {
    const ns = uniq();
    const { site } = await (await publishZip(OWNER, ns, "gone", { "index.html": PAGE("x"), "a.js": "1", "b/c.css": "2" })).json<Published>();
    const appUrl = await appAt(ns, "gone");
    await call(`${await appAt(ns, "gone")}/_api/kv/k`, { as: OWNER, mount: "/", method: "PUT", body: '"v"' });
    await call(`${await appAt(ns, "gone")}/_api/secrets/s`, { as: OWNER, mount: "/", method: "PUT", json: { hosts: HOSTS, value: "shh-secret" } });
    expect((await r2Keys(`sites/${site.id}/`)).length).toBe(3);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM kv WHERE site_id = ?").bind(site.id).first<{ n: number }>())!.n).toBe(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM secrets WHERE site_id = ?").bind(site.id).first<{ n: number }>())!.n).toBe(1);

    expect((await call(`/_api/admin/sites/${site.id}`, { as: "stranger@example.com", method: "DELETE" })).status).toBe(404);
    const del = await call(`/_api/admin/sites/${site.id}`, { as: OWNER, method: "DELETE" });
    expect(del.status).toBe(200);

    expect(await r2Keys(`sites/${site.id}/`)).toEqual([]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM kv WHERE site_id = ?").bind(site.id).first<{ n: number }>())!.n).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM secrets WHERE site_id = ?").bind(site.id).first<{ n: number }>())!.n).toBe(0);
    expect(await env.DB.prepare("SELECT id FROM sites WHERE id = ?").bind(site.id).first()).toBeNull();
    expect((await call(`${appUrl}/`, { as: OWNER })).status).toBe(404);
  });

  it("deleting a namespace removes every site in it", async () => {
    const ns = uniq();
    const a = await (await publishHtml(OWNER, ns, "a", PAGE("a"))).json<Published>();
    const b = await (await publishHtml(OWNER, ns, "b", PAGE("b"))).json<Published>();
    const del = await call(`/_api/admin/namespaces/${ns}`, { as: OWNER, method: "DELETE" });
    expect(await del.json()).toEqual({ ok: true, deletedSites: 2 });
    for (const id of [a.site.id, b.site.id]) expect(await r2Keys(`sites/${id}/`)).toEqual([]);
    expect(await env.DB.prepare("SELECT label FROM namespaces WHERE label = ?").bind(ns).first()).toBeNull();
  });
});

describe("migration 0016: every existing app gets its own host", () => {
  it("names each app from its mount path (or its space) plus a 4-character code", async () => {
    const ns = uniq();
    await publishHtml(OWNER, ns, "", PAGE("root"));
    await publishHtml(OWNER, ns, "tools/budget", PAGE("b"));
    // Apps from before the migration have no host label yet.
    await env.DB.prepare("UPDATE sites SET host_label = NULL WHERE namespace = ?").bind(ns).run();
    const migration = (env as unknown as { TEST_MIGRATIONS: { name: string; queries: string[] }[] }).TEST_MIGRATIONS.find((m) => m.name.startsWith("0016_"))!;
    const update = migration.queries.find((q) => /^\s*UPDATE sites SET host_label/.test(q))!;
    await env.DB.prepare(update).run();
    expect(new URL(await appAt(ns, "")).hostname).toMatch(new RegExp(`^${ns}-[a-z2-9]{4}\\.example\\.app$`));
    expect(new URL(await appAt(ns, "tools/budget")).hostname).toMatch(/^tools-budget-[a-z2-9]{4}\.example\.app$/);
    // ...and the app opens there.
    expect(await (await call(`${await appAt(ns, "tools/budget")}/`, { as: OWNER })).text()).toContain(">b<");
  });
});
