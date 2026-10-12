// Browser sessions for Formelab's own login (WorkOS AuthKit).
//
// The cookie is `__Host-` prefixed: host-only, Secure, Path=/. Apps on namespace hosts run their
// owners' JavaScript, and the prefix stops them from setting or overwriting the dashboard's
// cookie from a sibling subdomain. Each namespace host therefore gets its own session, handed
// over from the apex session through a single-use code (mintAppCode / redeemAppCode).
import type { Env, User } from "./env";
import { now } from "./env";
import { userOf } from "./auth";
import { base32, randomBytes, sha256Hex } from "./util";

export const SESSION_COOKIE = "__Host-fl_session";
export const APEX_SESSION_TTL_MS = 30 * 24 * 3600_000;
export const APP_SESSION_TTL_MS = 12 * 3600_000;
/** The admin panel's session is shorter than the dashboard's. */
export const ADMIN_SESSION_TTL_MS = 8 * 3600_000;
const CODE_TTL_MS = 60_000;

export function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function cookieHeader(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

const newToken = () => base32(randomBytes(32));

/** Creates a session for `host` and returns the Set-Cookie header value. */
export async function createSession(
  env: Env,
  email: string,
  host: string,
  opts: { parentId?: string; expiresAt?: number } = {},
): Promise<string> {
  const token = newToken();
  const t = now();
  const expiresAt = opts.expiresAt ?? t + APEX_SESSION_TTL_MS;
  await env.DB.prepare("INSERT INTO sessions (id, email, host, parent_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(await sha256Hex(token), email, host.toLowerCase(), opts.parentId ?? null, expiresAt, t)
    .run();
  if (Math.random() < 0.02) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(t),
      env.DB.prepare("DELETE FROM auth_codes WHERE expires_at < ?").bind(t),
    ]);
  }
  return cookieHeader(SESSION_COOKIE, token, Math.max(0, Math.floor((expiresAt - t) / 1000)));
}

/**
 * The user behind a session cookie on this request's host, or null. A namespace-host session is
 * only valid while the apex session that created it is, so logging out ends both.
 */
export async function sessionFromRequest(req: Request, env: Env): Promise<{ user: User; sessionId: string } | null> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token || !/^[a-z2-7]{20,100}$/.test(token)) return null;
  const id = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT s.id, s.expires_at, s.host, s.parent_id, u.email, u.name, u.is_admin, u.status,
            p.expires_at AS parent_expires
       FROM sessions s JOIN users u ON u.email = s.email
       LEFT JOIN sessions p ON p.id = s.parent_id
      WHERE s.id = ?`,
  )
    .bind(id)
    .first<{
      id: string; expires_at: number; host: string; parent_id: string | null;
      email: string; name: string | null; is_admin: number; status: string; parent_expires: number | null;
    }>();
  if (!row) return null;
  const t = now();
  if (row.host !== new URL(req.url).hostname.toLowerCase() || row.expires_at <= t) return null;
  if (row.parent_id && (row.parent_expires === null || row.parent_expires <= t)) return null;
  return { user: userOf(row), sessionId: row.id };
}

/**
 * Ends a sign-in everywhere: the session, the sign-in it was handed over from (if any), and every
 * other session handed over from that sign-in.
 */
export async function destroySession(env: Env, sessionId: string): Promise<void> {
  const row = await env.DB.prepare("SELECT parent_id FROM sessions WHERE id = ?").bind(sessionId).first<{ parent_id: string | null }>();
  if (row?.parent_id) sessionId = row.parent_id;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE parent_id = ?").bind(sessionId),
    env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId),
  ]);
}

/** A single-use code that lets `host` open its own session for the signed-in apex session. */
export async function mintAppCode(env: Env, sessionId: string, host: string): Promise<string> {
  const code = newToken();
  await env.DB.prepare("INSERT INTO auth_codes (id, session_id, host, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(code), sessionId, host.toLowerCase(), now() + CODE_TTL_MS)
    .run();
  return code;
}

/** Spends a code minted for this host. Returns the cookie for the new namespace-host session. */
export async function redeemAppCode(env: Env, code: string, host: string, maxTtlMs = APP_SESSION_TTL_MS): Promise<string | null> {
  if (!/^[a-z2-7]{20,100}$/.test(code)) return null;
  const row = await env.DB.prepare("DELETE FROM auth_codes WHERE id = ? RETURNING session_id, host, expires_at")
    .bind(await sha256Hex(code))
    .first<{ session_id: string; host: string; expires_at: number }>();
  if (!row || row.host !== host.toLowerCase() || row.expires_at <= now()) return null;
  const parent = await env.DB.prepare("SELECT email, expires_at FROM sessions WHERE id = ? AND parent_id IS NULL")
    .bind(row.session_id)
    .first<{ email: string; expires_at: number }>();
  if (!parent || parent.expires_at <= now()) return null;
  return createSession(env, parent.email, host, {
    parentId: row.session_id,
    expiresAt: Math.min(parent.expires_at, now() + maxTtlMs),
  });
}
