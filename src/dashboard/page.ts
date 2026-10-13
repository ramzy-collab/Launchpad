import type { Context } from "hono";
import { describeActivity, siteActivity } from "../audit";
import { listTokens } from "../auth";
import type { AppEnv, User } from "../env";
import { getManageableSite, listNamespaces, listOwnSites, listSharedSites } from "../sites";
import { escapeHtml as e } from "../util";
import { ApiError } from "../errors";
import { plainPage } from "../serve";
import { adminOrigin, aiOrigin, appOrigin } from "../hosts";
import { canSetPassword, workosEnabled } from "../login";
import { ctxOf } from "../api";
import { head, htmlResponse } from "./layout";
import { SERVICE_ICONS, SPRITE_URL } from "./services";
import { GEMINI_MODEL_NAME, geminiStatus } from "../gemini";
import { sheetsConfigured, sheetsStatus } from "../sheets";
import { ago, appBrowser, appName, fmtBytes, thumb } from "./apps";
import { connectedAiApps, type AiApp } from "./aiapps";
import { AI_LOGOS } from "./logos";

export const fmtTime = (ms: number | null) => (ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "never");

const VISIBILITY_LABEL = { restricted: "Only people you share with", all: "All Formelab members" } as const;

const visibilityOptions = (current: "all" | "restricted") =>
  (["restricted", "all"] as const)
    .map((v) => `<option value="${v}"${v === current ? " selected" : ""}>${VISIBILITY_LABEL[v]}</option>`)
    .join("");

export function logoutControl(c: Context<AppEnv>): string {
  return c.get("sessionId")
    ? `<form method="post" action="/auth/logout" class="logout"><button class="link">Log out</button></form>`
    : `<a class="link" href="/cdn-cgi/access/logout">Log out</a>`;
}

export type Page = "apps" | "new" | "shared" | "spaces" | "connect" | "connected" | "keys" | "account";

const PAGES: Record<Page, { title: string; intro: string }> = {
  apps: { title: "My apps", intro: "Everything you've made, live on Formelab." },
  new: { title: "New app", intro: "Ask your AI to make it, or upload one you already have." },
  shared: { title: "Shared with me", intro: "Apps other people have shared with you." },
  spaces: { title: "Spaces", intro: "A space is the first part of your apps' address, like yourname.formelab.app. Invite editors to publish into it with you." },
  connect: { title: "Connect your AI", intro: "Make and publish apps by asking Claude, ChatGPT or Gemini." },
  connected: { title: "Connected apps", intro: "Services your apps can use through Formelab, without putting keys in them." },
  keys: { title: "Access keys", intro: "For tools that publish without signing in, like Claude Code or a script. Treat a key like a password." },
  account: { title: "Password", intro: "Set a password to log in with your email and password instead of waiting for a code." },
};

export const MENU_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>`;

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
      <a href="/connected"${current("connected")}>Connected apps${c.get("features")?.has("connected_apps") ? "" : ` <span class="soon">Soon</span>`}</a>
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
  <details class="account"${page === "keys" || page === "account" ? " open" : ""}>
    <summary><span class="avatar" aria-hidden="true">${e(user.email.slice(0, 1).toUpperCase())}</span><span class="who">Signed in as <strong>${e(user.email)}</strong></span></summary>
    <div class="account-menu">
      ${c.get("sessionId") ? `<a class="link" href="/account"${current("account")}>Password</a>` : ""}
      <a class="link" href="/keys"${current("keys")}>Access keys</a>
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
  const body = `${ctx.user.active ? "" : waitlistedNotice}
<section>
  ${
    sites.length
      ? appBrowser(sites, { shared: true, appDomain: c.env.APP_DOMAIN })
      : `<p class="muted">Nothing yet. When someone adds your email to one of their apps, it shows up here.</p>`
  }
</section>`;
  return shell(c, ctx.user, "shared", body);
}

/** Loads an app the person can manage, or answers 404 like any unknown page. */
async function manageable(c: Context<AppEnv>, id: string) {
  try {
    return await getManageableSite(ctxOf(c), id);
  } catch (err) {
    if (err instanceof ApiError) return null;
    throw err;
  }
}

/** An app's activity log: everything done to or in the app, for the people who can manage it. */
export async function appActivityPage(c: Context<AppEnv>, id: string): Promise<Response> {
  const site = await manageable(c, id);
  if (!site) return plainPage(404, "Not found", "There is nothing here.");
  const user = c.get("user");
  const rows = (await siteActivity(c.env, site.id))
    .map((a) => `<tr><td class="nowrap">${e(fmtTime(a.at))}</td><td>${e(a.actor)}</td><td>${e(describeActivity(a))}</td></tr>`)
    .join("");
  const body = `<section>
  <p><a href="/apps/${e(encodeURIComponent(site.id))}">← ${e(appName(site))} settings</a></p>
  <p class="muted"><a href="${e(site.url)}" target="_blank" rel="noopener">${e(site.url)}</a>. Everything people have done to this app: publishing, sharing and settings, secrets, and calls made with its secrets. Newest first.</p>
  ${
    rows
      ? `<div class="scroll"><table><thead><tr><th>When</th><th>Who</th><th>What they did</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : `<p class="muted">Nothing yet.</p>`
  }
</section>`;
  return shell(c, user, site.ownerEmail === user.email ? "apps" : "shared", body, `Activity: ${appName(site)}`);
}

/** An app's own page: everything about it, its settings, a new version, recent activity, delete. */
export async function appSettingsPage(c: Context<AppEnv>, id: string): Promise<Response> {
  const site = await manageable(c, id);
  if (!site) return plainPage(404, "Not found", "There is nothing here.");
  const user = c.get("user");
  const mine = site.ownerEmail === user.email;
  const activity = (await siteActivity(c.env, site.id, 5))
    .map((a) => `<tr><td class="nowrap">${e(fmtTime(a.at))}</td><td>${e(a.actor)}</td><td>${e(describeActivity(a))}</td></tr>`)
    .join("");
  const fact = (label: string, value: string) => `<div><dt>${e(label)}</dt><dd>${value}</dd></div>`;
  const body = `<section class="app-head">
  <p><a href="${mine ? "/" : "/shared"}">← ${mine ? "My apps" : "Shared with me"}</a></p>
  <div class="app-title">
    ${thumb(site, "lg")}
    <div><p class="app-url"><a href="${e(site.url)}" target="_blank" rel="noopener">${e(site.url)}</a></p></div>
    <a class="cta open-app" href="${e(site.url)}" target="_blank" rel="noopener">Open app ↗</a>
  </div>
  <dl class="facts">
    ${fact("Space", e(site.namespace))}
    ${fact("Path", e(site.mountPath ? `/${site.mountPath}/` : "/ (the space's root)"))}
    ${fact("Owner", e(site.ownerEmail))}
    ${fact("Who can open it", e(VISIBILITY_LABEL[site.visibility]))}
    ${fact("Published", e(fmtTime(site.createdAt)))}
    ${fact("Last updated", e(`${fmtTime(site.updatedAt)} (${ago(site.updatedAt)})`))}
    ${fact("Size", e(`${fmtBytes(site.totalBytes)} in ${site.fileCount} file${site.fileCount === 1 ? "" : "s"}`))}
    ${fact("Options", e([site.spa ? "SPA fallback" : "", site.hidden ? "Hidden from listings" : ""].filter(Boolean).join(", ") || "None"))}
  </dl>
</section>

<section>
  <h2>Settings and sharing</h2>
  <form class="stack wide" data-action="site-update" data-id="${e(site.id)}">
    <label>Title <input name="title" value="${e(site.title ?? "")}" placeholder="${e(appName(site))}"></label>
    <label>Who can open it <select name="visibility">${visibilityOptions(site.visibility)}</select></label>
    <label>Who can change its data <select name="data_writes">
      <option value="editors"${site.dataWrites === "editors" ? " selected" : ""}>Only the owner and editors</option>
      <option value="everyone"${site.dataWrites === "everyone" ? " selected" : ""}>Everyone who can open it (polls, sign-ups)</option>
    </select></label>
    <label>Share with (can open) <input name="allowed_emails" value="${e(site.allowedEmails.join(", "))}" placeholder="friend@example.com, ..."></label>
    ${
      site.canEditEditors
        ? `<label>Editors (can update it) <input name="editors" value="${e(site.editors.join(", "))}" placeholder="teammate@example.com, ..."></label>`
        : `<p class="muted">Editors: ${e(site.editors.join(", ") || "none")}. Only the owner can change them.</p>`
    }
    ${
      mine && c.get("features")?.has("connected_apps")
        ? `<label>Google Sheets it can use (links or ids, one per line) <textarea name="sheets" rows="3" placeholder="https://docs.google.com/spreadsheets/d/...">${e(site.sheets.join("\n"))}</textarea></label>`
        : ""
    }
    <label class="check"><input type="checkbox" name="spa"${site.spa ? " checked" : ""}> SPA fallback (send unknown addresses in the app to its index.html)</label>
    <label class="check"><input type="checkbox" name="hidden"${site.hidden ? " checked" : ""}> Hidden from listings</label>
    <div><button>Save</button></div>
  </form>
</section>

<section>
  <h2>Publish a new version</h2>
  <p class="muted">Upload a new <code>.html</code> or <code>.zip</code>. It replaces the app's files; its data, secrets and sharing stay as they are.</p>
  <form class="inline" data-action="site-replace" data-namespace="${e(site.namespace)}" data-mount="${e(site.mountPath)}">
    <input type="file" name="file" accept=".html,.htm,.zip" required aria-label="New version">
    <button>Publish</button>
  </form>
</section>

<section>
  <h2>Recent activity</h2>
  ${activity ? `<div class="scroll"><table><tbody>${activity}</tbody></table></div>` : `<p class="muted">Nothing yet.</p>`}
  <p><a href="/apps/${e(encodeURIComponent(site.id))}/activity">See all activity →</a></p>
</section>

${
  mine || site.canEditEditors
    ? `<section class="danger-zone">
  <h2>Delete this app</h2>
  <p class="muted">Removes its files, data and secrets for good. Its address stops working.</p>
  <button class="danger" data-action="site-delete" data-id="${e(site.id)}" data-mount="${e(site.mountPath)}" data-namespace="${e(site.namespace)}" data-next="/">Delete app</button>
</section>`
    : ""
}`;
  return shell(c, user, mine ? "apps" : "shared", body, appName(site));
}

/** My apps: the apps you own, as tiles grouped by space or a list. */
export async function dashboardPage(c: Context<AppEnv>): Promise<Response> {
  const ctx = ctxOf(c);
  if (!ctx.user.active) return sharedPage(c);
  const sites = await listOwnSites(ctx);
  const body = sites.length
    ? `<section>${appBrowser(sites.map((s) => ({ ...s, canManage: true })), { shared: false, appDomain: c.env.APP_DOMAIN })}</section>`
    : `<section class="empty">
  <h2>What do you want to make?</h2>
  <p>A budget tracker, a sign-up sheet for your team, a tiny game. Describe it to your AI and it lands here, live.</p>
  <p><a class="cta" href="/new">+ New app</a></p>
</section>`;
  return shell(c, ctx.user, "apps", body);
}

const IDEAS = [
  "A budget tracker where I add expenses by category and see a monthly total",
  "A sign-up sheet for our team lunch, with a spot for dietary needs",
  "A habit tracker with a streak for each habit",
];

/** New app: describe it and hand it to your AI (the easy path), or upload files you already have. */
export async function newAppPage(c: Context<AppEnv>): Promise<Response> {
  const ctx = ctxOf(c);
  if (!ctx.user.active) return sharedPage(c);
  const [namespaces, connected] = await Promise.all([listNamespaces(ctx), connectedAiApps(c.env, ctx.user)]);
  const own = namespaces.filter((n) => n.isOwner || n.editors.includes(ctx.user.email));
  const nsOptions = own.map((n) => `<option value="${e(n.label)}">`).join("");
  const domain = c.env.APP_DOMAIN;
  const state = (app: AiApp, setup: string) =>
    connected.has(app)
      ? `<span class="badge on"><span class="dot" aria-hidden="true"></span>Connected</span>`
      : `<a class="muted" href="/connect#${app}">${setup}</a>`;
  const body = `<section class="maker">
  <p class="eyebrow">The easy way</p>
  <h2>What do you want to make?</h2>
  <p>Describe it in your own words. We'll open your AI with it typed in; press send and it builds the app and publishes it here.</p>
  <textarea id="idea" rows="4" maxlength="4000" placeholder="${e(IDEAS[0]!)}" aria-label="Describe your app"></textarea>
  <div class="ideas" aria-label="Ideas to start from">${IDEAS.map((i) => `<button type="button" class="idea" data-idea="${e(i)}">${e(i)}</button>`).join("")}</div>
  <div class="make-row">
    <div class="make">
      <button type="button" class="make-btn" data-make="claude"><span class="ai-mini">${AI_LOGOS.claude}</span>Make it with Claude</button>
      ${state("claude", "Connect Claude first")}
    </div>
    <div class="make">
      <button type="button" class="make-btn" data-make="chatgpt"><span class="ai-mini">${AI_LOGOS.chatgpt}</span>Make it with ChatGPT</button>
      ${state("chatgpt", "Connect ChatGPT first")}
    </div>
    <div class="make">
      <button type="button" class="make-btn secondary" data-make="copy"><span class="ai-mini">${AI_LOGOS["claude-code"]}</span>Copy for Claude Code</button>
      ${state("claude-code", "Set up Claude Code")}
    </div>
  </div>
  <p class="muted">Claude: make sure Formelab is on under the <strong>+</strong> menu → Connectors. ChatGPT: pick <strong>Developer mode</strong> in the <strong>+</strong> menu and turn on Formelab. New apps are private to you until you share them.</p>
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

/** Connected apps: services a person's apps can use through Formelab (Google Gemini so far). */
export async function connectedPage(c: Context<AppEnv>): Promise<Response> {
  const user = c.get("user");
  // Behind the connected_apps flag (admin panel → Features): off, the page lists no apps yet.
  const on = !!c.get("features")?.has("connected_apps");
  const gemini = on ? await geminiStatus(c.env, user.email) : { connected: false };
  const sheets = on ? await sheetsStatus(c.env, user.email) : { connected: false };
  const sheetsReady = sheetsConfigured(c.env);
  const SHEETS_OUTCOME: Record<string, [boolean, string]> = {
    connected: [true, "Connected. Your apps can use your Google Sheets now."],
    denied: [false, "You didn't allow access in Google, so nothing was connected."],
    expired: [false, "That sign-in took too long or was already used. Try Connect again."],
    failed: [false, "Google didn't complete the sign-in. Try Connect again."],
    scope: [false, "Google didn't give access to spreadsheets. Try again and leave the spreadsheets box ticked."],
  };
  const outcome = SHEETS_OUTCOME[c.req.query("sheets") ?? ""];
  const sheetsLogo = (() => {
    const icon = SERVICE_ICONS.find(([name]) => name === "Google Sheets")!;
    return `<svg viewBox="0 0 48 48" aria-hidden="true"><rect width="48" height="48" rx="12" fill="${icon[1]}"/><path transform="translate(12 12)" fill="${icon[2]}" d="${icon[3]}"/></svg>`;
  })();
  // The coming-soon wall: each logo drawn once in a cached sprite and reused.
  const tiles = Array.from({ length: Math.max(150, SERVICE_ICONS.length) }, (_, n) => {
    const i = n % SERVICE_ICONS.length;
    return `<svg class="svc" viewBox="0 0 48 48"><use href="${SPRITE_URL}#svc-${i}"/></svg>`;
  }).join("");
  const apps = on
    ? `<section class="howto">
  <h2>Your apps can use</h2>
  <div class="ai-grid">
    <button type="button" class="ai-tile" data-dialog="dlg-gemini-service" aria-haspopup="dialog">
      <span class="ai-logo">${AI_LOGOS.gemini}</span>
      <span class="ai-name">Google Gemini</span>
      <span class="ai-where">${e(GEMINI_MODEL_NAME)}: AI answers, summaries, writing</span>
      ${gemini.connected ? `<span class="badge on"><span class="dot" aria-hidden="true"></span>Connected</span>` : `<span class="badge">Connect</span>`}
    </button>
    <button type="button" class="ai-tile" data-dialog="dlg-google-sheets" aria-haspopup="dialog">
      <span class="ai-logo">${sheetsLogo}</span>
      <span class="ai-name">Google Sheets</span>
      <span class="ai-where">Read and add rows to your spreadsheets</span>
      ${sheets.connected ? `<span class="badge on"><span class="dot" aria-hidden="true"></span>Connected</span>` : `<span class="badge">${sheetsReady ? "Connect" : "Not set up yet"}</span>`}
    </button>
  </div>
</section>

<dialog id="dlg-google-sheets" class="howto-dialog" aria-labelledby="dlg-google-sheets-title">
  <form method="dialog" class="dialog-close"><button aria-label="Close">×</button></form>
  <div class="howto">
    <div class="dialog-head"><span class="ai-logo">${sheetsLogo}</span><h2 id="dlg-google-sheets-title">Google Sheets</h2></div>
    ${outcome ? `<div class="dialog-flash ${outcome[0] ? "ok" : "error"}" role="status">${e(outcome[1])}</div>` : ""}
    <p>Let your apps read and add to your spreadsheets: a sign-up form that saves into a sheet, a dashboard over your numbers, a tracker everyone on your team can use. Sign in with Google once; no keys to copy.</p>
    ${
      !sheetsReady
        ? `<p class="note">Google Sheets isn't set up on this Formelab yet: the admin needs to add a Google sign-in client first.</p>`
        : sheets.connected
          ? `<div class="conn-status"><p><span class="dot" aria-hidden="true"></span><strong>Connected</strong> as ${e(sheets.account ?? "")}.</p>
      <p class="muted">Added ${e(fmtTime(sheets.createdAt ?? null))} · last used ${e(fmtTime(sheets.lastUsedAt ?? null))}</p></div>
    <p><a class="cta" href="/services/google-sheets/connect">Reconnect with Google</a></p>
    <p><button class="danger" data-action="service-disconnect" data-service="google-sheets">Disconnect Google Sheets</button></p>`
          : `<p><a class="cta" href="/services/google-sheets/connect">Connect with Google</a></p>
    <p class="muted">Google asks you to pick an account and allow access to your spreadsheets.</p>`
    }
    <p class="muted">Apps use your Google account, also when people you share them with use them. Your sign-in is encrypted and never shown to apps or people. Ask your AI for an app "that saves to Google Sheets" and it will use this.</p>
  </div>
</dialog>

<dialog id="dlg-gemini-service" class="howto-dialog" aria-labelledby="dlg-gemini-service-title">
  <form method="dialog" class="dialog-close"><button aria-label="Close">×</button></form>
  <div class="howto">
    <div class="dialog-head"><span class="ai-logo">${AI_LOGOS.gemini}</span><h2 id="dlg-gemini-service-title">Google Gemini</h2></div>
    <p>Give your apps AI: answering questions, summarizing, drafting, sorting. Add your Gemini API key once and any of your apps can use <strong>${e(GEMINI_MODEL_NAME)}</strong>, without the key ever being put in an app.</p>
    ${
      gemini.connected
        ? `<div class="conn-status"><p><span class="dot" aria-hidden="true"></span><strong>Connected</strong> with the key ending in ${e(gemini.hint ?? "")}.</p>
      <p class="muted">Added ${e(fmtTime(gemini.createdAt ?? null))} · last used ${e(fmtTime(gemini.lastUsedAt ?? null))}</p></div>
    <h3>Replace the key</h3>`
        : `<h3>Connect it</h3>
    <ol>
      <li>Open <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Google AI Studio → API keys</a> and sign in with Google.</li>
      <li>Click <strong>Create API key</strong> and copy it.</li>
      <li>Paste it here and click <strong>Connect</strong>. Formelab checks it with Google first.</li>
    </ol>`
    }
    <form class="inline" data-action="service-connect" data-service="gemini">
      <input type="password" name="apiKey" required autocomplete="off" spellcheck="false" placeholder="Paste your Gemini API key" aria-label="Gemini API key">
      <button>${gemini.connected ? "Replace key" : "Connect"}</button>
    </form>
    <p class="muted">Your key is encrypted and never shown to apps or to anyone. Apps you share use your key, so calls from people you share them with count toward your Google usage. Ask your AI for an app "that uses Gemini" and it will use this.</p>
    ${gemini.connected ? `<p><button class="danger" data-action="service-disconnect" data-service="gemini">Disconnect Gemini</button></p>` : ""}
  </div>
</dialog>

`
    : "";
  const body = `${apps}<section class="soon-wall${on ? " compact" : ""}">
  <div class="wall" aria-hidden="true">${tiles}</div>
  <div class="soon-card">
    <p class="eyebrow">${on ? "More coming soon" : "Coming soon"}</p>
    <h2>Plug your apps into the tools you already use</h2>
    <p>${
      on
        ? "Next up: Stripe, Gmail, Notion and more. Connect them here once, and any of your apps can use them."
        : "Soon you'll connect services like Google Sheets, Stripe, Gmail and Notion here, once, and any of your apps can use them. No keys to copy, no code to write."
    }</p>
    <p class="muted">Looking for Claude, ChatGPT or Gemini chat? They're under <a href="/connect">Connect your AI</a>.</p>
  </div>
</section>`;
  return shell(c, user, "connected", body);
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
  <td>${e(k.name)}</td><td>${e(state)}</td><td>${e(k.clientName ?? "—")}</td><td>${e(fmtTime(k.expiresAt))}</td><td>${e(fmtTime(k.lastUsed))}</td>
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
  <div class="scroll"><table><thead><tr><th>Name</th><th>State</th><th>Used by</th><th>Expires</th><th>Last used</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
</section>`
    : ""
}`;
  return shell(c, ctx.user, "keys", body);
}

/**
 * Password: set or change the password used to log in with WorkOS. Only right after a sign-in
 * (see PASSWORD_REAUTH_MS); otherwise the page asks the person to log in again first.
 */
export async function accountPage(c: Context<AppEnv>): Promise<Response> {
  const user = c.get("user");
  if (!workosEnabled(c.env) || !c.get("sessionId")) {
    return shell(c, user, "account", `<section><p class="muted">Your organization handles sign-in for this Formelab, so there's no Formelab password to set.</p></section>`);
  }
  const body = (await canSetPassword(c.env, c.get("sessionId")))
    ? `<section>
  <h2>New password</h2>
  <form class="stack" data-action="password-set">
    <input type="email" name="username" autocomplete="username" value="${e(user.email)}" readonly hidden>
    <label>Password <input type="password" name="password" autocomplete="new-password" minlength="10" maxlength="256" required></label>
    <label>Confirm password <input type="password" name="confirm" autocomplete="new-password" minlength="10" maxlength="256" required></label>
    <button>Save password</button>
  </form>
  <p class="muted">Use at least 10 characters. Next time, choose <strong>Continue with email</strong> and enter ${e(user.email)}; you can use this password or a one-time code. If you forget it, use <strong>Forgot password</strong> on the login screen.</p>
</section>`
    : `<section>
  <h2>Confirm it's you</h2>
  <p>For your security, log in again before you set or change your password. You'll come straight back here.</p>
  <p><a class="btn" href="${e(reauthUrl(c))}">Log in again</a></p>
</section>`;
  return shell(c, user, "account", body);
}

/** The login flow on DOMAIN, ending with a fresh session handed back to this page. */
function reauthUrl(c: Context<AppEnv>): string {
  const back = `/auth/app?return=${encodeURIComponent(`${appOrigin(c.env, c.req.url)}/account`)}`;
  return `${aiOrigin(c.env, c.req.url)}/auth/login?provider=email&return=${encodeURIComponent(back)}`;
}
