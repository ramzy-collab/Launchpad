import { audit } from "./audit";
import type { Env, User } from "./env";
import { isDev, now } from "./env";
import { ApiError, badRequest, err, notFound } from "./errors";
import type { SiteRow } from "./sites";
import { checkProxyUrl } from "./ssrf";
import { b64decode, b64encode } from "./util";

export { checkProxyUrl };

export const SECRET_NAME_RE = /^[a-z0-9_-]{1,64}$/;
export const SECRET_MAX_BYTES = 8 * 1024;
export const SECRETS_MAX_PER_SITE = 50;
export const PROXY_MAX_BODY = 1024 * 1024;
export const PROXY_MAX_RESPONSE = 5 * 1024 * 1024;
export const PROXY_TIMEOUT_MS = 20_000;
export const PROXY_RATE_PER_MINUTE = 60;
const PROXY_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

type SecretValue = string | Record<string, unknown>;

// ---------------------------------------------------------------------------
// Encryption at rest: AES-256-GCM, AAD = site_id + ":" + name
// ---------------------------------------------------------------------------

const keyCache = new Map<string, Promise<CryptoKey>>();

function kek(env: Env): Promise<CryptoKey> {
  const raw = env.SECRETS_KEK ?? "";
  let p = keyCache.get(raw);
  if (!p) {
    p = (async () => {
      let bytes: Uint8Array;
      try {
        bytes = b64decode(raw.trim());
      } catch {
        bytes = new Uint8Array(0);
      }
      if (bytes.length !== 32) {
        throw err(500, "misconfigured", "The platform's SECRETS_KEK is missing or not 32 bytes of base64.", "The platform admin needs to set SECRETS_KEK with `wrangler secret put`.");
      }
      return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
    })();
    p.catch(() => keyCache.delete(raw));
    keyCache.set(raw, p);
  }
  return p;
}

const aad = (siteId: string, name: string) => new TextEncoder().encode(`${siteId}:${name}`);

export async function encryptSecret(env: Env, siteId: string, name: string, plaintext: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(siteId, name) }, await kek(env), new TextEncoder().encode(plaintext));
  return { iv: b64encode(iv), ciphertext: b64encode(new Uint8Array(ct)) };
}

/** Throws if the ciphertext was not produced for exactly this site and name. */
export async function decryptSecret(env: Env, siteId: string, name: string, iv: string, ciphertext: string): Promise<string> {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64decode(iv), additionalData: aad(siteId, name) }, await kek(env), b64decode(ciphertext));
  return new TextDecoder().decode(pt);
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function validateSecretName(name: string) {
  if (!SECRET_NAME_RE.test(name)) {
    throw badRequest("Secret names use 1–64 lowercase letters, digits, \"_\" or \"-\".", "Rename the secret, for example \"openweather_key\".");
  }
}

export async function secretList(env: Env, siteId: string): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT name FROM secrets WHERE site_id = ? ORDER BY name").bind(siteId).all<{ name: string }>();
  return results.map((r) => r.name);
}

export async function secretSet(env: Env, site: SiteRow, actor: User, name: string, body: unknown) {
  validateSecretName(name);
  const value = (body as { value?: unknown } | null)?.value;
  const okObject = value !== null && typeof value === "object" && !Array.isArray(value);
  if (typeof value !== "string" && !okObject) {
    throw badRequest("Send { value: \"...\" } with a string or an object.", "Example: { \"value\": \"sk-123\" } or { \"value\": { \"username\": \"me\", \"password\": \"...\" } }.");
  }
  if (typeof value === "string" && value.length === 0) throw badRequest("The secret value is empty.", "Paste the actual key or password.");
  const plaintext = JSON.stringify(value);
  if (new TextEncoder().encode(plaintext).length > SECRET_MAX_BYTES) {
    throw err(413, "secret_too_large", "Secret values can be at most 8 KB.", "Store only the key itself, not whole config files.");
  }
  const { iv, ciphertext } = await encryptSecret(env, site.id, name, plaintext);
  const res = await env.DB.prepare(
    `INSERT INTO secrets (site_id, name, iv, ciphertext, updated_at)
       SELECT ?1, ?2, ?3, ?4, ?5
        WHERE EXISTS (SELECT 1 FROM secrets WHERE site_id = ?1 AND name = ?2)
           OR (SELECT COUNT(*) FROM secrets WHERE site_id = ?1) < ?6
     ON CONFLICT(site_id, name) DO UPDATE SET iv = excluded.iv, ciphertext = excluded.ciphertext, updated_at = excluded.updated_at`,
  )
    .bind(site.id, name, iv, ciphertext, now(), SECRETS_MAX_PER_SITE)
    .run();
  if (!res.meta.changes) {
    throw err(409, "too_many_secrets", `This app already has ${SECRETS_MAX_PER_SITE} secrets.`, "Delete secrets you no longer use.");
  }
  await audit(env, actor.email, "secret_set", `${site.namespace}/${site.mount_path}`, { siteId: site.id, name, kind: typeof value === "string" ? "string" : "object" });
  return { ok: true };
}

export async function secretDelete(env: Env, site: SiteRow, actor: User, name: string) {
  validateSecretName(name);
  await env.DB.prepare("DELETE FROM secrets WHERE site_id = ? AND name = ?").bind(site.id, name).run();
  await audit(env, actor.email, "secret_delete", `${site.namespace}/${site.mount_path}`, { siteId: site.id, name });
  return { ok: true };
}

async function loadSecret(env: Env, siteId: string, name: string): Promise<SecretValue> {
  const row = await env.DB.prepare("SELECT iv, ciphertext FROM secrets WHERE site_id = ? AND name = ?").bind(siteId, name).first<{ iv: string; ciphertext: string }>();
  if (!row) throw notFound(`Secret "${name}"`);
  let pt: string;
  try {
    pt = await decryptSecret(env, siteId, name, row.iv, row.ciphertext);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw err(500, "secret_unreadable", `Secret "${name}" could not be decrypted.`, "Set the secret again.");
  }
  return JSON.parse(pt) as SecretValue;
}

// ---------------------------------------------------------------------------
// Placeholders
// ---------------------------------------------------------------------------

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

function placeholderValues(secret: SecretValue): Map<string, string> {
  const m = new Map<string, string>();
  if (typeof secret === "string") {
    m.set("value", secret);
    return m;
  }
  for (const [k, v] of Object.entries(secret)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") m.set(k, String(v));
  }
  const pair = (a: string, b: string) => {
    const x = secret[a];
    const y = secret[b];
    return typeof x === "string" && typeof y === "string" ? `${x}:${y}` : null;
  };
  const basic = pair("public", "secret") ?? pair("username", "password");
  if (basic !== null && !m.has("basic")) m.set("basic", btoa(unescape(encodeURIComponent(basic))));
  return m;
}

/** Fills `{{...}}` placeholders. Unknown placeholders are an error, never left empty. */
export function substitute(template: string, values: Map<string, string>, where: string): string {
  return template.replace(PLACEHOLDER, (_all, key: string) => {
    const v = values.get(key);
    if (v === undefined) {
      const known = [...values.keys()].map((k) => `{{${k}}}`).join(", ");
      throw badRequest(`Unknown placeholder {{${key}}} in ${where}.`, `This secret provides: ${known || "nothing"}.`);
    }
    return v;
  });
}

/**
 * Some APIs echo request headers back (httpbin does). Scrub the secret's values from
 * anything returned to the browser so the key never reaches client code.
 */
export function redact(text: string, values: Map<string, string>): string {
  const needles = [...new Set(values.values())].filter((v) => v.length >= 6).sort((a, b) => b.length - a.length);
  for (const n of needles) text = text.split(n).join("[redacted]");
  return text;
}

// ---------------------------------------------------------------------------
// Rate limit
// ---------------------------------------------------------------------------

async function checkRate(env: Env, siteId: string) {
  let ok: boolean;
  if (env.PROXY_LIMITER) {
    ok = (await env.PROXY_LIMITER.limit({ key: siteId })).success;
  } else {
    const minute = Math.floor(now() / 60_000);
    const row = await env.DB.prepare(
      `INSERT INTO rate_counters (bucket, count, expires_at) VALUES (?1, 1, ?2)
       ON CONFLICT(bucket) DO UPDATE SET count = count + 1 RETURNING count`,
    )
      .bind(`${siteId}:${minute}`, (minute + 2) * 60_000)
      .first<{ count: number }>();
    ok = (row?.count ?? 0) <= PROXY_RATE_PER_MINUTE;
    if (Math.random() < 0.02) await env.DB.prepare("DELETE FROM rate_counters WHERE expires_at < ?").bind(now()).run();
  }
  if (!ok) {
    throw err(429, "rate_limited", `This app made more than ${PROXY_RATE_PER_MINUTE} proxy calls in a minute.`, "Wait a minute, and cache results in KV or localStorage instead of refetching.");
  }
}

// ---------------------------------------------------------------------------
// Proxy
// ---------------------------------------------------------------------------

export interface ProxyRequest {
  url?: unknown;
  method?: unknown;
  headers?: unknown;
  body?: unknown;
}

export interface ProxyResult {
  status: number;
  contentType: string | null;
  text: string;
  truncated: boolean;
  location?: string;
}

async function readCapped(res: Response, cap: number): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: "", truncated: false };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.length > cap) {
      text += decoder.decode(value.subarray(0, cap - size), { stream: true });
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    size += value.length;
    text += decoder.decode(value, { stream: true });
  }
  return { text: text + decoder.decode(), truncated };
}

export async function proxy(env: Env, site: SiteRow, viewer: User, name: string, req: ProxyRequest): Promise<ProxyResult> {
  validateSecretName(name);
  if (typeof req.url !== "string" || !req.url) throw badRequest("Missing url.", "Pass { url: \"https://api.example.com/...\" }.");
  const method = typeof req.method === "string" ? req.method.toUpperCase() : "GET";
  if (!PROXY_METHODS.has(method)) throw badRequest(`Method ${method.slice(0, 10)} is not allowed.`, "Use GET, POST, PUT, PATCH or DELETE.");
  if (req.headers !== undefined && (req.headers === null || typeof req.headers !== "object" || Array.isArray(req.headers))) {
    throw badRequest("headers must be an object of strings.", "Example: { \"Authorization\": \"Bearer {{value}}\" }.");
  }
  let body: string | undefined;
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body !== "string") throw badRequest("body must be a string.", "Use JSON.stringify(...) on objects before sending them.");
    if (new TextEncoder().encode(req.body).length > PROXY_MAX_BODY) throw err(413, "body_too_large", "The proxy request body is larger than 1 MB.", "Send less data.");
    if (method === "GET") throw badRequest("GET requests cannot have a body.", "Use POST, or move the data into the URL.");
    body = req.body;
  }

  await checkRate(env, site.id);
  const values = placeholderValues(await loadSecret(env, site.id, name));

  const url = substitute(req.url, values, "url");
  const reason = checkProxyUrl(url, { domain: env.DOMAIN, allowHttp: isDev(env) });
  if (reason) throw err(400, "url_blocked", `That URL is not allowed: ${reason}.`, "The proxy only calls public https APIs.");

  const headers = new Headers();
  for (const [k, v] of Object.entries((req.headers as Record<string, unknown>) ?? {})) {
    if (typeof v !== "string") throw badRequest(`Header "${k.slice(0, 40)}" must be a string.`, "Convert header values to strings.");
    const lk = k.toLowerCase();
    if (lk === "cookie" || lk === "host" || lk === "content-length") continue;
    try {
      headers.set(k, substitute(v, values, `header "${k.slice(0, 40)}"`));
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw badRequest(`Header "${k.slice(0, 40)}" is not valid.`, "Check the header name and value.");
    }
  }
  if (body !== undefined) body = substitute(body, values, "body");

  const host = new URL(url).hostname;
  let upstream: Response;
  try {
    upstream = await fetch(url, { method, headers, body, redirect: "manual", signal: AbortSignal.timeout(PROXY_TIMEOUT_MS) });
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    await audit(env, viewer.email, "proxy", `${site.namespace}/${site.mount_path}`, { siteId: site.id, secret: name, host, status: timedOut ? "timeout" : "error" });
    throw err(502, timedOut ? "upstream_timeout" : "upstream_error", timedOut ? "The API did not answer within 20 seconds." : "Could not reach the API.", "Check the URL and try again later.");
  }
  const capped = await readCapped(upstream, PROXY_MAX_RESPONSE);
  const text = redact(capped.text, values);
  const truncated = capped.truncated;
  await audit(env, viewer.email, "proxy", `${site.namespace}/${site.mount_path}`, { siteId: site.id, secret: name, host, status: upstream.status });
  const result: ProxyResult = { status: upstream.status, contentType: upstream.headers.get("content-type"), text, truncated };
  if (upstream.status >= 300 && upstream.status < 400) {
    const loc = upstream.headers.get("location");
    if (loc) result.location = redact(loc, values);
  }
  return result;
}
