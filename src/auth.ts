import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Env, User } from "./env";
import { now } from "./env";
import { badRequest, err, notFound, unauthorized } from "./errors";
import { sessionFromRequest } from "./session";
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
  return (await identifyBrowser(req, env))?.user ?? null;
}

/**
 * Like identifyHuman, and also returns the Formelab session id when the request is signed in
 * through Formelab's own login (a session cookie) rather than Cloudflare Access.
 */
export async function identifyBrowser(req: Request, env: Env): Promise<{ user: User; sessionId?: string } | null> {
  if (env.ENVIRONMENT === "dev" && env.DEV_USER) return { user: await upsertUser(env, normEmail(env.DEV_USER), null) };
  const session = await sessionFromRequest(req, env);
  if (session) return session;
  const token = req.headers.get("cf-access-jwt-assertion");
  const ident = token ? await verifyAccessJwt(token, env) : null;
  // People reach Formelab through Access only if its allow-list lets them in, so they are active.
  return ident ? { user: await upsertUser(env, ident.email, ident.name) } : null;
}

export const isOwnerEmail = (env: Env, email: string) => normEmail(email) === normEmail(env.OWNER_EMAIL ?? "");

/** Creates or refreshes a user. An existing account never loses active status here. */
export async function upsertUser(
  env: Env,
  email: string,
  name: string | null,
  opts: { status?: "active" | "waitlisted"; workosId?: string } = {},
): Promise<User> {
  const isAdmin = isOwnerEmail(env, email) ? 1 : 0;
  const status = isAdmin ? "active" : (opts.status ?? "active");
  const row = await env.DB.prepare(
    `INSERT INTO users (email, name, is_admin, created_at, status, workos_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(email) DO UPDATE SET name = COALESCE(excluded.name, users.name),
       is_admin = MAX(users.is_admin, excluded.is_admin),
       status = CASE WHEN users.status = 'active' OR excluded.status = 'active' THEN 'active' ELSE users.status END,
       workos_id = COALESCE(excluded.workos_id, users.workos_id)
     RETURNING email, name, is_admin, status`,
  )
    .bind(email, name, isAdmin, now(), status, opts.workosId ?? null)
    .first<UserRow>();
  return userOf(row!);
}

type UserRow = { email: string; name: string | null; is_admin: number; status: string };
export const userOf = (r: UserRow): User => ({ email: r.email, name: r.name, isAdmin: r.is_admin === 1, active: r.status === "active" });

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
  /** The AI app last seen using the key over MCP (its clientInfo name), if any. */
  clientName: string | null;
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
  return { token, info: { id, name, expiresAt, revoked: false, lastUsed: null, createdAt, clientName: null } satisfies TokenInfo };
}

/** Resolves `Authorization: Bearer fl_...` to its owner, or null if missing/invalid/expired/revoked. */
export async function identifyBearer(req: Request, env: Env): Promise<User | null> {
  const auth = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)\s*$/.exec(auth);
  return m ? userForDeployToken(env, m[1]!) : null;
}

/** Looks up a plaintext deploy token (fl_...) by its hash. Null if unknown, expired or revoked. */
export async function userForDeployToken(env: Env, token: string): Promise<User | null> {
  return (await resolveDeployToken(env, token))?.user ?? null;
}

/** Like userForDeployToken, also returning the key's id. */
export async function resolveDeployToken(env: Env, token: string): Promise<{ user: User; tokenId: string; clientName: string | null } | null> {
  if (!/^fl_[a-z2-7]{20,100}$/.test(token)) return null;
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT t.id, t.expires_at, t.revoked, t.client_name, u.email, u.name, u.is_admin, u.status
       FROM tokens t JOIN users u ON u.email = t.owner_email WHERE t.hash = ?`,
  )
    .bind(hash)
    .first<{ id: string; expires_at: number; revoked: number; client_name: string | null } & UserRow>();
  if (!row || row.revoked || row.expires_at <= now()) return null;
  await env.DB.prepare("UPDATE tokens SET last_used = ? WHERE id = ?").bind(now(), row.id).run();
  return { user: userOf(row), tokenId: row.id, clientName: row.client_name };
}

/** Remembers which AI app uses an access key (from its MCP initialize message). */
export async function noteTokenClient(env: Env, tokenId: string, clientName: string): Promise<void> {
  await env.DB.prepare("UPDATE tokens SET client_name = ? WHERE id = ? AND client_name IS NOT ?").bind(clientName, tokenId, clientName).run();
}

/** The current record for a known user, or null. */
export async function getUser(env: Env, email: string): Promise<User | null> {
  const row = await env.DB.prepare("SELECT email, name, is_admin, status FROM users WHERE email = ?").bind(email).first<UserRow>();
  return row ? userOf(row) : null;
}

export async function listTokens(env: Env, user: User): Promise<TokenInfo[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, name, expires_at, revoked, last_used, created_at, client_name FROM tokens WHERE owner_email = ? ORDER BY created_at DESC",
  )
    .bind(user.email)
    .all<{ id: string; name: string; expires_at: number; revoked: number; last_used: number | null; created_at: number; client_name: string | null }>();
  return results.map((r) => ({
    id: r.id,
    name: r.name,
    expiresAt: r.expires_at,
    revoked: r.revoked === 1,
    lastUsed: r.last_used,
    createdAt: r.created_at,
    clientName: r.client_name,
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

/**
 * Viewing a site's files and using its KV, secret proxy and connected services. "all" means every
 * Formelab member: anyone can sign in and land on the waitlist, so waitlisted people only see apps
 * shared with them by name.
 */
export const canViewSite = (u: User, site: SiteRow, ns: NamespaceRow) =>
  (site.visibility !== "restricted" && u.active) || canManageSite(u, site, ns) || has(site.allowed_emails, u.email);

/** The app's owner, or the owner of its namespace: the people who may delete it and choose its editors. */
export const isAppOwner = (u: User, site: SiteRow, ns: NamespaceRow) => site.owner_email === u.email || isNamespaceOwner(u, ns);

/**
 * Changing who can open an app (visibility, share list, public link, link previews): its owners,
 * and editors the owner listed in `sharers` (audit finding #10). Other editors and namespace
 * editors can update the app but not widen who sees it.
 */
export const canShareSite = (u: User, site: SiteRow, ns: NamespaceRow) =>
  isAppOwner(u, site, ns) || (has(site.sharers ?? "[]", u.email) && has(site.editors, u.email));

export const ownerOnly = () =>
  err(403, "owner_only", "Only the namespace owner can do that.", "Ask the namespace owner to make this change.");
