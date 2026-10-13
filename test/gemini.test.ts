import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { call, onOutbound, OWNER, PAGE, publishHtml, uniq } from "./helpers";

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
const ask = (as: string, ns: string, mount: string, json: unknown) => call(`https://${ns}.example.app/_api/ai/gemini`, { as, mount: mount ? `/${mount}/` : "/", method: "POST", json });

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

    expect(await (await call(`https://${ns}.example.app/_api/ai/gemini`, { as: OWNER, mount: "/ai/" })).json()).toEqual({ connected: true, available: true, model: "gemini-3.5-flash-lite" });
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
    expect(await (await call(`https://${ns}.example.app/_api/ai/gemini`, { as: OWNER, mount: "/ai/" })).json()).toEqual({ connected: false, available: false });
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
});
