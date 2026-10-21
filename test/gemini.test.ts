import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { call, onOutbound, OWNER, PAGE, publishHtml, uniq, appAt } from "./helpers";

const GOOD = "AIzaSyTESTKEY0123456789abcdefGHIJ";
type Seen = { url: string; key: string | null; body: string };
const seen: Seen[] = [];

/** A stand-in for Google's Gemini API that accepts only GOOD. */
function mockGoogle(answer = "Hello from Gemini") {
  seen.length = 0;
  onOutbound(async (req) => {
    const raw = req.method === "POST" ? await req.text() : "";
    seen.push({ url: req.url, key: req.headers.get("x-goog-api-key"), body: raw });
    const url = new URL(req.url);
    if (url.hostname !== "generativelanguage.googleapis.com") return new Response("unexpected", { status: 599 });
    if (req.headers.get("x-goog-api-key") !== GOOD) return Response.json({ error: { message: "API key not valid." } }, { status: 400 });
    if (req.method === "GET") return Response.json({ name: "models/gemini-3.5-flash-lite" });
    const body = JSON.parse(raw) as unknown;
    return Response.json({
      candidates: [{ content: { parts: [{ text: answer }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 4, totalTokenCount: 9 },
      echo: body,
    });
  });
}
afterEach(() => onOutbound(undefined));
const setFlag = (state: string, as = OWNER) => call("/_api/admin/features/connected_apps", { as, method: "PUT", json: { state } });

const connect = (as: string, apiKey: string) => call("/_api/admin/services/gemini", { as, method: "PUT", json: { apiKey } });
const ask = async (as: string, ns: string, mount: string, json: unknown) => call(`${await appAt(ns, mount)}/_api/ai/gemini`, { as, mount: "/", method: "POST", json });

describe("Google Gemini as a connected app", () => {
  beforeEach(async () => {
    expect((await setFlag("on")).status).toBe(200);
  });

  it("checks the key with Google, stores it encrypted, and shows only its last four characters", async () => {
    mockGoogle();
    const me = `g-${uniq()}@example.com`;
    await call("/_api/admin/whoami", { as: me });
    const bad = await connect(me, "AIzaSyWRONGKEY0123456789abcdefXXXX");
    expect(bad.status).toBe(400);
    expect((await bad.json<{ error: { message: string } }>()).error.message).toContain("Google didn't accept this key");
    expect((await connect(me, "nope")).status).toBe(400);
    // Newer keys look like "AQ.<...>": they pass the format check and go to Google.
    const before = seen.length;
    expect((await connect(me, "AQ.Ab8RFAKEFAKEFAKEFAKEFAKEFAKE_fake-key0123")).status).toBe(400);
    expect(seen.length).toBe(before + 1);
    expect((await (await connect(me, "AQ.Ab8RFAKEFAKEFAKEFAKEFAKEFAKE_fake-key0123")).json<{ error: { message: string } }>()).error.message).toContain("Google didn't accept");

    const ok = await connect(me, GOOD);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ connected: true, hint: "GHIJ" });
    expect(seen.at(-1)!.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite");
    const row = await env.DB.prepare("SELECT * FROM service_keys WHERE owner_email = ?").bind(me).first();
    expect(JSON.stringify(row)).not.toContain(GOOD);

    const page = await (await call("/app/connected", { as: me })).text();
    expect(page).toContain("Connected</span>");
    expect(page).toContain("the key ending in GHIJ");
    expect(page).not.toContain(GOOD);
  });

  it("lets the owner's apps (and people they share them with) use it, without the key reaching the browser", async () => {
    mockGoogle("A short summary.");
    const ns = uniq();
    const friend = `gf-${uniq()}@example.com`;
    await publishHtml(OWNER, ns, "ai", PAGE("x"), { allowed_emails: friend });
    expect((await connect(OWNER, GOOD)).status).toBe(200);

    expect(await (await call(`${await appAt(ns, "ai")}/_api/ai/gemini`, { as: OWNER, mount: "/" })).json()).toEqual({ connected: true, available: true, model: "gemini-3.5-flash-lite" });
    const res = await ask(OWNER, ns, "ai", { prompt: "Summarize: lots of text", system: "Be brief.", schema: { type: "string" }, maxOutputTokens: 50 });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(GOOD);
    expect(JSON.parse(text)).toMatchObject({ text: "A short summary.", model: "gemini-3.5-flash-lite", usage: { totalTokens: 9 } });
    const sent = seen.at(-1)!;
    expect(sent.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent");
    expect(sent.key).toBe(GOOD);
    expect(JSON.parse(sent.body)).toEqual({
      contents: [{ role: "user", parts: [{ text: "Summarize: lots of text" }] }],
      systemInstruction: { parts: [{ text: "Be brief." }] },
      generationConfig: { maxOutputTokens: 50, responseMimeType: "application/json", responseJsonSchema: { type: "string" } },
    });

    // Someone the app is shared with uses the owner's key; strangers can't reach the app at all.
    expect((await ask(friend, ns, "ai", { prompt: "hi" })).status).toBe(200);
    expect((await ask(`stranger-${uniq()}@example.com`, ns, "ai", { prompt: "hi" })).status).toBe(403);

    // Each call is in the app's activity log.
    const site = await env.DB.prepare("SELECT id FROM sites WHERE namespace = ?").bind(ns).first<{ id: string }>();
    const log = await (await call(`/app/apps/${site!.id}/activity`, { as: OWNER })).text();
    expect(log).toContain("Asked Gemini (9 tokens)");
  });

  it("limits each person using someone else's apps, and the owner's apps together each day", async () => {
    mockGoogle();
    const owner = `gl-${uniq()}@example.com`;
    const [a, b] = [`gla-${uniq()}@example.com`, `glb-${uniq()}@example.com`];
    const ns = uniq();
    await publishHtml(owner, ns, "one", PAGE("x"), { allowed_emails: `${a}, ${b}` });
    await publishHtml(owner, ns, "two", PAGE("x"), { allowed_emails: `${a}, ${b}` });
    expect((await connect(owner, GOOD)).status).toBe(200);
    const error = async (res: Response) => (await res.json<{ error: { code: string; message: string } }>()).error;

    // 20 a minute for each person, across all the owner's apps.
    for (let i = 0; i < 20; i++) expect((await ask(a, ns, i % 2 ? "one" : "two", { prompt: "hi" })).status).toBe(200);
    const limited = await ask(a, ns, "two", { prompt: "hi" });
    expect(limited.status).toBe(429);
    expect((await error(limited)).message).toContain("through this person's apps more than 20 times in a minute");
    expect((await ask(b, ns, "one", { prompt: "hi" })).status).toBe(200);
    expect((await ask(owner, ns, "one", { prompt: "hi" })).status).toBe(200);

    // 100 a day for each person.
    const day = Math.floor(Date.now() / 86_400_000);
    await env.DB.prepare("UPDATE rate_counters SET count = 100 WHERE bucket = ?").bind(`gemini-viewer:${owner}:${b}:day${day}`).run();
    const daily = await ask(b, ns, "one", { prompt: "hi" });
    expect(daily.status).toBe(429);
    expect((await error(daily)).message).toContain("100 times today");

    // The owner's daily limit, for everyone together, owner included.
    const status = await (await call("/_api/admin/services/gemini", { as: owner })).json<{ dailyLimit: number; usedToday: number }>();
    expect(status.dailyLimit).toBe(1000);
    expect(status.usedToday).toBe(22);
    const set = (dailyLimit: unknown) => call("/_api/admin/services/gemini", { as: owner, method: "PATCH", json: { dailyLimit } });
    expect((await (await set(23)).json<{ dailyLimit: number }>()).dailyLimit).toBe(23);
    expect((await ask(owner, ns, "two", { prompt: "hi" })).status).toBe(200);
    const capped = await ask(owner, ns, "two", { prompt: "hi" });
    expect(capped.status).toBe(429);
    expect((await error(capped)).message).toContain("allows 23 Gemini calls a day");
    for (const bad of [-1, 100_001, 2.5, "many"]) expect((await set(bad)).status, String(bad)).toBe(400);
    expect((await call("/_api/admin/services/gemini", { as: a, method: "PATCH", json: { dailyLimit: 5 } })).status).toBe(409);

    const page = await (await call("/app/connected", { as: owner })).text();
    expect(page).toContain('data-action="gemini-limit"');
    expect(page).toContain('value="23"');
  });

  it("tells the app when its owner hasn't connected Gemini, and after they disconnect", async () => {
    mockGoogle();
    const owner = `gn-${uniq()}@example.com`;
    const ns = uniq();
    expect((await publishHtml(owner, ns, "", PAGE("x"))).status).toBe(201);
    const res = await ask(owner, ns, "", { prompt: "hi" });
    expect(res.status).toBe(409);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe("gemini_not_connected");
    expect((await ask(owner, ns, "", {})).status).toBe(409); // checked before anything else

    expect((await connect(owner, GOOD)).status).toBe(200);
    expect((await ask(owner, ns, "", { prompt: "hi" })).status).toBe(200);
    expect((await ask(owner, ns, "", {})).status).toBe(400); // no prompt
    expect((await call("/_api/admin/services/gemini", { as: owner, method: "DELETE" })).status).toBe(200);
    expect((await ask(owner, ns, "", { prompt: "hi" })).status).toBe(409);
  });
});

describe("the connected_apps feature flag", () => {
  it("is off by default: the page shows no apps, and nothing can use them", async () => {
    mockGoogle();
    expect((await setFlag("off")).status).toBe(200);
    const page = await (await call("/app/connected", { as: OWNER })).text();
    expect(page).toContain("Coming soon");
    expect(page).not.toContain("dlg-gemini-service");
    expect(page).toContain('Connected apps <span class="soon">Soon</span>');
    expect((await connect(OWNER, GOOD)).status).toBe(404);
    const ns = uniq();
    await publishHtml(OWNER, ns, "ai", PAGE("x"));
    expect(await (await call(`${await appAt(ns, "ai")}/_api/ai/gemini`, { as: OWNER, mount: "/" })).json()).toEqual({ connected: false, available: false });
    const r = await ask(OWNER, ns, "ai", { prompt: "hi" });
    expect(r.status).toBe(403);
    expect((await r.json<{ error: { code: string } }>()).error.code).toBe("not_available");
    const guide = await (await call("/_platform/guide.md", { as: OWNER })).text();
    expect(guide).not.toContain("formelab.gemini");
    expect(guide).not.toContain("<!-- flag:");
  });

  it("can be on for admins only, then for everyone; only admins can change it", async () => {
    mockGoogle();
    const person = `ff-${uniq()}@example.com`;
    expect((await setFlag("on", person)).status).toBe(403);
    expect((await setFlag("sideways")).status).toBe(400);
    expect((await call("/_api/admin/features/nope", { as: OWNER, method: "PUT", json: { state: "on" } })).status).toBe(404);

    expect((await setFlag("admins")).status).toBe(200);
    expect(await (await call("/app/connected", { as: OWNER })).text()).toContain("dlg-gemini-service");
    expect(await (await call("/app/connected", { as: person })).text()).not.toContain("dlg-gemini-service");
    expect(await (await call("/_platform/guide.md", { as: OWNER })).text()).toContain("formelab.gemini.generate");
    expect(await (await call("/_platform/guide.md", { as: person })).text()).not.toContain("formelab.gemini");
    // An admin's app works for the people it's shared with (it follows the app's owner).
    expect((await connect(OWNER, GOOD)).status).toBe(200);
    const ns = uniq();
    await publishHtml(OWNER, ns, "ai", PAGE("x"), { allowed_emails: person });
    expect((await ask(person, ns, "ai", { prompt: "hi" })).status).toBe(200);

    expect((await setFlag("on")).status).toBe(200);
    expect(await (await call("/app/connected", { as: person })).text()).toContain("dlg-gemini-service");
    const admin = await (await call("https://admin.example.com/features", { as: OWNER })).text();
    expect(admin).toContain('data-action="feature-set" data-name="connected_apps"');
    expect(admin).toContain('<option value="on" selected>Everyone</option>');
    expect(await (await call("https://admin.example.com/activity", { as: OWNER })).text()).toContain("Set Connected apps to on for everyone");
  });

  it("can be turned on for one person by email, whatever its state", async () => {
    mockGoogle();
    const person = `ff1-${uniq()}@example.com`;
    const other = `ff2-${uniq()}@example.com`;
    const addUser = (email: string, as = OWNER) => call("/_api/admin/features/connected_apps/users", { as, method: "POST", json: { email } });
    const removeUser = (email: string, as = OWNER) => call(`/_api/admin/features/connected_apps/users/${encodeURIComponent(email)}`, { as, method: "DELETE" });
    expect((await setFlag("off")).status).toBe(200);
    expect((await addUser(person, other)).status).toBe(403);
    expect((await addUser("not an email")).status).toBe(400);
    expect((await call("/_api/admin/features/nope/users", { as: OWNER, method: "POST", json: { email: person } })).status).toBe(404);

    expect((await addUser(` ${person.toUpperCase()} `)).status).toBe(200);
    expect(await (await call("/app/connected", { as: person })).text()).toContain("dlg-gemini-service");
    expect(await (await call("/app/connected", { as: other })).text()).not.toContain("dlg-gemini-service");
    expect(await (await call("/_platform/guide.md", { as: person })).text()).toContain("formelab.gemini.generate");
    // Their apps get it too, for whoever opens them.
    expect((await connect(person, GOOD)).status).toBe(200);
    const ns = uniq();
    await publishHtml(person, ns, "ai", PAGE("x"), { allowed_emails: other });
    expect((await ask(other, ns, "ai", { prompt: "hi" })).status).toBe(200);

    const admin = await (await call("https://admin.example.com/features", { as: OWNER })).text();
    expect(admin).toContain(`data-action="feature-user-remove" data-name="connected_apps" data-email="${person}"`);
    expect(await (await call("https://admin.example.com/activity", { as: OWNER })).text()).toContain(`Turned Connected apps on for ${person}`);

    expect((await removeUser(person)).status).toBe(200);
    expect((await removeUser(person)).status).toBe(404);
    expect(await (await call("/app/connected", { as: person })).text()).not.toContain("dlg-gemini-service");
    expect((await ask(other, ns, "ai", { prompt: "hi" })).status).toBe(403);
  });
});
