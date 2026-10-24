// Notification emails, sent through Cloudflare Email Service (the `EMAIL` send_email binding).
// Without the binding or EMAIL_FROM nothing is sent; each skipped message is logged instead.
// Sending never fails the request that triggered it: callers hand the promise to waitUntil.
import type { Env } from "./env";
import { now } from "./env";
import { adminOrigin, aiOrigin } from "./hosts";
import { escapeHtml as e, normEmail } from "./util";

export interface Email {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export const emailEnabled = (env: Env) => !!(env.EMAIL && env.EMAIL_FROM);

/** "Formelab <hello@formelab.ai>" -> { name, email }; a bare address stays a string. */
export function parseSender(from: string): string | { name: string; email: string } {
  const m = /^\s*(.*?)\s*<([^<>\s]+@[^<>\s]+)>\s*$/.exec(from);
  return m ? { name: m[1]!.replace(/^"|"$/g, ""), email: m[2]! } : from.trim();
}

/** The home page / sign-in origin (DOMAIN), for links in emails. */
export const publicOrigin = (env: Env, requestUrl?: string) => aiOrigin(env, requestUrl);

export async function sendEmail(env: Env, msg: Email): Promise<void> {
  if (!emailEnabled(env)) {
    console.log("email skipped (no EMAIL binding / EMAIL_FROM)", msg.subject);
    return;
  }
  try {
    await env.EMAIL!.send({ from: parseSender(env.EMAIL_FROM!), to: msg.to, subject: msg.subject, text: msg.text, html: msg.html });
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
    console.error("email failed", code, err instanceof Error ? err.message : "unknown", msg.subject);
  }
}

/** Sends one message per address, skipping `except` (usually the person who made the change). */
export function sendEach(env: Env, to: string[], except: string, build: (to: string) => Email): Promise<unknown> {
  const skip = normEmail(except);
  return Promise.all([...new Set(to.map(normEmail))].filter((t) => t && t !== skip).map((t) => sendEmail(env, build(t))));
}

// ---------------------------------------------------------------------------
// Share emails: limits, so Formelab's sending can't be used to spam (audit finding N7)
// ---------------------------------------------------------------------------

/** Share emails one person may cause a UTC day, to anyone. */
export const SHARE_EMAILS_PER_DAY = 100;
/** Of those, to addresses with no Formelab account and not on the waitlist. */
export const SHARE_EMAILS_NEW_PER_DAY = 20;

/** Addresses among `emails` that have an account or are on the waitlist. */
async function knownAddresses(env: Env, emails: string[]): Promise<Set<string>> {
  const known = new Set<string>();
  for (let i = 0; i < emails.length; i += 40) {
    const chunk = emails.slice(i, i + 40);
    const marks = chunk.map(() => "?").join(",");
    const { results } = await env.DB.prepare(`SELECT email FROM users WHERE email IN (${marks}) UNION SELECT email FROM waitlist WHERE email IN (${marks})`)
      .bind(...chunk, ...chunk)
      .all<{ email: string }>();
    for (const r of results) known.add(r.email);
  }
  return known;
}

/**
 * Takes up to `want` of today's `cap` for `key` (D1 rate_counters), returning how many it got. One
 * statement adds the whole `want` and returns the new count, so requests at the same moment each
 * see where they landed and can't share out the same allowance (audit A6).
 */
async function takeToday(env: Env, key: string, cap: number, want: number): Promise<number> {
  if (want <= 0) return 0;
  const day = Math.floor(now() / 86_400_000);
  const row = await env.DB.prepare(
    `INSERT INTO rate_counters (bucket, count, expires_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(bucket) DO UPDATE SET count = count + ?2 RETURNING count`,
  )
    .bind(`${key}:day${day}`, want, (day + 2) * 86_400_000)
    .first<{ count: number }>();
  const before = (row?.count ?? want) - want;
  return Math.max(0, Math.min(want, cap - before));
}

/**
 * Which of `recipients` `sender` may email about a share today: everyone with an account or on
 * the waitlist up to SHARE_EMAILS_PER_DAY, and new addresses up to SHARE_EMAILS_NEW_PER_DAY of
 * those. The rest are `held`: they still get access, but no email.
 */
export async function shareEmailAllowance(env: Env, sender: string, recipients: string[]): Promise<{ send: string[]; held: string[] }> {
  const me = normEmail(sender);
  const list = [...new Set(recipients.map(normEmail))].filter((t) => t && t !== me);
  if (!list.length) return { send: [], held: [] };
  const known = await knownAddresses(env, list);
  const fresh = list.filter((t) => !known.has(t));
  const freshOk = fresh.slice(0, await takeToday(env, `share-mail-new:${me}`, SHARE_EMAILS_NEW_PER_DAY, fresh.length));
  const candidates = list.filter((t) => known.has(t) || freshOk.includes(t));
  const send = candidates.slice(0, await takeToday(env, `share-mail:${me}`, SHARE_EMAILS_PER_DAY, candidates.length));
  const sending = new Set(send);
  return { send, held: list.filter((t) => !sending.has(t)) };
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** A plain, branded layout: the Formelab mark, a heading, paragraphs, and one button. */
function layout(heading: string, paragraphs: string[], button?: { label: string; url: string }): string {
  const p = paragraphs.map((t) => `<p style="margin:0 0 16px;font-size:16px;line-height:1.55;color:#4a4843">${t}</p>`).join("");
  const btn = button
    ? `<p style="margin:24px 0 8px"><a href="${e(button.url)}" style="display:inline-block;background:#5B4CF5;color:#ffffff;text-decoration:none;font-weight:600;font-size:16px;padding:12px 22px;border-radius:12px">${e(button.label)}</a></p>`
    : "";
  return `<!doctype html><html><body style="margin:0;background:#FAFAF8;font-family:Inter,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #ECEAE4;border-radius:20px">
<tr><td style="padding:36px 36px 28px">
<p style="margin:0 0 24px;font-size:20px;font-weight:800;color:#111110"><span style="display:inline-block;width:22px;height:22px;border-radius:7px;background:#5B4CF5;vertical-align:-4px;margin-right:8px"></span>Formelab</p>
<h1 style="margin:0 0 16px;font-size:26px;line-height:1.2;color:#111110">${heading}</h1>
${p}${btn}
</td></tr></table>
<p style="margin:16px 0 0;font-size:12px;color:#A8A69F">Formelab · Software that fits you, not the other way around.</p>
</td></tr></table></body></html>`;
}

const plain = (lines: string[]) => lines.join("\n\n") + "\n\n— Formelab\n";

export function waitlistJoinedEmail(origin: string, to: string): Email {
  return {
    to,
    subject: "You're on the Formelab waitlist",
    html: layout("You're on the list.", [
      "Thanks for signing up for Formelab. We're letting people in a few at a time, and we'll email you as soon as your spot opens.",
      "Until then, start thinking about what you'd make: the booking page, tracker or team tool you've always wanted to fit just right.",
    ]),
    text: plain([
      "You're on the list.",
      "Thanks for signing up for Formelab. We're letting people in a few at a time, and we'll email you as soon as your spot opens.",
      `Formelab: ${origin}/`,
    ]),
  };
}

export function acceptedEmail(origin: string, to: string): Email {
  const url = `${origin}/login`;
  return {
    to,
    subject: "You're in: your Formelab lab is open",
    html: layout(
      "You're in.",
      [
        "Your spot on Formelab is ready. Log in, connect the AI you already use, and ask it to build your first app.",
        "Tip: the <strong>Connect your AI</strong> tab walks you through Claude, ChatGPT and Gemini.",
      ],
      { label: "Open Formelab", url },
    ),
    text: plain(["You're in.", "Your spot on Formelab is ready. Log in, connect the AI you already use, and ask it to build your first app.", `Log in: ${url}`]),
  };
}

export function appSharedEmail(origin: string, to: string, opts: { by: string; title: string; url: string; canEdit: boolean }): Email {
  const access = opts.canEdit ? "open and update" : "open";
  return {
    to,
    // The title is the sharer's own text, so it stays out of the subject and heading (audit N7).
    subject: `${opts.by} shared an app with you on Formelab`,
    html: layout(
      "An app was shared with you",
      [
        `<strong>${e(opts.by)}</strong> shared the app <strong>${e(opts.title)}</strong> with you on Formelab. You can ${access} it, and you'll find it under <strong>My apps</strong>.`,
        `Log in as <strong>${e(to)}</strong> to open it.`,
      ],
      { label: "Open the app", url: opts.url },
    ),
    text: plain([
      `${opts.by} shared "${opts.title}" with you on Formelab. You can ${access} it.`,
      `Open it: ${opts.url}`,
      `Everything shared with you: ${origin}/?owner=others (log in as ${to}).`,
    ]),
  };
}

/** To someone invited as an Editor or Admin who has no account yet: join with this address. */
export function roleInviteEmail(origin: string, to: string, opts: { by: string; title: string; role: "Editor" | "Admin"; url: string }): Email {
  const join = `${origin}/login`;
  return {
    to,
    // The title is the inviter's own text, so it stays out of the subject and heading (audit N7).
    subject: `${opts.by} invited you to edit an app on Formelab`,
    html: layout(
      "You're invited to edit an app",
      [
        `<strong>${e(opts.by)}</strong> wants you as an ${opts.role} of <strong>${e(opts.title)}</strong> on Formelab. ${opts.role}s sign in to make changes, so join Formelab with <strong>${e(to)}</strong>.`,
        `You can already open the app. You become an ${opts.role} as soon as your account is set up. Formelab lets new people in a few at a time, so you may be on the waitlist for a little while before you can publish changes.`,
      ],
      { label: "Join Formelab", url: join },
    ),
    text: plain([
      `${opts.by} wants you as an ${opts.role} of "${opts.title}" on Formelab. Join with ${to} to make changes: ${join}`,
      `You can already open the app: ${opts.url}`,
    ]),
  };
}

/** To an app's new owner, after someone handed it to them. */
export function ownershipEmail(origin: string, to: string, opts: { by: string; title: string; settingsUrl: string }): Email {
  return {
    to,
    subject: `${opts.by} made you the owner of an app on Formelab`,
    html: layout(
      "You own an app now",
      [
        `<strong>${e(opts.by)}</strong> made you the owner of <strong>${e(opts.title)}</strong>. You control who can open it, and only you can delete it or hand it to someone else. ${e(opts.by)} stays on as an Admin.`,
        "It's under <strong>My apps</strong>.",
      ],
      { label: "Open its settings", url: opts.settingsUrl },
    ),
    text: plain([`${opts.by} made you the owner of "${opts.title}" on Formelab. ${opts.by} stays on as an Admin.`, `Its settings: ${opts.settingsUrl}`, `Your apps: ${origin}/`]),
  };
}

export function namespaceSharedEmail(origin: string, to: string, opts: { by: string; namespace: string; url: string }): Email {
  return {
    to,
    subject: `${opts.by} added you as an editor of "${opts.namespace}" on Formelab`,
    html: layout(
      `You can now edit ${e(opts.namespace)}`,
      [
        `<strong>${e(opts.by)}</strong> added you as an editor of the <strong>${e(opts.namespace)}</strong> space. You can open, update and publish the apps in it; they appear under <strong>My apps</strong>.`,
      ],
      { label: "See shared apps", url: `${origin}/?owner=others` },
    ),
    text: plain([
      `${opts.by} added you as an editor of the "${opts.namespace}" space on Formelab.`,
      `Its apps: ${opts.url}`,
      `Everything shared with you: ${origin}/?owner=others`,
    ]),
  };
}

export function adminSignupEmail(origin: string, to: string, opts: { email: string; via: "form" | "login"; total: number }): Email {
  const how = opts.via === "form" ? "signed up on the home page" : "logged in before being let in";
  const url = `${origin}/waitlist`;
  return {
    to,
    subject: `New waitlist sign-up: ${opts.email}`,
    html: layout(
      "Someone joined the waitlist",
      [
        `<strong>${e(opts.email)}</strong> ${how}.`,
        `That makes <strong>${e(opts.total)}</strong> ${opts.total === 1 ? "person" : "people"} on the waitlist. You can let them in from your dashboard.`,
      ],
      { label: "Open the waitlist", url },
    ),
    text: plain([`${opts.email} ${how}.`, `Waitlist total: ${opts.total}.`, `Let them in: ${url}`]),
  };
}

/** Tells the admin about a new waitlist sign-up (ADMIN_EMAIL, else OWNER_EMAIL). */
export async function notifyAdminOfSignup(env: Env, requestUrl: string, email: string, via: "form" | "login"): Promise<void> {
  const origin = adminOrigin(env, requestUrl);
  const to = env.ADMIN_EMAIL || env.OWNER_EMAIL;
  if (!to || normEmail(to) === normEmail(email)) return;
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM waitlist WHERE approved_at IS NULL").first<{ n: number }>();
  await sendEmail(env, adminSignupEmail(origin, to, { email, via, total: row?.n ?? 0 }));
}
