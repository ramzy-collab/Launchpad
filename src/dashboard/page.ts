import type { Context } from "hono";
import { recentActivity } from "../audit";
import { listTokens } from "../auth";
import type { AppEnv, User } from "../env";
import { isDev } from "../env";
import { listNamespaces, listOwnSites, listSharedSites, type SiteView } from "../sites";
import { escapeHtml as e } from "../util";
import { ctxOf } from "../api";
import { listConnections } from "../oauth";
import { listWaitlist } from "../waitlist";
import { isOwnerEmail } from "../auth";
import { listUsers } from "../users";
import { head, htmlResponse, nav } from "./layout";

const fmtTime = (ms: number | null) => (ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "never");
const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

const VISIBILITY_LABEL = { restricted: "Only people you share with", all: "Anyone signed in to Formelab" } as const;

const visibilityOptions = (current: "all" | "restricted") =>
  (["restricted", "all"] as const)
    .map((v) => `<option value="${v}"${v === current ? " selected" : ""}>${VISIBILITY_LABEL[v]}</option>`)
    .join("");

/** The page frame: nav with the account, the My apps / Shared with me tabs, then `body`. */
export function shell(c: Context<AppEnv>, user: User, tab: "mine" | "shared" | "connect", body: string): Response {
  const logout = c.get("sessionId")
    ? `<form method="post" action="/auth/logout" class="logout"><button class="link">Log out</button></form>`
    : `<a class="link" href="/cdn-cgi/access/logout">Log out</a>`;
  const current = (t: string) => (t === tab ? ' aria-current="page"' : "");
  return htmlResponse(`<!doctype html>
<html lang="en">
<head>
${head("Formelab", ["dashboard.js"])}
</head>
<body class="dash">
<div class="wrap">
${nav(
  "/app",
  `<span class="who">Signed in as <strong>${e(user.email)}</strong>${user.isAdmin ? ' <span class="tag admin">admin</span>' : ""}</span>
    ${logout}`,
)}
<main>
<div class="dash-hero">
  <h1>My lab</h1>
  <p>${user.active ? "Publish apps, choose who can open them, and connect your AI tools." : "Apps people share with you show up here."}</p>
</div>
<nav class="tabs" aria-label="Sections"><a href="/app"${current("mine")}>My apps</a><a href="/app/shared"${current("shared")}>Shared with me</a><a href="/app/connect"${current("connect")}>Connect your AI</a></nav>
<div id="flash" role="status" hidden></div>
${body}
</main>
</div>
</body>
</html>`);
}

const waitlistedNotice = `<section class="notice">
  <h2>You're on the waitlist</h2>
  <p>Thanks for signing up. We're letting people in a few at a time, and we'll email you when you can create your own apps.</p>
  <p>Until then, anything someone shares with you appears under <a href="/app/shared">Shared with me</a>.</p>
</section>`;

/** "Shared with me": apps other people own that they shared with this person by name. */
export async function sharedPage(c: Context<AppEnv>): Promise<Response> {
  const ctx = ctxOf(c);
  const sites = await listSharedSites(ctx);
  const rows = sites.map((s) => sharedRow(s)).join("");
  const body = `${ctx.user.active ? "" : waitlistedNotice}
<section>
  <h2>Shared with me<span class="count">${e(sites.length)}</span></h2>
  ${
    sites.length
      ? `<div class="scroll"><table><thead><tr><th>App</th><th>Owner</th><th>Your access</th><th>Updated</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : `<p class="muted">Nothing yet. When someone adds your email to one of their apps, it shows up here.</p>`
  }
</section>`;
  return shell(c, ctx.user, "shared", body);
}

function sharedRow(s: SiteView & { canManage: boolean }): string {
  return `<tr>
  <td><a href="${e(s.url)}" target="_blank" rel="noopener">${e(s.title || s.url)}</a>${s.title ? `<div class="muted">${e(s.url)}</div>` : ""}</td>
  <td>${e(s.ownerEmail)}</td>
  <td>${s.canManage ? "Can edit" : "Can open"}</td>
  <td class="nowrap">${e(fmtTime(s.updatedAt))}</td>
</tr>`;
}

export async function dashboardPage(c: Context<AppEnv>): Promise<Response> {
  const ctx = ctxOf(c);
  const user = ctx.user;
  if (!user.active) return shell(c, user, "mine", waitlistedNotice);
  const [namespaces, sites, tokens, activity, connections, waitlist, users] = await Promise.all([
    listNamespaces(ctx),
    listOwnSites(ctx),
    listTokens(c.env, user),
    recentActivity(c.env, user.email, 50),
    listConnections(c.env, user.email).catch(() => []),
    user.isAdmin ? listWaitlist(c.env) : null,
    user.isAdmin ? listUsers(c.env) : null,
  ]);
  const origin = isDev(c.env) ? new URL(c.req.url).origin : `https://${c.env.DOMAIN}`;
  const t = Date.now();

  const nsRows = namespaces
    .map(
      (n) => `<tr>
  <td><a href="${e(n.url)}" target="_blank" rel="noopener">${e(n.label)}</a></td>
  <td>${e(n.ownerEmail)}</td>
  <td>${
    n.isOwner
      ? `<form class="inline" data-action="ns-editors" data-label="${e(n.label)}">
      <input name="editors" value="${e(n.editors.join(", "))}" placeholder="editor@example.com, ..." aria-label="Editors of ${e(n.label)}">
      <button>Save</button></form>`
      : e(n.editors.join(", ") || "—")
  }</td>
  <td>${n.isOwner ? `<button class="danger" data-action="ns-delete" data-label="${e(n.label)}">Delete</button>` : ""}</td>
</tr>`,
    )
    .join("");

  const siteRows = sites
    .map(
      (s) => `<tr>
  <td><a href="${e(s.url)}" target="_blank" rel="noopener">${e(s.url)}</a>${s.hidden ? ' <span class="tag">hidden</span>' : ""}${s.spa ? ' <span class="tag">spa</span>' : ""}</td>
  <td>${e(s.title ?? "")}</td>
  <td>${e(VISIBILITY_LABEL[s.visibility])}${s.allowedEmails.length ? `<div class="muted">${e(s.allowedEmails.join(", "))}</div>` : ""}</td>
  <td class="nowrap">${e(fmtTime(s.updatedAt))}</td>
  <td>${e(fmtBytes(s.totalBytes))} · ${e(s.fileCount)} files</td>
  <td class="actions">
    <form class="inline" data-action="site-replace" data-namespace="${e(s.namespace)}" data-mount="${e(s.mountPath)}">
      <input type="file" name="file" accept=".html,.htm,.zip" required aria-label="Replacement file">
      <button>Replace</button>
    </form>
    <details><summary>Settings</summary>
      <form class="stack" data-action="site-update" data-id="${e(s.id)}">
        <label>Title <input name="title" value="${e(s.title ?? "")}"></label>
        <label>Who can open it <select name="visibility">${visibilityOptions(s.visibility)}</select></label>
        <label>Share with (can open) <input name="allowed_emails" value="${e(s.allowedEmails.join(", "))}" placeholder="friend@example.com, ..."></label>
        <label>Editors (can update) <input name="editors" value="${e(s.editors.join(", "))}"></label>
        <label class="check"><input type="checkbox" name="spa"${s.spa ? " checked" : ""}> SPA fallback</label>
        <label class="check"><input type="checkbox" name="hidden"${s.hidden ? " checked" : ""}> Hidden from listings</label>
        <button>Save settings</button>
      </form>
    </details>
    <button class="danger" data-action="site-delete" data-id="${e(s.id)}" data-mount="${e(s.mountPath)}" data-namespace="${e(s.namespace)}">Delete</button>
  </td>
</tr>`,
    )
    .join("");

  const tokenRows = tokens
    .map((k) => {
      const state = k.revoked ? "revoked" : k.expiresAt <= t ? "expired" : "active";
      return `<tr>
  <td>${e(k.name)}</td><td>${e(state)}</td><td>${e(fmtTime(k.expiresAt))}</td><td>${e(fmtTime(k.lastUsed))}</td>
  <td>${state === "active" ? `<button class="danger" data-action="token-revoke" data-id="${e(k.id)}">Revoke</button>` : ""}</td>
</tr>`;
    })
    .join("");

  const connectionRows = connections
    .map(
      (k) => `<tr>
  <td>${e(k.clientName)}</td><td class="nowrap">${e(fmtTime(k.createdAt))}</td><td class="nowrap">${e(k.expiresAt ? fmtTime(k.expiresAt) : "—")}</td>
  <td><button class="danger" data-action="connection-revoke" data-id="${e(k.id)}">Disconnect</button></td>
</tr>`,
    )
    .join("");

  const activityRows = activity
    .map(
      (a) => `<tr><td class="nowrap">${e(fmtTime(a.at))}</td><td>${e(a.actor)}</td><td>${e(a.action)}</td><td>${e(a.target ?? "")}</td><td class="muted">${e(a.detail ?? "")}</td></tr>`,
    )
    .join("");

  const waitlistRows = (waitlist?.entries ?? [])
    .map(
      (w) => `<tr><td>${e(w.email)}</td><td class="nowrap">${e(fmtTime(w.createdAt))}</td>
  <td>${w.approvedAt ? `<span class="tag">let in ${e(fmtTime(w.approvedAt).slice(0, 10))}</span>` : `<button data-action="waitlist-approve" data-email="${e(w.email)}">Let in</button>`}</td></tr>`,
    )
    .join("");
  const waitlistSection = waitlist
    ? `<section id="waitlist">
  <h2>Waitlist<span class="count">${e(waitlist.total)}</span></h2>
  ${
    waitlist.entries.length
      ? `<p class="muted">People who signed up on the home page or tried to log in, newest first${waitlist.total > waitlist.entries.length ? ` (latest ${waitlist.entries.length} shown)` : ""}. <strong>Let in</strong> lets them create apps. Only admins see this.</p>
  <div class="scroll"><table><thead><tr><th>Email</th><th>Joined</th><th></th></tr></thead><tbody>${waitlistRows}</tbody></table></div>`
      : `<p class="muted">No sign-ups yet. Share the home page at <a href="/">${e(origin)}/</a>.</p>`
  }
  <form class="inline" data-action="waitlist-invite">
    <input name="email" type="email" required placeholder="someone@example.com" aria-label="Email to invite">
    <button>Invite</button>
  </form>
</section>`
    : "";

  const userRows = (users ?? [])
    .map((u) => {
      const status = u.isAdmin ? '<span class="tag admin">admin</span>' : u.status === "active" ? "Active" : '<span class="tag">waitlist</span>';
      const protectedUser = u.email === user.email || isOwnerEmail(c.env, u.email);
      return `<tr><td>${e(u.email)}${u.name ? `<div class="muted">${e(u.name)}</div>` : ""}</td><td>${status}</td><td>${e(u.apps)}</td><td class="nowrap">${e(fmtTime(u.createdAt))}</td>
  <td>${protectedUser ? "" : `<button class="danger" data-action="user-delete" data-email="${e(u.email)}" data-apps="${e(u.apps)}">Delete</button>`}</td></tr>`;
    })
    .join("");
  const usersSection = users
    ? `<section>
  <h2>Users<span class="count">${e(users.length)}</span></h2>
  <p class="muted">Everyone who has signed in. <strong>Delete</strong> removes the account and everything it owns: its namespaces and apps (with their data and secrets), its place on other people's share lists, tokens and connected AI apps. Only admins see this.</p>
  <div class="scroll"><table><thead><tr><th>Email</th><th>Status</th><th>Apps</th><th>Joined</th><th></th></tr></thead><tbody>${userRows}</tbody></table></div>
</section>`
    : "";

  const nsOptions = namespaces.map((n) => `<option value="${e(n.label)}">`).join("");

  const body = `
<section>
  <h2>Publish an app</h2>
  <form class="grid" data-action="upload">
    <label>Namespace <input name="namespace" list="ns-list" required placeholder="yourname" pattern="[a-z0-9\-]+"></label>
    <datalist id="ns-list">${nsOptions}</datalist>
    <label>Mount path <input name="mount_path" placeholder="my-app (empty for root)"></label>
    <label>File (.html or .zip) <input type="file" name="file" accept=".html,.htm,.zip" required></label>
    <label>Title <input name="title"></label>
    <label>Who can open it <select name="visibility">${visibilityOptions("restricted")}</select></label>
    <label>Share with (can open) <input name="allowed_emails" placeholder="a@example.com, b@example.com"></label>
    <label class="check"><input type="checkbox" name="spa"> SPA fallback</label>
    <div><button>Publish</button></div>
  </form>
</section>

<section>
  <h2>My apps<span class="count">${e(sites.length)}</span></h2>
  ${
    sites.length
      ? `<div class="scroll"><table><thead><tr><th>URL</th><th>Title</th><th>Visibility</th><th>Updated</th><th>Size</th><th>Actions</th></tr></thead><tbody>${siteRows}</tbody></table></div>`
      : `<p class="muted">No apps yet. Publish one above, or connect your AI app below.</p>`
  }
</section>

<section>
  <h2>Namespaces</h2>
  ${
    namespaces.length
      ? `<div class="scroll"><table><thead><tr><th>Namespace</th><th>Owner</th><th>Editors</th><th></th></tr></thead><tbody>${nsRows}</tbody></table></div>`
      : `<p class="muted">You have no namespaces yet.</p>`
  }
  <form class="inline" data-action="ns-create">
    <input name="label" required placeholder="new-namespace" pattern="[a-z0-9\-]+" aria-label="New namespace">
    <button>Create namespace</button>
  </form>
</section>

<section>
  <h2>Deploy tokens</h2>
  <form class="inline" data-action="token-create">
    <input name="name" required placeholder="token name" aria-label="Token name">
    <select name="ttlHours" aria-label="Lifetime">
      <option value="1">1 hour</option><option value="24" selected>24 hours</option><option value="168">7 days</option><option value="720">30 days</option>
    </select>
    <button>Create token</button>
  </form>
  <div id="new-token" hidden>
    <p><strong>Copy this token now. It will not be shown again.</strong></p>
    <div class="copyrow"><code id="new-token-value"></code><button type="button" data-copy="#new-token-value">Copy</button></div>
  </div>
  ${
    tokens.length
      ? `<div class="scroll"><table><thead><tr><th>Name</th><th>State</th><th>Expires</th><th>Last used</th><th></th></tr></thead><tbody>${tokenRows}</tbody></table></div>`
      : ""
  }
</section>

<section>
  <h2>Connect an AI app</h2>
  <p>Build and publish apps by asking Claude, ChatGPT or Gemini. Your connector URL is <code>${e(origin)}/mcp</code>.</p>
  <p><a href="/app/connect">Step-by-step instructions for Claude, ChatGPT, Gemini and Claude Code →</a></p>
</section>

<section>
  <h2>Connected apps</h2>
  ${
    connections.length
      ? `<div class="scroll"><table><thead><tr><th>App</th><th>Connected</th><th>Expires</th><th></th></tr></thead><tbody>${connectionRows}</tbody></table></div>`
      : `<p class="muted">No apps are connected through sign-in yet. Deploy tokens are listed above.</p>`
  }
</section>

<section>
  <h2>Recent activity</h2>
  ${
    activity.length
      ? `<div class="scroll"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead><tbody>${activityRows}</tbody></table></div>`
      : `<p class="muted">Nothing yet.</p>`
  }
</section>
${usersSection}
${waitlistSection}`;

  return shell(c, user, "mine", body);
}
