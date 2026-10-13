import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { extractHtml, slugify, titleOf } from "../src/builder";
import { call, onOutbound, uniq } from "./helpers";

const CLAUDE_KEY = "sk-ant-api03-TESTKEY0123456789abcdefWXYZ";
const OPENAI_KEY = "sk-proj-TESTKEY0123456789abcdefOPEN";
const APP_HTML = `<!doctype html><html><head><title>Lunch Sign-up</title><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"></head><body><h1>Lunch</h1></body></html>`;

type Seen = { url: string; method: string; headers: Headers; body: string };
const seen: Seen[] = [];

const sse = (events: [string, unknown][]) =>
  new Response(events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });

/** Claude's streaming Messages API, answering in two text chunks. */
function claudeStream(text: string, stop = "end_turn") {
  const half = Math.floor(text.length / 2);
  return sse([
    ["message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(0, half) } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(half) } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 50 } }],
    ["message_stop", { type: "message_stop" }],
  ]);
}

function mockAi(opts: { claudeText?: string; claudeStop?: string; openaiText?: string } = {}) {
  seen.length = 0;
  onOutbound(async (req) => {
    const body = req.method === "POST" ? await req.text() : "";
    seen.push({ url: req.url, method: req.method, headers: req.headers, body });
    const url = new URL(req.url);
    if (url.hostname === "api.anthropic.com") {
      if (req.headers.get("x-api-key") !== CLAUDE_KEY) return Response.json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, { status: 401 });
      if (req.method === "GET") return Response.json({ id: "claude-opus-5-5", type: "model", display_name: "Claude Opus 5.5", created_at: "2026-01-01T00:00:00Z" });
      return claudeStream(opts.claudeText ?? APP_HTML, opts.claudeStop);
    }
    if (url.hostname === "api.openai.com") {
      if (req.headers.get("authorization") !== `Bearer ${OPENAI_KEY}`) return Response.json({ error: { message: "Incorrect API key provided." } }, { status: 401 });
      if (req.method === "GET") return Response.json({ data: [{ id: "gpt-4.1" }, { id: "gpt-5.6" }, { id: "gpt-5.6-mini" }, { id: "gpt-5" }] });
      const text = opts.openaiText ?? "Here you go:\n```html\n" + APP_HTML + "\n```";
      return new Response(
        [
          { type: "response.created" },
          { type: "response.output_text.delta", delta: text.slice(0, 20) },
          { type: "response.output_text.delta", delta: text.slice(20) },
          { type: "response.completed", response: { usage: { total_tokens: 321 } } },
        ]
          .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    return new Response("unexpected", { status: 599 });
  });
}
afterEach(() => onOutbound(undefined));

const connect = (as: string, provider: string, apiKey: string) => call(`/_api/admin/builders/${provider}`, { as, method: "PUT", json: { apiKey } });
async function build(as: string, provider: string, idea: string) {
  const res = await call("/_api/admin/build", { as, method: "POST", json: { provider, idea } });
  expect(res.status).toBe(200);
  const lines = new TextDecoder().decode(await res.arrayBuffer()).trim().split("\n").map((l) => JSON.parse(l) as Record<string, any>);
  return lines.at(-1)!;
}

describe("building apps with the person's own API key", () => {
  it("checks a Claude key, stores it encrypted, builds the app with it and publishes it", async () => {
    mockAi();
    const me = `b-${uniq()}@example.com`;
    await call("/_api/admin/whoami", { as: me });
    await env.DB.prepare("UPDATE users SET status = 'active' WHERE email = ?").bind(me).run();

    expect((await connect(me, "claude", "sk-ant-api03-WRONGKEY0123456789abcdefXXXX")).status).toBe(400);
    expect((await connect(me, "claude", "nope")).status).toBe(400);
    const ok = await connect(me, "claude", CLAUDE_KEY);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ connected: true, hint: "WXYZ" });
    const row = await env.DB.prepare("SELECT * FROM service_keys WHERE owner_email = ? AND service = 'anthropic'").bind(me).first();
    expect(JSON.stringify(row)).not.toContain(CLAUDE_KEY);

    const page = await (await call("/app/new", { as: me })).text();
    expect(page).toContain('data-build="claude"');
    expect(page).toContain("Your API key …WXYZ");
    expect(page).not.toContain(CLAUDE_KEY);

    const last = await build(me, "claude", "A sign-up sheet for our team lunch");
    expect(last.done).toMatchObject({ title: "Lunch Sign-up", mountPath: "lunch-sign-up", model: "claude-opus-5-5" });
    expect(last.done.url).toContain(`${last.done.namespace}.example.app/lunch-sign-up/`);

    const sent = seen.find((s) => s.method === "POST")!;
    expect(sent.url).toContain("https://api.anthropic.com/v1/messages");
    expect(sent.headers.get("x-api-key")).toBe(CLAUDE_KEY);
    const req = JSON.parse(sent.body);
    expect(req).toMatchObject({ model: "claude-opus-5-5", stream: true, fallbacks: "default", messages: [{ role: "user", content: "A sign-up sheet for our team lunch" }] });
    expect(req.system[0].text).toContain("Building apps for Formelab");

    const site = await env.DB.prepare("SELECT * FROM sites WHERE namespace = ? AND mount_path = ?").bind(last.done.namespace, "lunch-sign-up").first<{ owner_email: string; title: string }>();
    expect(site).toMatchObject({ owner_email: me, title: "Lunch Sign-up" });

    // A second app with the same name gets its own address.
    expect((await build(me, "claude", "Another lunch sheet")).done.mountPath).toBe("lunch-sign-up-2");
  });

  it("builds with an OpenAI key, picking the newest GPT model", async () => {
    mockAi();
    const me = `o-${uniq()}@example.com`;
    await call("/_api/admin/whoami", { as: me });
    await env.DB.prepare("UPDATE users SET status = 'active' WHERE email = ?").bind(me).run();
    expect((await connect(me, "openai", "sk-proj-WRONGKEY0123456789abcdefXXXX")).status).toBe(400);
    expect((await connect(me, "openai", OPENAI_KEY)).status).toBe(200);
    const last = await build(me, "openai", "A habit tracker");
    expect(last.done).toMatchObject({ title: "Lunch Sign-up", model: "gpt-5.6" });
    const sent = JSON.parse(seen.find((s) => s.method === "POST")!.body);
    expect(sent).toMatchObject({ model: "gpt-5.6", input: "A habit tracker", stream: true });
  });

  it("explains what's wrong instead of publishing", async () => {
    const me = `n-${uniq()}@example.com`;
    await call("/_api/admin/whoami", { as: me });
    await env.DB.prepare("UPDATE users SET status = 'active' WHERE email = ?").bind(me).run();
    mockAi({ claudeText: "Sorry, I can't help with that." });
    expect((await build(me, "claude", "x")).error.code).toBe("builder_not_connected");
    expect((await connect(me, "claude", CLAUDE_KEY)).status).toBe(200);
    expect((await build(me, "claude", "")).error.message).toContain("Describe your app");
    expect((await build(me, "claude", "x")).error.code).toBe("builder_no_html");
    mockAi({ claudeStop: "max_tokens" });
    expect((await build(me, "claude", "x")).error.code).toBe("builder_too_long");
    expect((await call("/_api/admin/build", { as: me, method: "POST", json: { provider: "gemini", idea: "x" } })).status).toBe(400);

    // Removing the key works, and the page asks for one again.
    expect((await call("/_api/admin/builders/claude", { as: me, method: "DELETE" })).status).toBe(200);
    const page = await (await call("/app/new", { as: me })).text();
    expect(page).toContain('data-dialog="dlg-key-claude"');
    expect(page).not.toContain('data-build="claude"');
  });

  it("pulls the HTML out of a chatty answer and names the app from its title", () => {
    expect(extractHtml("Sure!\n```html\n<!DOCTYPE html><html><head><title>A</title></head></html>\n```\nEnjoy")).toBe("<!DOCTYPE html><html><head><title>A</title></head></html>");
    expect(extractHtml("<html><body>x</body></html> trailing")).toBe("<html><body>x</body></html>");
    expect(titleOf("<title> Budget &amp; Bills </title>")).toBe("Budget & Bills");
    expect(slugify("Budget & Bills!")).toBe("budget-bills");
    expect(slugify("☃")).toBe("app");
  });
});
