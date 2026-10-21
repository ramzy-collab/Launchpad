import type { Env } from "./env";
import { now } from "./env";
import { badRequest, err, notFound } from "./errors";

export const KV_MAX_KEY = 256;
export const KV_MAX_VALUE_BYTES = 64 * 1024;
export const KV_MAX_KEYS = 1000;
/** Keys each person may keep in their private space (formelab.kv.mine) per app. */
export const KV_MAX_USER_KEYS = 200;

/**
 * Where a call reads and writes: the app's shared data, or one person's private data in the app
 * (`email` set). Private rows live in kv_user, so they never mix with, or count against, shared keys.
 */
export interface KvScope {
  siteId: string;
  email?: string;
}

const table = (s: KvScope) => (s.email === undefined ? "kv" : "kv_user");
/** The WHERE clause selecting the scope's rows, with ?1 = site id and ?2 = email (when private). */
const owner = (s: KvScope) => (s.email === undefined ? "site_id = ?1" : "site_id = ?1 AND email = ?2");
const ownerBinds = (s: KvScope) => (s.email === undefined ? [s.siteId, null] : [s.siteId, s.email]);

export function validateKey(key: string) {
  if (!key || key.length > KV_MAX_KEY) {
    throw badRequest(`Keys must be 1–${KV_MAX_KEY} characters.`, "Use a shorter key, like \"settings\" or \"votes:alice\".");
  }
}

/** About how much of the values one list response carries; the rest comes in later pages. */
export const KV_LIST_PAGE_BYTES = 4 * 1024 * 1024;
const LIST_BATCH = 100;

/**
 * The scope's keys in order, starting after `after`, up to about KV_LIST_PAGE_BYTES of values
 * (1,000 keys of 64 KB would be 64 MB in one response). `next` is the key to continue after, or
 * null at the end; the SDK's list() follows it, so apps still get the whole list in one call.
 */
export async function kvList(env: Env, scope: KvScope, prefix = "", after = "") {
  const rows: { key: string; value: unknown; updatedAt: number }[] = [];
  let bytes = 0;
  let cursor = after;
  for (;;) {
    const { results } = await env.DB.prepare(
      `SELECT key, value, updated_at FROM ${table(scope)} WHERE ${owner(scope)} AND substr(key, 1, ?3) = ?4 AND key > ?5 ORDER BY key LIMIT ${LIST_BATCH}`,
    )
      .bind(...ownerBinds(scope), prefix.length, prefix, cursor)
      .all<{ key: string; value: string; updated_at: number }>();
    for (const r of results) {
      rows.push({ key: r.key, value: JSON.parse(r.value) as unknown, updatedAt: r.updated_at });
      bytes += r.value.length;
      cursor = r.key;
      if (bytes >= KV_LIST_PAGE_BYTES) return { rows, next: cursor };
    }
    if (results.length < LIST_BATCH) return { rows, next: null };
  }
}

export async function kvGet(env: Env, scope: KvScope, key: string) {
  validateKey(key);
  const row = await env.DB.prepare(`SELECT value FROM ${table(scope)} WHERE ${owner(scope)} AND key = ?3`)
    .bind(...ownerBinds(scope), key)
    .first<{ value: string }>();
  if (!row) throw notFound(`Key "${key.slice(0, 80)}"`);
  return { value: JSON.parse(row.value) as unknown };
}

export async function kvSet(env: Env, scope: KvScope, key: string, rawBody: string) {
  validateKey(key);
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw badRequest("The value is not valid JSON.", "Send any JSON value: a string in quotes, a number, an object or an array.");
  }
  const serialized = JSON.stringify(parsed);
  if (new TextEncoder().encode(serialized).length > KV_MAX_VALUE_BYTES) {
    throw err(413, "value_too_large", "Values can be at most 64 KB of JSON.", "Split the data across several keys, or store less.");
  }
  const cap = scope.email === undefined ? KV_MAX_KEYS : KV_MAX_USER_KEYS;
  const t = table(scope);
  // Insert only if under the key cap (or the key already exists); one statement keeps it race-free.
  const res = await env.DB.prepare(
    scope.email === undefined
      ? `INSERT INTO kv (site_id, key, value, updated_at)
           SELECT ?1, ?3, ?4, ?5
            WHERE EXISTS (SELECT 1 FROM kv WHERE site_id = ?1 AND key = ?3)
               OR (SELECT COUNT(*) FROM kv WHERE site_id = ?1) < ?6
         ON CONFLICT(site_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      : `INSERT INTO kv_user (site_id, email, key, value, updated_at)
           SELECT ?1, ?2, ?3, ?4, ?5
            WHERE EXISTS (SELECT 1 FROM kv_user WHERE site_id = ?1 AND email = ?2 AND key = ?3)
               OR (SELECT COUNT(*) FROM kv_user WHERE site_id = ?1 AND email = ?2) < ?6
         ON CONFLICT(site_id, email, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(...ownerBinds(scope), key, serialized, now(), cap)
    .run();
  if (!res.meta.changes) {
    throw t === "kv"
      ? err(409, "too_many_keys", `This app already has ${KV_MAX_KEYS} keys.`, "Delete keys you no longer need, or combine small values into one key.")
      : err(409, "too_many_keys", `You already have ${KV_MAX_USER_KEYS} keys of your own in this app.`, "Delete keys you no longer need, or combine small values into one key.");
  }
  return { ok: true };
}

export async function kvDelete(env: Env, scope: KvScope, key: string) {
  validateKey(key);
  await env.DB.prepare(`DELETE FROM ${table(scope)} WHERE ${owner(scope)} AND key = ?3`).bind(...ownerBinds(scope), key).run();
  return { ok: true };
}
