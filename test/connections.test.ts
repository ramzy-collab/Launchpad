import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accounts, appAt, call, OWNER, PAGE, publishHtml, uniq } from "./helpers";

const SHEET = "1AbcDefGhiJklMnoPqrStuVwxYz0123456789abcdEFG";
const setConnectedApps = (state: "on" | "off") =>
  env.DB.prepare("INSERT OR REPLACE INTO feature_flags (name, state, updated_at, updated_by) VALUES ('connected_apps', ?, 0, 'test')").bind(state).run();

async function newApp(title = "Inbox") {
  const ns = uniq();
  const { site } = await (await publishHtml(OWNER, ns, "app", PAGE("x"), { title })).json<{ site: { id: string } }>();
  const origin = await appAt(ns, "app");
  const settings = async (as = OWNER) => (await call(`/app/apps/${site.id}`, { as })).text();
  const keys = (name: string, method: string, json?: unknown, as = OWNER) => call(`/_api/admin/sites/${site.id}/keys/${name}`, { as, method, ...(json ? { json } : {}) });
  const saveSecret = (name: string, value: string, hosts: string[]) => call(`${origin}/_api/secrets/${name}`, { as: OWNER, mount: "/", method: "PUT", json: { value, hosts } });
  return { ns, site, origin, settings, keys, saveSecret };
}

describe("the Connected apps tab, with the feature off", () => {
  it("isn't shown, and its key actions answer 404", async () => {
    await setConnectedApps("off");
    const { settings, keys, saveSecret } = await newApp();
    await saveSecret("quo", "k1", ["api.quo.com"]);
    const html = await settings();
    expect(html).not.toContain('id="tab-connected"');
    expect(html).not.toContain('href="/connected"');
    expect((await keys("quo", "DELETE")).status).toBe(404);
  });
});

describe("the Connected apps tab", () => {
  beforeAll(() => setConnectedApps("on"));
  afterAll(() => setConnectedApps("off"));

  it("shows nothing connected for a new app, with a way to the Connected apps page", async () => {
    const html = await (await newApp()).settings();
    expect(html).toContain('id="tab-connected"');
    expect(html).toContain('<span class="tab-badge" data-conn-count>0</span>');
    expect(html).toContain("Nothing connected yet.");
    expect(html).toContain('<div class="conn-empty" data-conn-empty>');
    expect(html).toContain('<a href="/connected">Connected apps</a>'); // the menu links Connected apps again
  });

  it("lists Gemini once the app used it, its spreadsheets and its saved keys", async () => {
    const { site, settings, saveSecret } = await newApp();
    expect((await saveSecret("quo", "k1", ["api.quo.com"])).status).toBe(200);
    expect((await call(`/_api/admin/sites/${site.id}`, { as: OWNER, method: "PATCH", json: { sheets: [`https://docs.google.com/spreadsheets/d/${SHEET}/edit`] } })).status).toBe(200);
    await env.DB.prepare("INSERT INTO audit (at, actor, action, target, detail, site_id) VALUES (?, ?, 'gemini', 'x', '{\"status\":200}', ?)").bind(Date.now(), OWNER, site.id).run();
    const html = await settings();
    expect(html).toContain('<span class="tab-badge" data-conn-count>3</span>');
    expect(html).toContain('data-conn="gemini"');
    expect(html).toContain("Last used just now.");
    expect(html).toContain(`<li class="sheet-item" data-sheet="${SHEET}">`);
    expect(html).toContain(`https://docs.google.com/spreadsheets/d/${SHEET}`);
    expect(html).toContain("+ Add a spreadsheet");
    expect(html).toContain('data-key="quo"');
    expect(html).toContain("Only ever sent to api.quo.com, never shown in the app or to people you share it with.");
    expect(html).not.toContain("k1");
    expect(html).toContain("data-key-replace");
  });

  it("replaces a key for the same hosts, and removes one", async () => {
    const { site, keys, saveSecret } = await newApp();
    await saveSecret("quo", "old-key", ["api.quo.com"]);
    const before = await env.DB.prepare("SELECT ciphertext, hosts FROM secrets WHERE site_id = ? AND name = 'quo'").bind(site.id).first<{ ciphertext: string; hosts: string }>();
    const replaced = await keys("quo", "PUT", { value: "new-key" });
    expect(replaced.status).toBe(200);
    expect(await replaced.json()).toMatchObject({ name: "quo", hosts: ["api.quo.com"] });
    const after = await env.DB.prepare("SELECT ciphertext, hosts FROM secrets WHERE site_id = ? AND name = 'quo'").bind(site.id).first<{ ciphertext: string; hosts: string }>();
    expect(after!.ciphertext).not.toBe(before!.ciphertext);
    expect(after!.hosts).toBe(before!.hosts);
    expect((await keys("quo", "PUT", { value: " " })).status).toBe(400);
    expect((await keys("missing", "PUT", { value: "x" })).status).toBe(404);
    expect((await keys("quo", "DELETE")).status).toBe(200);
    expect((await keys("quo", "DELETE")).status).toBe(404);
    const log = await (await call(`/app/apps/${site.id}/activity`, { as: OWNER })).text();
    expect(log).toContain("Removed the secret quo");
  });

  it("lets only the people who manage the app change its keys", async () => {
    const viewer = `v-${uniq()}@example.com`;
    await accounts(viewer);
    const { site, keys, saveSecret } = await newApp();
    await saveSecret("quo", "k1", ["api.quo.com"]);
    await call(`/_api/admin/sites/${site.id}`, { as: OWNER, method: "PATCH", json: { allowed_emails: [viewer] } });
    // Viewers can open the app but not manage it: refused, like its other settings.
    expect((await keys("quo", "PUT", { value: "x" }, viewer)).status).toBe(403);
    expect((await keys("quo", "DELETE", undefined, viewer)).status).toBe(403);
  });

  it("says which apps use each service on the Connected apps page", async () => {
    const used = await newApp(`Used ${uniq()}`);
    await used.saveSecret("stripe", "k", ["api.stripe.com"]);
    await call(`/_api/admin/sites/${used.site.id}`, { as: OWNER, method: "PATCH", json: { sheets: [SHEET] } });
    const page = await (await call("/app/connected", { as: OWNER })).text();
    expect(page).toContain("Where they're used");
    const sheetsRow = page.slice(page.indexOf("<strong>Google Sheets</strong>"), page.indexOf("</li>", page.indexOf("<strong>Google Sheets</strong>")));
    expect(sheetsRow).toContain(`<a href="/apps/${used.site.id}">`);
    expect(page).toContain("<strong>stripe <span class=\"chip ok\">Key saved</span></strong>");
  });
});
