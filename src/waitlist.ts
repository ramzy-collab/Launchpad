import type { Env } from "./env";
import { now } from "./env";
import { badRequest, forbidden } from "./errors";
import { aiOrigin } from "./hosts";
import { rateLimit } from "./secrets";
import { isEmail, normEmail } from "./util";
import { notifyAdminOfSignup, sendEmail, waitlistJoinedEmail } from "./email";

export const WAITLIST_RATE_PER_MINUTE = 10;

export interface WaitlistEntry {
  email: string;
  createdAt: number;
  approvedAt: number | null;
  /** Whether they have logged in at least once (and so have an account). */
  signedIn: boolean;
}

/**
 * Public, unauthenticated sign-up. Joining twice is a no-op with the same answer, so the response
 * never reveals whether an address was already on the list.
 */
export async function joinWaitlist(req: Request, env: Env, waitUntil: (p: Promise<unknown>) => void): Promise<void> {
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(req.url).origin) throw forbidden("Cross-origin requests are not allowed.");
  if (!(req.headers.get("content-type") ?? "").includes("application/json")) {
    throw badRequest("Send JSON: { \"email\": \"you@example.com\" }.", "Set content-type: application/json.");
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw badRequest("The request body is not valid JSON.", "Send { \"email\": \"you@example.com\" }.");
  }
  const raw = typeof body === "object" && body && "email" in body ? (body as { email: unknown }).email : null;
  const email = typeof raw === "string" ? normEmail(raw) : "";
  if (!isEmail(email)) {
    throw badRequest("That email address is not valid.", "Hmm, that email looks a little off. Mind checking it?");
  }
  await rateLimit(
    env,
    `waitlist:${req.headers.get("cf-connecting-ip") ?? "unknown"}`,
    WAITLIST_RATE_PER_MINUTE,
    "Too many sign-ups from this address.",
    env.WAITLIST_LIMITER,
    "Give it a minute and try again.",
  );
  await addToWaitlist(env, email, req.url, "form", waitUntil);
}

/**
 * Puts `email` on the waitlist, from the home page's form or a sign-in before being let in. Only
 * the first time sends the confirmation and tells the admin, so it can't be used to repeat-email someone.
 */
export async function addToWaitlist(env: Env, email: string, requestUrl: string, via: "form" | "login", waitUntil: (p: Promise<unknown>) => void) {
  const res = await env.DB.prepare("INSERT INTO waitlist (email, created_at) VALUES (?, ?) ON CONFLICT(email) DO NOTHING").bind(email, now()).run();
  if (!res.meta.changes) return;
  waitUntil(sendEmail(env, waitlistJoinedEmail(aiOrigin(env, requestUrl), email)));
  waitUntil(notifyAdminOfSignup(env, requestUrl, email, via));
}

export async function listWaitlist(
  env: Env,
  limit = 200,
  filter: "all" | "let-in-not-signed-in" = "all",
): Promise<{ total: number; entries: WaitlistEntry[] }> {
  const where = filter === "all" ? "" : "WHERE w.approved_at IS NOT NULL AND u.email IS NULL";
  const from = "FROM waitlist w LEFT JOIN users u ON u.email = w.email";
  const [count, rows] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS n ${from} ${where}`).first<{ n: number }>(),
    env.DB.prepare(`SELECT w.email, w.created_at, w.approved_at, u.email IS NOT NULL AS signed_in ${from} ${where} ORDER BY w.created_at DESC LIMIT ?`)
      .bind(limit)
      .all<{ email: string; created_at: number; approved_at: number | null; signed_in: number }>(),
  ]);
  return {
    total: count?.n ?? 0,
    entries: rows.results.map((r) => ({ email: r.email, createdAt: r.created_at, approvedAt: r.approved_at, signedIn: r.signed_in === 1 })),
  };
}
