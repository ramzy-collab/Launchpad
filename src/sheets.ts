// Google Sheets as a connected app, through Google sign-in (OAuth): a person clicks Connect, picks
// their Google account and allows access to their spreadsheets. Their apps then read and write
// sheets through Formelab (formelab.sheets in the SDK). The tokens are encrypted at rest, never
// sent to a browser, and only used for apps that person owns.
//
// Formelab's Google OAuth client: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (README 1.9), with the
// redirect https://APP_DOMAIN/services/google-sheets/callback.
import type { Context } from "hono";
import { audit } from "./audit";
import type { AppEnv, Env, User } from "./env";
import { now } from "./env";
import { badRequest, err } from "./errors";
import { appOrigin } from "./hosts";
import { decryptSecret, encryptSecret, rateLimit } from "./secrets";
import { cookieHeader, readCookie } from "./session";
import { addSiteSheet, type SiteRow } from "./sites";
import { b64encode, base32, parseJsonArray, randomBytes } from "./util";

const b64url = (bytes: Uint8Array) => b64encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const SERVICE = "google_sheets";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const SHEETS_API = "https://sheets.googleapis.com/v4/";
export const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const STATE_COOKIE = "__Host-fl_sheets";
export const SHEETS_RATE_PER_MINUTE = 60;
const MAX_BODY = 1024 * 1024;
const TIMEOUT_MS = 30_000;

export const sheetsConfigured = (env: Env) => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
const scope = (email: string) => `user:${email}`;
const redirectUri = (env: Env, requestUrl: string) => `${appOrigin(env, requestUrl)}/services/google-sheets/callback`;

interface Tokens {
  refresh_token: string;
  access_token?: string;
  /** ms */
  expires_at?: number;
}

type Row = { iv: string; ciphertext: string; hint: string; created_at: number; last_used_at: number | null };
const loadRow = (env: Env, email: string) =>
  env.DB.prepare("SELECT iv, ciphertext, hint, created_at, last_used_at FROM service_keys WHERE owner_email = ? AND service = ?")
    .bind(email, SERVICE)
    .first<Row>();

async function saveTokens(env: Env, email: string, tokens: Tokens, googleEmail?: string) {
  const { iv, ciphertext } = await encryptSecret(env, scope(email), SERVICE, JSON.stringify(tokens));
  const t = now();
  if (googleEmail !== undefined) {
    await env.DB.prepare(
      `INSERT INTO service_keys (owner_email, service, iv, ciphertext, hint, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
       ON CONFLICT(owner_email, service) DO UPDATE SET iv = excluded.iv, ciphertext = excluded.ciphertext,
         hint = excluded.hint, updated_at = excluded.updated_at`,
    )
      .bind(email, SERVICE, iv, ciphertext, googleEmail, t)
      .run();
  } else {
    await env.DB.prepare("UPDATE service_keys SET iv = ?, ciphertext = ?, updated_at = ? WHERE owner_email = ? AND service = ?")
      .bind(iv, ciphertext, t, email, SERVICE)
      .run();
  }
}

export async function sheetsStatus(env: Env, email: string): Promise<{ connected: boolean; account?: string; createdAt?: number; lastUsedAt?: number | null }> {
  const row = await loadRow(env, email);
  return row ? { connected: true, account: row.hint, createdAt: row.created_at, lastUsedAt: row.last_used_at } : { connected: false };
}

// ---------------------------------------------------------------------------
// Connecting: GET /services/google-sheets/connect → Google → /services/google-sheets/callback
// ---------------------------------------------------------------------------

/** Sends the person to Google to allow access to their spreadsheets (state and PKCE in a cookie). */
export async function sheetsConnect(c: Context<AppEnv>): Promise<Response> {
  const env = c.env;
  if (!sheetsConfigured(env)) throw err(503, "not_configured", "Google Sheets isn't set up on this Formelab yet.", "The Formelab admin needs to add a Google OAuth client (README 1.9).");
  const state = base32(randomBytes(20));
  const verifier = base32(randomBytes(32));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const url = new URL(AUTH_URL);
  url.searchParams.set("client_id", env.GOOGLE_CLIENT_ID!);
  url.searchParams.set("redirect_uri", redirectUri(env, c.req.url));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", `openid email ${SHEETS_SCOPE}`);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent"); // always returns a refresh token
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  const headers = new Headers({ location: url.toString(), "cache-control": "no-store" });
  headers.append("set-cookie", cookieHeader(STATE_COOKIE, `${state}.${verifier}`, 600));
  return new Response(null, { status: 302, headers });
}

const back = (c: Context<AppEnv>, outcome: string) => {
  const headers = new Headers({ location: `/connected?sheets=${outcome}#google-sheets`, "cache-control": "no-store" });
  headers.append("set-cookie", cookieHeader(STATE_COOKIE, "", 0));
  return new Response(null, { status: 302, headers });
};

/** Google sends the person back here with a code; trade it for tokens and store them. */
export async function sheetsCallback(c: Context<AppEnv>): Promise<Response> {
  const env = c.env;
  const user = c.get("user");
  const saved = readCookie(c.req.raw, STATE_COOKIE) ?? "";
  const [state, verifier] = saved.split(".");
  if (c.req.query("error")) return back(c, "denied");
  const code = c.req.query("code");
  if (!state || !verifier || state !== c.req.query("state") || !code || !sheetsConfigured(env)) return back(c, "expired");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri(env, c.req.url),
    }),
  });
  if (!res.ok) {
    console.warn("google sheets token exchange failed", res.status);
    return back(c, "failed");
  }
  const t = await res.json<{ access_token: string; expires_in: number; refresh_token?: string; scope?: string; id_token?: string }>();
  if (!t.refresh_token || !(t.scope ?? "").split(" ").includes(SHEETS_SCOPE)) return back(c, "scope");
  // The id_token comes straight from Google's token endpoint over TLS: its claims can be read as is.
  let googleEmail = "";
  try {
    googleEmail = String(JSON.parse(atob(t.id_token!.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"))).email ?? "");
  } catch {
    /* no email claim: show the connection without one */
  }
  await saveTokens(env, user.email, { refresh_token: t.refresh_token, access_token: t.access_token, expires_at: now() + t.expires_in * 1000 }, googleEmail || "your Google account");
  await audit(env, user.email, "service_connect", null, { service: "Google Sheets" });
  return back(c, "connected");
}

export async function sheetsDisconnect(env: Env, user: User): Promise<{ ok: true }> {
  const row = await loadRow(env, user.email);
  if (!row) return { ok: true };
  try {
    const tokens = JSON.parse(await decryptSecret(env, scope(user.email), SERVICE, row.iv, row.ciphertext)) as Tokens;
    await fetch(REVOKE_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: tokens.refresh_token }) });
  } catch {
    /* revoking at Google is best effort; the tokens are deleted either way */
  }
  await env.DB.prepare("DELETE FROM service_keys WHERE owner_email = ? AND service = ?").bind(user.email, SERVICE).run();
  await audit(env, user.email, "service_disconnect", null, { service: "Google Sheets" });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Using it: apps call the Sheets API through /_api/services/google-sheets
// ---------------------------------------------------------------------------

const notConnected = () =>
  err(409, "sheets_not_connected", "This app's owner hasn't connected Google Sheets to Formelab.", "The owner can connect it in Formelab under Connected apps → Google Sheets.");

/** A valid access token for `email`, refreshing (and saving) it when it's about to expire. */
async function accessToken(env: Env, email: string): Promise<string> {
  const row = await loadRow(env, email);
  if (!row) throw notConnected();
  const tokens = JSON.parse(await decryptSecret(env, scope(email), SERVICE, row.iv, row.ciphertext)) as Tokens;
  if (tokens.access_token && (tokens.expires_at ?? 0) > now() + 60_000) return tokens.access_token;
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID ?? "", client_secret: env.GOOGLE_CLIENT_SECRET ?? "", refresh_token: tokens.refresh_token, grant_type: "refresh_token" }),
  });
  if (!res.ok) {
    throw err(502, "sheets_reconnect", "Google Sheets needs to be reconnected (Google no longer accepts the saved sign-in).", "The owner can reconnect it in Formelab under Connected apps → Google Sheets.");
  }
  const t = await res.json<{ access_token: string; expires_in: number; refresh_token?: string }>();
  await saveTokens(env, email, { refresh_token: t.refresh_token ?? tokens.refresh_token, access_token: t.access_token, expires_at: now() + t.expires_in * 1000 });
  return t.access_token;
}

export async function sheetsAvailable(env: Env, site: SiteRow) {
  return { connected: !!(await loadRow(env, site.owner_email)), available: sheetsConfigured(env) };
}

export interface SheetsRequest {
  method?: unknown;
  path?: unknown;
  query?: unknown;
  body?: unknown;
}

/** One Sheets API call (https://sheets.googleapis.com/v4/<path>) for an app, as its owner. */
export async function sheetsCall(env: Env, site: SiteRow, viewer: User, req: SheetsRequest): Promise<{ status: number; data: unknown }> {
  if (!sheetsConfigured(env)) throw err(503, "not_configured", "Google Sheets isn't set up on this Formelab yet.", "Ask the Formelab admin.");
  const method = String(req.method ?? "GET").toUpperCase();
  if (!["GET", "POST", "PUT", "DELETE"].includes(method)) throw badRequest("method must be GET, POST, PUT or DELETE.", "Use formelab.sheets.read/append/update/create, or request().");
  const path = String(req.path ?? "");
  if (!/^spreadsheets(\/[^?#\s]*)?(:[A-Za-z]+)?$/.test(path) || path.split("/").some((p) => p === ".." || p === ".")) {
    throw badRequest('path must be a Sheets API path starting with "spreadsheets", like "spreadsheets/<id>/values/Sheet1!A1:C10".', "See the Google Sheets API reference.");
  }
  const url = new URL(path, SHEETS_API);
  // Encoded dots ("%2e") count as ".." to URL parsing: make sure we're still inside the Sheets API.
  if (url.origin !== "https://sheets.googleapis.com" || !url.pathname.startsWith("/v4/spreadsheets") || /%2e/i.test(path)) {
    throw badRequest("That isn't a Google Sheets API path.", 'Use a path like "spreadsheets/<id>/values/Sheet1!A1:C10".');
  }
  // The owner's connection reaches every spreadsheet in their Google account, so each app may only
  // use the spreadsheets its owner listed for it (or created through it).
  const sheetId = /^spreadsheets\/([^/:]+)/.exec(path)?.[1];
  const creating = method === "POST" && path === "spreadsheets";
  if (creating) {
    if (viewer.email !== site.owner_email) {
      throw err(403, "sheets_owner_only", "Only the app's owner can create spreadsheets with it.", "New spreadsheets go into the owner's Google account. Ask the owner to create it.");
    }
  } else if (!sheetId) {
    throw badRequest('path must name a spreadsheet, like "spreadsheets/<id>/values/Sheet1!A1:C10".', "Use formelab.sheets.read/append/update, or create().");
  } else if (!parseJsonArray(site.sheets).includes(sheetId)) {
    throw err(
      403,
      "sheet_not_allowed",
      "This app isn't allowed to use that spreadsheet.",
      "The app's owner can add it under the app's settings in Formelab (Google Sheets), or with update_site's sheets field.",
    );
  }
  if (req.query && typeof req.query === "object") {
    for (const [k, v] of Object.entries(req.query as Record<string, unknown>)) {
      for (const item of Array.isArray(v) ? v : [v]) url.searchParams.append(k, String(item));
    }
  }
  const payload = req.body === undefined ? undefined : JSON.stringify(req.body);
  if (payload && payload.length > MAX_BODY) throw err(413, "body_too_large", "The request to Google Sheets is larger than 1 MB.", "Send fewer rows at a time.");

  if (!(await loadRow(env, site.owner_email))) throw notConnected();
  await rateLimit(env, `sheets:${site.id}`, SHEETS_RATE_PER_MINUTE, `This app called Google Sheets more than ${SHEETS_RATE_PER_MINUTE} times in a minute.`);
  const token = await accessToken(env, site.owner_email);
  const target = `${site.namespace}/${site.mount_path}`;
  const done = (status: number | string) =>
    Promise.all([
      audit(env, viewer.email, "sheets", target, { siteId: site.id, method, op: path.replace(/^spreadsheets\/[^/:]+/, "spreadsheets/…").slice(0, 80), status }),
      env.DB.prepare("UPDATE service_keys SET last_used_at = ? WHERE owner_email = ? AND service = ?").bind(now(), site.owner_email, SERVICE).run(),
    ]);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(payload ? { "content-type": "application/json" } : {}) },
      body: payload,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    await done("timeout");
    throw err(504, "sheets_unreachable", "Google Sheets didn't answer in time.", "Try again.");
  }
  const text = await res.text();
  await done(res.status);
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (res.ok && creating) {
    const created = (data as { spreadsheetId?: unknown })?.spreadsheetId;
    if (typeof created === "string" && /^[A-Za-z0-9_-]{20,128}$/.test(created)) await addSiteSheet(env, site.id, created);
  }
  if (!res.ok) {
    const message = (data as { error?: { message?: string } })?.error?.message ?? `HTTP ${res.status}`;
    if (res.status === 401) throw err(502, "sheets_reconnect", "Google Sheets needs to be reconnected.", "The owner can reconnect it in Formelab under Connected apps → Google Sheets.");
    if (res.status === 403) throw err(403, "sheets_forbidden", `Google Sheets refused: ${message}`, "Check that the owner's Google account can open this spreadsheet.");
    if (res.status === 404) throw err(404, "sheets_not_found", `Google Sheets: ${message}`, "Check the spreadsheet id and the range (e.g. Sheet1!A1:C10).");
    if (res.status === 429) throw err(429, "sheets_quota", `Google Sheets is busy: ${message}`, "Wait a minute and try again.");
    throw err(res.status >= 500 ? 502 : 400, "sheets_error", `Google Sheets: ${message}`, "Check the request against the Google Sheets API reference.");
  }
  return { status: res.status, data };
}
