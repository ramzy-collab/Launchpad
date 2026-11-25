// App members and roles (docs/specs/2026-11-22-agent-access.md, step 4). An app with access rules
// has one member list, kept here: people added inside the app (formelab.roles.set) with a role from
// its rules. People with access on the Formelab side (owner, editors, share list) count as members
// without a row; share list people have default_role unless a row gives them another.
import { audit } from "./audit";
import { canManageSite, canShareSite, canViewSite, isListed } from "./auth";
import type { Env, User } from "./env";
import { now } from "./env";
import { badRequest, err, notFound } from "./errors";
import { rolesIn, type Rules } from "./rules";
import { requireManageableSite, rulesOfSite, type Ctx, type NamespaceRow, type SiteRow } from "./sites";
import { dropUnlistedAppUsers } from "./users";
import { revokeAppGrants } from "./appmcp";
import { isEmail, normEmail, parseJsonArray } from "./util";

/** Rows an app can have, so a manager can't fill the table. */
export const MEMBERS_MAX = 2000;

type RecordRules = Extract<Rules, { records: unknown }>;
const hasRoles = (rules: Rules | null): rules is RecordRules => !!rules && "records" in rules;

/**
 * Whether a signed-in person may open the app, whether they manage it, and their role. Members
 * get in only while the app has rules with roles, so dropping the rules can't leave them open.
 */
export async function appAccess(env: Env, site: SiteRow, ns: NamespaceRow, user: User): Promise<{ allowed: boolean; manages: boolean; role: string | null }> {
  if (canManageSite(user, site, ns)) return { allowed: true, manages: true, role: null };
  const viewable = canViewSite(user, site, ns);
  const rules = await rulesOfSite(env, site);
  if (!hasRoles(rules)) return { allowed: viewable, manages: false, role: null };
  const row = await env.DB.prepare("SELECT role FROM app_members WHERE site_id = ? AND email = ?").bind(site.id, user.email).first<{ role: string }>();
  const role = row?.role ?? (viewable ? (rules.default_role ?? null) : null);
  return { allowed: viewable || !!row, manages: false, role };
}

export interface RolesCaller {
  env: Env;
  site: SiteRow;
  user: User;
  manages: boolean;
  role: string | null;
}

/** The app's rules, if the caller may see and change who has which role: owner, editors and manage_roles. */
async function requireManager(c: RolesCaller): Promise<RecordRules> {
  const rules = await rulesOfSite(c.env, c.site);
  if (!hasRoles(rules)) {
    throw err(400, "roles_unavailable", "This app has no roles to give people.", "Roles come from the app's access rules (formelab.json): add records with roles, as the guide's Access rules section shows, and publish again.");
  }
  if (!c.manages && !(c.role && rules.manage_roles?.includes(c.role))) {
    throw err(403, "not_allowed", "You can't change who uses this app.", "Ask the app's owner, or someone whose role lets them manage people (manage_roles in formelab.json).");
  }
  return rules;
}

export interface MemberView {
  email: string;
  /** Their role; null for the owner and editors, who see and change everything. */
  role: string | null;
  /** The app's owner or an editor: changed in Formelab, not in the app. */
  manages: boolean;
  /** Added in the app (or given a role there): roles.remove takes them off. */
  member: boolean;
}

/** formelab.roles.list(): everyone who uses the app and their role, the owner first. */
export async function listRoles(c: RolesCaller): Promise<MemberView[]> {
  const rules = await requireManager(c);
  const people = new Map<string, MemberView>();
  people.set(c.site.owner_email, { email: c.site.owner_email, role: null, manages: true, member: false });
  for (const e of parseJsonArray(c.site.editors).map(normEmail)) if (!people.has(e)) people.set(e, { email: e, role: null, manages: true, member: false });
  for (const e of parseJsonArray(c.site.allowed_emails).map(normEmail)) if (!people.has(e)) people.set(e, { email: e, role: rules.default_role ?? null, manages: false, member: false });
  const { results } = await c.env.DB.prepare("SELECT email, role FROM app_members WHERE site_id = ? ORDER BY email").bind(c.site.id).all<{ email: string; role: string }>();
  for (const r of results) if (!people.get(r.email)?.manages) people.set(r.email, { email: r.email, role: r.role, manages: false, member: true });
  return [...people.values()];
}

const target = (site: SiteRow) => `${site.namespace}/${site.mount_path}`;

function emailOf(raw: unknown): string {
  const email = normEmail(String(raw ?? ""));
  if (!isEmail(email)) throw badRequest(`"${String(raw ?? "").slice(0, 80)}" isn't an email address.`, 'Pass an email, like formelab.roles.set("ada@example.com", "salesperson").');
  return email;
}

/** formelab.roles.set(email, role): adds the person (which lets them open the app) or changes their role. */
export async function setRole(c: RolesCaller, rawEmail: unknown, rawRole: unknown): Promise<MemberView> {
  const rules = await requireManager(c);
  const email = emailOf(rawEmail);
  if (email === normEmail(c.site.owner_email) || isListed(c.site.editors, email)) {
    throw err(409, "manages_app", `${email} is this app's owner or an editor, so they already see and change everything.`, "Change what they can do in the app's settings on Formelab.");
  }
  const roles = rolesIn(rules);
  const role = String(rawRole ?? "");
  if (!roles.includes(role)) {
    throw err(400, "role_unknown", `"${role.slice(0, 40)}" isn't one of this app's roles.`, `Use ${roles.map((r) => `"${r}"`).join(", ") || "a role from formelab.json"}.`);
  }
  // One statement, so two managers adding people at once can't pass the limit.
  const res = await c.env.DB.prepare(
    `INSERT INTO app_members (site_id, email, role, added_by, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5
      WHERE EXISTS (SELECT 1 FROM app_members WHERE site_id = ?1 AND email = ?2)
         OR (SELECT COUNT(*) FROM app_members WHERE site_id = ?1) < ?6
     ON CONFLICT (site_id, email) DO UPDATE SET role = excluded.role`,
  )
    .bind(c.site.id, email, role, c.user.email, now(), MEMBERS_MAX)
    .run();
  if (!res.meta.changes) throw err(409, "members_full", `This app already has ${MEMBERS_MAX} people added to it.`, "Remove people who no longer use it first.");
  await audit(c.env, c.user.email, "member_set", target(c.site), { siteId: c.site.id, email, role });
  return { email, role, manages: false, member: true };
}

async function deleteMember(env: Env, site: SiteRow, actor: string, email: string) {
  const res = await env.DB.prepare("DELETE FROM app_members WHERE site_id = ? AND email = ?").bind(site.id, email).run();
  if (!res.meta.changes) throw notFound(`${email} on this app's member list`);
  await audit(env, actor, "member_remove", target(site), { siteId: site.id, email });
  // Someone the app is also shared with keeps opening it (on default_role), and keeps their AI connection.
  if (!(await isAppMember(env, site, email))) await revokeAppGrants(env, site.id, [email]);
  await dropUnlistedAppUsers(env, [email]);
  return { ok: true };
}

/**
 * formelab.roles.remove(email): takes the person off the member list. Someone the app is also
 * shared with in Formelab keeps opening it, with default_role.
 */
export async function removeRole(c: RolesCaller, rawEmail: unknown) {
  await requireManager(c);
  return deleteMember(c.env, c.site, c.user.email, emailOf(rawEmail));
}

/**
 * Whether signing in to this app should give `email` an app user account (part B): they're its
 * owner, an editor, on its share list or added in the app.
 */
export async function isAppMember(env: Env, site: SiteRow, email: string): Promise<boolean> {
  if (normEmail(site.owner_email) === email || isListed(site.editors, email) || isListed(site.allowed_emails, email)) return true;
  return !!(await env.DB.prepare("SELECT 1 FROM app_members WHERE site_id = ? AND email = ?").bind(site.id, email).first());
}

/** The member list on the app's settings page. */
export async function membersOf(env: Env, siteId: string): Promise<{ email: string; role: string }[]> {
  const { results } = await env.DB.prepare("SELECT email, role FROM app_members WHERE site_id = ? ORDER BY email").bind(siteId).all<{ email: string; role: string }>();
  return results;
}

/** "Remove this person" on the app's settings page: who can open the app is for those who share it. */
export async function removeMemberInSettings(ctx: Ctx, id: string, rawEmail: unknown) {
  const { site, ns } = await requireManageableSite(ctx, id);
  if (!canShareSite(ctx.user, site, ns)) {
    throw err(403, "cannot_share", "Only the app's owner and the people they let share it can remove people.", `Ask ${site.owner_email}.`);
  }
  return deleteMember(ctx.env, site, ctx.user.email, emailOf(rawEmail));
}
