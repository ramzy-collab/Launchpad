// Formelab admin: a separate area from anyone's own lab, for running Formelab itself. Admins only.
import type { Context } from "hono";
import { describeActivity, platformActivity } from "../audit";
import { listFlags, STATE_LABEL } from "../flags";
import { CHANGELOG_MD } from "../generated/assets";
import { isOwnerEmail } from "../auth";
import type { AppEnv } from "../env";
import { aiOrigin } from "../hosts";
import { plainPage } from "../serve";
import { adminStats, listUsers } from "../users";
import { escapeHtml as e } from "../util";
import { listWaitlist } from "../waitlist";
import { head, htmlResponse, nav } from "./layout";
import { fmtTime, logoutControl } from "./page";

type Tab = "overview" | "users" | "waitlist" | "features" | "activity" | "changelog";

function adminShell(c: Context<AppEnv>, tab: Tab, body: string): Response {
  const user = c.get("user");
  const current = (t: Tab) => (t === tab ? ' aria-current="page"' : "");
  return htmlResponse(`<!doctype html>
<html lang="en">
<head>
${head("Formelab admin", ["dashboard.js"])}
</head>
<body class="dash admin">
<div class="wrap">
${nav(
  "/",
  `<span class="who">Signed in as <strong>${e(user.email)}</strong> <span class="tag admin">admin</span></span>
    ${logoutControl(c)}`,
)}
<main>
<div class="dash-hero">
  <p class="eyebrow">Formelab admin</p>
  <h1>Run Formelab</h1>
  <p>People, the waitlist and admin access. Changes here affect everyone on Formelab.</p>
</div>
<nav class="tabs" aria-label="Admin sections"><a href="/"${current("overview")}>Overview</a><a href="/users"${current("users")}>Users</a><a href="/waitlist"${current("waitlist")}>Waitlist</a><a href="/features"${current("features")}>Features</a><a href="/activity"${current("activity")}>Activity</a><a href="/changelog"${current("changelog")}>Changelog</a></nav>
<div id="flash" role="status" hidden></div>
${body}
</main>
</div>
</body>
</html>`);
}

/** Admins only; everyone else gets the same "not found" as any unknown page. */
export async function adminPage(c: Context<AppEnv>, tab: Tab): Promise<Response> {
  if (!c.get("user").isAdmin) return plainPage(404, "Not found", "There is nothing here.");
  if (tab === "users") return adminShell(c, tab, await usersBody(c));
  if (tab === "waitlist") return adminShell(c, tab, await waitlistBody(c));
  if (tab === "activity") return adminShell(c, tab, await activityBody(c));
  if (tab === "features") return adminShell(c, tab, await featuresBody(c));
  if (tab === "changelog") return adminShell(c, tab, changelogBody());
  return adminShell(c, tab, await overviewBody(c));
}

const stat = (label: string, value: number, href?: string) =>
  `<div class="stat">${href ? `<a href="${href}">` : ""}<span class="stat-value">${e(value)}</span><span class="stat-label">${e(label)}</span>${href ? "</a>" : ""}</div>`;

async function overviewBody(c: Context<AppEnv>): Promise<string> {
  const [s, waitlist, users] = await Promise.all([adminStats(c.env), listWaitlist(c.env, 5), listUsers(c.env, 5)]);
  const pending = waitlist.entries.filter((w) => !w.approvedAt);
  return `<section>
  <h2>At a glance</h2>
  <div class="stats">
    ${stat("People", s.users, "/users")}
    ${stat("Waiting to get in", s.waiting, "/waitlist")}
    ${stat("Let in, not logged in yet", s.letInNotSignedIn, "/users#not-signed-in")}
    ${stat("Sign-ups this week", s.signupsThisWeek, "/waitlist")}
    ${stat("Apps", s.apps)}
    ${stat("Spaces", s.namespaces)}
    ${stat("Admins", s.admins, "/users")}
  </div>
</section>

<section>
  <h2>Latest sign-ups</h2>
  ${
    pending.length
      ? `<div class="scroll"><table><thead><tr><th>Email</th><th>Joined</th><th></th></tr></thead><tbody>${pending
          .map((w) => `<tr><td>${e(w.email)}</td><td class="nowrap">${e(fmtTime(w.createdAt))}</td><td><button data-action="waitlist-approve" data-email="${e(w.email)}">Let in</button></td></tr>`)
          .join("")}</tbody></table></div>
  <p><a href="/waitlist">See the whole waitlist →</a></p>`
      : `<p class="muted">Nobody is waiting. Share the home page at <a href="${e(aiOrigin(c.env, c.req.url))}/">${e(aiOrigin(c.env, c.req.url))}/</a>.</p>`
  }
</section>

<section>
  <h2>Newest people</h2>
  <div class="scroll"><table><thead><tr><th>Email</th><th>Status</th><th>Joined</th></tr></thead><tbody>${users
    .map((u) => `<tr><td>${e(u.email)}</td><td>${statusTag(u)}</td><td class="nowrap">${e(fmtTime(u.createdAt))}</td></tr>`)
    .join("")}</tbody></table></div>
  <p><a href="/users">Manage people →</a></p>
</section>`;
}

const statusTag = (u: { isAdmin: boolean; status: string }) =>
  u.isAdmin ? '<span class="tag admin">admin</span>' : u.status === "active" ? "Active" : '<span class="tag">waitlist</span>';

async function usersBody(c: Context<AppEnv>): Promise<string> {
  const me = c.get("user");
  const [users, notSignedIn] = await Promise.all([listUsers(c.env), listWaitlist(c.env, 500, "let-in-not-signed-in")]);
  const rows = users
    .map((u) => {
      const owner = isOwnerEmail(c.env, u.email);
      const self = u.email === me.email;
      const adminBtn = owner || self
        ? ""
        : u.isAdmin
          ? `<button class="danger" data-action="user-admin" data-email="${e(u.email)}" data-admin="false">Remove admin</button>`
          : `<button class="secondary" data-action="user-admin" data-email="${e(u.email)}" data-admin="true">Make admin</button>`;
      const deleteBtn = owner || self ? "" : `<button class="danger" data-action="user-delete" data-email="${e(u.email)}" data-apps="${e(u.apps)}">Delete</button>`;
      const note = owner ? '<div class="muted">Owner</div>' : self ? '<div class="muted">You</div>' : "";
      return `<tr><td>${e(u.email)}${u.name ? `<div class="muted">${e(u.name)}</div>` : ""}${note}</td><td>${statusTag(u)}</td><td>${e(u.apps)}</td><td class="nowrap">${e(fmtTime(u.createdAt))}</td>
  <td><div class="inline">${adminBtn}${deleteBtn}</div></td></tr>`;
    })
    .join("");
  return `<section>
  <h2>People<span class="count">${e(users.length)}</span></h2>
  <p class="muted"><strong>Make admin</strong> gives someone this admin area (and lets them in if they were waiting). <strong>Delete</strong> removes the account and everything it owns: its spaces and apps (with their data and secrets), its place on other people's share lists, access keys and connected AI apps.</p>
  <div class="scroll"><table><thead><tr><th>Email</th><th>Status</th><th>Apps</th><th>Joined</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
</section>

<section id="not-signed-in">
  <h2>Let in, not logged in yet<span class="count">${e(notSignedIn.total)}</span></h2>
  ${
    notSignedIn.entries.length
      ? `<p class="muted">You let these people in (or invited them), but they haven't logged in yet. Their account is created the first time they do, and they move up to People.</p>
  <div class="scroll"><table><thead><tr><th>Email</th><th>Joined the waitlist</th><th>Let in</th></tr></thead><tbody>${notSignedIn.entries
    .map((w) => `<tr><td>${e(w.email)}</td><td class="nowrap">${e(fmtTime(w.createdAt))}</td><td class="nowrap">${e(fmtTime(w.approvedAt!))}</td></tr>`)
    .join("")}</tbody></table></div>`
      : `<p class="muted">Everyone you've let in has logged in.</p>`
  }
</section>`;
}

/** CHANGELOG.md as HTML. It's our own file, in a small fixed format: "## YYYY-MM-DD" days and "- " items. */
export function changelogBody(): string {
  const inline = (s: string) => e(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>");
  const day = (iso: string) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  const sections = CHANGELOG_MD.split(/^## /m).slice(1).map((chunk) => {
    const [date, ...lines] = chunk.split("\n");
    const items = lines.filter((l) => l.startsWith("- ")).map((l) => `<li>${inline(l.slice(2))}</li>`).join("");
    return `<section class="changelog-day">
  <h2><time datetime="${e(date!.trim())}">${e(day(date!.trim()))}</time></h2>
  <ul class="changelog">${items}</ul>
</section>`;
  });
  return `<p class="muted">Everything that has changed in Formelab, newest first.</p>
${sections.join("\n")}`;
}

async function featuresBody(c: Context<AppEnv>): Promise<string> {
  const flags = await listFlags(c.env);
  const rows = flags
    .map(
      (f) => `<tr>
  <td><strong>${e(f.label)}</strong><div class="muted">${e(f.description)}</div></td>
  <td class="nowrap">${f.updatedAt ? `${e(fmtTime(f.updatedAt))}<div class="muted">${e(f.updatedBy ?? "")}</div>` : '<span class="muted">Never changed</span>'}</td>
  <td><form class="inline" data-action="feature-set" data-name="${e(f.name)}">
    <select name="state" aria-label="${e(f.label)}">${(["off", "admins", "on"] as const)
      .map((s) => `<option value="${s}"${s === f.state ? " selected" : ""}>${e(STATE_LABEL[s])}</option>`)
      .join("")}</select>
    <button>Save</button>
  </form></td>
</tr>`,
    )
    .join("");
  return `<section>
  <h2>Features</h2>
  <p class="muted">New features ship turned off. Turn one on for <strong>Admins only</strong> to try it yourself, then for <strong>Everyone</strong>. Turning a feature off hides it again right away; nothing people set up is deleted.</p>
  <div class="scroll"><table><thead><tr><th>Feature</th><th>Last changed</th><th>Who gets it</th></tr></thead><tbody>${rows}</tbody></table></div>
</section>`;
}

async function activityBody(c: Context<AppEnv>): Promise<string> {
  const rows = (await platformActivity(c.env, 300))
    .map((a) => `<tr><td class="nowrap">${e(fmtTime(a.at))}</td><td>${e(a.actor)}</td><td>${e(describeActivity(a))}</td></tr>`)
    .join("");
  return `<section>
  <h2>Activity</h2>
  <p class="muted">Formelab-level changes, newest first: people let in and invited, admin access, deleted accounts, spaces, and AI apps connected. What happens inside an app is in that app's own activity log, under <strong>Activity</strong> on its owner's My apps page.</p>
  ${rows ? `<div class="scroll"><table><thead><tr><th>When</th><th>Who</th><th>What they did</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<p class="muted">Nothing yet.</p>`}
</section>`;
}

async function waitlistBody(c: Context<AppEnv>): Promise<string> {
  const waitlist = await listWaitlist(c.env);
  const rows = waitlist.entries
    .map(
      (w) => `<tr><td>${e(w.email)}</td><td class="nowrap">${e(fmtTime(w.createdAt))}</td>
  <td>${w.approvedAt ? `<span class="tag">let in ${e(fmtTime(w.approvedAt).slice(0, 10))}</span>${w.signedIn ? "" : ' <span class="muted">not logged in yet</span>'}` : `<button data-action="waitlist-approve" data-email="${e(w.email)}">Let in</button>`}</td></tr>`,
    )
    .join("");
  return `<section id="waitlist">
  <h2>Waitlist<span class="count">${e(waitlist.total)}</span></h2>
  <p class="muted">${e(waitlist.entries.filter((w) => !w.approvedAt).length)} waiting, ${e(waitlist.entries.filter((w) => w.approvedAt).length)} let in.</p>
  ${
    waitlist.entries.length
      ? `<p class="muted">People who signed up on the home page or tried to log in, newest first${waitlist.total > waitlist.entries.length ? ` (latest ${waitlist.entries.length} shown)` : ""}. <strong>Let in</strong> lets them create apps and emails them.</p>
  <div class="scroll"><table><thead><tr><th>Email</th><th>Joined</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
      : `<p class="muted">No sign-ups yet. Share the home page at <a href="${e(aiOrigin(c.env, c.req.url))}/">${e(aiOrigin(c.env, c.req.url))}/</a>.</p>`
  }
  <h3>Invite someone</h3>
  <p class="muted">They can create apps as soon as they log in, and get a "You're in" email.</p>
  <form class="inline" data-action="waitlist-invite">
    <input name="email" type="email" required placeholder="someone@example.com" aria-label="Email to invite">
    <button>Invite</button>
  </form>
</section>`;
}
