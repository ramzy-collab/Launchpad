import type { Env } from "./env";
import { now } from "./env";
import { badRequest, err, forbidden } from "./errors";
import { normEmail } from "./util";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const WAITLIST_RATE_PER_MINUTE = 10;

export interface WaitlistEntry {
  email: string;
  createdAt: number;
}

/**
 * Public, unauthenticated sign-up. Joining twice is a no-op with the same answer, so the response
 * never reveals whether an address was already on the list.
 */
export async function joinWaitlist(req: Request, env: Env): Promise<void> {
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
  if (email.length > 254 || !EMAIL.test(email)) {
    throw badRequest("That email address is not valid.", "Hmm, that email looks a little off. Mind checking it?");
  }
  await checkRate(env, req.headers.get("cf-connecting-ip") ?? "unknown");
  await env.DB.prepare("INSERT INTO waitlist (email, created_at) VALUES (?, ?) ON CONFLICT(email) DO NOTHING")
    .bind(email, now())
    .run();
}

export async function listWaitlist(env: Env, limit = 200): Promise<{ total: number; entries: WaitlistEntry[] }> {
  const [count, rows] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS n FROM waitlist").first<{ n: number }>(),
    env.DB.prepare("SELECT email, created_at FROM waitlist ORDER BY created_at DESC LIMIT ?")
      .bind(limit)
      .all<{ email: string; created_at: number }>(),
  ]);
  return {
    total: count?.n ?? 0,
    entries: rows.results.map((r) => ({ email: r.email, createdAt: r.created_at })),
  };
}

async function checkRate(env: Env, ip: string) {
  let ok: boolean;
  if (env.WAITLIST_LIMITER) {
    ok = (await env.WAITLIST_LIMITER.limit({ key: ip })).success;
  } else {
    const minute = Math.floor(now() / 60_000);
    const row = await env.DB.prepare(
      `INSERT INTO rate_counters (bucket, count, expires_at) VALUES (?1, 1, ?2)
       ON CONFLICT(bucket) DO UPDATE SET count = count + 1 RETURNING count`,
    )
      .bind(`waitlist:${ip}:${minute}`, (minute + 2) * 60_000)
      .first<{ count: number }>();
    ok = (row?.count ?? 0) <= WAITLIST_RATE_PER_MINUTE;
  }
  if (!ok) throw err(429, "rate_limited", "Too many sign-ups from this address.", "Give it a minute and try again.");
}
