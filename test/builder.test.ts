import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { extractHtml, slugify, titleOf } from "../src/builder";
import { call, onOutbound, OWNER, publishZip, uniq } from "./helpers";

const GEMINI_KEY = "AIzaSyTESTKEY0123456789abcdefGEMI";
const CLAUDE_KEY = "sk-ant-api03-TESTKEY0123456789abcdefWXYZ";
const OPENAI_KEY = "sk-proj-TESTKEY0123456789abcdefOPEN";
const XAI_KEY = "xai-TESTKEY0123456789abcdefGROK";
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

function mockAi(opts: { claudeText?: string; claudeStop?: string; openaiText?: string; geminiText?: string; geminiFinish?: string; grokFinish?: string } = {}) {
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
    if (url.hostname === "api.x.ai") {
      if (req.headers.get("authorization") !== `Bearer ${XAI_KEY}`) return Response.json({ code: "Client specified an invalid argument", error: "Incorrect API key provided: xa***XX." }, { status: 400 });
      if (req.method === "GET") return Response.json({ data: [{ id: "grok-4" }, { id: "grok-4-1" }, { id: "grok-4-1-fast-reasoning" }, { id: "grok-4-0709" }, { id: "grok-code-fast-1" }, { id: "grok-3-mini" }] });
      const chunk = (d: unknown) => `data: ${JSON.stringify(d)}\n\n`;
      return new Response(
        chunk({ choices: [{ delta: { role: "assistant", content: APP_HTML.slice(0, 25) } }] }) +
          chunk({ choices: [{ delta: { content: APP_HTML.slice(25) }, finish_reason: opts.grokFinish ?? "stop" }] }) +
          chunk({ choices: [], usage: { total_tokens: 222 } }) +
          "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    if (url.hostname === "generativelanguage.googleapis.com") {
      if (req.headers.get("x-goog-api-key") !== GEMINI_KEY) return Response.json({ error: { message: "API key not valid." } }, { status: 400 });
      if (req.method === "GET" && url.pathname.endsWith("/models")) {
        return Response.json({ models: [{ name: "models/gemini-3.5-flash-lite" }, { name: "models/gemini-3.5-flash" }, { name: "models/gemini-3.6-flash-preview" }, { name: "models/gemini-3.5-pro" }, { name: "models/gemini-2.5-flash" }] });
      }
      if (req.method === "GET") return Response.json({ name: "models/gemini-3.5-flash-lite" });
      const text = opts.geminiText ?? APP_HTML;
      const chunk = (t: string, extra: Record<string, unknown> = {}) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: t }] }, ...extra }] })}\r\n\r\n`;
      return new Response(chunk(text.slice(0, 30)) + chunk(text.slice(30), { finishReason: opts.geminiFinish ?? "STOP" }) + `data: ${JSON.stringify({ usageMetadata: { totalTokenCount: 77 } })}\r\n\r\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    }
    return new Response("unexpected", { status: 599 });
  });
}
afterEach(() => onOutbound(undefined));

/** A signed-in, let-in person with the app_builder feature turned on for them by name. */
async function person(prefix: string) {
  const me = `${prefix}-${uniq()}@example.com`;
  await call("/_api/admin/whoami", { as: me });
  await env.DB.prepare("UPDATE users SET status = 'active' WHERE email = ?").bind(me).run();
  expect((await call("/_api/admin/features/app_builder/users", { as: OWNER, method: "POST", json: { email: me } })).status).toBe(200);
  return me;
}

const connect = (as: string, provider: string, apiKey: string) => call(`/_api/admin/builders/${provider}`, { as, method: "PUT", json: { apiKey } });
async function build(as: string, provider: string, idea: string) {
  return run(as, { provider, idea });
}
async function run(as: string, json: Record<string, unknown>) {
  const res = await call("/_api/admin/build", { as, method: "POST", json });
  expect(res.status).toBe(200);
  const lines = new TextDecoder().decode(await res.arrayBuffer()).trim().split("\n").map((l) => JSON.parse(l) as Record<string, any>);
  return lines.at(-1)!;
}

describe("building apps with the person's own API key", () => {
  it("checks a Claude key, stores it encrypted, builds the app with it and publishes it", async () => {
    mockAi();
    const me = await person("b");

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
    expect(last.done.url).toMatch(/^https:\/\/lunch-sign-up-[a-z0-9]+\.example\.app\//);

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
    const me = await person("o");
    expect((await connect(me, "openai", "sk-proj-WRONGKEY0123456789abcdefXXXX")).status).toBe(400);
    expect((await connect(me, "openai", OPENAI_KEY)).status).toBe(200);
    const last = await build(me, "openai", "A habit tracker");
    expect(last.done).toMatchObject({ title: "Lunch Sign-up", model: "gpt-5.6" });
    const sent = JSON.parse(seen.find((s) => s.method === "POST")!.body);
    expect(sent).toMatchObject({ model: "gpt-5.6", input: "A habit tracker", stream: true });
  });

  it("builds with a Grok (xAI) key, picking the newest Grok model", async () => {
    mockAi();
    const me = await person("x");
    const bad = await connect(me, "grok", "xai-WRONGKEY0123456789abcdefXXXX");
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("xAI didn't accept this key");
    expect(await (await connect(me, "grok", XAI_KEY)).json()).toEqual({ connected: true, hint: "GROK" });
    const row = await env.DB.prepare("SELECT * FROM service_keys WHERE owner_email = ? AND service = 'xai'").bind(me).first();
    expect(JSON.stringify(row)).not.toContain(XAI_KEY);

    const page = await (await call("/app/new", { as: me })).text();
    expect(page).toContain('data-build="grok"');
    expect(page).toContain("Make it with Grok");

    const last = await build(me, "grok", "A habit tracker");
    expect(last.done).toMatchObject({ title: "Lunch Sign-up", model: "grok-4-1" });
    const sent = seen.find((s) => s.method === "POST")!;
    expect(sent.url).toBe("https://api.x.ai/v1/chat/completions");
    expect(JSON.parse(sent.body)).toMatchObject({ model: "grok-4-1", stream: true, messages: [{ role: "system" }, { role: "user", content: "A habit tracker" }] });

    mockAi({ grokFinish: "length" });
    expect((await build(me, "grok", "x")).error.code).toBe("builder_too_long");
  });

  it("explains what's wrong instead of publishing", async () => {
    const me = await person("n");
    mockAi({ claudeText: "Sorry, I can't help with that." });
    expect((await build(me, "claude", "x")).error.code).toBe("builder_not_connected");
    expect((await connect(me, "claude", CLAUDE_KEY)).status).toBe(200);
    expect((await build(me, "claude", "")).error.message).toContain("Describe your app");
    expect((await build(me, "claude", "x")).error.code).toBe("builder_no_html");
    mockAi({ claudeStop: "max_tokens" });
    expect((await build(me, "claude", "x")).error.code).toBe("builder_too_long");
    expect((await call("/_api/admin/build", { as: me, method: "POST", json: { provider: "mistral", idea: "x" } })).status).toBe(400);

    // Removing the key works, and the page asks for one again.
    expect((await call("/_api/admin/builders/claude", { as: me, method: "DELETE" })).status).toBe(200);
    const page = await (await call("/app/new", { as: me })).text();
    expect(page).toContain('data-dialog="dlg-key-claude"');
    expect(page).not.toContain('data-build="claude"');
  });

  it("builds with a free Gemini key, which is the same key as the Gemini connected app", async () => {
    mockAi();
    const me = await person("g");
    expect((await call("/_api/admin/features/connected_apps/users", { as: OWNER, method: "POST", json: { email: me } })).status).toBe(200);
    expect((await connect(me, "gemini", "AIzaSyWRONGKEY0123456789abcdefXXXX")).status).toBe(400);

    // Saved on New app, it shows as connected under Connected apps.
    expect(await (await connect(me, "gemini", GEMINI_KEY)).json()).toEqual({ connected: true, hint: "GEMI" });
    expect(await (await call("/_api/admin/services/gemini", { as: me })).json()).toMatchObject({ connected: true, hint: "GEMI" });
    expect(await (await call("/app/connected", { as: me })).text()).toContain("Make it with Gemini");

    const last = await build(me, "gemini", "A habit tracker");
    expect(last.done).toMatchObject({ title: "Lunch Sign-up", model: "gemini-3.5-flash" });
    const sent = seen.find((x) => x.method === "POST")!;
    expect(sent.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse");
    expect(JSON.parse(sent.body)).toMatchObject({ contents: [{ role: "user", parts: [{ text: "A habit tracker" }] }] });

    mockAi({ geminiFinish: "MAX_TOKENS" });
    expect((await build(me, "gemini", "x")).error.code).toBe("builder_too_long");

    // Removed on New app, it's gone from Connected apps too; and the other way round.
    expect((await call("/_api/admin/builders/gemini", { as: me, method: "DELETE" })).status).toBe(200);
    expect(await (await call("/_api/admin/services/gemini", { as: me })).json()).toMatchObject({ connected: false });
    mockAi();
    expect((await call("/_api/admin/services/gemini", { as: me, method: "PUT", json: { apiKey: GEMINI_KEY } })).status).toBe(200);
    const page = await (await call("/app/new", { as: me })).text();
    expect(page).toContain('data-build="gemini"');
    expect(page).toContain("Your API key …GEMI");
  });

  it("changes an existing app from its settings page, keeping its other files and settings", async () => {
    const me = await person("e");
    const ns = uniq();
    const old = `<!doctype html><html><head><title>Chores</title><link rel="stylesheet" href="style.css"></head><body>Old chores</body></html>`;
    const pub = await publishZip(me, ns, "chores", { "index.html": old, "style.css": "body{color:red}" }, { allowed_emails: "pal@example.com" });
    const site = await pub.json<{ site: { id: string } }>();
    const id = site.site.id;

    // No key yet: the page says where to add one.
    let page = await (await call(`/app/apps/${id}`, { as: me })).text();
    expect(page).toContain("Change it with AI");
    expect(page).toContain("Add your Claude, OpenAI, Grok or free Gemini API key");

    mockAi({ claudeText: `<!doctype html><html><head><title>Chores</title><link rel="stylesheet" href="style.css"></head><body>New chores, with dark mode</body></html>` });
    expect((await connect(me, "claude", CLAUDE_KEY)).status).toBe(200);
    page = await (await call(`/app/apps/${id}`, { as: me })).text();
    expect(page).toContain(`data-build="claude" data-site="${id}"`);
    expect(page).not.toContain('data-build="openai"');

    const last = await run(me, { provider: "claude", site_id: id, change: "Add a dark mode" });
    expect(last.done).toMatchObject({ namespace: ns, mountPath: "chores", title: "Chores" });
    const prompt = JSON.parse(seen.find((s) => s.method === "POST")!.body).messages[0].content as string;
    expect(prompt).toContain("Old chores");
    expect(prompt).toContain("style.css");
    expect(prompt).toContain("Add a dark mode");

    const row = await env.DB.prepare("SELECT id, current_version, allowed_emails FROM sites WHERE id = ?").bind(id).first<{ current_version: string; allowed_emails: string }>();
    expect(row!.allowed_emails).toContain("pal@example.com");
    const read = async (f: string) => (await env.BUCKET.get(`sites/${id}/${row!.current_version}/${f}`))?.text();
    expect(await read("index.html")).toContain("New chores, with dark mode");
    expect(await read("style.css")).toBe("body{color:red}");
    const act = await (await call(`/app/apps/${id}/activity`, { as: me })).text();
    expect(act).toContain("Changed it with Claude");

    // Someone who can't manage the app can't change it.
    const stranger = await person("s");
    expect((await connect(stranger, "claude", CLAUDE_KEY)).status).toBe(200);
    expect((await run(stranger, { provider: "claude", site_id: id, change: "Delete everything" })).error.code).toBe("not_found");
    expect((await run(me, { provider: "claude", site_id: id, change: " " })).error.message).toContain("Describe the change");
  });

  it("stays hidden, and its API answers 404, without the app_builder feature", async () => {
    mockAi();
    const me = `f-${uniq()}@example.com`;
    await call("/_api/admin/whoami", { as: me });
    await env.DB.prepare("UPDATE users SET status = 'active' WHERE email = ?").bind(me).run();
    expect((await connect(me, "claude", CLAUDE_KEY)).status).toBe(404);
    expect((await call("/_api/admin/build", { as: me, method: "POST", json: { provider: "claude", idea: "x" } })).status).toBe(404);
    const page = await (await call("/app/new", { as: me })).text();
    expect(page).toContain('data-make="claude"');
    expect(page).not.toContain("dlg-key-");
    expect(page).not.toContain("data-build=");
    const pub = await publishZip(me, uniq(), "x", { "index.html": "<!doctype html><html><head><title>x</title></head></html>" });
    const id = (await pub.json<{ site: { id: string } }>()).site.id;
    expect(await (await call(`/app/apps/${id}`, { as: me })).text()).not.toContain("Change it with AI");
  });

  it("pulls the HTML out of a chatty answer and names the app from its title", () => {
    expect(extractHtml("Sure!\n```html\n<!DOCTYPE html><html><head><title>A</title></head></html>\n```\nEnjoy")).toBe("<!DOCTYPE html><html><head><title>A</title></head></html>");
    expect(extractHtml("<html><body>x</body></html> trailing")).toBe("<html><body>x</body></html>");
    expect(titleOf("<title> Budget &amp; Bills </title>")).toBe("Budget & Bills");
    expect(slugify("Budget & Bills!")).toBe("budget-bills");
    expect(slugify("☃")).toBe("app");
  });
});
