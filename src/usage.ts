// Usage tracking for the admin panel's Metrics page: MCP calls and people opening apps. Writes
// happen after the response (waitUntil) and never fail the request they describe.
import type { Env } from "./env";
import { now } from "./env";
import { extOf } from "./mime";

/** Records one MCP tool call (or a new connection, tool "initialize"). */
export async function recordMcpCall(env: Env, call: { email: string; client: string | null; tool: string; ok: boolean; ms: number }): Promise<void> {
  await env.DB.prepare("INSERT INTO mcp_calls (at, email, client, tool, ok, ms) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(now(), call.email, call.client?.slice(0, 100) ?? null, call.tool.slice(0, 64), call.ok ? 1 : 0, Math.max(0, Math.round(call.ms)))
    .run();
}

/** Whether an app request is someone opening a page (not the page's scripts, images or API calls). */
export function isPageView(req: Request): boolean {
  if (req.method !== "GET" || new URL(req.url).pathname.startsWith("/_")) return false;
  const dest = req.headers.get("sec-fetch-dest");
  if (dest) return dest === "document";
  // Browsers without Fetch Metadata: a page is an address with no extension, or an .html file.
  const path = new URL(req.url).pathname;
  const ext = extOf(path);
  return !ext || ext === "html" || ext === "htm";
}

/** The email recorded for guests let in by an app's public link, who are anonymous. */
export const GUEST = "";

export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Counts a page someone opened in an app: one row per app, person and day. */
export async function recordAppVisit(env: Env, siteId: string, email: string, own: boolean): Promise<void> {
  const t = now();
  await env.DB.prepare(
    `INSERT INTO app_visits (site_id, day, email, own, views, first_at) VALUES (?, ?, ?, ?, 1, ?)
     ON CONFLICT (site_id, day, email) DO UPDATE SET views = views + 1, own = MAX(own, excluded.own)`,
  )
    .bind(siteId, utcDay(t), email, own ? 1 : 0, t)
    .run();
}
