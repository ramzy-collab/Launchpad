import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { call, OWNER, PAGE, publishHtml, publishZip, r2Keys, uniq } from "./helpers";

type Published = { url: string; site: { id: string; mountPath: string; fileCount: number } };

describe("publish and serve", () => {
  it("publishes a single HTML file and serves it with <base> injected", async () => {
    const ns = uniq();
    const res = await publishHtml(OWNER, ns, "hello", PAGE("<p>hi</p>"), { title: "Hello" });
    expect(res.status).toBe(201);
    const body = await res.json<Published>();
    expect(body.url).toBe(`https://${ns}.example.com/hello/`);

    const page = await call(body.url, { as: OWNER });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("cache-control")).toBe("no-cache");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    const html = await page.text();
    expect(html).toContain('<head><base href="/hello/"><title>');
    expect(html).toContain("<p>hi</p>");
    // The SDK is never injected automatically.
    expect(html).not.toContain("sdk.js");
  });

  it("injects <base href='/'> for root mounts and synthesizes <head> when missing", async () => {
    const ns = uniq();
    await publishHtml(OWNER, ns, "", "<!doctype html><html><body>bare</body></html>");
    const html = await (await call(`https://${ns}.example.com/`, { as: OWNER })).text();
    expect(html).toBe('<!doctype html><html><head><base href="/"></head><body>bare</body></html>');
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
    const base = `https://${ns}.example.com/docs`;

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

  it("redirects a mount path without its trailing slash", async () => {
    const ns = uniq();
    await publishHtml(OWNER, ns, "tools/budget", PAGE("b"));
    const res = await call(`https://${ns}.example.com/tools/budget?x=1`, { as: OWNER });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/tools/budget/?x=1");
  });

  it("resolves the longest matching mount path", async () => {
    const ns = uniq();
    await publishHtml(OWNER, ns, "", PAGE("root"));
    await publishHtml(OWNER, ns, "a", PAGE("a"));
    await publishHtml(OWNER, ns, "a/b", PAGE("ab"));
    const get = async (p: string) => (await call(`https://${ns}.example.com${p}`, { as: OWNER })).text();
    expect(await get("/")).toContain(">root<");
    expect(await get("/a/")).toContain(">a<");
    expect(await get("/a/b/")).toContain(">ab<");
    expect(await get("/ab/")).toContain("Not found"); // "ab" is not under "a"; root has no ab/
    expect(await get("/a/bc")).toContain("Not found");
  });

  it("SPA mode serves index.html for unknown extensionless paths only", async () => {
    const ns = uniq();
    await publishHtml(OWNER, ns, "app", PAGE("spa"), { spa: "true" });
    const deep = await call(`https://${ns}.example.com/app/users/42`, { as: OWNER });
    expect(deep.status).toBe(200);
    expect(await deep.text()).toContain("spa");
    expect((await call(`https://${ns}.example.com/app/logo.png`, { as: OWNER })).status).toBe(404);
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
    expect(await (await call(`https://${ns}.example.com/r/`, { as: OWNER })).text()).toContain("v1");

    const second = await publishHtml(OWNER, ns, "r", PAGE("v2"));
    expect(second.status).toBe(200);
    const body = await second.json<Published & { replaced: boolean }>();
    expect(body.replaced).toBe(true);
    expect(body.site.id).toBe(id);
    expect(await (await call(`https://${ns}.example.com/r/`, { as: OWNER })).text()).toContain("v2");
    const v2 = (await env.DB.prepare("SELECT current_version FROM sites WHERE id = ?").bind(id).first<{ current_version: string }>())!.current_version;
    expect(v2 > v1).toBe(true); // time-sortable
    expect(await env.DB.prepare("SELECT value FROM kv WHERE site_id = ?").bind(id).first()).toEqual({ value: "1" });
    // The old version's files are removed in the background.
    await new Promise((r) => setTimeout(r, 50));
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

  it("supports the JSON publish body and PATCH settings", async () => {
    const ns = uniq();
    const res = await call("/_api/admin/sites", { as: OWNER, method: "POST", json: { html: PAGE("json"), namespace: ns, mount_path: "j", title: "J" } });
    expect(res.status).toBe(201);
    const { site } = await res.json<Published>();
    const patched = await call(`/_api/admin/sites/${site.id}`, { as: OWNER, method: "PATCH", json: { title: "New", hidden: true, spa: true } });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ title: "New", hidden: true, spa: true, visibility: "all" });
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
    const url = `https://${ns}.example.com/secret/`;

    const denied = await call(url, { as: "stranger@example.com" });
    expect(denied.status).toBe(403);
    expect(await denied.text()).not.toContain("private");
    expect((await call(url + "index.html", { as: "stranger@example.com" })).status).toBe(403);
    for (const path of ["me", "kv", "kv/x", "secrets"]) {
      const r = await call(`https://${ns}.example.com/_api/${path}`, { as: "stranger@example.com", mount: "/secret/" });
      expect(r.status, path).toBe(403);
    }
    const proxy = await call(`https://${ns}.example.com/_api/secrets/x/proxy`, { as: "stranger@example.com", mount: "/secret/", method: "POST", json: { url: "https://api.test/" } });
    expect(proxy.status).toBe(403);
    const put = await call(`https://${ns}.example.com/_api/kv/x`, { as: "stranger@example.com", mount: "/secret/", method: "PUT", body: "1" });
    expect(put.status).toBe(403);

    for (const who of [OWNER, "friend@example.com"]) {
      expect((await call(url, { as: who })).status, who).toBe(200);
      expect((await call(`https://${ns}.example.com/_api/me`, { as: who, mount: "/secret/" })).status, who).toBe(200);
    }
  });

  it("also admits site editors and namespace editors", async () => {
    const ns = uniq();
    await publishHtml(OWNER, ns, "", PAGE("private"), { visibility: "restricted", editors: "siteed@example.com" });
    await call(`/_api/admin/namespaces/${ns}`, { as: OWNER, method: "PATCH", json: { editors: "nsed@example.com" } });
    for (const who of ["siteed@example.com", "nsed@example.com"]) {
      expect((await call(`https://${ns}.example.com/`, { as: who })).status, who).toBe(200);
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
    await call(`https://${ns}.example.com/_api/kv/k`, { as: OWNER, mount: "/gone/", method: "PUT", body: '"v"' });
    await call(`https://${ns}.example.com/_api/secrets/s`, { as: OWNER, mount: "/gone/", method: "PUT", json: { value: "shh-secret" } });
    expect((await r2Keys(`sites/${site.id}/`)).length).toBe(3);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM kv WHERE site_id = ?").bind(site.id).first<{ n: number }>())!.n).toBe(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM secrets WHERE site_id = ?").bind(site.id).first<{ n: number }>())!.n).toBe(1);

    expect((await call(`/_api/admin/sites/${site.id}`, { as: "stranger@example.com", method: "DELETE" })).status).toBe(403);
    const del = await call(`/_api/admin/sites/${site.id}`, { as: OWNER, method: "DELETE" });
    expect(del.status).toBe(200);

    expect(await r2Keys(`sites/${site.id}/`)).toEqual([]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM kv WHERE site_id = ?").bind(site.id).first<{ n: number }>())!.n).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM secrets WHERE site_id = ?").bind(site.id).first<{ n: number }>())!.n).toBe(0);
    expect(await env.DB.prepare("SELECT id FROM sites WHERE id = ?").bind(site.id).first()).toBeNull();
    expect((await call(`https://${ns}.example.com/gone/`, { as: OWNER })).status).toBe(404);
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
