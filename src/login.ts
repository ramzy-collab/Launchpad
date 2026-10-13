// Formelab's own login through WorkOS AuthKit (email codes, Google and other social sign-in).
//
// Flow: /login → /auth/login (sets a state cookie, redirects to WorkOS) → WorkOS → /auth/callback
// (exchanges the code server side, creates or updates the user, starts a session) → the page the
// person wanted. The web app and namespace hosts get their session from the apex through
// /auth/app. The admin panel (admin.DOMAIN) runs the same flow on its own host instead, so it
// has a separate, shorter sign-in that only admins can complete.
import type { Context } from "hono";
import { decodeJwt } from "jose";
import { audit } from "./audit";
import { isOwnerEmail, upsertUser } from "./auth";
import type { AppEnv, Env, User } from "./env";
import { err } from "./errors";
import { now } from "./env";
import { acceptedEmail, notifyAdminOfSignup, publicOrigin, sendEmail, waitlistJoinedEmail } from "./email";
import { plainPage } from "./serve";
import { adminOrigin, aiOrigin, hostKind } from "./hosts";
import {
  cookieHeader,
  createSession,
  destroySession,
  mintAppCode,
  readCookie,
  signedInAt,
  redeemAppCode,
  SESSION_COOKIE,
  ADMIN_SESSION_TTL_MS,
  APEX_SESSION_TTL_MS,
  APP_SESSION_TTL_MS,
} from "./session";
import { base32, escapeHtml, normEmail, randomBytes } from "./util";

export const WORKOS_API = "https://api.workos.com";
const STATE_COOKIE = "__Host-fl_login";
const RESTARTED = "-r";

export const workosEnabled = (env: Env) => !!(env.WORKOS_CLIENT_ID && env.WORKOS_API_KEY);

/** A path on this host to return to after signing in; anything else falls back to `fallback`. */
export function safeReturn(raw: string | null | undefined, fallback = "/app"): string {
  const v = String(raw ?? "");
  return v.startsWith("/") && !v.startsWith("//") && !v.startsWith("/\\") ? v : fallback;
}

export const onAdminHost = (c: Context<AppEnv>) => hostKind(new URL(c.req.url).hostname, c.env) === "admin";
export const homePath = (c: Context<AppEnv>) => (onAdminHost(c) ? "/" : "/app");

const PROVIDERS: Record<string, string> = { google: "GoogleOAuth", email: "authkit" };

/** GET /auth/login?provider=google|email&return=/path */
export function loginStart(c: Context<AppEnv>): Response {
  const env = c.env;
  if (!workosEnabled(env)) return c.redirect(homePath(c), 302);
  // "-r" marks a sign-in restarted by loginCallback, so it restarts at most once.
  const state = base32(randomBytes(20)) + (c.req.query("again") ? RESTARTED : "");
  const returnTo = safeReturn(c.req.query("return"), homePath(c));
  const url = new URL(`${WORKOS_API}/user_management/authorize`);
  url.searchParams.set("client_id", env.WORKOS_CLIENT_ID!);
  url.searchParams.set("redirect_uri", new URL("/auth/callback", c.req.url).toString());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("provider", PROVIDERS[c.req.query("provider") ?? ""] ?? "authkit");
  url.searchParams.set("state", state);
  const headers = new Headers({ location: url.toString(), "cache-control": "no-store" });
  headers.append("set-cookie", cookieHeader(STATE_COOKIE, `${state}.${encodeURIComponent(returnTo)}`, 600));
  return new Response(null, { status: 302, headers });
}

interface WorkosUser {
  id: string;
  email: string;
  email_verified?: boolean;
  first_name?: string | null;
  last_name?: string | null;
}

/** GET /auth/callback?code=...&state=... */
export async function loginCallback(c: Context<AppEnv>): Promise<Response> {
  const env = c.env;
  if (!workosEnabled(env)) return c.redirect(homePath(c), 302);
  const saved = readCookie(c.req.raw, STATE_COOKIE) ?? "";
  const dot = saved.indexOf(".");
  const state = dot > 0 ? saved.slice(0, dot) : "";
  const code = c.req.query("code");
  const sent = c.req.query("state") ?? "";
  if (!state || state !== sent || !code) {
    // A sign-in Formelab didn't start: WorkOS's own pages (Forgot password, an emailed link, its
    // sign-in page opened directly) come back without our state, and the state cookie lasts 10
    // minutes. Such a code is never redeemed (it could be someone else's sign-in); a fresh one is
    // started instead, which WorkOS answers straight away since the person is signed in there.
    // Only once, so a browser that drops cookies gets the message below rather than a loop.
    if (code && (!state || !sent) && !sent.endsWith(RESTARTED)) {
      const ret = state ? safeReturn(decodeURIComponent(saved.slice(dot + 1)), homePath(c)) : homePath(c);
      const headers = new Headers({ location: `/auth/login?again=1&return=${encodeURIComponent(ret)}`, "cache-control": "no-store" });
      headers.append("set-cookie", cookieHeader(STATE_COOKIE, "", 0));
      return new Response(null, { status: 302, headers });
    }
    return plainPage(400, "Sign-in expired", "This sign-in link was already used or took too long. Go back to Formelab and log in again.");
  }
  const returnTo = safeReturn(decodeURIComponent(saved.slice(dot + 1)), homePath(c));

  const res = await fetch(`${WORKOS_API}/user_management/authenticate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: env.WORKOS_CLIENT_ID,
      client_secret: env.WORKOS_API_KEY,
      grant_type: "authorization_code",
      code,
    }),
  });
  if (!res.ok) {
    console.error("workos authenticate failed", res.status);
    return plainPage(502, "Couldn't sign you in", "The sign-in service didn't accept this attempt. Go back to Formelab and try again.");
  }
  const signedIn = await res.json<WorkosAuthentication>();
  const done = await completeSignIn(c, signedIn, (headers) => {
    headers.set("location", returnTo);
    return new Response(null, { status: 302, headers });
  });
  done.headers.append("set-cookie", cookieHeader(STATE_COOKIE, "", 0));
  return done;
}

/** A successful answer from WorkOS's /user_management/authenticate. */
export interface WorkosAuthentication {
  user: WorkosUser;
  access_token?: string;
  /** How the person signed in: "Password", "MagicAuth", "GoogleOAuth", … */
  authentication_method?: string;
}

/** The sign-in method this browser used last, for the login page's "Last used" label. */
export const LAST_USED_COOKIE = "__Host-fl_last";
export type LastUsed = "email" | "google";
const lastUsedOf = (method: string | undefined): LastUsed | null =>
  method === "GoogleOAuth" ? "google" : method === "Password" || method === "MagicAuth" ? "email" : null;

/** Remembers that this person has a password, so the login page asks for it. */
export const markHasPassword = (env: Env, email: string) =>
  env.DB.prepare("UPDATE users SET has_password = 1 WHERE email = ?").bind(normEmail(email)).run();

/**
 * Turns a WorkOS sign-in into a Formelab one: checks the email, creates or updates the account
 * (new people land on the waitlist), and starts a session. `respond` builds the response from the
 * headers (cache-control and the session cookie) once everything checks out.
 */
export async function completeSignIn(
  c: Context<AppEnv>,
  { user: wu, access_token, authentication_method }: WorkosAuthentication,
  respond: (headers: Headers) => Response,
): Promise<Response> {
  const env = c.env;
  if (!wu?.email || wu.email_verified === false) {
    return plainPage(403, "Email not verified", "Confirm your email address with the code we sent, then log in again.");
  }

  const email = normEmail(wu.email);
  const workosSid = sessionIdOf(access_token);
  const name = [wu.first_name, wu.last_name].filter(Boolean).join(" ") || null;
  const headers = new Headers({ "cache-control": "no-store" });
  const last = lastUsedOf(authentication_method);
  if (last) headers.append("set-cookie", cookieHeader(LAST_USED_COOKIE, last, 365 * 24 * 3600));
  const remember = () => (authentication_method === "Password" ? markHasPassword(env, email) : null);

  // The admin panel's own sign-in: admins only, nobody is added to the waitlist from here.
  if (onAdminHost(c)) {
    const row = await env.DB.prepare("SELECT is_admin FROM users WHERE email = ?").bind(email).first<{ is_admin: number }>();
    if (!isOwnerEmail(env, email) && row?.is_admin !== 1) {
      return plainPage(403, "Not an admin", `${email} can't manage Formelab. Use your lab at ${aiOrigin(env, c.req.url)} instead.`);
    }
    await upsertUser(env, email, name, { workosId: wu.id });
    await remember();
    headers.append("set-cookie", await createSession(env, email, new URL(c.req.url).hostname, { expiresAt: now() + ADMIN_SESSION_TTL_MS, workosSid }));
    return respond(headers);
  }

  const status = isOwnerEmail(env, email) || (await isApproved(env, email)) ? "active" : "waitlisted";
  const user = await upsertUser(env, email, name, { status, workosId: wu.id });
  await remember();
  // Someone who signs in before being let in lands on the waitlist, so an admin can approve them.
  if (!user.active) {
    const added = await env.DB.prepare("INSERT INTO waitlist (email, created_at) VALUES (?, ?) ON CONFLICT(email) DO NOTHING").bind(email, now()).run();
    if (added.meta.changes) {
      const origin = publicOrigin(env, c.req.url);
      c.executionCtx.waitUntil(sendEmail(env, waitlistJoinedEmail(origin, email)));
      c.executionCtx.waitUntil(notifyAdminOfSignup(env, c.req.url, email, "login"));
    }
  }

  headers.append("set-cookie", await createSession(env, email, new URL(c.req.url).hostname, { workosSid }));
  return respond(headers);
}

async function isApproved(env: Env, email: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT approved_at FROM waitlist WHERE email = ?").bind(email).first<{ approved_at: number | null }>();
  return !!row?.approved_at;
}

/** The WorkOS session id (`sid`) in an AuthKit access token, or null. */
function sessionIdOf(accessToken: string | undefined): string | null {
  if (!accessToken) return null;
  try {
    const sid = decodeJwt(accessToken).sid;
    return typeof sid === "string" && sid ? sid : null;
  } catch {
    return null;
  }
}

/**
 * POST /auth/logout: ends the Formelab sign-in everywhere, then the WorkOS session behind it, so
 * the next "Log in" asks for a code or password again instead of signing straight back in.
 *
 * It answers with a page that moves on by itself rather than a redirect: the logout form is
 * posted from pages whose CSP says `form-action 'self'`, which also covers redirects after the
 * POST, so the browser would block a redirect to another host (formelab.ai, or WorkOS).
 */
export async function logout(c: Context<AppEnv>): Promise<Response> {
  const origin = c.req.header("origin");
  if (origin && origin !== new URL(c.req.url).origin) return plainPage(403, "Not allowed", "Log out from Formelab itself.");
  const id = c.get("sessionId");
  const { workosSid } = id ? await destroySession(c.env, id) : { workosSid: null };
  let to = onAdminHost(c) ? `${adminOrigin(c.env, c.req.url)}/login` : `${aiOrigin(c.env, c.req.url)}/`;
  if (workosSid && workosEnabled(c.env)) {
    const out = new URL(`${WORKOS_API}/user_management/sessions/logout`);
    out.searchParams.set("session_id", workosSid);
    out.searchParams.set("return_to", to);
    to = out.toString();
  }
  const page = movingOnPage("Logged out", "You're logged out of Formelab.", to);
  page.headers.append("set-cookie", cookieHeader(SESSION_COOKIE, "", 0));
  return page;
}

/** A page that sends the browser on to `to` straight away, with a link in case it doesn't. */
export function movingOnPage(title: string, message: string, to: string): Response {
  const href = escapeHtml(to);
  const body = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="0;url=${href}"><title>${escapeHtml(title)}</title></head><body style="font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#222"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)} <a href="${href}">Continue</a></p></body></html>`;
  return new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

/**
 * GET /auth/app?return=https://<host>/path (on DOMAIN, signed in): hands the sign-in to the web
 * app or a published app's host with a single-use code. The admin panel has its own sign-in.
 */
export async function appHandoff(c: Context<AppEnv>): Promise<Response> {
  let target: URL;
  try {
    target = new URL(c.req.query("return") ?? "");
  } catch {
    return plainPage(400, "Bad request", "The address to return to is missing or not valid.");
  }
  const here = new URL(c.req.url);
  const kind = hostKind(target.hostname, c.env);
  if (target.protocol !== here.protocol || (kind !== "app" && kind !== "ns")) {
    return plainPage(400, "Bad request", "Formelab only signs you in to its own apps.");
  }
  const sessionId = c.get("sessionId");
  // Signed in through Cloudflare Access instead: there is no session to hand over, and sending
  // the visitor back would only bring them here again. Access has to cover that host itself.
  if (!sessionId) return plainPage(403, "Sign-in required", `Log in to Formelab to open ${target.hostname}.`);
  const code = await mintAppCode(c.env, sessionId, target.hostname);
  const back = new URL("/_auth/callback", target.origin);
  back.searchParams.set("code", code);
  back.searchParams.set("return", target.pathname + target.search);
  return new Response(null, { status: 302, headers: { location: back.toString(), "cache-control": "no-store" } });
}

/** GET /_auth/callback?code=...&return=/path (namespace host) */
export async function appCallback(c: Context<AppEnv>): Promise<Response> {
  const host = new URL(c.req.url).hostname;
  const kind = hostKind(host, c.env);
  if (kind !== "app" && kind !== "ns") return plainPage(404, "Not found", "There is nothing here.");
  const ttl = kind === "app" ? APEX_SESSION_TTL_MS : APP_SESSION_TTL_MS;
  const cookie = await redeemAppCode(c.env, c.req.query("code") ?? "", host, ttl);
  if (!cookie) return plainPage(400, "Sign-in expired", "This link was already used or took too long. Open the app again.");
  const returnTo = c.req.query("return") ?? "/";
  const headers = new Headers({ location: returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/", "cache-control": "no-store" });
  headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

/** Admin: let someone in from the waitlist, or invite a new address. Emails them the first time. */
export async function approveWaitlist(
  env: Env,
  rawEmail: string,
  opts: { actor?: string; requestUrl?: string; waitUntil?: (p: Promise<unknown>) => void } = {},
): Promise<void> {
  const email = normEmail(rawEmail);
  const t = now();
  const before = await env.DB.prepare("SELECT approved_at FROM waitlist WHERE email = ?").bind(email).first<{ approved_at: number | null }>();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO waitlist (email, created_at, approved_at) VALUES (?1, ?2, ?2)
       ON CONFLICT(email) DO UPDATE SET approved_at = COALESCE(waitlist.approved_at, excluded.approved_at)`,
    ).bind(email, t),
    env.DB.prepare("UPDATE users SET status = 'active' WHERE email = ?").bind(email),
  ]);
  if (!before?.approved_at) {
    if (opts.actor) await audit(env, opts.actor, "waitlist_approve", email, { invited: !before });
    const send = sendEmail(env, acceptedEmail(publicOrigin(env, opts.requestUrl), email));
    if (opts.waitUntil) opts.waitUntil(send);
    else await send;
  }
}

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

/** Setting a password needs a sign-in this recent, so a stolen or forgotten session can't do it. */
export const PASSWORD_REAUTH_MS = 15 * 60_000;
const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_LENGTH = 256;

/** Whether the person behind this session signed in recently enough to set a password. */
export async function canSetPassword(env: Env, sessionId: string | undefined): Promise<boolean> {
  if (!sessionId) return false;
  const at = await signedInAt(env, sessionId);
  return at !== null && now() - at < PASSWORD_REAUTH_MS;
}

/**
 * Sets (or replaces) the signed-in person's password at WorkOS, so they can log in with their
 * email and password instead of a code. WorkOS applies its own password strength rules on top.
 */
export async function setPassword(env: Env, user: User, sessionId: string | undefined, password: unknown): Promise<void> {
  if (!workosEnabled(env)) {
    throw err(400, "passwords_off", "Passwords aren't available here.", "This Formelab signs people in through Cloudflare Access.");
  }
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    throw err(400, "weak_password", `Use at least ${MIN_PASSWORD_LENGTH} characters.`, "A short phrase of a few words is easy to remember and hard to guess.");
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw err(400, "weak_password", `Use at most ${MAX_PASSWORD_LENGTH} characters.`, "Pick a shorter password.");
  }
  if (!(await canSetPassword(env, sessionId))) {
    throw err(403, "reauth_required", "Log in again before setting a password.", "For your security, you need to have logged in within the last 15 minutes.");
  }
  const row = await env.DB.prepare("SELECT workos_id FROM users WHERE email = ?").bind(user.email).first<{ workos_id: string | null }>();
  if (!row?.workos_id) {
    throw err(403, "reauth_required", "Log in again before setting a password.", "Log out, then log in with your email.");
  }
  const res = await fetch(`${WORKOS_API}/user_management/users/${encodeURIComponent(row.workos_id)}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${env.WORKOS_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) {
    const body = await res.json<{ message?: unknown; errors?: { message?: unknown }[] }>().catch(() => null);
    const reason = [body?.errors?.[0]?.message, body?.message].find((m): m is string => typeof m === "string" && m.length > 0);
    console.error("workos set password failed", res.status);
    if (res.status === 400 || res.status === 422) {
      throw err(400, "weak_password", reason ?? "That password wasn't accepted.", "Try a longer password that isn't easy to guess.");
    }
    throw err(502, "upstream", "Couldn't save your password.", "Try again in a minute.");
  }
  await markHasPassword(env, user.email);
  await audit(env, user.email, "password_set", user.email);
}
