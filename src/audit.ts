// The activity log. Rows about an app carry its site_id and make up that app's activity log;
// everything else (accounts, admin, namespaces, connections) is Formelab-level and shows in the
// admin panel.
import type { Env } from "./env";
import { now } from "./env";

/** Records an action. `detail` must never contain secret values; `detail.siteId` ties it to an app. */
export async function audit(env: Env, actor: string, action: string, target: string | null, detail?: Record<string, unknown>) {
  const siteId = typeof detail?.siteId === "string" ? detail.siteId : null;
  await env.DB.prepare("INSERT INTO audit (at, actor, action, target, detail, site_id) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(now(), actor, action, target, detail ? JSON.stringify(detail) : null, siteId)
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

/** One app's activity, newest first. */
export async function siteActivity(env: Env, siteId: string, limit = 200): Promise<AuditRow[]> {
  const { results } = await env.DB.prepare("SELECT id, at, actor, action, target, detail FROM audit WHERE site_id = ? ORDER BY id DESC LIMIT ?")
    .bind(siteId, limit)
    .all<AuditRow>();
  return results;
}

/** Formelab-level activity (anything not inside an app), newest first. Admins only. */
export async function platformActivity(env: Env, limit = 200): Promise<AuditRow[]> {
  const { results } = await env.DB.prepare("SELECT id, at, actor, action, target, detail FROM audit WHERE site_id IS NULL ORDER BY id DESC LIMIT ?")
    .bind(limit)
    .all<AuditRow>();
  return results;
}

const FIELD_LABEL: Record<string, string> = {
  title: "title",
  hidden: "hidden from listings",
  spa: "SPA fallback",
  visibility: "who can open it",
  allowed_emails: "who it's shared with",
  editors: "editors",
};

const list = (v: unknown) => (Array.isArray(v) ? v.map(String).join(", ") : "");
const plural = (n: unknown, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
const size = (n: unknown) => {
  const b = Number(n) || 0;
  return b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`;
};

/** A plain-language sentence for an activity row, naming the action that caused it. */
export function describeActivity(row: AuditRow): string {
  let d: Record<string, unknown> = {};
  try {
    d = row.detail ? JSON.parse(row.detail) : {};
  } catch {
    /* old or malformed detail: describe from the action alone */
  }
  const t = row.target ?? "";
  switch (row.action) {
    case "publish":
      return `Published the app (${plural(d.files, "file")}, ${size(d.bytes)})`;
    case "replace":
      return `Published a new version (${plural(d.files, "file")}, ${size(d.bytes)})`;
    case "update_site": {
      const parts: string[] = [];
      const explained = new Set<string>();
      if ("sharedWith" in d) {
        explained.add("allowed_emails");
        if (list(d.sharedWith)) parts.push(`shared it with ${list(d.sharedWith)}`);
        if (list(d.unsharedWith)) parts.push(`stopped sharing it with ${list(d.unsharedWith)}`);
      }
      if ("editorsAdded" in d) {
        explained.add("editors");
        if (list(d.editorsAdded)) parts.push(`made ${list(d.editorsAdded)} ${(d.editorsAdded as unknown[]).length === 1 ? "an editor" : "editors"}`);
        if (list(d.editorsRemoved)) parts.push(`removed ${list(d.editorsRemoved)} as ${(d.editorsRemoved as unknown[]).length === 1 ? "an editor" : "editors"}`);
      }
      if (d.visibility) {
        explained.add("visibility");
        parts.push(`set who can open it to ${d.visibility === "all" ? "anyone signed in" : "only people it's shared with"}`);
      }
      if (typeof d.title === "string") {
        explained.add("title");
        parts.push(d.title ? `renamed it to "${d.title}"` : "removed its title");
      }
      const rest = (Array.isArray(d.fields) ? d.fields.map(String) : []).filter((f) => !explained.has(f)).map((f) => FIELD_LABEL[f] ?? f);
      if (rest.length) parts.push(`changed the ${rest.join(", ")}`);
      const s = parts.join("; ") || "Changed the app's settings";
      return s[0]!.toUpperCase() + s.slice(1);
    }
    case "secret_set":
      return `Saved the secret ${d.name}`;
    case "secret_delete":
      return `Removed the secret ${d.name}`;
    case "proxy":
      return `Called ${d.host} with the secret ${d.secret} (${d.status === "timeout" ? "timed out" : d.status === "error" ? "failed" : `HTTP ${d.status}`})`;
    case "gemini":
      return d.status === 200 ? `Asked Gemini${d.tokens ? ` (${d.tokens} tokens)` : ""}` : `Asked Gemini, which failed (${d.status === "timeout" ? "no answer" : `HTTP ${d.status}`})`;
    case "feature_flag":
      return `Set ${d.feature ?? t} to ${d.state === "on" ? "on for everyone" : d.state === "admins" ? "admins only" : "off"}`;
    case "sheets": {
      const what = d.method === "GET" ? "Read from" : "Wrote to";
      return typeof d.status === "number" && d.status < 300 ? `${what} Google Sheets` : `${what} Google Sheets, which failed (${d.status === "timeout" ? "no answer" : `HTTP ${d.status}`})`;
    }
    case "service_connect":
      return `Connected ${d.service ?? "a service"} for their apps`;
    case "service_disconnect":
      return `Disconnected ${d.service ?? "a service"}`;
    case "delete_site":
      return `Deleted the app ${t}`;
    case "namespace_create":
      return `Created the space ${t}`;
    case "namespace_editors":
      return `Set the editors of the space ${t} to ${list(d.editors) || "nobody"}`;
    case "namespace_delete":
      return `Deleted the space ${t} and ${plural(d.sites, "app")}`;
    case "user_delete":
      return `Deleted the account ${t}`;
    case "admin_grant":
      return `Made ${t} an admin`;
    case "admin_revoke":
      return `Removed admin access from ${t}`;
    case "waitlist_approve":
      return d.invited ? `Invited ${t}` : `Let ${t} in from the waitlist`;
    case "oauth_connect":
      return `Connected ${d.client ?? "an AI app"}`;
    case "oauth_disconnect":
      return "Disconnected an AI app";
    default:
      return `${row.action}${t ? ` ${t}` : ""}`;
  }
}
