import type { Env } from "./env";
import { now } from "./env";
import { badRequest, err, notFound } from "./errors";
import { rateLimit } from "./secrets";
import { DEFAULT_GUEST_RESPONSES_PER_DAY, type SiteRow } from "./sites";
import { randomId } from "./util";

/**
 * Responses (formelab.responses): what people send an app, like form answers or sign-ups. Anyone
 * who can open the app may send one, and so may guests from its public link when the owner allows
 * it (sites.guest_responses). Only the app's owner and editors can read or delete them. Responses
 * can only be added, never read back or changed by whoever sent them, so letting anonymous people
 * send them doesn't open the app's data the way guest writes to shared KV would. Guests may send at
 * most sites.guest_responses_per_day a UTC day (the owner sets it; 500 unless they do), so a
 * leaked link can't fill the app with junk; signed-in people don't count toward it.
 */

export const RESPONSE_MAX_BYTES = 16 * 1024;
export const RESPONSES_MAX = 5000;
/** Responses an app takes a minute, from everyone together (PROXY_LIMITER's limit in production). */
export const RESPONSES_PER_MINUTE = 60;
/** Responses one guest (by IP address) may send an app a minute (RESPONSES_LIMITER's limit in production). */
export const GUEST_RESPONSES_PER_MINUTE = 5;
const LIST_MAX = 500;
const ID_RE = /^r_[a-z2-7]{20}$/;

export interface ResponseView {
  id: string;
  at: number;
  /** Who sent it; null for a guest who opened the app through its public link. */
  email: string | null;
  data: unknown;
}

export async function submitResponse(env: Env, site: SiteRow, email: string | null, rawBody: string, ip: string | null) {
  if (rawBody.length > RESPONSE_MAX_BYTES * 4) throw tooLarge();
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw badRequest("The response is not valid JSON.", "Send an object like { \"name\": \"Ana\", \"answer\": \"Yes\" }.");
  }
  if (parsed === null || parsed === undefined) throw badRequest("The response is empty.", "Send an object like { \"name\": \"Ana\", \"answer\": \"Yes\" }.");
  const data = JSON.stringify(parsed);
  if (new TextEncoder().encode(data).length > RESPONSE_MAX_BYTES) throw tooLarge();
  // Rate buckets start with the site id so deleting the app clears them (sites.ts removeSite).
  await rateLimit(env, `${site.id}:responses`, RESPONSES_PER_MINUTE, `This app received more than ${RESPONSES_PER_MINUTE} responses in a minute.`);
  if (email === null) {
    const message = `You sent more than ${GUEST_RESPONSES_PER_MINUTE} responses in a minute.`;
    await rateLimit(env, `${site.id}:responses:${ip ?? "unknown"}`, GUEST_RESPONSES_PER_MINUTE, message, env.RESPONSES_LIMITER);
  }
  const id = randomId("r_", 20);
  const at = now();
  const dayStart = at - (at % 86_400_000);
  const guestCap = email === null ? (site.guest_responses_per_day ?? DEFAULT_GUEST_RESPONSES_PER_DAY) : null;
  // Insert only while under the caps; one statement keeps it race-free.
  const res = await env.DB.prepare(
    `INSERT INTO responses (id, site_id, at, email, data)
       SELECT ?1, ?2, ?3, ?4, ?5
        WHERE (SELECT COUNT(*) FROM responses WHERE site_id = ?2) < ?6
          AND (?7 IS NULL OR (SELECT COUNT(*) FROM responses WHERE site_id = ?2 AND email IS NULL AND at >= ?8) < ?7)`,
  )
    .bind(id, site.id, at, email, data, RESPONSES_MAX, guestCap, dayStart)
    .run();
  if (!res.meta.changes) {
    if (guestCap !== null && (await countResponses(env, site.id)) < RESPONSES_MAX) {
      throw err(
        429,
        "rate_limited",
        `This app has taken its ${guestCap} responses for today from people without an account.`,
        "Try again tomorrow, or sign in to Formelab if the app is shared with you. The app's owner can raise the limit in its Public link settings.",
      );
    }
    throw err(409, "too_many_responses", `This app already has ${RESPONSES_MAX} responses.`, "Ask the app's owner to download and delete old responses.");
  }
  return { id, at };
}

const tooLarge = () => err(413, "value_too_large", "A response can be at most 16 KB of JSON.", "Send shorter answers, or leave out files and images.");

/** The app's responses, newest first; `before` (a response id) continues a long list. */
export async function listResponses(env: Env, siteId: string, opts: { before?: string; limit?: number } = {}) {
  const asked = Math.floor(Number(opts.limit ?? LIST_MAX));
  const limit = Number.isFinite(asked) ? Math.min(Math.max(1, asked), LIST_MAX) : LIST_MAX;
  if (opts.before !== undefined && !ID_RE.test(opts.before)) throw badRequest("before must be a response id.", "Pass the id of the last response you got.");
  const [{ results }, count] = await Promise.all([
    env.DB.prepare(
      `SELECT id, at, email, data FROM responses
        WHERE site_id = ?1 ${opts.before ? "AND rowid < (SELECT rowid FROM responses WHERE site_id = ?1 AND id = ?3)" : ""}
        ORDER BY rowid DESC LIMIT ?2`,
    )
      .bind(siteId, limit + 1, ...(opts.before ? [opts.before] : []))
      .all<{ id: string; at: number; email: string | null; data: string }>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM responses WHERE site_id = ?").bind(siteId).first<{ n: number }>(),
  ]);
  const more = results.length > limit;
  const rows = more ? results.slice(0, limit) : results;
  const responses: ResponseView[] = rows.map((r) => ({ id: r.id, at: r.at, email: r.email, data: JSON.parse(r.data) as unknown }));
  return { total: count?.n ?? 0, responses, next: more ? rows[rows.length - 1]!.id : null };
}

export async function countResponses(env: Env, siteId: string): Promise<number> {
  return (await env.DB.prepare("SELECT COUNT(*) AS n FROM responses WHERE site_id = ?").bind(siteId).first<{ n: number }>())?.n ?? 0;
}

export async function deleteResponse(env: Env, siteId: string, id: string) {
  if (!ID_RE.test(id)) throw notFound("Response");
  const res = await env.DB.prepare("DELETE FROM responses WHERE site_id = ? AND id = ?").bind(siteId, id).run();
  if (!res.meta.changes) throw notFound("Response");
  return { ok: true };
}

/**
 * Every response as CSV, oldest first: when, who, then one column per field the answers use
 * (objects' keys in the order first seen; anything else goes in a "value" column).
 */
export async function responsesCsv(env: Env, siteId: string): Promise<string> {
  const { results } = await env.DB.prepare("SELECT at, email, data FROM responses WHERE site_id = ? ORDER BY rowid")
    .bind(siteId)
    .all<{ at: number; email: string | null; data: string }>();
  const rows = results.map((r) => {
    const data = JSON.parse(r.data) as unknown;
    const fields = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : { value: data };
    return { at: r.at, email: r.email, fields };
  });
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    for (const k of Object.keys(r.fields)) {
      if (!seen.has(k)) {
        seen.add(k);
        columns.push(k);
      }
    }
  }
  const lines = [["Submitted (UTC)", "Email", ...columns].map(csvCell).join(",")];
  for (const r of rows) {
    const time = new Date(r.at).toISOString().replace("T", " ").slice(0, 19);
    lines.push([time, r.email ?? "(public link)", ...columns.map((k) => r.fields[k])].map(csvCell).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

function csvCell(v: unknown): string {
  let s = v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v);
  // Spreadsheets run text starting with these as a formula; a leading quote keeps it as text.
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
