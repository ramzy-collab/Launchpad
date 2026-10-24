import { audit } from "./audit";
import type { Env, User } from "./env";
import { isDev, now } from "./env";
import { ApiError, badRequest, err, notFound } from "./errors";
import type { SiteRow } from "./sites";
import { connectorKey, siteUses } from "./connectors";
import { checkProxyUrl } from "./ssrf";
import { b64decode, b64encode, b64url, hex, isTimeout, parseJsonArray } from "./util";

export const SECRET_NAME_RE = /^[a-z0-9_-]{1,64}$/;
export const SECRET_MAX_BYTES = 8 * 1024;
export const SECRETS_MAX_PER_SITE = 50;
export const PROXY_MAX_BODY = 1024 * 1024;
export const PROXY_MAX_RESPONSE = 5 * 1024 * 1024;
export const PROXY_TIMEOUT_MS = 20_000;
export const PROXY_RATE_PER_MINUTE = 60;
export const SECRET_MAX_HOSTS = 20;
const PROXY_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export type SecretValue = string | Record<string, unknown>;

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
// A person's own keys and sign-ins (service_keys): Gemini, Google Sheets, the AI builders.
// Encrypted like app secrets, bound to the person: AAD "user:<email>:<service>".
// ---------------------------------------------------------------------------

const personScope = (email: string) => `user:${email}`;

/**
 * Saves `plaintext` encrypted as the person's key for `service`, with `hint` (what the web app
 * shows of it). Without a hint, only replaces a key that's already there, keeping its hint.
 */
export async function saveServiceKey(env: Env, email: string, service: string, plaintext: string, hint?: string): Promise<void> {
  const { iv, ciphertext } = await encryptSecret(env, personScope(email), service, plaintext);
  const t = now();
  if (hint === undefined) {
    await env.DB.prepare("UPDATE service_keys SET iv = ?, ciphertext = ?, updated_at = ? WHERE owner_email = ? AND service = ?")
      .bind(iv, ciphertext, t, email, service)
      .run();
    return;
  }
  await env.DB.prepare(
    `INSERT INTO service_keys (owner_email, service, iv, ciphertext, hint, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
     ON CONFLICT(owner_email, service) DO UPDATE SET iv = excluded.iv, ciphertext = excluded.ciphertext,
       hint = excluded.hint, updated_at = excluded.updated_at`,
  )
    .bind(email, service, iv, ciphertext, hint, t)
    .run();
}

/** The plaintext of a service_keys row saved with saveServiceKey. */
export const readServiceKey = (env: Env, email: string, service: string, row: { iv: string; ciphertext: string }) =>
  decryptSecret(env, personScope(email), service, row.iv, row.ciphertext);

export const markServiceKeyUsed = (env: Env, email: string, service: string) =>
  env.DB.prepare("UPDATE service_keys SET last_used_at = ? WHERE owner_email = ? AND service = ?").bind(now(), email, service).run();

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function validateSecretName(name: string) {
  if (!SECRET_NAME_RE.test(name)) {
    throw badRequest("Secret names use 1–64 lowercase letters, digits, \"_\" or \"-\".", "Rename the secret, for example \"openweather_key\".");
  }
}

/** The app's saved secrets, and the connectors it was built to use (formelab.secrets.proxy reaches both). */
export async function secretList(env: Env, site: Pick<SiteRow, "id" | "connectors">): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT name FROM secrets WHERE site_id = ? ORDER BY name").bind(site.id).all<{ name: string }>();
  const names = new Set(results.map((r) => r.name));
  for (const n of parseJsonArray(site.connectors)) if (n !== "gemini") names.add(n);
  return [...names].sort();
}

/** Why the proxy may not call `url` (see ssrf.ts), or null; Formelab's own domains count as blocked. */
const blockedUrl = (env: Env, url: string, allowHttp: boolean) =>
  checkProxyUrl(url, { domain: env.DOMAIN, allowHttp }) ?? checkProxyUrl(url, { domain: env.APP_DOMAIN, allowHttp });

const HOST_RE = /^(\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Validates the hosts a secret may be sent to. Each is a host name ("api.example.com") or a
 * wildcard for its subdomains ("*.example.com"), and must itself pass the SSRF guard.
 */
export function parseSecretHosts(raw: unknown, env: Env): string[] {
  const hint = "Example: { \"value\": \"sk-123\", \"hosts\": [\"api.example.com\"] }. Use \"*.example.com\" to allow its subdomains.";
  if (!Array.isArray(raw) || raw.length === 0) {
    throw badRequest("Say which hosts this secret may be sent to, as a non-empty hosts list.", hint);
  }
  if (raw.length > SECRET_MAX_HOSTS) throw badRequest(`A secret can list at most ${SECRET_MAX_HOSTS} hosts.`, hint);
  const out = new Set<string>();
  for (const h of raw) {
    const host = typeof h === "string" ? h.trim().toLowerCase().replace(/\.$/, "") : "";
    const bare = host.startsWith("*.") ? host.slice(2) : host;
    const blocked = blockedUrl(env, `https://${bare}/`, false);
    if (!HOST_RE.test(host) || blocked) {
      throw badRequest(`"${String(h).slice(0, 80)}" is not an allowed host.`, "List public host names only, without a scheme or path. " + hint);
    }
    out.add(host);
  }
  return [...out].sort();
}

/** True if `hostname` is listed exactly, or is a subdomain of a listed "*.domain". */
export function hostAllowed(hostname: string, hosts: string[]): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  return hosts.some((a) => (a.startsWith("*.") ? h.endsWith(a.slice(1)) : h === a));
}

export async function secretSet(env: Env, site: SiteRow, actor: User, name: string, body: unknown) {
  validateSecretName(name);
  if (siteUses(site, name)) {
    throw err(
      409,
      "is_connector",
      `${name} is one of the owner's connectors, so its key isn't saved in the app.`,
      `The owner can replace it in Formelab under Connected apps → ${name}. The app keeps using it with formelab.secrets.proxy("${name}", ...).`,
    );
  }
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
  const hosts = parseSecretHosts((body as { hosts?: unknown }).hosts, env);
  const { iv, ciphertext } = await encryptSecret(env, site.id, name, plaintext);
  const res = await env.DB.prepare(
    `INSERT INTO secrets (site_id, name, iv, ciphertext, hosts, updated_at)
       SELECT ?1, ?2, ?3, ?4, ?7, ?5
        WHERE EXISTS (SELECT 1 FROM secrets WHERE site_id = ?1 AND name = ?2)
           OR (SELECT COUNT(*) FROM secrets WHERE site_id = ?1) < ?6
     ON CONFLICT(site_id, name) DO UPDATE SET iv = excluded.iv, ciphertext = excluded.ciphertext, hosts = excluded.hosts,
       updated_at = excluded.updated_at`,
  )
    .bind(site.id, name, iv, ciphertext, now(), SECRETS_MAX_PER_SITE, JSON.stringify(hosts))
    .run();
  if (!res.meta.changes) {
    throw err(409, "too_many_secrets", `This app already has ${SECRETS_MAX_PER_SITE} secrets.`, "Delete secrets you no longer use.");
  }
  await audit(env, actor.email, "secret_set", `${site.namespace}/${site.mount_path}`, { siteId: site.id, name, kind: typeof value === "string" ? "string" : "object", hosts });
  return { ok: true };
}

export async function secretDelete(env: Env, site: SiteRow, actor: User, name: string) {
  validateSecretName(name);
  await env.DB.prepare("DELETE FROM secrets WHERE site_id = ? AND name = ?").bind(site.id, name).run();
  await audit(env, actor.email, "secret_delete", `${site.namespace}/${site.mount_path}`, { siteId: site.id, name });
  return { ok: true };
}

async function loadSecret(env: Env, siteId: string, name: string): Promise<{ secret: SecretValue; hosts: string[] }> {
  const row = await env.DB.prepare("SELECT iv, ciphertext, hosts FROM secrets WHERE site_id = ? AND name = ?")
    .bind(siteId, name)
    .first<{ iv: string; ciphertext: string; hosts: string | null }>();
  if (!row) throw notFound(`Secret "${name}"`);
  const hosts = parseJsonArray(row.hosts);
  if (row.hosts === null || hosts.length === 0) {
    throw err(
      409,
      "secret_needs_hosts",
      `Secret "${name}" was saved before secrets had to name the hosts they may be sent to, so it can't be used yet.`,
      "An owner or editor of this app needs to set it again with its hosts: formelab.secrets.set(name, value, { hosts: [\"api.example.com\"] }).",
    );
  }
  let pt: string;
  try {
    pt = await decryptSecret(env, siteId, name, row.iv, row.ciphertext);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw err(500, "secret_unreadable", `Secret "${name}" could not be decrypted.`, "Set the secret again.");
  }
  return { secret: JSON.parse(pt) as SecretValue, hosts };
}

// ---------------------------------------------------------------------------
// Placeholders
// ---------------------------------------------------------------------------

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

export function placeholderValues(secret: SecretValue): Map<string, string> {
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
 * A value as an API might echo it back: as is, and base64 (standard and URL-safe, unpadded),
 * URL-encoded and hex. Best effort (audit finding #7): a value split, reversed or re-encoded
 * some other way still gets through, which is why secrets can only reach their own hosts.
 */
function encodings(v: string): string[] {
  const bytes = new TextEncoder().encode(v);
  const h = hex(bytes);
  return [v, b64encode(bytes).replace(/=+$/, ""), b64url(bytes), encodeURIComponent(v), h, h.toUpperCase()];
}

/**
 * Some APIs echo request headers back (httpbin does). Scrub the secret's values from
 * anything returned to the browser so the key never reaches client code.
 */
export function redact(text: string, values: Map<string, string>): string {
  const needles = [...new Set([...values.values()].filter((v) => v.length >= 6).flatMap(encodings))].sort((a, b) => b.length - a.length);
  for (const n of needles) text = text.split(n).join("[redacted]");
  return text;
}

// ---------------------------------------------------------------------------
// Rate limit
// ---------------------------------------------------------------------------

/** Proxy calls a minute from one person other than the app's owner (VIEWER_LIMITER's limit in production). */
export const PROXY_VIEWER_PER_MINUTE = 20;

/**
 * The app's limit, and below it one for each person other than the owner, checked first so one
 * person can't use up the app's minute for everyone else (audit finding #8).
 */
export async function checkRate(env: Env, site: SiteRow, viewer: User) {
  if (viewer.email !== site.owner_email) {
    await rateLimit(
      env,
      `proxy-viewer:${site.id}:${viewer.email}`,
      PROXY_VIEWER_PER_MINUTE,
      `You made more than ${PROXY_VIEWER_PER_MINUTE} proxy calls in this app in a minute.`,
      env.VIEWER_LIMITER,
    );
  }
  await rateLimit(env, site.id, PROXY_RATE_PER_MINUTE, `This app made more than ${PROXY_RATE_PER_MINUTE} proxy calls in a minute.`);
}

const DAY_MS = 86_400_000;
const dayBucket = (key: string) => `${key}:day${Math.floor(now() / DAY_MS)}`;

/** Adds `by` to a D1 rate counter (made if new, expiring at `expiresAt`) and returns its new count. */
export async function bumpCounter(env: Env, bucket: string, expiresAt: number, by = 1): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO rate_counters (bucket, count, expires_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(bucket) DO UPDATE SET count = count + ?2 RETURNING count`,
  )
    .bind(bucket, by, expiresAt)
    .first<{ count: number }>();
  return row?.count ?? by;
}

/** Adds `by` to today's (UTC) counter for `key` and returns its new count. */
export const bumpToday = (env: Env, key: string, by = 1) =>
  bumpCounter(env, dayBucket(key), (Math.floor(now() / DAY_MS) + 2) * DAY_MS, by);

/**
 * At most `perMinute` calls a minute for `key`. When the limiter binding (PROXY_LIMITER unless
 * another is given) is configured, its own limit applies instead, so it must match `perMinute`.
 */
export async function rateLimit(
  env: Env,
  key: string,
  perMinute: number,
  message: string,
  limiter: RateLimit | undefined = env.PROXY_LIMITER,
  hint = "Wait a minute, and cache results in KV or localStorage instead of refetching.",
) {
  let ok: boolean;
  if (limiter) {
    ok = (await limiter.limit({ key })).success;
  } else {
    const minute = Math.floor(now() / 60_000);
    ok = (await bumpCounter(env, `${key}:${minute}`, (minute + 2) * 60_000)) <= perMinute;
    if (Math.random() < 0.02) await env.DB.prepare("DELETE FROM rate_counters WHERE expires_at < ?").bind(now()).run();
  }
  if (!ok) throw err(429, "rate_limited", message, hint);
}

/**
 * At most `perDay` calls a UTC day for `key`, counted in D1 (rate limiter bindings only count by
 * the minute). Every call counts, including ones turned away, so a caller can't keep retrying.
 */
export async function dailyLimit(env: Env, key: string, perDay: number, message: string, hint: string) {
  if ((await bumpToday(env, key)) > perDay) throw err(429, "rate_limited", message, hint);
}

/** How many calls `key` has made today (see dailyLimit). */
export async function usedToday(env: Env, key: string): Promise<number> {
  return (await env.DB.prepare("SELECT count FROM rate_counters WHERE bucket = ?").bind(dayBucket(key)).first<{ count: number }>())?.count ?? 0;
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

export interface ParsedProxyRequest {
  url: string;
  method: string;
  headers: Record<string, unknown>;
  body?: string;
}

export function parseProxyRequest(req: ProxyRequest, how = "formelab.secrets.proxy(name, { url })"): ParsedProxyRequest {
  if (typeof req.url !== "string" || !req.url) throw badRequest("Missing url.", `Pass { url: "https://api.example.com/..." } to ${how}.`);
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
  return { url: req.url, method, headers: (req.headers as Record<string, unknown>) ?? {}, body };
}

/** A key the proxy sends: an app's saved secret or a connector (see src/connectors.ts). */
export interface ProxyKey {
  /** How errors name it, like `Secret "quo"` or `The connector quo`. */
  what: string;
  secret: SecretValue;
  hosts: string[];
  /** Added to the audit entry, like { secret: "quo" } or { connector: "quo" }. */
  audit: Record<string, unknown>;
  /** Puts the key into the request the way its service expects (connectors). */
  inject?: (url: URL, headers: Headers, value: string) => void;
  /** Where to change its hosts, for the host_not_allowed hint. */
  hostsHint: string;
}

export async function proxy(env: Env, site: SiteRow, viewer: User, name: string, req: ProxyRequest): Promise<ProxyResult> {
  validateSecretName(name);
  const parsed = parseProxyRequest(req);
  await checkRate(env, site, viewer);
  const saved = await env.DB.prepare("SELECT 1 FROM secrets WHERE site_id = ? AND name = ?").bind(site.id, name).first();
  // No saved key by that name: one of the connectors the app was built to use, if it has that one.
  if (!saved && siteUses(site, name)) {
    return sendProxied(env, site, viewer, parsed, await connectorKey(env, site, name));
  }
  const { secret, hosts } = await loadSecret(env, site.id, name);
  return sendProxied(env, site, viewer, parsed, {
    what: `Secret "${name}"`,
    secret,
    hosts,
    audit: { secret: name },
    hostsHint: "Call one of those hosts, or have an owner or editor set the secret again with this host added.",
  });
}

/** Sends a parsed request with `key`, only to its hosts, and scrubs the key from the answer. */
export async function sendProxied(env: Env, site: SiteRow, viewer: User, req: ParsedProxyRequest, key: ProxyKey): Promise<ProxyResult> {
  const { secret, hosts } = key;
  const method = req.method;
  let body = req.body;
  const values = placeholderValues(secret);

  let url = substitute(req.url, values, "url");
  const reason = blockedUrl(env, url, isDev(env));
  if (reason) throw err(400, "url_blocked", `That URL is not allowed: ${reason}.`, "The proxy only calls public https APIs.");
  // The URL's host is never echoed: a placeholder may have put the secret into it.
  if (!hostAllowed(new URL(url).hostname, hosts)) {
    throw err(403, "host_not_allowed", `${key.what} may only be sent to: ${hosts.join(", ")}.`, key.hostsHint);
  }

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
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
  if (key.inject && typeof secret === "string") {
    const u = new URL(url);
    key.inject(u, headers, secret);
    url = u.toString();
  }

  const host = new URL(url).hostname;
  let upstream: Response;
  try {
    upstream = await fetch(url, { method, headers, body, redirect: "manual", signal: AbortSignal.timeout(PROXY_TIMEOUT_MS) });
  } catch (e) {
    const timedOut = isTimeout(e);
    await audit(env, viewer.email, "proxy", `${site.namespace}/${site.mount_path}`, { siteId: site.id, ...key.audit, host, status: timedOut ? "timeout" : "error" });
    throw err(502, timedOut ? "upstream_timeout" : "upstream_error", timedOut ? "The API did not answer within 20 seconds." : "Could not reach the API.", "Check the URL and try again later.");
  }
  const capped = await readCapped(upstream, PROXY_MAX_RESPONSE);
  const text = redact(capped.text, values);
  const truncated = capped.truncated;
  await audit(env, viewer.email, "proxy", `${site.namespace}/${site.mount_path}`, { siteId: site.id, ...key.audit, host, status: upstream.status });
  const result: ProxyResult = { status: upstream.status, contentType: upstream.headers.get("content-type"), text, truncated };
  if (upstream.status >= 300 && upstream.status < 400) {
    const loc = upstream.headers.get("location");
    if (loc) result.location = redact(loc, values);
  }
  return result;
}
