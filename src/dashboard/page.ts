import type { Context } from "hono";
import { describeActivity, siteActivity } from "../audit";
import { listTokens } from "../auth";
import type { AppEnv, User } from "../env";
import { getManageableSite, listNamespaces, listOwnSites, listSharedSites, type SiteView } from "../sites";
import { escapeHtml as e } from "../util";
import { ApiError } from "../errors";
import { plainPage } from "../serve";
import { adminOrigin } from "../hosts";
import { ctxOf } from "../api";
import { listConnections } from "../oauth";
import { head, htmlResponse } from "./layout";

export const fmtTime = (ms: number | null) => (ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "never");
const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

const VISIBILITY_LABEL = { restricted: "Only people you share with", all: "Anyone signed in to Formelab" } as const;

const visibilityOptions = (current: "all" | "restricted") =>
  (["restricted", "all"] as const)
    .map((v) => `<option value="${v}"${v === current ? " selected" : ""}>${VISIBILITY_LABEL[v]}</option>`)
    .join("");

export function logoutControl(c: Context<AppEnv>): string {
  return c.get("sessionId")
    ? `<form method="post" action="/auth/logout" class="logout"><button class="link">Log out</button></form>`
    : `<a class="link" href="/cdn-cgi/access/logout">Log out</a>`;
}

export type Page = "apps" | "new" | "shared" | "spaces" | "connect" | "connected" | "keys";

const PAGES: Record<Page, { title: string; intro: string }> = {
  apps: { title: "My apps", intro: "Everything you've made, live on Formelab." },
  new: { title: "New app", intro: "Ask your AI to make it, or upload one you already have." },
  shared: { title: "Shared with me", intro: "Apps other people have shared with you." },
  spaces: { title: "Spaces", intro: "A space is the first part of your apps' address, like yourname.formelab.app. Invite editors to publish into it with you." },
  connect: { title: "Connect your AI", intro: "Make and publish apps by asking Claude, ChatGPT or Gemini." },
  connected: { title: "Connected apps", intro: "AI apps you've signed in to Formelab with." },
  keys: { title: "Access keys", intro: "For tools that publish without signing in, like Claude Code or a script. Treat a key like a password." },
};

const MENU_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>`;

/** The page frame: the left menu (with the account menu at its foot), then the page's `body`. */
export function shell(c: Context<AppEnv>, user: User, page: Page, body: string, title?: string): Response {
  const current = (p: Page) => (p === page ? ' aria-current="page"' : "");
  const link = (p: Page, href: string) => `<a href="${href}"${current(p)}>${PAGES[p].title}</a>`;
  const head_ = PAGES[page];
  const menu = user.active
    ? `<a class="new-app" href="/new"${current("new")}><span aria-hidden="true">+</span> New app</a>
    <nav class="side-nav" aria-label="Main">
      <p class="side-label">Apps</p>
      ${link("apps", "/")}
      ${link("shared", "/shared")}
      ${link("spaces", "/spaces")}
      <p class="side-label">Connect</p>
      ${link("connect", "/connect")}
      ${link("connected", "/connected")}
      ${link("keys", "/keys")}
    </nav>`
    : `<nav class="side-nav" aria-label="Main">
      ${link("shared", "/shared")}
      ${link("connect", "/connect")}
    </nav>`;
  return htmlResponse(`<!doctype html>
<html lang="en">
<head>
${head(title ? `${title} · Formelab` : `${head_.title} · Formelab`, ["dashboard.js"])}
</head>
<body class="dash">
<div class="app-shell">
<header class="topbar">
  <a class="brand" href="/" aria-label="Formelab home"><span class="mark"></span>Formelab</a>
  <button type="button" class="menu-toggle" data-menu-toggle aria-controls="sidebar" aria-expanded="false" aria-label="Open menu">${MENU_ICON}</button>
</header>
<aside class="sidebar" id="sidebar">
  <a class="brand" href="/" aria-label="Formelab home"><span class="mark"></span>Formelab</a>
  ${menu}
  <details class="account">
    <summary><span class="avatar" aria-hidden="true">${e(user.email.slice(0, 1).toUpperCase())}</span><span class="who">Signed in as <strong>${e(user.email)}</strong></span></summary>
    <div class="account-menu">
      <button type="button" class="link theme-item" data-theme-toggle><span class="to-dark">Dark mode</span><span class="to-light">Light mode</span></button>
      ${user.isAdmin ? `<a class="link" href="${e(adminOrigin(c.env, c.req.url))}/" target="_blank" rel="noopener">Admin panel ↗</a>` : ""}
      ${logoutControl(c)}
    </div>
  </details>
</aside>
<main class="content">
<div class="page-head">
  <h1>${e(title ?? head_.title)}</h1>
  ${title ? "" : `<p>${e(head_.intro)}</p>`}
</div>
<div id="flash" role="status" hidden></div>
${body}
</main>
</div>
</body>
</html>`);
}

const waitlistedNotice = `<section class="notice">
  <h2>You're on the waitlist</h2>
  <p>Thanks for signing up. We're letting people in a few at a time, and we'll email you when you can make your own apps.</p>
  <p>Until then, anything someone shares with you appears below, and you can already <a href="/connect">connect your AI</a>.</p>
</section>`;

/** "Shared with me": apps other people own that they shared with this person by name. */
export async function sharedPage(c: Context<AppEnv>): Promise<Response> {
  const ctx = ctxOf(c);
  const sites = await listSharedSites(ctx);
  const rows = sites.map((s) => sharedRow(s)).join("");
  const body = `${ctx.user.active ? "" : waitlistedNotice}
<section>
  ${
    sites.length
      ? `<div class="scroll"><table><thead><tr><th>App</th><th>Owner</th><th>Your access</th><th>Updated</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
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
  <td>${s.canManage ? `<a href="/apps/${e(encodeURIComponent(s.id))}/activity">Activity</a>` : ""}</td>
</tr>`;
}

/** An app's activity log: everything done to or in the app, for the people who can manage it. */
export async function appActivityPage(c: Context<AppEnv>, id: string): Promise<Response> {
  const ctx = ctxOf(c);
  let site: SiteView;
  try {
    site = await getManageableSite(ctx, id);
  } catch (err) {
    if (err instanceof ApiError) return plainPage(404, "Not found", "There is nothing here.");
    throw err;
  }
  const rows = (await siteActivity(c.env, site.id))
    .map((a) => `<tr><td class="nowrap">${e(fmtTime(a.at))}</td><td>${e(a.actor)}</td><td>${e(describeActivity(a))}</td></tr>`)
    .join("");
  const mine = site.ownerEmail === ctx.user.email;
  const body = `<section>
  <p><a href="${mine ? "/" : "/shared"}">← ${mine ? "My apps" : "Shared with me"}</a></p>
  <p class="muted"><a href="${e(site.url)}" target="_blank" rel="noopener">${e(site.url)}</a>. Everything people have done to this app: publishing, sharing and settings, secrets, and calls made with its secrets. Newest first.</p>
  ${
    rows
      ? `<div class="scroll"><table><thead><tr><th>When</th><th>Who</th><th>What they did</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : `<p class="muted">Nothing yet.</p>`
  }
</section>`;
  return shell(c, ctx.user, mine ? "apps" : "shared", body, `Activity: ${site.title || `${site.namespace}/${site.mountPath}`}`);
}

/** My apps: the apps you own, with their settings. */
export async function dashboardPage(c: Context<AppEnv>): Promise<Response> {
  const ctx = ctxOf(c);
  if (!ctx.user.active) return sharedPage(c);
  const sites = await listOwnSites(ctx);
  const siteRows = sites
    .map(
      (s) => `<tr>
  <td><a href="${e(s.url)}" target="_blank" rel="noopener">${e(s.title || s.url)}</a>${s.title ? `<div class="muted">${e(s.url)}</div>` : ""}${s.hidden ? ' <span class="tag">hidden</span>' : ""}${s.spa ? ' <span class="tag">spa</span>' : ""}</td>
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
    <a class="action-link" href="/apps/${e(encodeURIComponent(s.id))}/activity">Activity</a>
    <button class="danger" data-action="site-delete" data-id="${e(s.id)}" data-mount="${e(s.mountPath)}" data-namespace="${e(s.namespace)}">Delete</button>
  </td>
</tr>`,
    )
    .join("");
  const body = sites.length
    ? `<section>
  <div class="scroll"><table><thead><tr><th>App</th><th>Who can open it</th><th>Updated</th><th>Size</th><th>Actions</th></tr></thead><tbody>${siteRows}</tbody></table></div>
</section>`
    : `<section class="empty">
  <h2>What do you want to make?</h2>
  <p>A budget tracker, a sign-up sheet for your team, a tiny game. Describe it to your AI and it lands here, live.</p>
  <p><a class="cta" href="/new">+ New app</a></p>
</section>`;
  return shell(c, ctx.user, "apps", body);
}

const EXAMPLE_PROMPT = "Make me a simple budget tracker where I can add expenses by category, and publish it on Formelab.";

/** New app: ask your AI (the easy path), or upload files you already have. */
export async function newAppPage(c: Context<AppEnv>): Promise<Response> {
  const ctx = ctxOf(c);
  if (!ctx.user.active) return sharedPage(c);
  const [namespaces, connections] = await Promise.all([listNamespaces(ctx), listConnections(c.env, ctx.user.email).catch(() => [])]);
  const own = namespaces.filter((n) => n.isOwner || n.editors.includes(ctx.user.email));
  const nsOptions = own.map((n) => `<option value="${e(n.label)}">`).join("");
  const domain = c.env.APP_DOMAIN;
  const body = `<section>
  <p class="eyebrow">The easy way</p>
  <h2>Ask your AI</h2>
  <p>Describe the app in Claude, ChatGPT or Gemini. It makes the app and publishes it here for you. Try something like:</p>
  <div class="copyrow"><p class="prompt" id="example-prompt">${e(EXAMPLE_PROMPT)}</p><button type="button" data-copy="#example-prompt">Copy</button></div>
  ${
    connections.length
      ? `<p class="muted">Your AI is connected (${e(connections.map((k) => k.clientName).join(", "))}). Paste the idea into a chat and you're off.</p>`
      : `<p><a href="/connect">Connect your AI first →</a> It takes about a minute.</p>`
  }
</section>

<section>
  <p class="eyebrow">Already have the files?</p>
  <h2>Upload an app</h2>
  <p class="muted">A single <code>.html</code> file, or a <code>.zip</code> with <code>index.html</code> at the top.</p>
  <form class="grid" data-action="upload" data-next="/">
    <label>Space <input name="namespace" list="ns-list" required placeholder="${e(own[0]?.label ?? "yourname")}" value="${e(own[0]?.label ?? "")}" pattern="[a-z0-9\-]+"></label>
    <datalist id="ns-list">${nsOptions}</datalist>
    <label>Path (optional) <input name="mount_path" placeholder="budget"></label>
    <label>File <input type="file" name="file" accept=".html,.htm,.zip" required></label>
    <label>Title <input name="title" placeholder="Budget tracker"></label>
    <label>Who can open it <select name="visibility">${visibilityOptions("restricted")}</select></label>
    <label>Share with (can open) <input name="allowed_emails" placeholder="a@example.com, b@example.com"></label>
    <label class="check"><input type="checkbox" name="spa"> SPA fallback</label>
    <div><button>Publish</button></div>
  </form>
  <p class="muted">Your app will live at <code>https://&lt;space&gt;.${e(domain)}/&lt;path&gt;/</code>.${own.length ? "" : " New here? Type a name for your space and we'll create it."}</p>
</section>`;
  return shell(c, ctx.user, "new", body);
}

/** Spaces (namespaces): the first part of an app's address, and who can publish into it. */
export async function spacesPage(c: Context<AppEnv>): Promise<Response> {
  const ctx = ctxOf(c);
  if (!ctx.user.active) return sharedPage(c);
  const namespaces = await listNamespaces(ctx);
  const rows = namespaces
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
  const body = `<section>
  ${
    namespaces.length
      ? `<div class="scroll"><table><thead><tr><th>Space</th><th>Owner</th><th>Editors</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
      : `<p class="muted">You have no spaces yet. One is created for you when you publish your first app, or make one here.</p>`
  }
  <h3>New space</h3>
  <form class="inline" data-action="ns-create">
    <input name="label" required placeholder="new-space" pattern="[a-z0-9\-]+" aria-label="New space">
    <button>Create space</button>
  </form>
</section>`;
  return shell(c, ctx.user, "spaces", body);
}

/** Connected apps: AI apps signed in to Formelab through OAuth. */
export async function connectedPage(c: Context<AppEnv>): Promise<Response> {
  const ctx = ctxOf(c);
  const connections = await listConnections(c.env, ctx.user.email).catch(() => []);
  const rows = connections
    .map(
      (k) => `<tr>
  <td>${e(k.clientName)}</td><td class="nowrap">${e(fmtTime(k.createdAt))}</td><td class="nowrap">${e(k.expiresAt ? fmtTime(k.expiresAt) : "—")}</td>
  <td><button class="danger" data-action="connection-revoke" data-id="${e(k.id)}">Disconnect</button></td>
</tr>`,
    )
    .join("");
  const body = `<section>
  ${
    connections.length
      ? `<div class="scroll"><table><thead><tr><th>App</th><th>Connected</th><th>Expires</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
      : `<p class="muted">Nothing connected yet. <a href="/connect">Connect Claude, ChatGPT or Gemini →</a></p>`
  }
</section>`;
  return shell(c, ctx.user, "connected", body);
}

/** Access keys (deploy tokens) for tools that publish without signing in. */
export async function keysPage(c: Context<AppEnv>): Promise<Response> {
  const ctx = ctxOf(c);
  const tokens = await listTokens(c.env, ctx.user);
  const t = Date.now();
  const rows = tokens
    .map((k) => {
      const state = k.revoked ? "revoked" : k.expiresAt <= t ? "expired" : "active";
      return `<tr>
  <td>${e(k.name)}</td><td>${e(state)}</td><td>${e(fmtTime(k.expiresAt))}</td><td>${e(fmtTime(k.lastUsed))}</td>
  <td>${state === "active" ? `<button class="danger" data-action="token-revoke" data-id="${e(k.id)}">Revoke</button>` : ""}</td>
</tr>`;
    })
    .join("");
  const body = `<section>
  <h2>New access key</h2>
  <form class="inline" data-action="token-create">
    <input name="name" required placeholder="What it's for, e.g. laptop" aria-label="Key name">
    <select name="ttlHours" aria-label="Lifetime">
      <option value="1">1 hour</option><option value="24" selected>24 hours</option><option value="168">7 days</option><option value="720">30 days</option>
    </select>
    <button>Create key</button>
  </form>
  <div id="new-token" hidden>
    <p><strong>Copy this key now. It won't be shown again.</strong></p>
    <div class="copyrow"><code id="new-token-value"></code><button type="button" data-copy="#new-token-value">Copy</button></div>
  </div>
  <p class="muted">Claude Code uses a key like this; the steps are under <a href="/connect#claude-code">Connect your AI</a>.</p>
</section>
${
  tokens.length
    ? `<section>
  <h2>Your keys</h2>
  <div class="scroll"><table><thead><tr><th>Name</th><th>State</th><th>Expires</th><th>Last used</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
</section>`
    : ""
}`;
  return shell(c, ctx.user, "keys", body);
}
