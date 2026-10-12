// Formelab's own login through WorkOS AuthKit (email codes, Google and other social sign-in).
//
// Flow: /login → /auth/login (sets a state cookie, redirects to WorkOS) → WorkOS → /auth/callback
// (exchanges the code server side, creates or updates the user, starts a session) → the page the
// person wanted. Namespace hosts get their session from the apex through /auth/app.
import type { Context } from "hono";
import { isOwnerEmail, upsertUser } from "./auth";
import type { AppEnv, Env } from "./env";
import { now } from "./env";
import { plainPage } from "./serve";
import {
  cookieHeader,
  createSession,
  destroySession,
  mintAppCode,
  readCookie,
  redeemAppCode,
  SESSION_COOKIE,
} from "./session";
import { base32, normEmail, randomBytes } from "./util";

const WORKOS_API = "https://api.workos.com";
const STATE_COOKIE = "__Host-fl_login";

export const workosEnabled = (env: Env) => !!(env.WORKOS_CLIENT_ID && env.WORKOS_API_KEY);

/** A path on this host to return to after signing in; anything else falls back to /app. */
export function safeReturn(raw: string | null | undefined): string {
  const v = String(raw ?? "");
  return v.startsWith("/") && !v.startsWith("//") && !v.startsWith("/\\") ? v : "/app";
}

const PROVIDERS: Record<string, string> = { google: "GoogleOAuth", email: "authkit" };

/** GET /auth/login?provider=google|email&return=/path */
export function loginStart(c: Context<AppEnv>): Response {
  const env = c.env;
  if (!workosEnabled(env)) return c.redirect("/app", 302);
  const state = base32(randomBytes(20));
  const returnTo = safeReturn(c.req.query("return"));
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
  if (!workosEnabled(env)) return c.redirect("/app", 302);
  const saved = readCookie(c.req.raw, STATE_COOKIE) ?? "";
  const dot = saved.indexOf(".");
  const state = dot > 0 ? saved.slice(0, dot) : "";
  const code = c.req.query("code");
  if (!state || state !== c.req.query("state") || !code) {
    return plainPage(400, "Sign-in expired", "This sign-in link was already used or took too long. Go back to Formelab and log in again.");
  }
  const returnTo = safeReturn(decodeURIComponent(saved.slice(dot + 1)));

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
  const { user: wu } = await res.json<{ user: WorkosUser }>();
  if (!wu?.email || wu.email_verified === false) {
    return plainPage(403, "Email not verified", "Confirm your email address with the code we sent, then log in again.");
  }

  const email = normEmail(wu.email);
  const name = [wu.first_name, wu.last_name].filter(Boolean).join(" ") || null;
  const status = isOwnerEmail(env, email) || (await isApproved(env, email)) ? "active" : "waitlisted";
  const user = await upsertUser(env, email, name, { status, workosId: wu.id });
  // Someone who signs in before being let in lands on the waitlist, so an admin can approve them.
  if (!user.active) {
    await env.DB.prepare("INSERT INTO waitlist (email, created_at) VALUES (?, ?) ON CONFLICT(email) DO NOTHING").bind(email, now()).run();
  }

  const headers = new Headers({ location: returnTo, "cache-control": "no-store" });
  headers.append("set-cookie", await createSession(env, email, new URL(c.req.url).hostname));
  headers.append("set-cookie", cookieHeader(STATE_COOKIE, "", 0));
  return new Response(null, { status: 302, headers });
}

async function isApproved(env: Env, email: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT approved_at FROM waitlist WHERE email = ?").bind(email).first<{ approved_at: number | null }>();
  return !!row?.approved_at;
}

/** POST /auth/logout */
export async function logout(c: Context<AppEnv>): Promise<Response> {
  const origin = c.req.header("origin");
  if (origin && origin !== new URL(c.req.url).origin) return plainPage(403, "Not allowed", "Log out from Formelab itself.");
  const id = c.get("sessionId");
  if (id) await destroySession(c.env, id);
  const headers = new Headers({ location: "/", "cache-control": "no-store" });
  headers.append("set-cookie", cookieHeader(SESSION_COOKIE, "", 0));
  return new Response(null, { status: 302, headers });
}

/**
 * GET /auth/app?return=https://<ns>.DOMAIN/path (apex, signed in): hands the session to a
 * namespace host with a single-use code.
 */
export async function appHandoff(c: Context<AppEnv>, namespaceOf: (host: string) => string | null): Promise<Response> {
  let target: URL;
  try {
    target = new URL(c.req.query("return") ?? "");
  } catch {
    return plainPage(400, "Bad request", "The address to return to is missing or not valid.");
  }
  const here = new URL(c.req.url);
  if (target.protocol !== here.protocol || !namespaceOf(target.hostname)) {
    return plainPage(400, "Bad request", "Formelab only signs you in to its own apps.");
  }
  const sessionId = c.get("sessionId");
  // Signed in through Cloudflare Access instead: Access covers the namespace hosts itself.
  if (!sessionId) return c.redirect(target.toString(), 302);
  const code = await mintAppCode(c.env, sessionId, target.hostname);
  const back = new URL("/_auth/callback", target.origin);
  back.searchParams.set("code", code);
  back.searchParams.set("return", target.pathname + target.search);
  return new Response(null, { status: 302, headers: { location: back.toString(), "cache-control": "no-store" } });
}

/** GET /_auth/callback?code=...&return=/path (namespace host) */
export async function appCallback(c: Context<AppEnv>): Promise<Response> {
  const host = new URL(c.req.url).hostname;
  const cookie = await redeemAppCode(c.env, c.req.query("code") ?? "", host);
  if (!cookie) return plainPage(400, "Sign-in expired", "This link was already used or took too long. Open the app again.");
  const returnTo = c.req.query("return") ?? "/";
  const headers = new Headers({ location: returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/", "cache-control": "no-store" });
  headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

/** Admin: let someone in from the waitlist, or invite a new address. */
export async function approveWaitlist(env: Env, rawEmail: string): Promise<void> {
  const email = normEmail(rawEmail);
  const t = now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO waitlist (email, created_at, approved_at) VALUES (?1, ?2, ?2)
       ON CONFLICT(email) DO UPDATE SET approved_at = COALESCE(waitlist.approved_at, excluded.approved_at)`,
    ).bind(email, t),
    env.DB.prepare("UPDATE users SET status = 'active' WHERE email = ?").bind(email),
  ]);
}
