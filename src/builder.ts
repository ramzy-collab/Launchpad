// The easy way, built in: a person saves their own Claude (Anthropic) or OpenAI API key once, and
// "Make it" on the New app page builds the app with that key right here, then publishes it. No
// connector to set up in Claude or ChatGPT, and the person's own API account pays for the tokens.
// Keys are encrypted at rest like Gemini's (service_keys, AAD "user:<email>:<service>") and never
// sent to a browser.
import Anthropic from "@anthropic-ai/sdk";
import { audit } from "./audit";
import type { Env, User } from "./env";
import { now } from "./env";
import { ApiError, badRequest, err } from "./errors";
import { enabledFlags, withFlags } from "./flags";
import { GUIDE_MD } from "./generated/assets";
import { decryptSecret, encryptSecret, rateLimit } from "./secrets";
import { createNamespace, getNamespace, getSiteByMount, listNamespaces, publishSite, RESERVED_LABELS, type Ctx } from "./sites";
import { filesFromHtml } from "./upload";

export type Builder = "claude" | "openai";
export const BUILDERS: Record<Builder, { service: string; name: string; keyUrl: string }> = {
  claude: { service: "anthropic", name: "Claude", keyUrl: "https://console.anthropic.com/settings/keys" },
  openai: { service: "openai", name: "ChatGPT (OpenAI)", keyUrl: "https://platform.openai.com/api-keys" },
};

export const CLAUDE_MODEL = "claude-opus-5-5";
const OPENAI_API = "https://api.openai.com/v1";
const MAX_IDEA = 4000;
const MAX_OUTPUT_TOKENS = 32000;
export const BUILDS_PER_MINUTE = 5;

export function parseBuilder(raw: unknown): Builder {
  if (raw === "claude" || raw === "openai") return raw;
  throw badRequest("Pick Claude or ChatGPT.", 'Send provider "claude" or "openai".');
}

const scope = (email: string) => `user:${email}`;
type Row = { iv: string; ciphertext: string; hint: string };
const loadRow = (env: Env, email: string, b: Builder) =>
  env.DB.prepare("SELECT iv, ciphertext, hint FROM service_keys WHERE owner_email = ? AND service = ?").bind(email, BUILDERS[b].service).first<Row>();

/** Which builders this person has a key for, with the key's last four characters. */
export async function builderKeys(env: Env, email: string): Promise<Partial<Record<Builder, { hint: string }>>> {
  const { results } = await env.DB.prepare("SELECT service, hint FROM service_keys WHERE owner_email = ? AND service IN ('anthropic', 'openai')")
    .bind(email)
    .all<{ service: string; hint: string }>();
  const out: Partial<Record<Builder, { hint: string }>> = {};
  for (const r of results) out[r.service === "anthropic" ? "claude" : "openai"] = { hint: r.hint };
  return out;
}

const keyRejected = (b: Builder, why: string) =>
  badRequest(`${b === "claude" ? "Anthropic" : "OpenAI"} didn't accept this key: ${why}`, `Check the key at ${BUILDERS[b].keyUrl}, or create a new one, then paste it again.`);

async function openaiError(res: Response) {
  try {
    const body = await res.json<{ error?: { message?: string } }>();
    return body.error?.message?.slice(0, 300) ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

const anthropic = (apiKey: string) => new Anthropic({ apiKey, maxRetries: 1, fetch: (...a: Parameters<typeof fetch>) => fetch(...a) });

/** Checks the key with Anthropic or OpenAI (a free model lookup), then saves it encrypted. */
export async function connectBuilder(env: Env, user: User, b: Builder, rawKey: unknown) {
  const key = String(rawKey ?? "").trim();
  if (!/^[A-Za-z0-9._~-]{20,400}$/.test(key)) {
    throw badRequest(`That doesn't look like ${b === "claude" ? "an Anthropic" : "an OpenAI"} API key.`, `Copy the whole key from ${BUILDERS[b].keyUrl}, with no spaces.`);
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
    let res: Response;
    try {
      res = await fetch(`${OPENAI_API}/models`, { headers: { authorization: `Bearer ${key}` } });
    } catch {
      throw err(502, "builder_unreachable", "Couldn't reach OpenAI to check the key.", "Try again in a minute.");
    }
    if (res.status === 401 || res.status === 403) throw keyRejected(b, await openaiError(res));
    if (!res.ok) throw err(502, "builder_error", `OpenAI couldn't check the key right now: ${await openaiError(res)}`, "Try again in a minute.");
  }
  const service = BUILDERS[b].service;
  const { iv, ciphertext } = await encryptSecret(env, scope(user.email), service, key);
  const t = now();
  await env.DB.prepare(
    `INSERT INTO service_keys (owner_email, service, iv, ciphertext, hint, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
     ON CONFLICT(owner_email, service) DO UPDATE SET iv = excluded.iv, ciphertext = excluded.ciphertext,
       hint = excluded.hint, updated_at = excluded.updated_at`,
  )
    .bind(user.email, service, iv, ciphertext, key.slice(-4), t)
    .run();
  await audit(env, user.email, "service_connect", null, { service: BUILDERS[b].name });
  return { connected: true, hint: key.slice(-4) };
}

export async function disconnectBuilder(env: Env, user: User, b: Builder) {
  const res = await env.DB.prepare("DELETE FROM service_keys WHERE owner_email = ? AND service = ?").bind(user.email, BUILDERS[b].service).run();
  if (res.meta.changes) await audit(env, user.email, "service_disconnect", null, { service: BUILDERS[b].name });
  return { ok: true };
}

const BUILD_RULES = `You are building a web app for a Formelab user, from their description. The guide below
describes Formelab. Formelab publishes what you write for you, so ignore the guide's publishing
section and don't ask the user anything: make sensible choices and build the whole app.

Reply with ONE complete, self-contained HTML document and nothing else: no explanation, no
Markdown fences. Start with <!doctype html>. It must have a short, friendly <title> naming the
app, a <link rel="icon"> with an inline SVG that fits the app, work well on a phone, and follow
the guide's ground rules and checklist. Save data with formelab.kv (or formelab.kv.mine for each
person's own data) so it lasts; the app is published with data_writes "everyone", so every viewer
can write shared data.`;

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

export const slugify = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "app";

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

async function generateWithClaude(key: string, system: string, idea: string, progress: Progress): Promise<Generated> {
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
    messages: [{ role: "user", content: idea }],
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
  if (!res.ok) throw err(502, "builder_error", `OpenAI had a problem: ${await openaiError(res)}`, "Try again in a moment.");
  const { data = [] } = await res.json<{ data?: { id: string }[] }>();
  const ranked = data
    .map((m) => ({ id: m.id, v: m.id.match(/^gpt-(\d+(?:\.\d+)?)$/)?.[1] }))
    .filter((m): m is { id: string; v: string } => !!m.v)
    .sort((a, b) => Number(b.v) - Number(a.v));
  if (!ranked.length) throw err(502, "builder_no_model", "Your OpenAI key can't use a GPT model.", "Check the key's project and model permissions at platform.openai.com.");
  return ranked[0]!.id;
}

async function generateWithOpenAi(key: string, system: string, idea: string, progress: Progress, modelOverride?: string): Promise<Generated> {
  const model = modelOverride || (await pickOpenAiModel(key));
  let res: Response;
  try {
    res = await fetch(`${OPENAI_API}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, instructions: system, input: idea, max_output_tokens: MAX_OUTPUT_TOKENS, stream: true }),
    });
  } catch {
    throw err(504, "builder_unreachable", "Couldn't reach OpenAI.", "Try again in a moment.");
  }
  if (!res.ok || !res.body) {
    const why = await openaiError(res);
    if (res.status === 401 || res.status === 403) throw err(502, "builder_key_rejected", "OpenAI rejected your API key.", "Paste a new key on the New app page (ChatGPT → Change key).");
    if (res.status === 429) throw err(429, "builder_quota", `Your OpenAI account is over a limit: ${why}`, "Wait a bit, or check your usage and billing at platform.openai.com.");
    throw err(502, "builder_error", `OpenAI had a problem: ${why}`, "Try again in a moment.");
  }
  let text = "";
  let tokens = 0;
  let failure: string | null = null;
  let incomplete = false;
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      let ev: { type?: string; delta?: string; message?: string; response?: { usage?: { total_tokens?: number }; error?: { message?: string }; incomplete_details?: { reason?: string } } };
      try {
        ev = JSON.parse(line.slice(5));
      } catch {
        continue;
      }
      if (ev.type === "response.output_text.delta" && ev.delta) {
        text += ev.delta;
        progress(text.length);
      } else if (ev.type === "response.completed") {
        tokens = ev.response?.usage?.total_tokens ?? 0;
      } else if (ev.type === "response.incomplete") {
        incomplete = true;
      } else if (ev.type === "response.failed" || ev.type === "error") {
        failure = ev.response?.error?.message ?? ev.message ?? "unknown error";
      }
    }
  }
  if (failure) throw err(502, "builder_error", `OpenAI had a problem: ${failure}`, "Try again in a moment.");
  if (incomplete) throw err(502, "builder_too_long", "The app came out too long to finish.", "Ask for a smaller first version, then add to it.");
  return { html: extractHtml(text), model, tokens };
}

export interface BuildResult {
  url: string;
  title: string;
  namespace: string;
  mountPath: string;
  model: string;
}

/** Builds an app from a description with the person's own API key, then publishes it to their space. */
export async function buildApp(ctx: Ctx, b: Builder, rawIdea: unknown, progress: Progress): Promise<BuildResult> {
  const { env, user } = ctx;
  if (!user.active) throw err(403, "waitlisted", "Your account is still on the waitlist.", "You can make apps once you're let in.");
  const idea = String(rawIdea ?? "").trim();
  if (!idea) throw badRequest("Describe your app first.", "Say what it should do, in your own words.");
  if (idea.length > MAX_IDEA) throw badRequest(`Keep the description under ${MAX_IDEA} characters.`, "Start with the main idea; you can add to the app later.");
  const row = await loadRow(env, user.email, b);
  if (!row) throw err(409, "builder_not_connected", `Connect ${BUILDERS[b].name} first.`, "Paste your API key on the New app page.");
  await rateLimit(env, `build:${user.email}`, BUILDS_PER_MINUTE, `You started more than ${BUILDS_PER_MINUTE} builds in a minute.`);

  const key = await decryptSecret(env, scope(user.email), BUILDERS[b].service, row.iv, row.ciphertext);
  const system = `${BUILD_RULES}\n\n---\n\n${withFlags(GUIDE_MD, await enabledFlags(env, user))}`;
  const generated = b === "claude" ? await generateWithClaude(key, system, idea, progress) : await generateWithOpenAi(key, system, idea, progress);
  await env.DB.prepare("UPDATE service_keys SET last_used_at = ? WHERE owner_email = ? AND service = ?").bind(now(), user.email, BUILDERS[b].service).run();

  const title = titleOf(generated.html);
  const namespace = await homeNamespace(ctx);
  const mountPath = await freeMount(env, namespace, title);
  const published = await publishSite(ctx, { namespace, mountPath, files: filesFromHtml(generated.html), title, dataWrites: "everyone" });
  await audit(env, user.email, "ai_build", `${namespace}/${mountPath}`, { siteId: published.site.id, builder: BUILDERS[b].name, model: generated.model, tokens: generated.tokens });
  return { url: published.url, title, namespace, mountPath, model: generated.model };
}
