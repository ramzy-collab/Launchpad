import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ASSET_VERSION } from "../src/generated/assets";
import { call, OWNER, PAGE, publishHtml, uniq } from "./helpers";

describe("dashboard", () => {
  it("renders with a strict CSP and no inline script", async () => {
    const res = await call("/app", { as: OWNER });
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
    const html = await res.text();
    expect(html).toContain(`Signed in as <strong>${OWNER}</strong>`);
    expect(html).toContain(`<script src="/_assets/dashboard.js?v=${ASSET_VERSION}" defer></script>`);
    // Versioned URLs still serve the file, so a deploy reaches browsers right away.
    const versioned = await call(`/_assets/dashboard.js?v=${ASSET_VERSION}`);
    expect(versioned.status).toBe(200);
    expect(versioned.headers.get("cache-control")).toBe("public, max-age=300");
    // Another build's version (mid-deploy) is served but never cached under that address.
    expect((await call("/_assets/home.css?v=0123456789")).headers.get("cache-control")).toBe("no-store");
    expect(ASSET_VERSION).toMatch(/^[0-9a-f]{10}$/);
    expect(html).not.toMatch(/<script>(?!<\/script>)/);
    expect(html).not.toMatch(/\son[a-z]+=/i); // no inline event handlers
    expect(html).toContain('href="/connect"');
    expect((await call("/_assets/dashboard.js")).headers.get("content-type")).toContain("javascript");
    expect((await call("/_assets/formelab.css")).headers.get("content-type")).toContain("text/css");
  });

  it("security 11: escapes user-supplied strings", async () => {
    const ns = uniq();
    const evil = `<script>alert("x")</script><img src=x onerror=alert(1)>`;
    const res = await publishHtml(OWNER, ns, "xss", PAGE("x"), { title: evil });
    expect(res.status).toBe(201);
    await call("/_api/admin/tokens", { as: OWNER, method: "POST", json: { name: `<script>tok()</script>` } });
    const html = (await (await call("/app", { as: OWNER })).text()) + (await (await call("/app/keys", { as: OWNER })).text());
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<script>tok()");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;script&gt;tok()&lt;/script&gt;");
  });

  it("shows apps, spaces and access keys on their own pages, with an activity log per app", async () => {
    const ns = uniq();
    await publishHtml(OWNER, ns, "listed", PAGE("x"), { title: "Listed app" });
    await call("/_api/admin/tokens", { as: OWNER, method: "POST", json: { name: "laptop-token" } });
    const html = await (await call("/app", { as: OWNER })).text();
    expect(html).toContain(`https://${ns}.example.app/listed/`);
    expect(html).toContain(`<a class="tile-link" href="https://${ns}.example.app/listed/" target="_blank" rel="noopener">`); // a tile opens the app in a new tab
    expect(html).toContain("Listed app");
    expect(html).not.toContain("Recent activity");
    expect(html).toMatch(/<a class="gear" href="\/apps\/[^"]+" aria-label="Settings for Listed app"/);
    expect(await (await call("/app/spaces", { as: OWNER })).text()).toContain(`>${ns}</a>`);
    expect(await (await call("/app/keys", { as: OWNER })).text()).toContain("laptop-token");
  });

  it("has a left menu with New app, the app and connect pages, and an account menu", async () => {
    for (const [path, title] of [
      ["/app", "My apps"], ["/app/new", "New app"], ["/app/shared", "Shared with me"], ["/app/spaces", "Spaces"],
      ["/app/connect", "Connect your AI"], ["/app/connected", "Connected apps"], ["/app/keys", "Access keys"],
    ]) {
      const res = await call(path!, { as: OWNER });
      expect(res.status, path).toBe(200);
      const html = await res.text();
      expect(html, path).toContain(`<h1>${title}</h1>`);
      expect(html, path).toContain('<a class="new-app" href="/new"');
      for (const href of ['href="/"', 'href="/shared"', 'href="/spaces"', 'href="/connect"', 'href="/connected"', 'href="/keys"']) expect(html, path).toContain(href);
      expect(html, path).toContain("data-theme-toggle");
      expect(html, path).toContain("Admin panel ↗");
      expect(html, path).toContain('<a class="link" href="/keys"'); // Access keys sit in the account menu
      if (path !== "/app") expect(html, path).not.toMatch(/\son[a-z]+=/i); // My apps holds the escaped XSS titles from the test above
    }
    const soon = await (await call("/app/connected", { as: OWNER })).text();
    expect(soon).toContain("Coming soon"); // connected apps are behind a feature flag, off by default
    expect(soon).toContain('<div class="wall" aria-hidden="true">'); // the wall of service logos
    expect(soon).toMatch(/<use href="\/_assets\/services\.svg\?n=\d+#svc-0"\/>/);
    const sprite = await call("/app/_assets/services.svg");
    expect(sprite.headers.get("content-type")).toContain("image/svg+xml");
    const symbols = (await sprite.text()).match(/<symbol id="svc-\d+"/g)!;
    expect(symbols.length).toBeGreaterThan(120); // lots of different services, not a few repeated
    expect(soon).not.toMatch(/\sstyle="/); // strict CSP: no inline styles
    // New app offers asking your AI first, then the upload form; publishing goes back to My apps.
    const page = await (await call("/app/new", { as: OWNER })).text();
    expect(page.indexOf("What do you want to make?")).toBeGreaterThan(-1);
    expect(page.indexOf("What do you want to make?")).toBeLessThan(page.indexOf('data-action="upload"'));
    for (const make of ["claude", "chatgpt", "copy"]) expect(page).toContain(`data-make="${make}"`);
    expect(page).toContain('href="/connect#claude"'); // not connected yet: a link to set it up
    expect(page).toContain('data-next="/"');
  });

  it("does not show other people's sites or activity", async () => {
    const ns = uniq();
    await publishHtml(OWNER, ns, "mine", PAGE("x"), { title: "Owner only title" });
    const html = await (await call("/app", { as: "someone-else@example.com" })).text();
    expect(html).not.toContain("Owner only title");
    expect(html).not.toContain(ns);
  });

  it("has a Connect your AI page with the connector URL and steps for each app", async () => {
    const res = await call("/app/connect", { as: OWNER });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<a href="/connect" aria-current="page">Connect your AI</a>');
    expect(html).toContain('<pre id="mcp-url-claude">https://example.com/mcp</pre>'); // the connector URL, in each app's dialog
    expect(html).not.toContain("Your connector URL");
    expect(html).not.toContain("If something's off");
    // A tile per AI app, each opening its steps in a dialog; nothing is connected yet.
    for (const id of ["claude", "chatgpt", "gemini", "claude-code"]) {
      expect(html).toContain(`data-dialog="dlg-${id}"`);
      expect(html).toContain(`<dialog id="dlg-${id}"`);
    }
    expect(html).not.toContain("Connected</span>");
    expect(html).toContain("&quot;httpUrl&quot;: &quot;https://example.com/mcp&quot;"); // Gemini CLI settings
    expect(html).toContain("claude mcp add --transport http formelab https://example.com/mcp");
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect((await call("/app/connect")).status).toBe(302); // signed out: to the login screen
  });

  it("serves the guide on the apex and namespace hosts", async () => {
    for (const url of ["https://example.com/_platform/guide.md", `https://${uniq()}.example.app/_platform/guide.md`]) {
      const res = await call(url, { as: OWNER });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/markdown");
      expect(await res.text()).toContain("## 7. Agent checklist");
    }
  });

  it("serves the SDK under 5 KB, defining formelab and archie", async () => {
    const res = await call(`https://${uniq()}.example.app/_platform/sdk.js`, { as: OWNER });
    const js = await res.text();
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(new TextEncoder().encode(js).length).toBeLessThan(5 * 1024);
    expect(js).toContain("window.formelab = formelab");
    expect(js).toContain("window.archie = formelab");
  });
});

describe("app activity logs", () => {
  const activityUrl = async (as: string, ns: string, mount: string) => {
    const site = await env.DB.prepare("SELECT id FROM sites WHERE namespace = ? AND mount_path = ?").bind(ns, mount).first<{ id: string }>();
    return `/app/apps/${site!.id}/activity`;
  };

  it("records each action in the app, in plain words, for the people who manage it", async () => {
    const ns = uniq();
    const editor = `ed-${uniq()}@example.com`;
    const viewer = `vw-${uniq()}@example.com`;
    await publishHtml(OWNER, ns, "log", PAGE("v1"), { title: "Logged app" });
    await publishHtml(OWNER, ns, "log", PAGE("v2"));
    const url = await activityUrl(OWNER, ns, "log");
    const id = url.split("/")[3]!;
    const patch = (json: unknown, as = OWNER) => call(`/_api/admin/sites/${id}`, { as, method: "PATCH", json });
    expect((await patch({ allowed_emails: [viewer], editors: [editor], title: "Logged app" })).status).toBe(200);
    expect((await patch({ visibility: "all", title: "Renamed app" })).status).toBe(200);
    // Saving the settings form unchanged logs nothing.
    expect((await patch({ visibility: "all", title: "Renamed app", allowed_emails: [viewer], editors: [editor] })).status).toBe(200);
    await call(`https://${ns}.example.app/_api/secrets/api-key`, { as: OWNER, mount: "/log/", method: "PUT", json: { hosts: ["api.test"], value: "shh" } });

    const res = await call(url, { as: OWNER });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Activity: Renamed app");
    expect(html).toContain("Published the app (1 file,");
    expect(html).toContain("Published a new version (1 file,");
    expect(html).toContain(`Shared it with ${viewer}; made ${editor} an editor`);
    expect(html).toContain("Set who can open it to all Formelab members; renamed it to &quot;Renamed app&quot;");
    expect(html).toContain("Saved the secret api-key");
    expect(html).not.toContain("shh");
    expect(html.match(/<tr><td class="nowrap">/g)).toHaveLength(5);

    // Editors see it (and get a link under Shared with me); viewers and strangers get a 404.
    expect((await call(url, { as: editor })).status).toBe(200);
    expect(await (await call("/app/shared", { as: editor })).text()).toContain(`<a class="gear" href="/apps/${id}"`);
    expect(await (await call("/app/shared", { as: viewer })).text()).not.toContain(`href="/apps/${id}"`); // viewers get no settings
    expect((await call(url, { as: viewer })).status).toBe(404);
    expect((await call(url, { as: `x-${uniq()}@example.com` })).status).toBe(404);
    expect((await call("/app/apps/nope/activity", { as: OWNER })).status).toBe(404);
  });

  it("keeps Formelab-level activity in the admin panel, for admins only", async () => {
    const email = `act-${uniq()}@example.com`;
    const ns = uniq();
    await call("/_api/admin/waitlist/approve", { as: OWNER, method: "POST", json: { email } });
    await call("/_api/admin/namespaces", { as: OWNER, method: "POST", json: { label: ns } });
    const res = await call("https://admin.example.com/activity", { as: OWNER });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`Invited ${email}`);
    expect(html).toContain(`Created the space ${ns}`);
    expect((await call("https://admin.example.com/activity", { as: `nope-${uniq()}@example.com` })).status).toBe(404);
  });
});

describe("app browser and app settings page", () => {
  it("shows tiles grouped by space by default, and a sortable list", async () => {
    const [a, b] = [uniq(), uniq()];
    await publishHtml(OWNER, a, "one", PAGE("x"), { title: "Alpha tool" });
    await publishHtml(OWNER, a, "two", PAGE("x"), { title: "Beta tool" });
    await publishHtml(OWNER, b, "", PAGE("x"), { title: "Gamma home" });
    const html = await (await call("/app", { as: OWNER })).text();
    expect(html).toContain('<div class="browser" data-browser data-view="tiles">');
    expect(html).toContain('<div class="view-list" hidden>');
    expect(html).toContain(`<div class="group" data-group="${a}">`);
    expect(html).toContain(`<div class="group" data-group="${b}">`);
    const groupA = html.slice(html.indexOf(`data-group="${a}"`), html.indexOf("</div>\n</div>", html.indexOf(`data-group="${a}"`)));
    expect(groupA).toContain("Alpha tool");
    expect(groupA).toContain("Beta tool");
    expect(groupA).not.toContain("Gamma home");
    for (const key of ["name", "space", "vis", "updated", "size"]) expect(html).toContain(`data-sort="${key}"`);
    expect(html).toContain("data-q");
    expect(html).toContain('data-filter="space"');
    expect(html).toContain('data-name="alpha tool"');
  });

  it("has a settings page per app with its details and every edit option", async () => {
    const ns = uniq();
    const editor = `sed-${uniq()}@example.com`;
    await publishHtml(OWNER, ns, "cfg", PAGE("x"), { title: "Configured app", editors: editor });
    const site = await env.DB.prepare("SELECT id FROM sites WHERE namespace = ? AND mount_path = 'cfg'").bind(ns).first<{ id: string }>();
    const res = await call(`/app/apps/${site!.id}`, { as: OWNER });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<h1>Configured app</h1>");
    for (const fact of ["<dt>Space</dt>", "<dt>Path</dt>", "<dt>Owner</dt>", "<dt>Size</dt>", "<dt>Last updated</dt>"]) expect(html).toContain(fact);
    expect(html).toContain('data-action="site-update"');
    expect(html).toContain('name="editors"');
    expect(html).toContain('data-action="site-replace"');
    expect(html).toContain('data-action="site-delete"');
    expect(html).toContain('data-next="/"');
    expect(html).toContain(`href="/apps/${site!.id}/activity"`);
    // Editors can manage it but not change who the editors are; strangers get a 404.
    const asEditor = await (await call(`/app/apps/${site!.id}`, { as: editor })).text();
    expect(asEditor).toContain('data-action="site-update"');
    expect(asEditor).not.toContain('name="editors"');
    expect((await call(`/app/apps/${site!.id}`, { as: `nobody-${uniq()}@example.com` })).status).toBe(404);
  });
});
