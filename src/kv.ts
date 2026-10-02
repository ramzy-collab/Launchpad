import type { Env } from "./env";
import { now } from "./env";
import { badRequest, err, notFound } from "./errors";

export const KV_MAX_KEY = 256;
export const KV_MAX_VALUE_BYTES = 64 * 1024;
export const KV_MAX_KEYS = 1000;

export function validateKey(key: string) {
  if (!key || key.length > KV_MAX_KEY) {
    throw badRequest(`Keys must be 1–${KV_MAX_KEY} characters.`, "Use a shorter key, like \"settings\" or \"votes:alice\".");
  }
}

export async function kvList(env: Env, siteId: string, prefix = "") {
  const { results } = await env.DB.prepare(
    "SELECT key, value, updated_at FROM kv WHERE site_id = ? AND substr(key, 1, ?) = ? ORDER BY key",
  )
    .bind(siteId, prefix.length, prefix)
    .all<{ key: string; value: string; updated_at: number }>();
  return results.map((r) => ({ key: r.key, value: JSON.parse(r.value) as unknown, updatedAt: r.updated_at }));
}

export async function kvGet(env: Env, siteId: string, key: string) {
  validateKey(key);
  const row = await env.DB.prepare("SELECT value FROM kv WHERE site_id = ? AND key = ?").bind(siteId, key).first<{ value: string }>();
  if (!row) throw notFound(`Key "${key.slice(0, 80)}"`);
  return { value: JSON.parse(row.value) as unknown };
}

export async function kvSet(env: Env, siteId: string, key: string, rawBody: string) {
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
  // Insert only if under the per-site key cap (or the key already exists); one statement keeps it race-free.
  const res = await env.DB.prepare(
    `INSERT INTO kv (site_id, key, value, updated_at)
       SELECT ?1, ?2, ?3, ?4
        WHERE EXISTS (SELECT 1 FROM kv WHERE site_id = ?1 AND key = ?2)
           OR (SELECT COUNT(*) FROM kv WHERE site_id = ?1) < ?5
     ON CONFLICT(site_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(siteId, key, serialized, now(), KV_MAX_KEYS)
    .run();
  if (!res.meta.changes) {
    throw err(409, "too_many_keys", `This app already has ${KV_MAX_KEYS} keys.`, "Delete keys you no longer need, or combine small values into one key.");
  }
  return { ok: true };
}

export async function kvDelete(env: Env, siteId: string, key: string) {
  validateKey(key);
  await env.DB.prepare("DELETE FROM kv WHERE site_id = ? AND key = ?").bind(siteId, key).run();
  return { ok: true };
}
