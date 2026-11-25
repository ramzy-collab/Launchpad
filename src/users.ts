// Admin: list and delete user accounts.
import { audit } from "./audit";
import { isOwnerEmail } from "./auth";
import type { Env, User } from "./env";
import { now } from "./env";
import { badRequest, err, notFound } from "./errors";
import { WORKOS_API } from "./login";
import { listConnections, oauthHelpers } from "./oauth";
import { removeSite, type NamespaceRow, type SiteRow } from "./sites";
import { appOrigin } from "./hosts";
import { deletionRequestEmail, sendEmail } from "./email";
import { isEmail, normEmail, parseJsonArray, randomId } from "./util";

export interface UserSummary {
  email: string;
  name: string | null;
  status: "active" | "waitlisted" | "app_user";
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
    status: r.status === "active" || r.status === "app_user" ? r.status : "waitlisted",
    isAdmin: r.is_admin === 1,
    createdAt: r.created_at,
    apps: r.apps,
  }));
}

/** Rewrites a JSON email list without `email`; null when it wasn't in the list. */
function without(list: string | null | undefined, email: string): string | null {
  const items = parseJsonArray(list);
  const kept = items.filter((x) => normEmail(String(x)) !== email);
  return kept.length === items.length ? null : JSON.stringify(kept);
}

/** How deleted people appear in usage metrics: this, then a random code. */
export const DELETED_USER_PREFIX = "deleted-user-";

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
  const sites = (
    await env.DB.prepare("SELECT id, editors, allowed_emails, sharers FROM sites WHERE editors LIKE ?1 OR allowed_emails LIKE ?1 OR sharers LIKE ?1")
      .bind(pattern)
      .all<Pick<SiteRow, "id" | "editors" | "allowed_emails" | "sharers">>()
  ).results;
  const namespaces = (await env.DB.prepare("SELECT label, editors FROM namespaces WHERE editors LIKE ?").bind(pattern).all<Pick<NamespaceRow, "label" | "editors">>()).results;
  const updates = [
    ...sites.map((s) =>
      env.DB.prepare("UPDATE sites SET editors = COALESCE(?, editors), allowed_emails = COALESCE(?, allowed_emails), sharers = COALESCE(?, sharers) WHERE id = ?")
        .bind(without(s.editors, email), without(s.allowed_emails, email), without(s.sharers, email), s.id),
    ),
    ...namespaces.map((n) => env.DB.prepare("UPDATE namespaces SET editors = COALESCE(?, editors) WHERE label = ?").bind(without(n.editors, email), n.label)),
  ];

  // Only here: an app user's clean-up must keep a member row added while it ran (dropUnlistedAppUsers).
  const disconnected = await eraseAccount(env, email, user.workos_id, [...updates, env.DB.prepare("DELETE FROM app_members WHERE email = ?").bind(email)]);
  const result = { ok: true, email, deletedNamespaces: owned.length, deletedSites, removedFromShares: sites.length + namespaces.length, disconnected };
  await audit(env, admin.email, "user_delete", email, result);
  return result;
}

/**
 * Step 4 and 5 of deleting someone: their account and sign-ins, run with `extra` in one batch, then
 * their connected AI apps and WorkOS user, best effort. Usage metrics keep their rows (so counts
 * stay whole) under a stand-in that's the same for all their rows (so counts of people stay right)
 * but isn't their email. Returns how many AI apps were disconnected.
 */
async function eraseAccount(env: Env, email: string, workosId: string | null, extra: D1PreparedStatement[], standIn = `${DELETED_USER_PREFIX}${randomId("", 10)}`) {
  await env.DB.batch([
    ...extra,
    env.DB.prepare("UPDATE mcp_calls SET email = ? WHERE email = ?").bind(standIn, email),
    env.DB.prepare("UPDATE app_visits SET email = ? WHERE email = ?").bind(standIn, email),
    env.DB.prepare("DELETE FROM auth_codes WHERE session_id IN (SELECT id FROM sessions WHERE email = ?)").bind(email),
    env.DB.prepare("DELETE FROM sessions WHERE email = ?").bind(email),
    env.DB.prepare("DELETE FROM tokens WHERE owner_email = ?").bind(email),
    env.DB.prepare("DELETE FROM service_keys WHERE owner_email = ?").bind(email),
    env.DB.prepare("DELETE FROM kv_user WHERE email = ?").bind(email),
    env.DB.prepare("DELETE FROM feature_flag_users WHERE email = ?").bind(email),
    env.DB.prepare("DELETE FROM waitlist WHERE email = ?").bind(email),
    env.DB.prepare("DELETE FROM users WHERE email = ?").bind(email),
  ]);

  let disconnected = 0;
  for (const g of await listConnections(env, email, true).catch(() => [])) {
    await oauthHelpers(env).revokeGrant(g.id, email).then(() => disconnected++, () => {});
  }
  if (workosId && env.WORKOS_API_KEY) {
    const res = await fetch(`${WORKOS_API}/user_management/users/${encodeURIComponent(workosId)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${env.WORKOS_API_KEY}` },
    }).catch(() => null);
    if (!res?.ok) console.warn("workos user delete failed", res?.status ?? "network");
  }
  return disconnected;
}

/** SQL: whether the JSON email list in `column` holds ?1 exactly (LIKE would let "_" match any character). */
const listHas = (column: string) => `EXISTS (SELECT 1 FROM json_each(${column}) WHERE lower(trim(value)) = ?1)`;

/** Apps that list `email`: as owner, editor, on the share list or added in the app. */
async function appsListing(env: Env, email: string) {
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.title, s.namespace, s.mount_path, s.owner_email,
            CASE WHEN s.owner_email = ?1 THEN 'owner' WHEN ${listHas("s.editors")} THEN 'editor' WHEN ${listHas("s.allowed_emails")} THEN 'shared' ELSE 'member' END AS how
       FROM sites s
      WHERE s.owner_email = ?1 OR ${listHas("s.editors")} OR ${listHas("s.allowed_emails")}
         OR EXISTS (SELECT 1 FROM app_members m WHERE m.site_id = s.id AND m.email = ?1)
      ORDER BY s.owner_email, s.namespace, s.mount_path`,
  )
    .bind(email)
    .all<{ id: string; title: string | null; namespace: string; mount_path: string; owner_email: string; how: "owner" | "editor" | "shared" | "member" }>();
  return results;
}

/**
 * Deletes the app user accounts (spec step 4) among `emails` that no app lists any more: called
 * after someone is removed from an app or an app is deleted. Their activity log lines keep a
 * stand-in instead of their email, like their usage metrics. Formelab accounts are never touched.
 */
export async function dropUnlistedAppUsers(env: Env, emails: string[]) {
  for (const email of new Set(emails.map(normEmail))) {
    const user = await env.DB.prepare("SELECT workos_id FROM users WHERE email = ? AND status = 'app_user'").bind(email).first<{ workos_id: string | null }>();
    if (!user || (await appsListing(env, email)).length) continue;
    // A space's editors count too: its apps are theirs to change.
    if (await env.DB.prepare(`SELECT 1 FROM namespaces WHERE owner_email = ?1 OR ${listHas("editors")}`).bind(email).first()) continue;
    const standIn = `${DELETED_USER_PREFIX}${randomId("", 10)}`;
    const quoted = JSON.stringify(email);
    await eraseAccount(env, email, user.workos_id, [
      env.DB.prepare("UPDATE audit SET actor = ? WHERE actor = ?").bind(standIn, email),
      env.DB.prepare("UPDATE audit SET target = ? WHERE target = ?").bind(standIn, email),
      env.DB.prepare("UPDATE audit SET detail = replace(detail, ?, ?) WHERE detail LIKE ?").bind(quoted, JSON.stringify(standIn), `%${quoted}%`),
    ], standIn);
  }
}

export interface PersonInApps {
  email: string;
  /** Their Formelab account's status, or null without one. */
  account: string | null;
  apps: { id: string; name: string; owner: string; how: "owner" | "editor" | "shared" | "member" }[];
}

/** Admin: for a deletion request, the person's account and every app that lists them. */
export async function findPerson(env: Env, admin: User, rawEmail: string): Promise<PersonInApps> {
  if (!admin.isAdmin) throw err(403, "admin_only", "Only an admin can look people up.", "Ask the Formelab owner.");
  const email = normEmail(rawEmail);
  if (!isEmail(email)) throw badRequest("That email address is not valid.", "Check the address and try again.");
  const row = await env.DB.prepare("SELECT status FROM users WHERE email = ?").bind(email).first<{ status: string }>();
  const apps = (await appsListing(env, email)).map((s) => ({ id: s.id, name: s.title || s.mount_path || s.namespace, owner: s.owner_email, how: s.how }));
  return { email, account: row?.status ?? null, apps };
}

/**
 * Admin: tells the owner of every app that lists the person (other than their own apps) that they
 * asked for their data to be deleted, with a link to each app's people. Owners decide; Formelab
 * never tells the person which apps these were.
 */
export async function notifyOwnersOfDeletion(env: Env, admin: User, rawEmail: string, requestUrl: string) {
  const person = await findPerson(env, admin, rawEmail);
  const byOwner = new Map<string, { name: string; url: string }[]>();
  for (const a of person.apps) {
    if (a.how === "owner") continue;
    const list = byOwner.get(a.owner) ?? [];
    list.push({ name: a.name, url: `${appOrigin(env, requestUrl)}/apps/${encodeURIComponent(a.id)}` });
    byOwner.set(a.owner, list);
  }
  for (const [owner, apps] of byOwner) await sendEmail(env, deletionRequestEmail(appOrigin(env, requestUrl), owner, { email: person.email, apps }));
  await audit(env, admin.email, "deletion_request", null, { owners: byOwner.size, apps: [...byOwner.values()].flat().length });
  return { ok: true, owners: byOwner.size };
}

/** Gives or removes admin access. The owner (OWNER_EMAIL) is always an admin. */
export async function setAdmin(env: Env, admin: User, rawEmail: string, makeAdmin: unknown) {
  if (!admin.isAdmin) throw err(403, "admin_only", "Only an admin can change who is an admin.", "Ask the Formelab owner.");
  if (typeof makeAdmin !== "boolean") throw badRequest("Send { \"admin\": true } or { \"admin\": false }.", "admin must be true or false.");
  const email = normEmail(rawEmail);
  if (!makeAdmin && isOwnerEmail(env, email)) throw badRequest("The owner account is always an admin.", "Change OWNER_EMAIL to hand over ownership.");
  if (!makeAdmin && email === admin.email) throw badRequest("You can't remove your own admin access.", "Ask another admin to do it.");
  // Admins can create apps, so giving admin access also lets someone in from the waitlist.
  const res = await env.DB.prepare(
    `UPDATE users SET is_admin = ?1, status = CASE WHEN ?1 = 1 THEN 'active' ELSE status END WHERE email = ?2`,
  )
    .bind(makeAdmin ? 1 : 0, email)
    .run();
  if (!res.meta.changes) throw notFound(`The user ${email}`);
  await audit(env, admin.email, makeAdmin ? "admin_grant" : "admin_revoke", email);
  return { ok: true, email, isAdmin: makeAdmin };
}

export interface AdminStats {
  users: number;
  /** People who have only signed in to apps they were added to, not to Formelab itself. */
  appUsers: number;
  active: number;
  waiting: number;
  /** Let in from the waitlist (or invited) but never logged in, so no account yet. */
  letInNotSignedIn: number;
  admins: number;
  apps: number;
  namespaces: number;
  signupsThisWeek: number;
}

export async function adminStats(env: Env): Promise<AdminStats> {
  const weekAgo = now() - 7 * 86_400_000;
  const row = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM users WHERE status != 'app_user') AS users,
            (SELECT COUNT(*) FROM users WHERE status = 'app_user') AS app_users,
            (SELECT COUNT(*) FROM users WHERE status = 'active') AS active,
            (SELECT COUNT(*) FROM waitlist WHERE approved_at IS NULL) AS waiting,
            (SELECT COUNT(*) FROM waitlist w WHERE w.approved_at IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM users u WHERE u.email = w.email)) AS let_in,
            (SELECT COUNT(*) FROM users WHERE is_admin = 1) AS admins,
            (SELECT COUNT(*) FROM sites) AS apps,
            (SELECT COUNT(*) FROM namespaces) AS namespaces,
            (SELECT COUNT(*) FROM waitlist WHERE created_at >= ?) AS signups`,
  )
    .bind(weekAgo)
    .first<{ users: number; app_users: number; active: number; waiting: number; let_in: number; admins: number; apps: number; namespaces: number; signups: number }>();
  return {
    users: row?.users ?? 0,
    appUsers: row?.app_users ?? 0,
    active: row?.active ?? 0,
    waiting: row?.waiting ?? 0,
    letInNotSignedIn: row?.let_in ?? 0,
    admins: row?.admins ?? 0,
    apps: row?.apps ?? 0,
    namespaces: row?.namespaces ?? 0,
    signupsThisWeek: row?.signups ?? 0,
  };
}
