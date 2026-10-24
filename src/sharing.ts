// The people around an app beyond its share lists: each person's stars, sign-up invites for
// Editors and Admins who don't have an account yet, and handing the app to a new owner.
import { audit } from "./audit";
import { accountsAmong, canShareSite, canViewSite, isAppOwner } from "./auth";
import { now } from "./env";
import { badRequest, err, notFound } from "./errors";
import { appOrigin } from "./hosts";
import { ownershipEmail, roleInviteEmail, sendEach, sendEmail, shareEmailAllowance } from "./email";
import { getNamespace, getSiteById, heldNote, requireManageableSite, siteUrl, siteView, type Ctx, type SiteRow } from "./sites";
import { isEmail, normEmail, parseJsonArray } from "./util";

// ---------------------------------------------------------------------------
// Stars: per person, never seen by anyone else
// ---------------------------------------------------------------------------

/** The ids of the apps this person starred. */
export async function starredIds(ctx: Ctx): Promise<Set<string>> {
  const { results } = await ctx.env.DB.prepare("SELECT site_id FROM app_stars WHERE user_email = ?").bind(ctx.user.email).all<{ site_id: string }>();
  return new Set(results.map((r) => r.site_id));
}

/** Stars or unstars an app the person can open. */
export async function setStar(ctx: Ctx, id: string, rawStarred: unknown) {
  if (typeof rawStarred !== "boolean") throw badRequest("starred must be true or false.", 'Send { "starred": true } to star the app.');
  const site = await getSiteById(ctx.env, id);
  const ns = site ? await getNamespace(ctx.env, site.namespace) : null;
  if (!site || !ns || !canViewSite(ctx.user, site, ns)) throw notFound("App");
  await (rawStarred
    ? ctx.env.DB.prepare("INSERT INTO app_stars (user_email, site_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").bind(ctx.user.email, id, now())
    : ctx.env.DB.prepare("DELETE FROM app_stars WHERE user_email = ? AND site_id = ?").bind(ctx.user.email, id)
  ).run();
  return { id, starred: rawStarred };
}

// ---------------------------------------------------------------------------
// Sign-up invites for Editors and Admins without an account
// ---------------------------------------------------------------------------

export type InviteRole = "editor" | "admin";
export interface PendingInvite {
  email: string;
  role: InviteRole;
  invitedBy: string;
  createdAt: number;
}

export async function pendingInvites(ctx: Ctx, siteId: string): Promise<PendingInvite[]> {
  const { results } = await ctx.env.DB.prepare("SELECT email, role, invited_by, created_at FROM pending_role_invites WHERE site_id = ? ORDER BY created_at")
    .bind(siteId)
    .all<{ email: string; role: InviteRole; invited_by: string; created_at: number }>();
  return results.map((r) => ({ email: r.email, role: r.role, invitedBy: r.invited_by, createdAt: r.created_at }));
}

/** The people on an app's People list who have a Formelab account, for the list's notes. */
export async function peopleWithAccounts(ctx: Ctx, site: { ownerEmail: string; allowedEmails: string[]; editors: string[] }): Promise<string[]> {
  return [...(await accountsAmong(ctx.env, [site.ownerEmail, ...site.allowedEmails, ...site.editors]))];
}

/**
 * Which of `emails` have no account yet: they need a sign-up invite to become an Editor or Admin,
 * and the People list notes it. For the people who may invite others to the app.
 */
export async function withoutAccounts(ctx: Ctx, id: string, rawEmails: unknown) {
  const { site, ns } = await requireManageableSite(ctx, id);
  if (!canShareSite(ctx.user, site, ns)) throw err(403, "sharing_not_allowed", "Only the app's owner and Admins can invite people.", `Ask ${site.owner_email}.`);
  const emails = emailsOf(rawEmails);
  const have = await accountsAmong(ctx.env, emails);
  return { withoutAccount: emails.filter((x) => !have.has(x)) };
}

const ownerOnly = () => err(403, "owner_only", "Only the app's owner can choose its Editors and Admins.", "Ask the owner to change this.");

function emailsOf(raw: unknown): string[] {
  const list = (Array.isArray(raw) ? raw : String(raw ?? "").split(/[\s,;]+/)).map((x) => normEmail(String(x))).filter(Boolean);
  const bad = list.find((x) => !isEmail(x));
  if (bad) throw badRequest(`${bad} isn't an email address.`, "Check the address and try again.");
  if (!list.length || list.length > 50) throw badRequest("Send 1 to 50 email addresses.", "Invite people in smaller groups.");
  return [...new Set(list)];
}

/**
 * Invites people without an account to become an Editor or Admin: they're a viewer right away (so
 * they can open the app), get an email to join, and take the role when they sign up (see
 * applyPendingInvites in auth.ts).
 */
export async function sendRoleInvites(ctx: Ctx, id: string, rawEmails: unknown, rawRole: unknown) {
  const { site, ns } = await requireManageableSite(ctx, id);
  if (!isAppOwner(ctx.user, site, ns)) throw ownerOnly();
  if (rawRole !== "editor" && rawRole !== "admin") throw badRequest('role must be "editor" or "admin".', "Viewers don't need an account; share the app with them directly.");
  const role: InviteRole = rawRole;
  const emails = emailsOf(rawEmails).filter((x) => x !== site.owner_email);
  const have = await accountsAmong(ctx.env, emails);
  const already = emails.filter((x) => have.has(x));
  if (already.length) {
    throw badRequest(`${already.join(", ")} already ${already.length === 1 ? "has" : "have"} a Formelab account.`, `Make ${already.length === 1 ? "them" : "each of them"} an ${role === "admin" ? "Admin" : "Editor"} directly instead.`);
  }
  const viewers = parseJsonArray(site.allowed_emails);
  const newViewers = emails.filter((x) => !viewers.includes(x));
  const t = now();
  await ctx.env.DB.batch([
    ...emails.map((x) =>
      ctx.env.DB.prepare(
        `INSERT INTO pending_role_invites (site_id, email, role, invited_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(site_id, email) DO UPDATE SET role = excluded.role, invited_by = excluded.invited_by, created_at = excluded.created_at`,
      ).bind(id, x, role, ctx.user.email, t),
    ),
    ctx.env.DB.prepare("UPDATE sites SET allowed_emails = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify([...viewers, ...newViewers]), t, id),
  ]);
  const target = `${site.namespace}/${site.mount_path}`;
  await audit(ctx.env, ctx.user.email, "role_invite", target, { siteId: id, emails, role });
  // One email each, counted against the same daily allowance as share emails.
  const { send, held } = await shareEmailAllowance(ctx.env, ctx.user.email, emails);
  const origin = appOrigin(ctx.env, ctx.requestUrl);
  const title = site.title || target;
  const url = siteUrl(ctx.env, site, ctx.requestUrl);
  const roleName = role === "admin" ? "Admin" : "Editor";
  ctx.waitUntil(sendEach(ctx.env, send, ctx.user.email, (to) => roleInviteEmail(origin, to, { by: ctx.user.email, title, role: roleName, url })));
  const note = heldNote(held);
  const updated = (await getSiteById(ctx.env, id)) as SiteRow;
  return { invited: emails, role, site: siteView(ctx.env, updated, ctx.requestUrl), ...(note ? { note, notEmailed: held } : {}) };
}

// ---------------------------------------------------------------------------
// Transfer ownership
// ---------------------------------------------------------------------------

/**
 * Hands the app to one of its Admins who has an account. The old owner stays on as an Admin; the
 * owner of the app's space no longer counts as an owner of it (space_owner_powers = 0).
 */
export async function transferOwnership(ctx: Ctx, id: string, rawTo: unknown, confirmed: unknown) {
  const { site, ns } = await requireManageableSite(ctx, id);
  if (!isAppOwner(ctx.user, site, ns)) throw err(403, "owner_only", "Only the app's owner can hand it to someone else.", `Ask ${site.owner_email}.`);
  if (confirmed !== true) throw badRequest("Confirm the transfer.", "Send confirm: true: only the new owner can transfer it back.");
  const to = normEmail(String(rawTo ?? ""));
  const editors = parseJsonArray(site.editors).map(normEmail);
  const sharers = parseJsonArray(site.sharers ?? "[]").map(normEmail);
  if (to === site.owner_email) throw badRequest(`${to} already owns this app.`, "Pick one of its Admins.");
  if (!editors.includes(to) || !sharers.includes(to)) throw badRequest("Only Admins can become the owner.", `Make ${to || "them"} an Admin first.`);
  if (!(await accountsAmong(ctx.env, [to])).has(to)) throw badRequest(`${to} doesn't have a Formelab account yet.`, "They can become the owner once they've joined.");
  const from = site.owner_email;
  // Whoever hands it over (the owner, or the space's owner) and the old owner stay on as Admins.
  const keep = [...new Set([from, ctx.user.email])];
  const nextEditors = [...new Set([...editors.filter((x) => x !== to), ...keep])];
  const nextSharers = [...new Set([...sharers.filter((x) => x !== to), ...keep])];
  const allowed = parseJsonArray(site.allowed_emails).map(normEmail).filter((x) => x !== to && !keep.includes(x));
  await ctx.env.DB.prepare(
    "UPDATE sites SET owner_email = ?, editors = ?, sharers = ?, allowed_emails = ?, space_owner_powers = 0, updated_at = ? WHERE id = ? AND owner_email = ?",
  )
    .bind(to, JSON.stringify(nextEditors), JSON.stringify(nextSharers), JSON.stringify(allowed), now(), id, from)
    .run();
  const target = `${site.namespace}/${site.mount_path}`;
  await audit(ctx.env, ctx.user.email, "transfer_owner", target, { siteId: id, from, to });
  const updated = (await getSiteById(ctx.env, id)) as SiteRow;
  const origin = appOrigin(ctx.env, ctx.requestUrl);
  ctx.waitUntil(sendEmail(ctx.env, ownershipEmail(origin, to, { by: ctx.user.email, title: site.title || target, settingsUrl: `${origin}/apps/${encodeURIComponent(id)}` })).catch(() => {}));
  return { id, ownerEmail: updated.owner_email, editors: nextEditors, sharers: nextSharers };
}
