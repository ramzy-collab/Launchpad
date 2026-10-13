// Google Gemini as a connected app: a person saves their Gemini API key once, and any of their
// apps can call Gemini through Formelab (formelab.gemini.generate in the SDK). The key is
// encrypted at rest, never sent to a browser, and only used for apps that person owns, so people
// they share an app with use the owner's key.
import { audit } from "./audit";
import type { Env, User } from "./env";
import { now } from "./env";
import { badRequest, err } from "./errors";
import { decryptSecret, encryptSecret, rateLimit } from "./secrets";
import type { SiteRow } from "./sites";

export const GEMINI_MODEL = "gemini-3.5-flash-lite";
export const GEMINI_MODEL_NAME = "Gemini 3.5 Flash-Lite";
const API = "https://generativelanguage.googleapis.com/v1beta";
const SERVICE = "gemini";
export const GEMINI_RATE_PER_MINUTE = 60; // the same limit as the PROXY_LIMITER binding, which enforces it in production
const MAX_BODY = 1024 * 1024;
const TIMEOUT_MS = 60_000;
const MAX_OUTPUT_TOKENS = 8192;

// The key is encrypted like app secrets, bound to the person: AAD "user:<email>:gemini".
const scope = (email: string) => `user:${email}`;

export interface ServiceStatus {
  connected: boolean;
  hint?: string;
  createdAt?: number;
  lastUsedAt?: number | null;
}

type Row = { iv: string; ciphertext: string; hint: string; created_at: number; last_used_at: number | null };

const loadRow = (env: Env, email: string) =>
  env.DB.prepare("SELECT iv, ciphertext, hint, created_at, last_used_at FROM service_keys WHERE owner_email = ? AND service = ?")
    .bind(email, SERVICE)
    .first<Row>();

export async function geminiStatus(env: Env, email: string): Promise<ServiceStatus> {
  const row = await loadRow(env, email);
  return row ? { connected: true, hint: row.hint, createdAt: row.created_at, lastUsedAt: row.last_used_at } : { connected: false };
}

const googleError = async (res: Response) => {
  try {
    const body = await res.json<{ error?: { message?: string } }>();
    return body.error?.message?.slice(0, 300) ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
};

/** Checks the key with Google (a free model lookup), then saves it encrypted. */
export async function connectGemini(env: Env, user: User, rawKey: unknown): Promise<ServiceStatus> {
  const key = String(rawKey ?? "").trim();
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(key)) {
    throw badRequest("That doesn't look like a Gemini API key.", "Copy the whole key from Google AI Studio (aistudio.google.com/apikey); it usually starts with \"AIza\".");
  }
  let res: Response;
  try {
    res = await fetch(`${API}/models/${GEMINI_MODEL}`, { headers: { "x-goog-api-key": key } });
  } catch {
    throw err(502, "gemini_unreachable", "Couldn't reach Google to check the key.", "Try again in a minute.");
  }
  if (!res.ok) {
    const why = await googleError(res);
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw badRequest(`Google didn't accept this key: ${why}`, "Check the key in Google AI Studio, or create a new one, then paste it again.");
    }
    throw err(502, "gemini_error", `Google couldn't check the key right now: ${why}`, "Try again in a minute.");
  }
  const { iv, ciphertext } = await encryptSecret(env, scope(user.email), SERVICE, key);
  const t = now();
  await env.DB.prepare(
    `INSERT INTO service_keys (owner_email, service, iv, ciphertext, hint, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
     ON CONFLICT(owner_email, service) DO UPDATE SET iv = excluded.iv, ciphertext = excluded.ciphertext,
       hint = excluded.hint, updated_at = excluded.updated_at`,
  )
    .bind(user.email, SERVICE, iv, ciphertext, key.slice(-4), t)
    .run();
  await audit(env, user.email, "service_connect", null, { service: "Google Gemini" });
  return geminiStatus(env, user.email);
}

export async function disconnectGemini(env: Env, user: User): Promise<{ ok: true }> {
  const res = await env.DB.prepare("DELETE FROM service_keys WHERE owner_email = ? AND service = ?").bind(user.email, SERVICE).run();
  if (res.meta.changes) await audit(env, user.email, "service_disconnect", null, { service: "Google Gemini" });
  return { ok: true };
}

export interface GenerateRequest {
  prompt?: unknown;
  contents?: unknown;
  system?: unknown;
  json?: unknown;
  schema?: unknown;
  maxOutputTokens?: unknown;
}

export interface GenerateResult {
  text: string;
  model: string;
  finishReason: string | null;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
}

const notConnected = () =>
  err(409, "gemini_not_connected", "This app's owner hasn't connected Google Gemini to Formelab.", "The owner can add their Gemini API key in Formelab under Connected apps → Google Gemini.");

/** Whether an app can use Gemini (its owner has connected a key). */
export async function geminiAvailable(env: Env, site: SiteRow): Promise<{ connected: boolean; model: string }> {
  return { connected: !!(await loadRow(env, site.owner_email)), model: GEMINI_MODEL };
}

/** Calls Gemini for an app with its owner's key. The key never leaves the server. */
export async function geminiGenerate(env: Env, site: SiteRow, viewer: User, req: GenerateRequest): Promise<GenerateResult> {
  const row = await loadRow(env, site.owner_email);
  if (!row) throw notConnected();

  let contents: unknown;
  if (typeof req.prompt === "string" && req.prompt.trim()) {
    contents = [{ role: "user", parts: [{ text: req.prompt }] }];
  } else if (Array.isArray(req.contents) && req.contents.length) {
    contents = req.contents;
  } else {
    throw badRequest("Send a prompt.", 'Call formelab.gemini.generate("your prompt"), or pass { contents } in Gemini\'s format.');
  }
  const generationConfig: Record<string, unknown> = {};
  if (req.maxOutputTokens !== undefined) {
    const n = Number(req.maxOutputTokens);
    if (!Number.isInteger(n) || n < 1 || n > MAX_OUTPUT_TOKENS) throw badRequest(`maxOutputTokens must be between 1 and ${MAX_OUTPUT_TOKENS}.`, "Ask for a shorter answer.");
    generationConfig.maxOutputTokens = n;
  }
  if (req.json === true || req.schema !== undefined) generationConfig.responseMimeType = "application/json";
  if (req.schema !== undefined) {
    if (!req.schema || typeof req.schema !== "object") throw badRequest("schema must be a JSON Schema object.", "Pass { schema: { type: \"object\", properties: { ... } } }.");
    generationConfig.responseJsonSchema = req.schema;
  }
  const body: Record<string, unknown> = { contents };
  if (typeof req.system === "string" && req.system.trim()) body.systemInstruction = { parts: [{ text: req.system }] };
  if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
  const payload = JSON.stringify(body);
  if (payload.length > MAX_BODY) throw err(413, "body_too_large", "The request to Gemini is larger than 1 MB.", "Send a shorter prompt or smaller images.");

  await rateLimit(env, `gemini:${site.id}`, GEMINI_RATE_PER_MINUTE, `This app asked Gemini more than ${GEMINI_RATE_PER_MINUTE} times in a minute.`);
  const key = await decryptSecret(env, scope(site.owner_email), SERVICE, row.iv, row.ciphertext);
  const target = `${site.namespace}/${site.mount_path}`;
  const done = (detail: Record<string, unknown>) =>
    Promise.all([
      audit(env, viewer.email, "gemini", target, { siteId: site.id, ...detail }),
      env.DB.prepare("UPDATE service_keys SET last_used_at = ? WHERE owner_email = ? AND service = ?").bind(now(), site.owner_email, SERVICE).run(),
    ]);

  let res: Response;
  try {
    res = await fetch(`${API}/models/${GEMINI_MODEL}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: payload,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    await done({ status: "timeout" });
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    throw err(504, "gemini_unreachable", timedOut ? "Gemini took too long to answer." : "Couldn't reach Gemini.", "Try again, or ask for a shorter answer.");
  }
  if (!res.ok) {
    const why = await googleError(res);
    await done({ status: res.status });
    if (res.status === 400) throw badRequest(`Gemini rejected the request: ${why}`, "Check the prompt or options you sent.");
    if (res.status === 401 || res.status === 403) {
      throw err(502, "gemini_key_rejected", "Google rejected the app owner's Gemini key.", "The owner can replace it in Formelab under Connected apps → Google Gemini.");
    }
    if (res.status === 429) throw err(429, "gemini_quota", `Gemini says the owner's key is over its limit: ${why}`, "Wait a bit, or raise the limits for the key in Google AI Studio.");
    throw err(502, "gemini_error", `Gemini had a problem: ${why}`, "Try again in a moment.");
  }
  const data = await res.json<{
    candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
  }>();
  const cand = data.candidates?.[0];
  const text = (cand?.content?.parts ?? []).filter((p) => !p.thought && typeof p.text === "string").map((p) => p.text).join("");
  const u = data.usageMetadata ?? {};
  const usage = { inputTokens: u.promptTokenCount ?? 0, outputTokens: u.candidatesTokenCount ?? 0, totalTokens: u.totalTokenCount ?? 0 };
  await done({ status: 200, tokens: usage.totalTokens });
  return { text, model: GEMINI_MODEL, finishReason: cand?.finishReason ?? null, usage };
}
