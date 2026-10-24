import { env } from "cloudflare:workers";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { accounts, appAt, call, onOutbound, OWNER, PAGE, publishHtml, uniq } from "./helpers";

const setConnectedApps = (state: "on" | "off") =>
  env.DB.prepare("INSERT OR REPLACE INTO feature_flags (name, state, updated_at, updated_by) VALUES ('connected_apps', ?, 0, 'test')").bind(state).run();

const KEY = "sk_live_connector_key_9xT2";
const make = (json: Record<string, unknown>, as = OWNER) => call("/_api/admin/connectors", { as, method: "POST", json });
const patchSite = (id: string, json: unknown, as = OWNER) => call(`/_api/admin/sites/${id}`, { as, method: "PATCH", json });

async function newApp(as = OWNER, extra: Record<string, string> = {}) {
  const ns = uniq();
  const res = await publishHtml(as, ns, "app", PAGE("x"), { title: `App ${ns}`, ...extra });
  const { site } = await res.json<{ site: { id: string } }>();
  const origin = await appAt(ns, "app");
  const api = (path: string, init: { as?: string; method?: string; json?: unknown } = {}) => call(`${origin}/_api/${path}`, { as: init.as ?? as, mount: "/", method: init.method ?? "GET", ...(init.json !== undefined ? { json: init.json } : {}) });
  return { ns, site, api };
}

/** Records what reached the service, and echoes the request back like httpbin does. */
function echo() {
  const seen: Request[] = [];
  onOutbound(async (req) => {
    seen.push(req.clone());
    return Response.json({ url: req.url, auth: req.headers.get("authorization"), key: req.headers.get("x-api-key") });
  });
  return seen;
}

describe("custom connectors, with the feature off", () => {
  it("aren't there: the API and the pages answer 404", async () => {
    await setConnectedApps("off");
    expect((await make({ label: "Quo", key: KEY, hosts: "api.quo.test" })).status).toBe(404);
    expect((await call("/app/connected/new", { as: OWNER })).status).toBe(404);
  });
});

describe("custom connectors", () => {
  beforeAll(() => setConnectedApps("on"));
  afterAll(() => setConnectedApps("off"));
  afterEach(() => onOutbound(undefined));

  it("are made with a name, a key, the hosts it may go to and how it's sent; the key is never shown", async () => {
    const me = `c-${uniq()}@example.com`;
    await accounts(me);
    expect((await make({ key: KEY, hosts: "api.quo.test" }, me)).status).toBe(400); // no name
    expect((await make({ label: "Quo", hosts: "api.quo.test" }, me)).status).toBe(400); // no key
    expect((await make({ label: "Quo", key: KEY, hosts: "localhost" }, me)).status).toBe(400);
    expect((await make({ label: "Quo", key: KEY, hosts: "api.quo.test", auth: "header" }, me)).status).toBe(400); // which header?
    expect((await make({ label: "Gemini", key: KEY, hosts: "api.quo.test" }, me)).status).toBe(400); // taken by Formelab

    const res = await make({ label: "Quo SMS", description: "Texts", key: KEY, hosts: "api.quo.test, *.quo.test" }, me);
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain(KEY);
    expect(JSON.parse(text)).toMatchObject({ name: "quo-sms", label: "Quo SMS", hint: "9xT2", hosts: ["*.quo.test", "api.quo.test"], auth: "bearer" });
    expect((await make({ label: "Quo SMS", key: KEY, hosts: "api.quo.test" }, me)).status).toBe(409);
    const row = await env.DB.prepare("SELECT * FROM connectors WHERE owner_email = ?").bind(me).first();
    expect(JSON.stringify(row)).not.toContain(KEY);

    const list = await (await call("/app/connected", { as: me })).text();
    expect(list).toContain('href="/connected/quo-sms"');
    expect(list).toContain("Not used yet");
    const page = await (await call("/app/connected/quo-sms", { as: me })).text();
    expect(page).toContain("Quo SMS");
    expect(page).toContain("ending in <code>…9xT2</code>");
    expect(page).not.toContain(KEY);
    expect(page).toContain("No app uses Quo SMS yet.");
    // Each person only ever sees their own.
    expect((await call("/app/connected/quo-sms", { as: OWNER })).status).toBe(404);
    expect((await call("/_api/admin/connectors/quo-sms", { as: OWNER, method: "DELETE" })).status).toBe(404);
  });

  it("are only used by apps built to use them, and only their owner can add one to an app", async () => {
    const seen = echo();
    const editor = `ce-${uniq()}@example.com`;
    const { site, api } = await newApp(OWNER, { editors: editor });
    const name = `quo${uniq().slice(-6)}`;
    expect((await make({ label: name, name, key: KEY, hosts: "api.quo.test" })).status).toBe(201);

    // Not in the app yet: refused, though its owner has the connector.
    const refused = await api(`connectors/${name}/fetch`, { method: "POST", json: { url: "/v1/messages" } });
    expect(refused.status).toBe(403);
    expect((await refused.json<{ error: { code: string } }>()).error.code).toBe("connector_not_in_app");
    expect((await patchSite(site.id, { connectors: [name] }, editor)).status).toBe(403);
    expect((await patchSite(site.id, { connectors: ["nope"] })).status).toBe(400);
    expect((await patchSite(site.id, { connectors: [name] })).status).toBe(200);
    expect(await (await api("connectors")).json()).toEqual([name]);

    const ok = await api(`connectors/${name}/fetch`, { method: "POST", json: { url: "/v1/messages", method: "POST", body: "{}" } });
    expect(ok.status).toBe(200);
    const out = await ok.json<{ status: number; text: string }>();
    expect(out.status).toBe(200);
    expect(out.text).not.toContain(KEY); // echoed back, and scrubbed
    expect(JSON.parse(out.text).url).toBe("https://api.quo.test/v1/messages");
    expect(seen.at(-1)!.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect((await api(`connectors/${name}/fetch`, { method: "POST", json: { url: "https://evil.test/" } })).status).toBe(403);

    // The app's activity names the connector; the Connected apps tab lists it.
    const log = await (await call(`/app/apps/${site.id}/activity`, { as: OWNER })).text();
    expect(log).toContain(`Called api.quo.test with the connector ${name} (HTTP 200)`);
    const tab = await (await call(`/app/apps/${site.id}`, { as: OWNER })).text();
    expect(tab).toContain(`data-conn="${name}"`);
    expect(tab).toContain(`href="/connected/${name}"`);
    expect(tab).toContain(`data-conn-remove="${name}"`);
    const asEditor = await (await call(`/app/apps/${site.id}`, { as: editor })).text();
    expect(asEditor).toContain(`data-conn="${name}"`);
    expect(asEditor).not.toContain("data-conn-remove");
    const page = await (await call(`/app/connected/${name}`, { as: OWNER })).text();
    expect(page).toContain(`<a href="/apps/${site.id}">`);
    expect(page).toContain("1 request");
  });

  it("send the key in its own header or query parameter, or where the app puts {{value}}", async () => {
    const seen = echo();
    const { site, api } = await newApp();
    const h = `h${uniq().slice(-6)}`;
    const q = `q${uniq().slice(-6)}`;
    const p = `p${uniq().slice(-6)}`;
    expect((await make({ label: h, key: KEY, hosts: "api.h.test", auth: "header", authName: "X-API-Key" })).status).toBe(201);
    expect((await make({ label: q, key: KEY, hosts: "api.q.test", auth: "query", authName: "api_key" })).status).toBe(201);
    expect((await make({ label: p, key: KEY, hosts: "api.p.test", auth: "placeholder" })).status).toBe(201);
    expect((await patchSite(site.id, { connectors: [h, q, p] })).status).toBe(200);
    await api(`connectors/${h}/fetch`, { method: "POST", json: { url: "/x" } });
    expect(seen.at(-1)!.headers.get("x-api-key")).toBe(KEY);
    await api(`connectors/${q}/fetch`, { method: "POST", json: { url: "https://api.q.test/x?a=1" } });
    expect(new URL(seen.at(-1)!.url).searchParams.get("api_key")).toBe(KEY);
    // The app's old proxy calls reach a connector by name too.
    await api(`secrets/${p}/proxy`, { method: "POST", json: { url: "https://api.p.test/x", headers: { Authorization: "Token {{value}}" } } });
    expect(seen.at(-1)!.headers.get("authorization")).toBe(`Token ${KEY}`);
    expect(await (await api("secrets")).json()).toEqual([h, p, q].sort());
    // Its key is the owner's, so the app can't save its own over it.
    expect((await api(`secrets/${p}`, { method: "PUT", json: { value: "x", hosts: ["api.p.test"] } })).status).toBe(409);
  });

  it("are changed and deleted by their owner; deleting takes them off the apps that used them", async () => {
    const seen = echo();
    const { site, api } = await newApp();
    const name = `d${uniq().slice(-6)}`;
    await make({ label: name, key: KEY, hosts: "api.d.test" });
    await patchSite(site.id, { connectors: [name] });
    const edit = (json: unknown) => call(`/_api/admin/connectors/${name}`, { as: OWNER, method: "PATCH", json });
    expect((await edit({ hosts: "" })).status).toBe(400);
    expect((await edit({ label: "Dee", hosts: "api.d.test, api2.d.test" })).status).toBe(200);
    expect((await edit({ key: "new-key-0000" })).status).toBe(200);
    await api(`connectors/${name}/fetch`, { method: "POST", json: { url: "https://api2.d.test/" } });
    expect(seen.at(-1)!.headers.get("authorization")).toBe("Bearer new-key-0000");
    const page = await (await call(`/app/connected/${name}`, { as: OWNER })).text();
    expect(page).toContain("You replaced the key");

    const del = await call(`/_api/admin/connectors/${name}`, { as: OWNER, method: "DELETE" });
    expect(await del.json()).toEqual({ ok: true, apps: 1 });
    const row = await env.DB.prepare("SELECT connectors FROM sites WHERE id = ?").bind(site.id).first<{ connectors: string }>();
    expect(JSON.parse(row!.connectors)).toEqual([]);
    expect((await api(`connectors/${name}/fetch`, { method: "POST", json: { url: "/" } })).status).toBe(403);
  });

  it("come off one app from its Connected apps tab, by the app's owner only", async () => {
    const editor = `cr-${uniq()}@example.com`;
    const { site } = await newApp(OWNER, { editors: editor });
    await patchSite(site.id, { connectors: ["gemini"] });
    const remove = (as: string) => call(`/_api/admin/sites/${site.id}/connectors/gemini`, { as, method: "DELETE" });
    expect((await remove(editor)).status).toBe(403);
    expect((await remove(OWNER)).status).toBe(200);
    expect((await remove(OWNER)).status).toBe(404);
    const log = await (await call(`/app/apps/${site.id}/activity`, { as: OWNER })).text();
    expect(log).toContain("Stopped it using gemini");
  });

  it("take over saved keys: apps with the same key share one connector and keep working", async () => {
    const seen = echo();
    const me = `cm-${uniq()}@example.com`;
    await accounts(me);
    const [a, b, c] = [await newApp(me), await newApp(me), await newApp(me)];
    const save = (app: typeof a, value: string) => app.api("secrets/quo", { method: "PUT", json: { value, hosts: ["api.quo.test"] } });
    expect((await save(a, "shared-key-1")).status).toBe(200);
    expect((await save(b, "shared-key-1")).status).toBe(200);
    expect((await save(c, "other-key-22")).status).toBe(200);

    const plan = await (await call("/_api/admin/connectors/saved-keys", { as: me })).json<{ moves: { name: string; apps: unknown[] }[]; kept: { name: string }[] }>();
    expect(plan.moves).toEqual([expect.objectContaining({ name: "quo", apps: expect.arrayContaining([expect.objectContaining({ id: a.site.id }), expect.objectContaining({ id: b.site.id })]) })]);
    expect(plan.kept).toEqual([expect.objectContaining({ name: "quo" })]);
    expect(await (await call("/app/connected", { as: me })).text()).toContain("Turn your saved keys into connectors");

    expect((await call("/_api/admin/connectors/saved-keys", { as: me, method: "POST" })).status).toBe(200);
    const left = await env.DB.prepare("SELECT site_id FROM secrets WHERE name = 'quo' AND site_id IN (?, ?, ?)").bind(a.site.id, b.site.id, c.site.id).all<{ site_id: string }>();
    expect(left.results.map((r) => r.site_id)).toEqual([c.site.id]);
    // Same code as before: the connector puts the key where {{value}} is.
    for (const app of [a, b]) {
      await app.api("secrets/quo/proxy", { method: "POST", json: { url: "https://api.quo.test/", headers: { Authorization: "Bearer {{value}}" } } });
      expect(seen.at(-1)!.headers.get("authorization")).toBe("Bearer shared-key-1");
    }
    await c.api("secrets/quo/proxy", { method: "POST", json: { url: "https://api.quo.test/", headers: { Authorization: "Bearer {{value}}" } } });
    expect(seen.at(-1)!.headers.get("authorization")).toBe("Bearer other-key-22");
    const page = await (await call("/app/connected/quo", { as: me })).text();
    expect(page).toContain("You turned the saved keys of 2 apps into this connector");
    expect(page).not.toContain("shared-key-1");
  });
});
