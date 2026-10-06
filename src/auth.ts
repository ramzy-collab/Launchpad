import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Env, User } from "./env";
import { now } from "./env";
import { badRequest, err, notFound, unauthorized } from "./errors";
import type { NamespaceRow, SiteRow } from "./sites";
import { base32, normEmail, parseJsonArray, randomBytes, randomId, sha256Hex } from "./util";

// ---------------------------------------------------------------------------
// Human identity: Cloudflare Access JWT
// ---------------------------------------------------------------------------

const jwksCache = new Map<string, JWTVerifyGetKey>();

function jwksFor(teamDomain: string): JWTVerifyGetKey {
  let jwks = jwksCache.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`), {
      cacheMaxAge: 10 * 60 * 1000,
      cooldownDuration: 30 * 1000,
    });
    jwksCache.set(teamDomain, jwks);
  }
  return jwks;
}

/** Verifies a Cf-Access-Jwt-Assertion and returns the email and name it carries, or null. */
export async function verifyAccessJwt(token: string, env: Env): Promise<{ email: string; name: string | null } | null> {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;
  try {
    const { payload } = await jwtVerify(token, jwksFor(env.ACCESS_TEAM_DOMAIN), {
      audience: env.ACCESS_AUD,
      issuer: `https://${env.ACCESS_TEAM_DOMAIN}`,
      algorithms: ["RS256"],
    });
    if (typeof payload.email !== "string" || !payload.email.includes("@")) return null;
    const name = typeof payload.name === "string" ? payload.name : null;
    return { email: normEmail(payload.email), name };
  } catch {
    return null;
  }
}

/**
 * Resolves the human behind a browser request. In dev mode (ENVIRONMENT === "dev" and
 * DEV_USER set) the JWT check is skipped; in every other environment a valid Access JWT
 * is required. The plain Cf-Access-Authenticated-User-Email header is never trusted.
 */
export async function identifyHuman(req: Request, env: Env): Promise<User | null> {
  let ident: { email: string; name: string | null } | null = null;
  if (env.ENVIRONMENT === "dev" && env.DEV_USER) {
    ident = { email: normEmail(env.DEV_USER), name: null };
  } else {
    const token = req.headers.get("cf-access-jwt-assertion");
    if (token) ident = await verifyAccessJwt(token, env);
  }
  if (!ident) return null;
  return upsertUser(env, ident.email, ident.name);
}

export async function upsertUser(env: Env, email: string, name: string | null): Promise<User> {
  const isAdmin = normEmail(email) === normEmail(env.OWNER_EMAIL ?? "") ? 1 : 0;
  const row = await env.DB.prepare(
    `INSERT INTO users (email, name, is_admin, created_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(email) DO UPDATE SET name = COALESCE(excluded.name, users.name),
       is_admin = MAX(users.is_admin, excluded.is_admin)
     RETURNING email, name, is_admin`,
  )
    .bind(email, name, isAdmin, now())
    .first<{ email: string; name: string | null; is_admin: number }>();
  return { email: row!.email, name: row!.name, isAdmin: row!.is_admin === 1 };
}

// ---------------------------------------------------------------------------
// Agent identity: deploy tokens
// ---------------------------------------------------------------------------

export const TOKEN_DEFAULT_TTL_HOURS = 24;
export const TOKEN_MIN_TTL_HOURS = 1;
export const TOKEN_MAX_TTL_HOURS = 30 * 24;

export interface TokenInfo {
  id: string;
  name: string;
  expiresAt: number;
  revoked: boolean;
  lastUsed: number | null;
  createdAt: number;
}

export async function mintToken(env: Env, user: User, name: string, ttlHours = TOKEN_DEFAULT_TTL_HOURS) {
  name = String(name ?? "").trim();
  if (!name || name.length > 100) throw badRequest("Token name must be 1–100 characters.", "Give the token a short name, like \"laptop\" or \"claude-code\".");
  if (!Number.isFinite(ttlHours) || ttlHours < TOKEN_MIN_TTL_HOURS || ttlHours > TOKEN_MAX_TTL_HOURS) {
    throw badRequest("ttlHours must be between 1 and 720.", "Pick a lifetime between 1 hour and 30 days.");
  }
  const token = "fl_" + base32(randomBytes(32));
  const id = randomId("t_");
  const createdAt = now();
  const expiresAt = createdAt + Math.round(ttlHours * 3600_000);
  await env.DB.prepare(
    "INSERT INTO tokens (id, owner_email, name, hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(id, user.email, name, await sha256Hex(token), expiresAt, createdAt)
    .run();
  return { token, info: { id, name, expiresAt, revoked: false, lastUsed: null, createdAt } satisfies TokenInfo };
}

/** Resolves `Authorization: Bearer fl_...` to its owner, or null if missing/invalid/expired/revoked. */
export async function identifyBearer(req: Request, env: Env): Promise<User | null> {
  const auth = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(fl_[a-z2-7]{20,100})\s*$/.exec(auth);
  if (!m) return null;
  const hash = await sha256Hex(m[1]!);
  const row = await env.DB.prepare(
    `SELECT t.id, t.expires_at, t.revoked, u.email, u.name, u.is_admin
       FROM tokens t JOIN users u ON u.email = t.owner_email WHERE t.hash = ?`,
  )
    .bind(hash)
    .first<{ id: string; expires_at: number; revoked: number; email: string; name: string | null; is_admin: number }>();
  if (!row || row.revoked || row.expires_at <= now()) return null;
  await env.DB.prepare("UPDATE tokens SET last_used = ? WHERE id = ?").bind(now(), row.id).run();
  return { email: row.email, name: row.name, isAdmin: row.is_admin === 1 };
}

export async function listTokens(env: Env, user: User): Promise<TokenInfo[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, name, expires_at, revoked, last_used, created_at FROM tokens WHERE owner_email = ? ORDER BY created_at DESC",
  )
    .bind(user.email)
    .all<{ id: string; name: string; expires_at: number; revoked: number; last_used: number | null; created_at: number }>();
  return results.map((r) => ({
    id: r.id,
    name: r.name,
    expiresAt: r.expires_at,
    revoked: r.revoked === 1,
    lastUsed: r.last_used,
    createdAt: r.created_at,
  }));
}

export async function revokeToken(env: Env, user: User, id: string) {
  const res = await env.DB.prepare("UPDATE tokens SET revoked = 1 WHERE id = ? AND owner_email = ?").bind(id, user.email).run();
  if (!res.meta.changes) throw notFound("Token");
}

export const requireUser = (u: User | null): User => {
  if (!u) throw unauthorized();
  return u;
};

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

const has = (list: string, email: string) => parseJsonArray(list).map(normEmail).includes(email);

export const isNamespaceOwner = (u: User, ns: NamespaceRow) => ns.owner_email === u.email;
export const isNamespaceEditor = (u: User, ns: NamespaceRow) => isNamespaceOwner(u, ns) || has(ns.editors, u.email);

/** Publishing a new site into a namespace. */
export const canPublishTo = (u: User, ns: NamespaceRow) => isNamespaceEditor(u, ns);

/** Replace, update, delete a site, and manage its secrets. */
export const canManageSite = (u: User, site: SiteRow, ns: NamespaceRow) =>
  site.owner_email === u.email || has(site.editors, u.email) || isNamespaceEditor(u, ns);

/** Viewing a site's files and using its KV and secret proxy. */
export const canViewSite = (u: User, site: SiteRow, ns: NamespaceRow) =>
  site.visibility !== "restricted" || canManageSite(u, site, ns) || has(site.allowed_emails, u.email);

export const ownerOnly = () =>
  err(403, "owner_only", "Only the namespace owner can do that.", "Ask the namespace owner to make this change.");
