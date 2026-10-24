// What each app is connected to: the app page's Connected apps tab. Behind the connected_apps flag.
//
// - Google Gemini, once the app was built to use it (its connectors list "gemini").
// - Google Sheets: the spreadsheets listed for the app (sites.sheets), reached with its owner's
//   Google account.
// - Custom connectors the app was built to use (see connectors.ts), with its owner's keys.
// - Saved keys: the app's own secrets, each sent only to the hosts listed for it.
import { audit } from "./audit";
import { authSentence, listConnectors } from "./connectors";
import type { Env } from "./env";
import { now } from "./env";
import { badRequest, err, notFound } from "./errors";
import { geminiStatus } from "./gemini";
import { encryptSecret, validateSecretName, SECRET_MAX_BYTES } from "./secrets";
import { sheetsStatus } from "./sheets";
import { requireManageableSite, type Ctx, type SiteView } from "./sites";
import { parseJsonArray } from "./util";

export interface SavedKey {
  name: string;
  /** Where it may be sent; empty for a key saved before host lists existed (the proxy refuses it). */
  hosts: string[];
  updatedAt: number;
}

export interface AppConnector {
  name: string;
  /** null when the owner has no connector by that name any more. */
  label: string | null;
  hosts: string[];
  sends: string;
  lastUsedAt: number | null;
}

export interface AppConnections {
  gemini: { connected: boolean; inApp: boolean; lastUsedAt: number | null };
  sheets: { connected: boolean; ids: string[] };
  connectors: AppConnector[];
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

async function lastConnectorCall(env: Env, siteId: string, name: string): Promise<number | null> {
  const row = await env.DB.prepare("SELECT MAX(at) AS at FROM audit WHERE site_id = ? AND action = 'proxy' AND json_extract(detail, '$.connector') = ?")
    .bind(siteId, name)
    .first<{ at: number | null }>();
  return row?.at ?? null;
}

export async function appConnections(env: Env, site: Pick<SiteView, "id" | "ownerEmail" | "sheets" | "connectors">): Promise<AppConnections> {
  const inApp = site.connectors.includes("gemini");
  const custom = site.connectors.filter((n) => n !== "gemini");
  const [gemini, sheets, keys, lastUsedAt, owned] = await Promise.all([
    geminiStatus(env, site.ownerEmail),
    sheetsStatus(env, site.ownerEmail),
    savedKeys(env, site.id),
    inApp ? lastGeminiCall(env, site.id) : null,
    custom.length ? listConnectors(env, site.ownerEmail) : [],
  ]);
  const connectors = await Promise.all(
    custom.map(async (name) => {
      const k = owned.find((o) => o.name === name);
      return { name, label: k?.label ?? null, hosts: k?.hosts ?? [], sends: k ? authSentence(k) : "", lastUsedAt: await lastConnectorCall(env, site.id, name) };
    }),
  );
  return {
    gemini: { connected: gemini.connected, inApp, lastUsedAt },
    sheets: { connected: sheets.connected, ids: site.sheets },
    connectors,
    keys,
    count: (inApp ? 1 : 0) + (site.sheets.length ? 1 : 0) + connectors.length + keys.length,
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
