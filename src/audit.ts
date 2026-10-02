import type { Env } from "./env";
import { now } from "./env";

/** Records an action. `detail` must never contain secret values. */
export async function audit(env: Env, actor: string, action: string, target: string | null, detail?: Record<string, unknown>) {
  await env.DB.prepare("INSERT INTO audit (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)")
    .bind(now(), actor, action, target, detail ? JSON.stringify(detail) : null)
    .run();
}

export interface AuditRow {
  id: number;
  at: number;
  actor: string;
  action: string;
  target: string | null;
  detail: string | null;
}

/** The last `limit` audit rows that the user performed or that concern their namespaces and sites. */
export async function recentActivity(env: Env, email: string, limit = 50): Promise<AuditRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, at, actor, action, target, detail FROM audit
      WHERE actor = ?1
         OR target IN (SELECT label FROM namespaces WHERE owner_email = ?1)
         OR target IN (SELECT namespace || '/' || mount_path FROM sites WHERE owner_email = ?1
                       OR namespace IN (SELECT label FROM namespaces WHERE owner_email = ?1))
         OR target IN (SELECT id FROM sites WHERE owner_email = ?1
                       OR namespace IN (SELECT label FROM namespaces WHERE owner_email = ?1))
      ORDER BY id DESC LIMIT ?2`,
  )
    .bind(email, limit)
    .all<AuditRow>();
  return results;
}
