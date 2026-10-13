import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
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

const connect = (as: string, apiKey: string) => call("/_api/admin/services/gemini", { as, method: "PUT", json: { apiKey } });
const ask = (as: string, ns: string, mount: string, json: unknown) => call(`https://${ns}.example.app/_api/ai/gemini`, { as, mount: mount ? `/${mount}/` : "/", method: "POST", json });

describe("Google Gemini as a connected app", () => {
  it("checks the key with Google, stores it encrypted, and shows only its last four characters", async () => {
    mockGoogle();
    const me = `g-${uniq()}@example.com`;
    await call("/_api/admin/whoami", { as: me });
    const bad = await connect(me, "AIzaSyWRONGKEY0123456789abcdefXXXX");
    expect(bad.status).toBe(400);
    expect((await bad.json<{ error: { message: string } }>()).error.message).toContain("Google didn't accept this key");
    expect((await connect(me, "nope")).status).toBe(400);

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

    expect(await (await call(`https://${ns}.example.app/_api/ai/gemini`, { as: OWNER, mount: "/ai/" })).json()).toEqual({ connected: true, model: "gemini-3.5-flash-lite" });
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
