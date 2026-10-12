// Notification emails, sent through Cloudflare Email Service (the `EMAIL` send_email binding).
// Without the binding or EMAIL_FROM nothing is sent; each skipped message is logged instead.
// Sending never fails the request that triggered it: callers hand the promise to waitUntil.
import type { Env } from "./env";
import { isDev } from "./env";
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

/** The address people should click: the dashboard's origin (the request's own in dev). */
export const publicOrigin = (env: Env, requestUrl?: string) =>
  isDev(env) && requestUrl ? new URL(requestUrl).origin : `https://${env.DOMAIN.toLowerCase()}`;

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
      { label: "Open my lab", url },
    ),
    text: plain(["You're in.", "Your spot on Formelab is ready. Log in, connect the AI you already use, and ask it to build your first app.", `Log in: ${url}`]),
  };
}

export function appSharedEmail(origin: string, to: string, opts: { by: string; title: string; url: string; canEdit: boolean }): Email {
  const access = opts.canEdit ? "open and update" : "open";
  return {
    to,
    subject: `${opts.by} shared "${opts.title}" with you on Formelab`,
    html: layout(
      `${e(opts.title)} was shared with you`,
      [
        `<strong>${e(opts.by)}</strong> shared an app with you on Formelab. You can ${access} it, and you'll find it under <strong>Shared with me</strong>.`,
        `Log in as <strong>${e(to)}</strong> to open it.`,
      ],
      { label: "Open the app", url: opts.url },
    ),
    text: plain([
      `${opts.by} shared "${opts.title}" with you on Formelab. You can ${access} it.`,
      `Open it: ${opts.url}`,
      `Everything shared with you: ${origin}/app/shared (log in as ${to}).`,
    ]),
  };
}

export function namespaceSharedEmail(origin: string, to: string, opts: { by: string; namespace: string; url: string }): Email {
  return {
    to,
    subject: `${opts.by} added you as an editor of "${opts.namespace}" on Formelab`,
    html: layout(
      `You can now edit ${e(opts.namespace)}`,
      [
        `<strong>${e(opts.by)}</strong> added you as an editor of the <strong>${e(opts.namespace)}</strong> namespace. You can open, update and publish the apps in it; they appear under <strong>Shared with me</strong>.`,
      ],
      { label: "See shared apps", url: `${origin}/app/shared` },
    ),
    text: plain([
      `${opts.by} added you as an editor of the "${opts.namespace}" namespace on Formelab.`,
      `Its apps: ${opts.url}`,
      `Everything shared with you: ${origin}/app/shared`,
    ]),
  };
}

export function adminSignupEmail(origin: string, to: string, opts: { email: string; via: "form" | "login"; total: number }): Email {
  const how = opts.via === "form" ? "signed up on the home page" : "logged in before being let in";
  const url = `${origin}/app#waitlist`;
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
export async function notifyAdminOfSignup(env: Env, origin: string, email: string, via: "form" | "login"): Promise<void> {
  const to = env.ADMIN_EMAIL || env.OWNER_EMAIL;
  if (!to || normEmail(to) === normEmail(email)) return;
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM waitlist WHERE approved_at IS NULL").first<{ n: number }>();
  await sendEmail(env, adminSignupEmail(origin, to, { email, via, total: row?.n ?? 0 }));
}
