// The easy way, built in: a person saves their own Claude (Anthropic), OpenAI, Gemini or Grok (xAI)
// API key once, and "Make it" on the New app page builds the app with that key right here, then publishes it. No
// connector to set up in Claude or ChatGPT, and the person's own API account pays for the tokens.
// Keys are encrypted at rest like Gemini's (service_keys, AAD "user:<email>:<service>") and never
// sent to a browser.
import Anthropic from "@anthropic-ai/sdk";
import { audit } from "./audit";
import type { Env, User } from "./env";
import { ApiError, badRequest, err, upstreamMessage } from "./errors";
import { enabledFlags, withFlags } from "./flags";
import { GUIDE_MD } from "./generated/assets";
import { connectGemini, disconnectGemini, GEMINI_API, GEMINI_MODEL } from "./gemini";
import { markServiceKeyUsed, rateLimit, readServiceKey, saveServiceKey } from "./secrets";
import {
  createNamespace,
  currentFiles,
  getNamespace,
  getSiteByMount,
  listNamespaces,
  publishSite,
  requireManageableSite,
  RESERVED_LABELS,
  waitlisted,
  type Ctx,
} from "./sites";
import { filesFromHtml } from "./upload";
import { slug } from "./util";

export type Builder = "claude" | "openai" | "gemini" | "grok";
// Gemini's builder key is the same stored key as the Google Gemini connected app (service
// "gemini"): saving or removing it in either place does it for both.
export const BUILDERS: Record<Builder, { service: string; name: string; keyUrl: string }> = {
  claude: { service: "anthropic", name: "Claude", keyUrl: "https://console.anthropic.com/settings/keys" },
  openai: { service: "openai", name: "ChatGPT (OpenAI)", keyUrl: "https://platform.openai.com/api-keys" },
  gemini: { service: "gemini", name: "Google Gemini", keyUrl: "https://aistudio.google.com/apikey" },
  grok: { service: "xai", name: "Grok (xAI)", keyUrl: "https://console.x.ai" },
};
/** Button labels: "Make it with Claude", "Change it with Gemini". */
export const BUILDER_LABEL: Record<Builder, string> = { claude: "Claude", openai: "ChatGPT", gemini: "Gemini", grok: "Grok" };

export const CLAUDE_MODEL = "claude-opus-5-5";
const OPENAI_API = "https://api.openai.com/v1";
const XAI_API = "https://api.x.ai/v1";
const MAX_IDEA = 4000;
const MAX_OUTPUT_TOKENS = 32000;
export const BUILDS_PER_MINUTE = 5;

export function parseBuilder(raw: unknown): Builder {
  if (raw === "claude" || raw === "openai" || raw === "gemini" || raw === "grok") return raw;
  throw badRequest("Pick Claude, ChatGPT, Gemini or Grok.", 'Send provider "claude", "openai", "gemini" or "grok".');
}

type Row = { iv: string; ciphertext: string; hint: string };
const loadRow = (env: Env, email: string, b: Builder) =>
  env.DB.prepare("SELECT iv, ciphertext, hint FROM service_keys WHERE owner_email = ? AND service = ?").bind(email, BUILDERS[b].service).first<Row>();

/** Which builders this person has a key for, with the key's last four characters. */
export async function builderKeys(env: Env, email: string): Promise<Partial<Record<Builder, { hint: string }>>> {
  const { results } = await env.DB.prepare("SELECT service, hint FROM service_keys WHERE owner_email = ? AND service IN ('anthropic', 'openai', 'gemini', 'xai')")
    .bind(email)
    .all<{ service: string; hint: string }>();
  const out: Partial<Record<Builder, { hint: string }>> = {};
  const byService = Object.fromEntries((Object.keys(BUILDERS) as Builder[]).map((b) => [BUILDERS[b].service, b]));
  for (const r of results) out[byService[r.service] as Builder] = { hint: r.hint };
  return out;
}

/** Who issues each builder's keys, for messages: "Anthropic didn't accept this key". */
const ORG: Record<Builder, string> = { claude: "Anthropic", openai: "OpenAI", gemini: "Google", grok: "xAI" };

const keyRejected = (b: Builder, why: string) =>
  badRequest(`${ORG[b]} didn't accept this key: ${why}`, `Check the key at ${BUILDERS[b].keyUrl}, or create a new one, then paste it again.`);

const anthropic = (apiKey: string) => new Anthropic({ apiKey, maxRetries: 1, fetch: (...a: Parameters<typeof fetch>) => fetch(...a) });

/** Checks the key with Anthropic, OpenAI or xAI (a free model lookup), then saves it encrypted. */
export async function connectBuilder(env: Env, user: User, b: Builder, rawKey: unknown) {
  if (b === "gemini") {
    const status = await connectGemini(env, user, rawKey);
    return { connected: true, hint: status.hint };
  }
  const key = String(rawKey ?? "").trim();
  if (!/^[A-Za-z0-9._~-]{20,400}$/.test(key)) {
    throw badRequest(`That doesn't look like ${b === "grok" ? "a" : "an"} ${ORG[b]} API key.`, `Copy the whole key from ${BUILDERS[b].keyUrl}, with no spaces.`);
  }
  if (b === "claude") {
    try {
      await anthropic(key).models.retrieve(CLAUDE_MODEL);
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) throw keyRejected(b, e.message);
      if (e instanceof Anthropic.NotFoundError) throw keyRejected(b, `this key can't use ${CLAUDE_MODEL}.`);
      throw err(502, "builder_unreachable", "Couldn't reach Anthropic to check the key.", "Try again in a minute.");
    }
  } else {
    // OpenAI and xAI share the same API shape: list the models the key can use.
    const api = b === "grok" ? XAI_API : OPENAI_API;
    let res: Response;
    try {
      res = await fetch(`${api}/models`, { headers: { authorization: `Bearer ${key}` } });
    } catch {
      throw err(502, "builder_unreachable", `Couldn't reach ${ORG[b]} to check the key.`, "Try again in a minute.");
    }
    // xAI answers a bad key with 400 ("Incorrect API key provided").
    if (res.status === 401 || res.status === 403 || (b === "grok" && res.status === 400)) throw keyRejected(b, await upstreamMessage(res));
    if (!res.ok) throw err(502, "builder_error", `${ORG[b]} couldn't check the key right now: ${await upstreamMessage(res)}`, "Try again in a minute.");
  }
  await saveServiceKey(env, user.email, BUILDERS[b].service, key, key.slice(-4));
  await audit(env, user.email, "service_connect", null, { service: BUILDERS[b].name });
  return { connected: true, hint: key.slice(-4) };
}

export async function disconnectBuilder(env: Env, user: User, b: Builder) {
  if (b === "gemini") return disconnectGemini(env, user);
  const res = await env.DB.prepare("DELETE FROM service_keys WHERE owner_email = ? AND service = ?").bind(user.email, BUILDERS[b].service).run();
  if (res.meta.changes) await audit(env, user.email, "service_disconnect", null, { service: BUILDERS[b].name });
  return { ok: true };
}

const BUILD_RULES = `You are building a web app for a Formelab user, from their description. The guide below
describes Formelab. Formelab publishes what you write for you, so ignore the guide's publishing
section and don't ask the user anything: make sensible choices and build the whole app.

Reply with ONE complete, self-contained HTML document and nothing else: no explanation, no
Markdown fences. Start with <!doctype html>. It must have a short, friendly <title> naming the
app, a <link rel="icon"> with an inline SVG that fits the app, a one-sentence
<meta name="description">, and a share illustration for link previews: a <meta property="og:image">
whose content is an inline, URL-encoded SVG data URI (viewBox 0 0 1200 630, under 20 KB) drawing the
app's name and a simple stylized picture of what it's for (see the guide's "Link previews"). It
must work well on a phone and follow the guide's ground rules and checklist. Save data with formelab.kv (or formelab.kv.mine for each
person's own data) so it lasts. Use formelab.kv for what people share (votes, sign-ups, a shared
list): when the app writes it, Formelab lets everyone who can open the app write it too, unless its
owner chose otherwise. Use formelab.kv.mine for each person's own data.`;

const EDIT_RULES = `You are changing an existing Formelab web app for its owner. The guide below
describes Formelab. Formelab publishes what you write for you, so ignore the guide's publishing
section and don't ask the user anything: make the change they ask for, sensibly, and keep
everything else working as it does now. Keep the app's formelab.kv keys and data shapes, so the
data people already saved still loads.

Reply with the ONE complete, updated HTML document for the app's index.html and nothing else: no
explanation, no Markdown fences, no "rest unchanged" placeholders. Start with <!doctype html>.
Keep its <title>, icon, description and share illustration (<meta property="og:image">) unless
asked to change them or the change makes them wrong; add the description and share illustration if
it has none (see the guide's "Link previews"). Follow the guide's ground rules and checklist.`;

/** The model's answer as an HTML document: tolerates a Markdown fence or a sentence around it. */
export function extractHtml(text: string): string {
  let t = text.trim();
  const fence = t.match(/```(?:html)?\s*\n([\s\S]*?)\n```/i);
  if (fence) t = fence[1]!.trim();
  const start = t.search(/<!doctype html|<html[\s>]/i);
  if (start < 0) throw err(502, "builder_no_html", "The AI didn't write an app this time.", "Try again, or describe the app in a bit more detail.");
  t = t.slice(start);
  const end = t.toLowerCase().lastIndexOf("</html>");
  return end >= 0 ? t.slice(0, end + 7) : t;
}

export function titleOf(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const t = (m?.[1] ?? "").replace(/\s+/g, " ").replace(/&amp;/g, "&").trim();
  return t.slice(0, 120) || "My app";
}

export const slugify = (s: string) => slug(s, 40) || "app";

/** The person's space to publish into: one they own, else one they edit, else a new one named after them. */
async function homeNamespace(ctx: Ctx): Promise<string> {
  const mine = await listNamespaces(ctx);
  const own = mine.find((n) => n.isOwner) ?? mine.find((n) => n.editors.includes(ctx.user.email));
  if (own) return own.label;
  const base = slugify(ctx.user.email.split("@")[0]!).slice(0, 30) || "me";
  for (let i = 0; i < 20; i++) {
    const label = i === 0 && !RESERVED_LABELS.has(base) ? base : `${base}-${Math.floor(1000 + Math.random() * 9000)}`;
    if (await getNamespace(ctx.env, label)) continue;
    try {
      await createNamespace(ctx, label);
      return label;
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "namespace_taken")) throw e;
    }
  }
  throw err(409, "namespace_taken", "Couldn't find a free name for your space.", "Create a space under Spaces, then try again.");
}

async function freeMount(env: Env, ns: string, title: string): Promise<string> {
  const base = slugify(title);
  for (let i = 1; i < 50; i++) {
    const mount = i === 1 ? base : `${base}-${i}`;
    if (!(await getSiteByMount(env, ns, mount))) return mount;
  }
  return `${base}-${Date.now().toString(36)}`;
}

type Progress = (chars: number) => void;
type Generated = { html: string; model: string; tokens: number };

/** The `data:` payloads of a server-sent event stream, in order. */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += value;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
}

/** One SSE payload as JSON, or null for anything that isn't (keep-alives, "[DONE]"). */
function parseEvent<T>(data: string): T | null {
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

async function generateWithClaude(key: string, system: string, prompt: string, progress: Progress): Promise<Generated> {
  let chars = 0;
  const stream = anthropic(key).beta.messages.stream({
    model: CLAUDE_MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    // If a safety check declines the request, Anthropic retries it on another model.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: prompt }],
  });
  stream.on("text", (delta) => {
    chars += delta.length;
    progress(chars);
  });
  let msg;
  try {
    msg = await stream.finalMessage();
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
      throw err(502, "builder_key_rejected", "Anthropic rejected your Claude API key.", "Paste a new key on the New app page (Claude → Change key).");
    }
    if (e instanceof Anthropic.RateLimitError) throw err(429, "builder_quota", `Your Anthropic account is over a limit: ${e.message}`, "Wait a bit, or check your usage and credits at console.anthropic.com.");
    if (e instanceof Anthropic.BadRequestError && /credit|billing/i.test(e.message)) {
      throw err(402, "builder_billing", "Your Anthropic account is out of credits.", "Add credits at console.anthropic.com → Billing, then try again.");
    }
    if (e instanceof Anthropic.APIError) throw err(502, "builder_error", `Claude had a problem: ${e.message}`, "Try again in a moment.");
    throw err(504, "builder_unreachable", "Couldn't reach Claude.", "Try again in a moment.");
  }
  if (msg.stop_reason === "refusal") throw badRequest("Claude declined to build this app.", "Try describing it differently.");
  if (msg.stop_reason === "max_tokens") throw err(502, "builder_too_long", "The app came out too long to finish.", "Ask for a smaller first version, then add to it.");
  const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  return { html: extractHtml(text), model: msg.model, tokens: msg.usage.input_tokens + msg.usage.output_tokens };
}

/** The newest flagship GPT model the key can use ("gpt-5.6" over "gpt-5" over "gpt-4.1"; no -mini etc.). */
async function pickOpenAiModel(key: string): Promise<string> {
  const res = await fetch(`${OPENAI_API}/models`, { headers: { authorization: `Bearer ${key}` } });
  if (res.status === 401 || res.status === 403) throw err(502, "builder_key_rejected", "OpenAI rejected your API key.", "Paste a new key on the New app page (ChatGPT → Change key).");
  if (!res.ok) throw err(502, "builder_error", `OpenAI had a problem: ${await upstreamMessage(res)}`, "Try again in a moment.");
  const { data = [] } = await res.json<{ data?: { id: string }[] }>();
  const ranked = data
    .map((m) => ({ id: m.id, v: m.id.match(/^gpt-(\d+(?:\.\d+)?)$/)?.[1] }))
    .filter((m): m is { id: string; v: string } => !!m.v)
    .sort((a, b) => Number(b.v) - Number(a.v));
  if (!ranked.length) throw err(502, "builder_no_model", "Your OpenAI key can't use a GPT model.", "Check the key's project and model permissions at platform.openai.com.");
  return ranked[0]!.id;
}

async function generateWithOpenAi(key: string, system: string, prompt: string, progress: Progress): Promise<Generated> {
  const model = await pickOpenAiModel(key);
  let res: Response;
  try {
    res = await fetch(`${OPENAI_API}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, instructions: system, input: prompt, max_output_tokens: MAX_OUTPUT_TOKENS, stream: true }),
    });
  } catch {
    throw err(504, "builder_unreachable", "Couldn't reach OpenAI.", "Try again in a moment.");
  }
  if (!res.ok || !res.body) {
    const why = await upstreamMessage(res);
    if (res.status === 401 || res.status === 403) throw err(502, "builder_key_rejected", "OpenAI rejected your API key.", "Paste a new key on the New app page (ChatGPT → Change key).");
    if (res.status === 429) throw err(429, "builder_quota", `Your OpenAI account is over a limit: ${why}`, "Wait a bit, or check your usage and billing at platform.openai.com.");
    throw err(502, "builder_error", `OpenAI had a problem: ${why}`, "Try again in a moment.");
  }
  let text = "";
  let tokens = 0;
  let failure: string | null = null;
  let incomplete = false;
  type Event = { type?: string; delta?: string; message?: string; response?: { usage?: { total_tokens?: number }; error?: { message?: string } } };
  for await (const data of sseData(res.body)) {
    const ev = parseEvent<Event>(data);
    if (ev?.type === "response.output_text.delta" && ev.delta) {
      text += ev.delta;
      progress(text.length);
    } else if (ev?.type === "response.completed") {
      tokens = ev.response?.usage?.total_tokens ?? 0;
    } else if (ev?.type === "response.incomplete") {
      incomplete = true;
    } else if (ev?.type === "response.failed" || ev?.type === "error") {
      failure = ev.response?.error?.message ?? ev.message ?? "unknown error";
    }
  }
  if (failure) throw err(502, "builder_error", `OpenAI had a problem: ${failure}`, "Try again in a moment.");
  if (incomplete) throw err(502, "builder_too_long", "The app came out too long to finish.", "Ask for a smaller first version, then add to it.");
  return { html: extractHtml(text), model, tokens };
}

/** The newest Gemini Flash model the key can use (free tier); Flash-Lite if there's none. */
async function pickGeminiModel(key: string): Promise<string> {
  const res = await fetch(`${GEMINI_API}/models?pageSize=1000`, { headers: { "x-goog-api-key": key } });
  if (res.status === 400 || res.status === 401 || res.status === 403) throw err(502, "builder_key_rejected", "Google rejected your Gemini API key.", "Paste a new key on the New app page (Gemini → Change key).");
  if (!res.ok) throw err(502, "builder_error", `Gemini had a problem: ${await upstreamMessage(res)}`, "Try again in a moment.");
  const { models = [] } = await res.json<{ models?: { name: string }[] }>();
  const ranked = models
    .map((m) => ({ id: m.name.replace(/^models\//, ""), v: m.name.match(/^models\/gemini-(\d+(?:\.\d+)?)-flash$/)?.[1] }))
    .filter((m): m is { id: string; v: string } => !!m.v)
    .sort((a, b) => Number(b.v) - Number(a.v));
  return ranked[0]?.id ?? GEMINI_MODEL;
}

async function generateWithGemini(key: string, system: string, prompt: string, progress: Progress): Promise<Generated> {
  const model = await pickGeminiModel(key);
  let res: Response;
  try {
    res = await fetch(`${GEMINI_API}/models/${model}:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
      }),
    });
  } catch {
    throw err(504, "builder_unreachable", "Couldn't reach Gemini.", "Try again in a moment.");
  }
  if (!res.ok || !res.body) {
    const why = await upstreamMessage(res);
    if (res.status === 401 || res.status === 403) throw err(502, "builder_key_rejected", "Google rejected your Gemini API key.", "Paste a new key on the New app page (Gemini → Change key).");
    if (res.status === 429) throw err(429, "builder_quota", `You've reached Gemini's free limit for now: ${why}`, "Wait a minute and try again. The daily limit resets at midnight Pacific time.");
    throw err(502, "builder_error", `Gemini had a problem: ${why}`, "Try again in a moment.");
  }
  let text = "";
  let tokens = 0;
  let finish: string | undefined;
  let blocked: string | undefined;
  type Event = {
    candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
    promptFeedback?: { blockReason?: string };
    usageMetadata?: { totalTokenCount?: number };
  };
  for await (const data of sseData(res.body)) {
    const ev = parseEvent<Event>(data);
    if (!ev) continue;
    const cand = ev.candidates?.[0];
    for (const p of cand?.content?.parts ?? []) if (!p.thought && p.text) text += p.text;
    if (cand?.finishReason) finish = cand.finishReason;
    if (ev.promptFeedback?.blockReason) blocked = ev.promptFeedback.blockReason;
    if (ev.usageMetadata?.totalTokenCount) tokens = ev.usageMetadata.totalTokenCount;
    progress(text.length);
  }
  if (blocked || finish === "SAFETY" || finish === "PROHIBITED_CONTENT") throw badRequest("Gemini declined to build this app.", "Try describing it differently.");
  if (finish === "MAX_TOKENS") throw err(502, "builder_too_long", "The app came out too long to finish.", "Ask for a smaller first version, then add to it.");
  return { html: extractHtml(text), model, tokens };
}

/** The newest flagship Grok model the key can use ("grok-5" over "grok-4.1" over "grok-4"; no -mini, -fast, -code or dated variants). */
async function pickGrokModel(key: string): Promise<string> {
  const res = await fetch(`${XAI_API}/models`, { headers: { authorization: `Bearer ${key}` } });
  if (res.status === 400 || res.status === 401 || res.status === 403) throw err(502, "builder_key_rejected", "xAI rejected your Grok API key.", "Paste a new key on the New app page (Grok → Change key).");
  if (!res.ok) throw err(502, "builder_error", `Grok had a problem: ${await upstreamMessage(res)}`, "Try again in a moment.");
  const { data = [] } = await res.json<{ data?: { id: string }[] }>();
  // xAI writes point versions either way: "grok-4.1" or "grok-4-1".
  const ranked = data
    .map((m) => {
      const v = m.id.match(/^grok-(\d+)(?:[.-](\d{1,2}))?$/);
      return { id: m.id, v: v ? Number(v[1]) + Number(v[2] ?? 0) / 100 : NaN };
    })
    .filter((m) => !Number.isNaN(m.v))
    .sort((a, b) => b.v - a.v);
  if (!ranked.length) throw err(502, "builder_no_model", "Your xAI key can't use a Grok model.", "Check the key's model permissions at console.x.ai.");
  return ranked[0]!.id;
}

/** Grok through xAI's OpenAI-compatible Chat Completions API, streaming. */
async function generateWithGrok(key: string, system: string, prompt: string, progress: Progress): Promise<Generated> {
  const model = await pickGrokModel(key);
  let res: Response;
  try {
    res = await fetch(`${XAI_API}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
        max_tokens: MAX_OUTPUT_TOKENS,
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
  } catch {
    throw err(504, "builder_unreachable", "Couldn't reach Grok.", "Try again in a moment.");
  }
  if (!res.ok || !res.body) {
    const why = await upstreamMessage(res);
    if (res.status === 401 || res.status === 403 || (res.status === 400 && /api key/i.test(why))) throw err(502, "builder_key_rejected", "xAI rejected your Grok API key.", "Paste a new key on the New app page (Grok → Change key).");
    if (res.status === 429) throw err(429, "builder_quota", `Your xAI account is over a limit: ${why}`, "Wait a bit, or check your usage and credits at console.x.ai.");
    throw err(502, "builder_error", `Grok had a problem: ${why}`, "Try again in a moment.");
  }
  let text = "";
  let tokens = 0;
  let finish: string | undefined;
  type Event = { choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[]; usage?: { total_tokens?: number }; error?: { message?: string } | string };
  for await (const data of sseData(res.body)) {
    const ev = parseEvent<Event>(data);
    if (!ev) continue;
    if (ev.error) throw err(502, "builder_error", `Grok had a problem: ${typeof ev.error === "string" ? ev.error : (ev.error.message ?? "unknown error")}`, "Try again in a moment.");
    const choice = ev.choices?.[0];
    if (choice?.delta?.content) {
      text += choice.delta.content;
      progress(text.length);
    }
    if (choice?.finish_reason) finish = choice.finish_reason;
    if (ev.usage?.total_tokens) tokens = ev.usage.total_tokens;
  }
  if (finish === "content_filter") throw badRequest("Grok declined to build this app.", "Try describing it differently.");
  if (finish === "length") throw err(502, "builder_too_long", "The app came out too long to finish.", "Ask for a smaller first version, then add to it.");
  return { html: extractHtml(text), model, tokens };
}

export interface BuildResult {
  url: string;
  title: string;
  namespace: string;
  mountPath: string;
  model: string;
  /** A new app only: who can change its shared data, and whether Formelab chose it from the app. */
  dataWrites?: { value: "everyone" | "editors"; chosen: "auto" | "you" };
  /** A new app only: its id, for a link to its settings. */
  siteId?: string;
}

/** "auto" (decide from the app), "editors" or "everyone": who a new app lets change its shared data. */
export function parseBuildDataWrites(raw: unknown): "auto" | "editors" | "everyone" {
  if (raw === undefined || raw === null || raw === "" || raw === "auto") return "auto";
  if (raw === "editors" || raw === "everyone") return raw;
  throw badRequest(`data_writes must be "auto", "editors" or "everyone".`, "\"auto\" lets Formelab decide from the app it builds.");
}

/**
 * Whether an app changes its shared data (formelab.kv.set or delete; formelab.kv.mine is each
 * person's own and doesn't count). A guess from its code: an app that does gets "everyone" when
 * the person lets Formelab decide, so its polls and sign-ups work for the people it's shared with;
 * any other app keeps its data to the owner and editors.
 */
export function writesSharedData(html: string): boolean {
  return /\bkv\s*\.\s*(?:set|delete)\s*\(/.test(html);
}

type Prepared = { key: string; guide: string };

/** Checks the request and the person's key, and loads what every build needs. */
async function prepare(ctx: Ctx, b: Builder, text: string, what: string): Promise<Prepared> {
  const { env, user } = ctx;
  if (!user.active) throw waitlisted();
  if (!text) throw badRequest(`Describe ${what} first.`, "Say what you want, in your own words.");
  if (text.length > MAX_IDEA) throw badRequest(`Keep the description under ${MAX_IDEA} characters.`, "Start with the main idea; you can make more changes after.");
  const row = await loadRow(env, user.email, b);
  if (!row) throw err(409, "builder_not_connected", `Connect ${BUILDERS[b].name} first.`, "Paste your API key on the New app page.");
  await rateLimit(env, `build:${user.email}`, BUILDS_PER_MINUTE, `You started more than ${BUILDS_PER_MINUTE} builds in a minute.`);
  const key = await readServiceKey(env, user.email, BUILDERS[b].service, row);
  return { key, guide: withFlags(GUIDE_MD, await enabledFlags(env, user)) };
}

const GENERATORS: Record<Builder, (key: string, system: string, prompt: string, progress: Progress) => Promise<Generated>> = {
  claude: generateWithClaude,
  openai: generateWithOpenAi,
  gemini: generateWithGemini,
  grok: generateWithGrok,
};

async function generate(ctx: Ctx, b: Builder, key: string, system: string, prompt: string, progress: Progress): Promise<Generated> {
  const generated = await GENERATORS[b](key, system, prompt, progress);
  await markServiceKeyUsed(ctx.env, ctx.user.email, BUILDERS[b].service);
  return generated;
}

/** Builds an app from a description with the person's own API key, then publishes it to their space. */
export async function buildApp(ctx: Ctx, b: Builder, rawIdea: unknown, progress: Progress, rawDataWrites?: unknown): Promise<BuildResult> {
  const { env, user } = ctx;
  const idea = String(rawIdea ?? "").trim();
  const choice = parseBuildDataWrites(rawDataWrites);
  const { key, guide } = await prepare(ctx, b, idea, "your app");
  const generated = await generate(ctx, b, key, `${BUILD_RULES}\n\n---\n\n${guide}`, idea, progress);

  const title = titleOf(generated.html);
  const namespace = await homeNamespace(ctx);
  const mountPath = await freeMount(env, namespace, title);
  const dataWrites = choice === "auto" ? (writesSharedData(generated.html) ? "everyone" : "editors") : choice;
  const published = await publishSite(ctx, { namespace, mountPath, files: filesFromHtml(generated.html), title, dataWrites });
  await audit(env, user.email, "ai_build", `${namespace}/${mountPath}`, { siteId: published.site.id, builder: BUILDERS[b].name, model: generated.model, tokens: generated.tokens, dataWrites });
  return { url: published.url, title, namespace, mountPath, model: generated.model, dataWrites: { value: dataWrites, chosen: choice === "auto" ? "auto" : "you" }, siteId: published.site.id };
}

const MAX_EDIT_HTML = 400 * 1024;

/** Changes an existing app as asked, with the person's own API key, and publishes the new version in place. */
export async function editApp(ctx: Ctx, b: Builder, siteId: unknown, rawChange: unknown, progress: Progress): Promise<BuildResult> {
  const { env, user } = ctx;
  const { site } = await requireManageableSite(ctx, String(siteId ?? ""));
  const change = String(rawChange ?? "").trim();
  const { key, guide } = await prepare(ctx, b, change, "the change");
  const files = await currentFiles(env, site);
  const index = files.get("index.html");
  if (!index) throw err(409, "no_index", "This app has no index.html to change.", "Publish a new version from a file instead.");
  if (index.length > MAX_EDIT_HTML) throw err(413, "too_large", "This app's index.html is too big to change with AI here.", "Change it in your AI app, or publish a new version from a file.");
  const others = [...files.keys()].filter((p) => p !== "index.html");
  const prompt =
    `The app's current index.html:\n\n<index.html>\n${new TextDecoder().decode(index)}\n</index.html>\n\n` +
    (others.length ? `The app also has these files, which stay as they are: ${others.slice(0, 200).join(", ")}\n\n` : "") +
    `The change to make:\n${change}`;
  const generated = await generate(ctx, b, key, `${EDIT_RULES}\n\n---\n\n${guide}`, prompt, progress);

  files.set("index.html", new TextEncoder().encode(generated.html));
  // If someone published while the AI was writing, keep their version rather than overwrite it (audit A12).
  const published = await publishSite(ctx, { namespace: site.namespace, mountPath: site.mount_path, files, expectedVersion: site.current_version });
  const target = `${site.namespace}/${site.mount_path}`;
  await audit(env, user.email, "ai_edit", target, { siteId: site.id, builder: BUILDERS[b].name, model: generated.model, tokens: generated.tokens, change: change.slice(0, 200) });
  return { url: published.url, title: published.site.title ?? titleOf(generated.html), namespace: site.namespace, mountPath: site.mount_path, model: generated.model };
}
