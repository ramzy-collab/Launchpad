// Admin: list and delete user accounts.
import { audit } from "./audit";
import { isOwnerEmail } from "./auth";
import type { Env, User } from "./env";
import { badRequest, err, notFound } from "./errors";
import { listConnections } from "./oauth";
import { removeSite, type NamespaceRow, type SiteRow } from "./sites";
import { normEmail, parseJsonArray } from "./util";

export interface UserSummary {
  email: string;
  name: string | null;
  status: "active" | "waitlisted";
  isAdmin: boolean;
  createdAt: number;
  apps: number;
}

export async function listUsers(env: Env, limit = 500): Promise<UserSummary[]> {
  const { results } = await env.DB.prepare(
    `SELECT u.email, u.name, u.status, u.is_admin, u.created_at,
            (SELECT COUNT(*) FROM sites s WHERE s.owner_email = u.email) AS apps
       FROM users u ORDER BY u.created_at DESC LIMIT ?`,
  )
    .bind(limit)
    .all<{ email: string; name: string | null; status: string; is_admin: number; created_at: number; apps: number }>();
  return results.map((r) => ({
    email: r.email,
    name: r.name,
    status: r.status === "active" ? "active" : "waitlisted",
    isAdmin: r.is_admin === 1,
    createdAt: r.created_at,
    apps: r.apps,
  }));
}

/** Rewrites a JSON email list without `email`; null when it wasn't in the list. */
function without(list: string, email: string): string | null {
  const items = parseJsonArray(list);
  const kept = items.filter((x) => normEmail(String(x)) !== email);
  return kept.length === items.length ? null : JSON.stringify(kept);
}

/**
 * Deletes a user and everything they own: their namespaces (with every app in them), their other
 * apps (files, KV data, secrets), their place on other apps' share and editor lists, deploy tokens,
 * sessions, connected AI apps, waitlist entry, and their WorkOS user. Audit history is kept.
 */
export async function deleteUser(env: Env, admin: User, rawEmail: string) {
  if (!admin.isAdmin) throw err(403, "admin_only", "Only an admin can delete users.", "Ask the Formelab owner.");
  const email = normEmail(rawEmail);
  if (email === admin.email) throw badRequest("You can't delete your own account here.", "Ask another admin, or change OWNER_EMAIL first.");
  if (isOwnerEmail(env, email)) throw badRequest("The owner account (OWNER_EMAIL) can't be deleted.", "Change OWNER_EMAIL first if you really mean to.");
  const user = await env.DB.prepare("SELECT email, workos_id FROM users WHERE email = ?").bind(email).first<{ email: string; workos_id: string | null }>();
  if (!user) throw notFound(`The user ${email}`);

  // 1. Namespaces they own, with every app in them.
  const owned = (await env.DB.prepare("SELECT * FROM namespaces WHERE owner_email = ?").bind(email).all<NamespaceRow>()).results;
  let deletedSites = 0;
  for (const ns of owned) {
    const sites = (await env.DB.prepare("SELECT * FROM sites WHERE namespace = ?").bind(ns.label).all<SiteRow>()).results;
    for (const s of sites) await removeSite(env, s);
    deletedSites += sites.length;
    await env.DB.prepare("DELETE FROM namespaces WHERE label = ?").bind(ns.label).run();
  }
  // 2. Their apps in other people's namespaces.
  const others = (await env.DB.prepare("SELECT * FROM sites WHERE owner_email = ?").bind(email).all<SiteRow>()).results;
  for (const s of others) await removeSite(env, s);
  deletedSites += others.length;

  // 3. Their place on other apps' and namespaces' share and editor lists.
  const pattern = `%"${email}"%`;
  const sites = (await env.DB.prepare("SELECT id, editors, allowed_emails FROM sites WHERE editors LIKE ? OR allowed_emails LIKE ?").bind(pattern, pattern).all<Pick<SiteRow, "id" | "editors" | "allowed_emails">>()).results;
  const namespaces = (await env.DB.prepare("SELECT label, editors FROM namespaces WHERE editors LIKE ?").bind(pattern).all<Pick<NamespaceRow, "label" | "editors">>()).results;
  const updates = [
    ...sites.map((s) =>
      env.DB.prepare("UPDATE sites SET editors = COALESCE(?, editors), allowed_emails = COALESCE(?, allowed_emails) WHERE id = ?")
        .bind(without(s.editors, email), without(s.allowed_emails, email), s.id),
    ),
    ...namespaces.map((n) => env.DB.prepare("UPDATE namespaces SET editors = COALESCE(?, editors) WHERE label = ?").bind(without(n.editors, email), n.label)),
  ];

  // 4. Their account and sign-ins.
  await env.DB.batch([
    ...updates,
    env.DB.prepare("DELETE FROM auth_codes WHERE session_id IN (SELECT id FROM sessions WHERE email = ?)").bind(email),
    env.DB.prepare("DELETE FROM sessions WHERE email = ?").bind(email),
    env.DB.prepare("DELETE FROM tokens WHERE owner_email = ?").bind(email),
    env.DB.prepare("DELETE FROM waitlist WHERE email = ?").bind(email),
    env.DB.prepare("DELETE FROM users WHERE email = ?").bind(email),
  ]);

  // 5. Connected AI apps (OAuth grants) and the WorkOS user, best effort.
  let disconnected = 0;
  if (env.OAUTH_PROVIDER) {
    for (const g of await listConnections(env, email).catch(() => [])) {
      await env.OAUTH_PROVIDER.revokeGrant(g.id, email).then(() => disconnected++, () => {});
    }
  }
  if (user.workos_id && env.WORKOS_API_KEY) {
    const res = await fetch(`https://api.workos.com/user_management/users/${encodeURIComponent(user.workos_id)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${env.WORKOS_API_KEY}` },
    }).catch(() => null);
    if (!res?.ok) console.warn("workos user delete failed", res?.status ?? "network");
  }

  const result = { ok: true, email, deletedNamespaces: owned.length, deletedSites, removedFromShares: sites.length + namespaces.length, disconnected };
  await audit(env, admin.email, "user_delete", email, result);
  return result;
}
