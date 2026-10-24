// What each app is connected to (the app page's Connected apps tab), and which apps use each
// connected service (the Connected apps page). Behind the connected_apps flag.
//
// - Google Gemini is connected once per person and every one of their apps may use it, so an app
//   counts as using it once it has called it (its activity has Gemini calls).
// - Google Sheets: the spreadsheets listed for the app (sites.sheets), reached with its owner's
//   Google account.
// - Saved keys: the app's own secrets, each sent only to the hosts listed for it.
import { audit } from "./audit";
import type { Env } from "./env";
import { now } from "./env";
import { badRequest, err, notFound } from "./errors";
import { geminiStatus } from "./gemini";
import { encryptSecret, validateSecretName, SECRET_MAX_BYTES } from "./secrets";
import { sheetsStatus } from "./sheets";
import { requireManageableSite, type Ctx, type SiteRow, type SiteView } from "./sites";
import { parseJsonArray } from "./util";

export interface SavedKey {
  name: string;
  /** Where it may be sent; empty for a key saved before host lists existed (the proxy refuses it). */
  hosts: string[];
  updatedAt: number;
}

export interface AppConnections {
  gemini: { connected: boolean; used: boolean; lastUsedAt: number | null };
  sheets: { connected: boolean; ids: string[] };
  keys: SavedKey[];
  /** How many things the app is connected to, for the tab's badge. */
  count: number;
}

export async function savedKeys(env: Env, siteId: string): Promise<SavedKey[]> {
  const { results } = await env.DB.prepare("SELECT name, hosts, updated_at FROM secrets WHERE site_id = ? ORDER BY name")
    .bind(siteId)
    .all<{ name: string; hosts: string | null; updated_at: number }>();
  return results.map((r) => ({ name: r.name, hosts: r.hosts ? parseJsonArray(r.hosts) : [], updatedAt: r.updated_at }));
}

/** When the app last called Gemini, or null if it never has (within the activity kept, a year). */
async function lastGeminiCall(env: Env, siteId: string): Promise<number | null> {
  const row = await env.DB.prepare("SELECT MAX(at) AS at FROM audit WHERE site_id = ? AND action = 'gemini'").bind(siteId).first<{ at: number | null }>();
  return row?.at ?? null;
}

export async function appConnections(env: Env, site: Pick<SiteView, "id" | "ownerEmail" | "sheets">): Promise<AppConnections> {
  const [gemini, sheets, keys, lastUsedAt] = await Promise.all([geminiStatus(env, site.ownerEmail), sheetsStatus(env, site.ownerEmail), savedKeys(env, site.id), lastGeminiCall(env, site.id)]);
  const used = lastUsedAt !== null;
  return {
    gemini: { connected: gemini.connected, used, lastUsedAt },
    sheets: { connected: sheets.connected, ids: site.sheets },
    keys,
    count: (used ? 1 : 0) + (site.sheets.length ? 1 : 0) + keys.length,
  };
}

export interface UsedBy {
  gemini: { id: string; name: string }[];
  sheets: { id: string; name: string }[];
  /** Saved keys by name, with the apps that have a key by that name. */
  keys: { name: string; apps: { id: string; name: string }[] }[];
}

const nameOf = (s: Pick<SiteRow, "title" | "mount_path" | "namespace">) => s.title || s.mount_path || s.namespace;

/** For the Connected apps page: which of this person's own apps use each service. */
export async function connectionsUsedBy(ctx: Ctx): Promise<UsedBy> {
  const { env, user } = ctx;
  const [{ results: sites }, { results: gemini }, { results: keys }] = await Promise.all([
    env.DB.prepare("SELECT id, title, mount_path, namespace, sheets FROM sites WHERE owner_email = ? ORDER BY title, mount_path").bind(user.email).all<SiteRow>(),
    env.DB.prepare("SELECT DISTINCT a.site_id FROM audit a JOIN sites s ON s.id = a.site_id WHERE s.owner_email = ? AND a.action = 'gemini'").bind(user.email).all<{ site_id: string }>(),
    env.DB.prepare("SELECT k.name, k.site_id FROM secrets k JOIN sites s ON s.id = k.site_id WHERE s.owner_email = ? ORDER BY k.name").bind(user.email).all<{ name: string; site_id: string }>(),
  ]);
  const byId = new Map(sites.map((s) => [s.id, { id: s.id, name: nameOf(s) }]));
  const geminiIds = new Set(gemini.map((g) => g.site_id));
  const keyGroups = new Map<string, { id: string; name: string }[]>();
  for (const k of keys) {
    const app = byId.get(k.site_id);
    if (app) keyGroups.set(k.name, [...(keyGroups.get(k.name) ?? []), app]);
  }
  return {
    gemini: sites.filter((s) => geminiIds.has(s.id)).map((s) => byId.get(s.id)!),
    sheets: sites.filter((s) => parseJsonArray(s.sheets ?? "[]").length).map((s) => byId.get(s.id)!),
    keys: [...keyGroups].map(([name, apps]) => ({ name, apps })),
  };
}

/**
 * Replace key: a new value for one of the app's saved keys, sent to the same hosts as before.
 * For the app's owner and editors, like setting a secret from the app.
 */
export async function replaceSavedKey(ctx: Ctx, id: string, name: string, rawValue: unknown) {
  const { site } = await requireManageableSite(ctx, id);
  validateSecretName(name);
  const row = await ctx.env.DB.prepare("SELECT hosts FROM secrets WHERE site_id = ? AND name = ?").bind(site.id, name).first<{ hosts: string | null }>();
  if (!row) throw notFound(`The key ${name}`);
  const hosts = row.hosts ? parseJsonArray(row.hosts) : [];
  if (!hosts.length) {
    throw err(409, "no_hosts", `${name} was saved before keys listed where they may be sent.`, "Ask your AI to set it again with formelab.secrets.set and its hosts.");
  }
  const value = typeof rawValue === "string" ? rawValue.trim() : "";
  if (!value) throw badRequest("Paste the new key.", "It replaces the saved one; the app keeps using it the same way.");
  const plaintext = JSON.stringify(value);
  if (new TextEncoder().encode(plaintext).length > SECRET_MAX_BYTES) throw err(413, "secret_too_large", "Keys can be at most 8 KB.", "Paste only the key itself.");
  const { iv, ciphertext } = await encryptSecret(ctx.env, site.id, name, plaintext);
  await ctx.env.DB.prepare("UPDATE secrets SET iv = ?, ciphertext = ?, updated_at = ? WHERE site_id = ? AND name = ?").bind(iv, ciphertext, now(), site.id, name).run();
  await audit(ctx.env, ctx.user.email, "secret_set", `${site.namespace}/${site.mount_path}`, { siteId: site.id, name, kind: "string", hosts });
  return { name, hosts, updatedAt: now() };
}

/** Remove a saved key from the app. The app can no longer reach that service until it's saved again. */
export async function removeSavedKey(ctx: Ctx, id: string, name: string) {
  const { site } = await requireManageableSite(ctx, id);
  validateSecretName(name);
  const res = await ctx.env.DB.prepare("DELETE FROM secrets WHERE site_id = ? AND name = ?").bind(site.id, name).run();
  if (!res.meta.changes) throw notFound(`The key ${name}`);
  await audit(ctx.env, ctx.user.email, "secret_delete", `${site.namespace}/${site.mount_path}`, { siteId: site.id, name });
  return { ok: true };
}
