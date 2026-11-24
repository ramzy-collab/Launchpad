// Google Sheets as a connected app, through Google sign-in (OAuth): a person clicks Connect, picks
// their Google account and allows access to their spreadsheets. Their apps then read and write
// sheets through Formelab (formelab.sheets in the SDK). The tokens are encrypted at rest, never
// sent to a browser, and only used for apps that person owns.
//
// Formelab's Google OAuth client: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (README 1.9), with the
// redirect https://app.DOMAIN/services/google-sheets/callback (the web app).
import type { Context } from "hono";
import { audit } from "./audit";
import type { AppEnv, Env, User } from "./env";
import { now } from "./env";
import { badRequest, err } from "./errors";
import { appOrigin } from "./hosts";
import { markServiceKeyUsed, rateLimit, readServiceKey, saveServiceKey } from "./secrets";
import { viewerLimits } from "./gemini";
import { cookieHeader, readCookie } from "./session";
import { addSiteSheet, type SiteRow } from "./sites";
import { sourceLevel, type Rules, type Who } from "./rules";
import { b64url, base32, normEmail, parseJsonArray, randomBytes } from "./util";

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

/** Saves the tokens; `googleEmail` (shown as the connection's account) only when connecting. */
const saveTokens = (env: Env, email: string, tokens: Tokens, googleEmail?: string) => saveServiceKey(env, email, SERVICE, JSON.stringify(tokens), googleEmail);

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
  const headers = new Headers({ location: `/connected/google-sheets?sheets=${outcome}`, "cache-control": "no-store" });
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
    const tokens = JSON.parse(await readServiceKey(env, user.email, SERVICE, row)) as Tokens;
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
  const tokens = JSON.parse(await readServiceKey(env, email, SERVICE, row)) as Tokens;
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

/**
 * What people who use an app (not its owner or editors) may do with its spreadsheets: read values
 * and add or change rows, which is all formelab.sheets.read/append/update need. Not structural
 * edits (batchUpdate, clear, copyTo, DELETE), data-filter calls or whole-grid reads, which they
 * could otherwise make with the owner's account by calling the endpoint directly.
 */
function viewerMayCall(method: string, rest: string, query: URLSearchParams): boolean {
  if (rest === "") {
    // Spreadsheet metadata (tab names) only: grid data comes with includeGridData or a field mask.
    // "*" (or a mask like "sheets/*") would take in grid data without naming it.
    return method === "GET" && [...query.keys()].every((k) => k === "fields" || k === "ranges") && !/data|\*/i.test(query.getAll("fields").join(","));
  }
  if (rest === "/values:batchGet") return method === "GET";
  if (rest === "/values:batchUpdate") return method === "POST";
  if (!/^\/values\/.+/.test(rest)) return false;
  // values/<range>: get (GET), update (PUT) or append (POST). Clear is also POST, so name append.
  return method === "GET" || method === "PUT" || (method === "POST" && rest.endsWith(":append"));
}

/** A range in A1 notation with its tab named: columns count from 0, rows from 1, open ends are Infinity. */
export interface A1 {
  tab: string;
  c1: number;
  r1: number;
  c2: number;
  r2: number;
}

const colNum = (letters: string) => [...letters.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
export function colName(n: number): string {
  let s = "";
  for (let k = n + 1; k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(65 + ((k - 1) % 26)) + s;
  return s;
}
const quoteTab = (tab: string) => `'${tab.replace(/'/g, "''")}'`;

/** Parses "Tab!A2:C10", "'My tab'!A:C", "Tab!2:5" or "Tab!B3"; null for anything else (no tab, named ranges, R1C1). */
export function parseA1(range: string): A1 | null {
  const m = /^(?:'((?:[^']|'')+)'|([^'!]+))!([A-Za-z]{0,3})(\d{0,7})(?::([A-Za-z]{0,3})(\d{0,7}))?$/.exec(range);
  if (!m) return null;
  const tab = m[1] !== undefined ? m[1].replace(/''/g, "'") : m[2]!;
  const [sc, sr, ec, er] = [m[3]!, m[4]!, m[5], m[6]];
  if (ec === undefined) {
    if (!sc || !sr) return null; // one cell
    return { tab, c1: colNum(sc), r1: +sr, c2: colNum(sc), r2: +sr };
  }
  if ((!sc && !sr) || (!ec && !er) || (!sc && ec) || (!sr && er)) return null;
  const a = { tab, c1: sc ? colNum(sc) : 0, r1: sr ? +sr : 1, c2: ec ? colNum(ec) : Infinity, r2: er ? +er : Infinity };
  return a.r1 < 1 || a.c1 > a.c2 || a.r1 > a.r2 ? null : a;
}

const OWN_HINT = "People using this app reach only their own rows: use formelab.sheets.read, append and update with a range that names its tab, like Sheet1!A2:D.";
const ownOnly = (message: string, hint = OWN_HINT) => err(403, "not_allowed", message, hint);
// USER_ENTERED turns "=D5" into a formula, which would show the person another row's cell.
const isFormula = (v: unknown) => typeof v === "string" && /^\s*(?:=|\+|-\s*[A-Za-z(])/.test(v);

interface OwnPlan {
  kind: "read" | "append" | "update";
  range: string;
  a1: A1;
  values?: unknown[][];
  input: "RAW" | "USER_ENTERED";
}

/** The values read, append or update a person at "own" may make, checked before anything is sent. */
function ownPlan(method: string, rest: string, body: unknown, query: URLSearchParams): OwnPlan {
  const m = /^\/values\/(.+?)(:append)?$/.exec(rest);
  const kind = !m ? null : method === "GET" && !m[2] ? "read" : method === "PUT" && !m[2] ? "update" : method === "POST" && m[2] ? "append" : null;
  if (!m || !kind) throw ownOnly("People using this app can only read, add and change their own rows.");
  let range: string;
  try {
    range = decodeURIComponent(m[1]!);
  } catch {
    throw badRequest("The range is not correctly URL-encoded.", "Use formelab.sheets.read, append or update, which encode it for you.");
  }
  const a1 = parseA1(range);
  if (!a1) throw ownOnly(`Name the tab in the range, like "Sheet1!A2:D".`);
  let values: unknown[][] | undefined;
  if (kind !== "read") {
    const b = body as { values?: unknown; majorDimension?: unknown } | undefined;
    if (!b || !Array.isArray(b.values) || !b.values.every(Array.isArray) || (b.majorDimension !== undefined && b.majorDimension !== "ROWS")) {
      throw badRequest('The body must be { "values": [[...], ...] }, one list per row.', "Use formelab.sheets.append or update.");
    }
    values = b.values as unknown[][];
    if (values.some((row) => row.some(isFormula))) throw ownOnly("Formulas can't be saved in this app.", "To save text that starts with =, + or -, put an apostrophe (') before it.");
  }
  return { kind, range, a1, values, input: query.get("valueInputOption") === "RAW" ? "RAW" : "USER_ENTERED" };
}

/** One Sheets API call (https://sheets.googleapis.com/v4/<path>) for an app, as its owner, within the app's rules. */
export async function sheetsCall(env: Env, site: SiteRow, viewer: User, req: SheetsRequest, who: Who, rules: Rules | null): Promise<{ status: number; data: unknown }> {
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
  const rest = creating ? "" : path.slice(`spreadsheets/${sheetId}`.length);
  // The app's rules for this spreadsheet (spec step 6): "all" is what people using the app could always do.
  const level = creating ? "all" : sourceLevel(rules, who, !!site.rules_required, "sheets", sheetId!, method === "GET" ? "read" : "write");
  if (level === "none") {
    throw err(403, "not_allowed", "You can't use this spreadsheet in this app.", "The app's access rules (formelab.json) don't give your role this spreadsheet. Ask the app's owner.");
  }
  const ownerColumn = level === "own" && rules && "records" in rules ? rules.sources?.sheets?.[sheetId!]?.owner_column : undefined;
  const email = who.email ? normEmail(who.email) : null;
  if (level === "own" && (!ownerColumn || !email)) throw ownOnly("You can't use this spreadsheet in this app.");
  if (level === "own" && rest === "") {
    // Tab names only, with a mask Formelab sets: no fields or ranges of the caller's can bring cells along.
    if (method !== "GET") throw ownOnly("People using this app can only read, add and change their own rows.");
    url.search = "";
    url.searchParams.set("fields", "spreadsheetId,properties.title,sheets.properties");
  }
  const own = level === "own" && rest !== "" ? ownPlan(method, rest, req.body, url.searchParams) : null;
  if (!creating && !who.manages && !own && !viewerMayCall(method, rest, url.searchParams)) {
    throw err(
      403,
      "sheets_editors_only",
      "Only the app's owner and editors can do that with its spreadsheets.",
      "People using the app can read values and add or change rows: use formelab.sheets.read, append and update.",
    );
  }
  const payload = req.body === undefined ? undefined : JSON.stringify(req.body);
  if (payload && payload.length > MAX_BODY) throw err(413, "body_too_large", "The request to Google Sheets is larger than 1 MB.", "Send fewer rows at a time.");

  if (!(await loadRow(env, site.owner_email))) throw notConnected();
  await rateLimit(env, `sheets:${site.id}`, SHEETS_RATE_PER_MINUTE, `This app called Google Sheets more than ${SHEETS_RATE_PER_MINUTE} times in a minute.`);
  await viewerLimits(env, site, viewer, "sheets");
  const token = await accessToken(env, site.owner_email);

  let upstream: number | string | null = null;
  /** One request to Google with the owner's token; Google's errors become Formelab's. */
  const send = async (target: URL, m: string, body?: string): Promise<{ status: number; data: unknown }> => {
    let res: Response;
    try {
      res = await fetch(target, {
        method: m,
        headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      upstream = "timeout";
      throw err(504, "sheets_unreachable", "Google Sheets didn't answer in time.", "Try again.");
    }
    upstream = res.status;
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
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
  };

  try {
    if (own) return await ownCall(send, sheetId!, own, ownerColumn!, email!);
    const result = await send(url, method, payload);
    if (creating) {
      const created = (result.data as { spreadsheetId?: unknown })?.spreadsheetId;
      if (typeof created === "string" && /^[A-Za-z0-9_-]{20,128}$/.test(created)) await addSiteSheet(env, site.id, created);
    }
    return result;
  } finally {
    if (upstream !== null) {
      await Promise.all([
        audit(env, viewer.email, "sheets", `${site.namespace}/${site.mount_path}`, { siteId: site.id, method, op: path.replace(/^spreadsheets\/[^/:]+/, "spreadsheets/…").slice(0, 80), status: upstream }),
        markServiceKeyUsed(env, site.owner_email, SERVICE),
      ]);
    }
  }
}

type Send = (target: URL, method: string, body?: string) => Promise<{ status: number; data: unknown }>;
type ValueRange = { range?: string; values?: unknown[][] };

/**
 * A read, append or update by a person who may reach only their own rows: those whose owner column
 * (found by its heading in row 1 of the tab) holds their email. Rows that aren't theirs come back
 * empty, so row positions stay where the app expects them.
 */
async function ownCall(send: Send, sheetId: string, plan: OwnPlan, ownerColumn: string, email: string): Promise<{ status: number; data: unknown }> {
  const { a1 } = plan;
  const values = (range: string, suffix = "", query: Record<string, string> = {}) => {
    const u = new URL(`spreadsheets/${sheetId}/values/${encodeURIComponent(range)}${suffix}`, SHEETS_API);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    return u;
  };
  const shown = { majorDimension: "ROWS", valueRenderOption: "FORMATTED_VALUE" };
  const header = ((await send(values(`${quoteTab(a1.tab)}!1:1`, "", shown), "GET")).data as ValueRange)?.values?.[0] ?? [];
  const want = ownerColumn.trim().toLowerCase();
  const col = header.findIndex((v) => String(v ?? "").trim().toLowerCase() === want);
  if (col < 0) {
    throw err(409, "sheets_owner_column_missing", `The tab "${a1.tab}" has no "${ownerColumn}" column in row 1.`, "The app's owner can add that heading in row 1 of the tab, or fix owner_column in formelab.json.");
  }
  const ownerRange = (r1: number, r2: number) => `${quoteTab(a1.tab)}!${colName(col)}${r1}:${colName(col)}${r2 === Infinity ? "" : r2}`;
  const mine = (cell: unknown) => typeof cell === "string" && normEmail(cell) === email;
  const json = (v: unknown) => JSON.stringify(v);

  if (plan.kind === "read") {
    const u = new URL(`spreadsheets/${sheetId}/values:batchGet`, SHEETS_API);
    u.searchParams.append("ranges", plan.range);
    u.searchParams.append("ranges", ownerRange(a1.r1, a1.r2));
    for (const [k, v] of Object.entries(shown)) u.searchParams.set(k, v);
    const [main, owners] = ((await send(u, "GET")).data as { valueRanges?: ValueRange[] })?.valueRanges ?? [];
    // Google leaves out empty trailing rows but keeps leading ones, so row i is row r1 + i.
    const kept = (main?.values ?? []).map((row, i) => (a1.r1 + i === 1 || mine(owners?.values?.[i]?.[0]) ? row : []));
    while (kept.length && !kept.at(-1)!.length) kept.pop();
    return { status: 200, data: { range: main?.range ?? plan.range, majorDimension: "ROWS", ...(kept.length ? { values: kept } : {}) } };
  }

  const rows = plan.values!;
  const at = col - a1.c1; // the owner column's place in each row sent
  if (plan.kind === "append") {
    if (col < a1.c1 || col > a1.c2) throw ownOnly(`The range must include the "${ownerColumn}" column.`);
    if (!rows.every((row) => mine(row[at]))) throw ownOnly(`Each new row needs your email in "${ownerColumn}".`, `Put your email (formelab.me().email) in the "${ownerColumn}" column of every row.`);
    const res = await send(values(plan.range, ":append", { valueInputOption: plan.input, insertDataOption: "INSERT_ROWS" }), "POST", json({ majorDimension: "ROWS", values: rows }));
    const updates = (res.data as { spreadsheetId?: string; updates?: Record<string, unknown> })?.updates;
    const written = typeof updates?.updatedRange === "string" ? updates.updatedRange : null;
    // Google appends at the table it finds, which can start in another column than the range: then
    // the owner column got a different cell, so the row is taken out again.
    if (written && parseA1(written)?.c1 !== a1.c1) {
      await send(values(written, ":clear"), "POST", "{}");
      throw err(409, "sheets_append_moved", "Google Sheets put the new row in other columns than asked, so it wasn't saved.", "Start the range at the first column of the table, like Sheet1!A:D.");
    }
    // tableRange would show how far other people's rows go.
    return { status: res.status, data: { spreadsheetId: sheetId, updates } };
  }

  const last = a1.r1 + rows.length - 1;
  if (rows.some((row) => at >= 0 && at < row.length && row[at] !== null && row[at] !== undefined && !mine(row[at]))) {
    throw ownOnly(`Keep your email in "${ownerColumn}": rows can't be given to someone else.`);
  }
  if (rows.length) {
    const owners = ((await send(values(ownerRange(a1.r1, last), "", shown), "GET")).data as ValueRange)?.values ?? [];
    for (let i = 0; i < rows.length; i++) {
      if (!mine(owners[i]?.[0])) throw ownOnly("That range includes rows that aren't yours.", `You can change only rows with your email in "${ownerColumn}". Use append to add a row.`);
    }
  }
  // shortcut: Sheets has no conditional write, so rows an owner inserts between this check and the write can shift; fine while only owners and editors make structural edits.
  return send(values(plan.range, "", { valueInputOption: plan.input }), "PUT", json({ majorDimension: "ROWS", values: rows }));
}
