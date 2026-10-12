// Formelab admin: a separate area from anyone's own lab, for running Formelab itself. Admins only.
import type { Context } from "hono";
import { isOwnerEmail } from "../auth";
import type { AppEnv } from "../env";
import { publicOrigin } from "../email";
import { plainPage } from "../serve";
import { adminStats, listUsers } from "../users";
import { escapeHtml as e } from "../util";
import { listWaitlist } from "../waitlist";
import { head, htmlResponse, nav } from "./layout";
import { fmtTime, logoutControl } from "./page";

type Tab = "overview" | "users" | "waitlist";

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
  "/admin",
  `<span class="who">Signed in as <strong>${e(user.email)}</strong> <span class="tag admin">admin</span></span>
    <a class="link" href="/app">My lab</a>
    ${logoutControl(c)}`,
)}
<main>
<div class="dash-hero">
  <p class="eyebrow">Formelab admin</p>
  <h1>Run Formelab</h1>
  <p>People, the waitlist and admin access. Changes here affect everyone on Formelab.</p>
</div>
<nav class="tabs" aria-label="Admin sections"><a href="/admin"${current("overview")}>Overview</a><a href="/admin/users"${current("users")}>Users</a><a href="/admin/waitlist"${current("waitlist")}>Waitlist</a></nav>
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
    ${stat("People", s.users, "/admin/users")}
    ${stat("Waiting to get in", s.waiting, "/admin/waitlist")}
    ${stat("Sign-ups this week", s.signupsThisWeek, "/admin/waitlist")}
    ${stat("Apps", s.apps)}
    ${stat("Namespaces", s.namespaces)}
    ${stat("Admins", s.admins, "/admin/users")}
  </div>
</section>

<section>
  <h2>Latest sign-ups</h2>
  ${
    pending.length
      ? `<div class="scroll"><table><thead><tr><th>Email</th><th>Joined</th><th></th></tr></thead><tbody>${pending
          .map((w) => `<tr><td>${e(w.email)}</td><td class="nowrap">${e(fmtTime(w.createdAt))}</td><td><button data-action="waitlist-approve" data-email="${e(w.email)}">Let in</button></td></tr>`)
          .join("")}</tbody></table></div>
  <p><a href="/admin/waitlist">See the whole waitlist →</a></p>`
      : `<p class="muted">Nobody is waiting. Share the home page at <a href="/">${e(publicOrigin(c.env, c.req.url))}/</a>.</p>`
  }
</section>

<section>
  <h2>Newest people</h2>
  <div class="scroll"><table><thead><tr><th>Email</th><th>Status</th><th>Joined</th></tr></thead><tbody>${users
    .map((u) => `<tr><td>${e(u.email)}</td><td>${statusTag(u)}</td><td class="nowrap">${e(fmtTime(u.createdAt))}</td></tr>`)
    .join("")}</tbody></table></div>
  <p><a href="/admin/users">Manage people →</a></p>
</section>`;
}

const statusTag = (u: { isAdmin: boolean; status: string }) =>
  u.isAdmin ? '<span class="tag admin">admin</span>' : u.status === "active" ? "Active" : '<span class="tag">waitlist</span>';

async function usersBody(c: Context<AppEnv>): Promise<string> {
  const me = c.get("user");
  const users = await listUsers(c.env);
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
  <p class="muted"><strong>Make admin</strong> gives someone this admin area (and lets them in if they were waiting). <strong>Delete</strong> removes the account and everything it owns: its namespaces and apps (with their data and secrets), its place on other people's share lists, tokens and connected AI apps.</p>
  <div class="scroll"><table><thead><tr><th>Email</th><th>Status</th><th>Apps</th><th>Joined</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
</section>`;
}

async function waitlistBody(c: Context<AppEnv>): Promise<string> {
  const waitlist = await listWaitlist(c.env);
  const rows = waitlist.entries
    .map(
      (w) => `<tr><td>${e(w.email)}</td><td class="nowrap">${e(fmtTime(w.createdAt))}</td>
  <td>${w.approvedAt ? `<span class="tag">let in ${e(fmtTime(w.approvedAt).slice(0, 10))}</span>` : `<button data-action="waitlist-approve" data-email="${e(w.email)}">Let in</button>`}</td></tr>`,
    )
    .join("");
  return `<section id="waitlist">
  <h2>Waitlist<span class="count">${e(waitlist.total)}</span></h2>
  ${
    waitlist.entries.length
      ? `<p class="muted">People who signed up on the home page or tried to log in, newest first${waitlist.total > waitlist.entries.length ? ` (latest ${waitlist.entries.length} shown)` : ""}. <strong>Let in</strong> lets them create apps and emails them.</p>
  <div class="scroll"><table><thead><tr><th>Email</th><th>Joined</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
      : `<p class="muted">No sign-ups yet. Share the home page at <a href="/">${e(publicOrigin(c.env, c.req.url))}/</a>.</p>`
  }
  <h3>Invite someone</h3>
  <p class="muted">They can create apps as soon as they log in, and get a "You're in" email.</p>
  <form class="inline" data-action="waitlist-invite">
    <input name="email" type="email" required placeholder="someone@example.com" aria-label="Email to invite">
    <button>Invite</button>
  </form>
</section>`;
}
