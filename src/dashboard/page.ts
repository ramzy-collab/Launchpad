import type { Context } from "hono";
import { describeActivity, HIGH_VOLUME_ACTIONS, siteActivity, type AuditRow } from "../audit";
import { canPublishTo, listTokens } from "../auth";
import type { AppEnv, User } from "../env";
import { getManageableSite, getNamespace, getSiteById, listNamespaces, listOwnSites, listSharedSites, type SiteView } from "../sites";
import { ago, escapeHtml as e } from "../util";
import { ApiError } from "../errors";
import { notFoundPage } from "../serve";
import { adminOrigin, aiOrigin, appOrigin } from "../hosts";
import { canSetPassword, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, workosEnabled } from "../login";
import { ctxOf } from "../api";
import { head, htmlResponse } from "./layout";
import { SERVICE_ICONS } from "./services";
import { accessOf, appBrowser, appName, hueClass, ICON, sharedWith, thumb } from "./apps";
import { connectedAiApps, type AiApp } from "./aiapps";
import { AI_LOGOS } from "./logos";
import { BUILDER_LABEL, BUILDERS, builderKeys, type Builder } from "../builder";
import { PWA_HEAD } from "../pwa";
import { csvDownload, responsesCsv } from "../responses";
import { flagOnForOwner } from "../flags";
import { appPreviewText } from "../share";
import { peopleWithAccounts, pendingInvites, starredIds } from "../sharing";
import { appConnections, type AppConnections } from "../connections";

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

export type Page = "apps" | "new" | "spaces" | "connect" | "connected" | "keys" | "account" | "install";

const PAGES: Record<Page, { title: string; intro: string }> = {
  apps: { title: "My apps", intro: "Apps you made, and apps other people shared with you." },
  new: { title: "New app", intro: "Ask your AI to make it, or upload one you already have." },
  spaces: { title: "Spaces", intro: "A space is the first part of your apps' address, like yourname.formelab.app. Invite editors to publish into it with you." },
  connect: { title: "Connect your AI", intro: "Make and publish apps by asking Claude, ChatGPT or Gemini." },
  connected: { title: "Connected apps", intro: "Services your apps can use through Formelab, without putting keys in them." },
  keys: { title: "Access keys", intro: "For tools that publish without signing in, like Claude Code or a script. Treat a key like a password." },
  account: { title: "Password", intro: "Set a password to log in with your email and password instead of waiting for a code." },
  install: { title: "Get the app", intro: "Put Formelab, and any app on it, on your phone's home screen or your computer's dock. It opens in its own window, like any other app." },
};

const PHONE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="2" width="12" height="20" rx="3"/><path d="M11 18h2"/></svg>`;

export const MENU_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>`;

/** The page frame: the left menu (with the account menu at its foot), then the page's `body`. */
export function shell(c: Context<AppEnv>, user: User, page: Page, body: string, title?: string, opts: { pageHead?: boolean } = {}): Response {
  const current = (p: Page) => (p === page ? ' aria-current="page"' : "");
  const link = (p: Page, href: string) => `<a href="${href}"${current(p)}>${PAGES[p].title}</a>`;
  const head_ = PAGES[page];
  const getApp = `<a class="get-app" href="/install"${current("install")}>${PHONE_ICON}<span>Get the app</span></a>`;
  const menu = user.active
    ? `<a class="new-app" href="/new"${current("new")}><span aria-hidden="true">+</span> New app</a>
    <nav class="side-nav" aria-label="Main">
      <p class="side-label">Apps</p>
      ${link("apps", "/")}
      ${link("spaces", "/spaces")}
      <p class="side-label">Connect</p>
      ${link("connect", "/connect")}
      ${c.get("features")?.has("connected_apps") ? `<a href="/connected"${current("connected")}>Connected apps</a>` : ""}
    </nav>
    ${getApp}`
    : `<nav class="side-nav" aria-label="Main">
      ${link("apps", "/")}
      ${link("connect", "/connect")}
    </nav>
    ${getApp}`;
  return htmlResponse(`<!doctype html>
<html lang="en">
<head>
${head(title ? `${title} · Formelab` : `${head_.title} · Formelab`, ["dashboard.js", "install.js"], { extra: PWA_HEAD })}
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
${
  opts.pageHead === false
    ? ""
    : `<div class="page-head">
  <h1>${e(title ?? head_.title)}</h1>
  ${title ? "" : `<p>${e(head_.intro)}</p>`}
</div>`
}
<div id="flash" role="status" hidden></div>
${body}
</main>
</div>
<div class="toast" id="toast" role="status" aria-live="polite" hidden></div>
</body>
</html>`);
}

const waitlistedNotice = `<section class="notice">
  <h2>You're on the waitlist</h2>
  <p>Thanks for signing up. We're letting people in a few at a time, and we'll email you when you can make your own apps.</p>
  <p>Until then, anything someone shares with you appears below, and you can already <a href="/connect">connect your AI</a>.</p>
</section>`;

/** Loads an app the person can manage, or answers 404 like any unknown page. */
async function manageable(c: Context<AppEnv>, id: string) {
  try {
    return await getManageableSite(ctxOf(c), id);
  } catch (err) {
    if (err instanceof ApiError) return null;
    throw err;
  }
}

/** Every response the app received, as a spreadsheet, for the people who can manage it. */
export async function appResponsesCsv(c: Context<AppEnv>, id: string): Promise<Response> {
  const site = await manageable(c, id);
  if (!site || !(await flagOnForOwner(c.env, "responses", site.ownerEmail))) return notFoundPage();
  return csvDownload(appName(site), "responses", await responsesCsv(c.env, site.id));
}

/** An app's activity log: everything done to or in the app, for the people who can manage it. */
export async function appActivityPage(c: Context<AppEnv>, id: string): Promise<Response> {
  const site = await manageable(c, id);
  if (!site) return notFoundPage();
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
  return shell(c, user, "apps", body, `Activity: ${appName(site)}`);
}

/** Google Sheets' logo, from the services sprite's data. */
export const SHEETS_LOGO = () => {
  const icon = SERVICE_ICONS.find(([name]) => name === "Google Sheets")!;
  return `<svg viewBox="0 0 48 48" aria-hidden="true"><rect width="48" height="48" rx="12" fill="${icon[1]}"/><path transform="translate(12 12)" fill="${icon[2]}" d="${icon[3]}"/></svg>`;
};
export const KEY_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="15" r="4"/><path d="M10.8 12.2L20 3M16 7l3 3M14 9l2 2"/></svg>`;

/** A custom connector's tile logo: its first letter on a color picked from its name. */
export function connectorLogo(label: string): string {
  const colors = ["#5B4CF5", "#FF6B4A", "#1E8E4E", "#C2410C", "#0E7490", "#9D174D", "#4D7C0F", "#7C3AED"];
  let h = 0;
  for (const ch of label) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const letter = e((label.trim()[0] ?? "?").toUpperCase());
  return `<svg viewBox="0 0 48 48" aria-hidden="true"><rect width="48" height="48" rx="12" fill="${colors[h % colors.length]}"/><text x="24" y="31" text-anchor="middle" font-family="Bricolage Grotesque, system-ui, sans-serif" font-weight="800" font-size="22" fill="#fff">${letter}</text></svg>`;
}

/** A spreadsheet in an app's list: a link to open it in Google Sheets, and Remove for the owner. */
export function sheetItem(id: string, canEdit: boolean): string {
  return `<li class="sheet-item" data-sheet="${e(id)}">${SHEETS_LOGO()}<a href="https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}" target="_blank" rel="noopener">Spreadsheet ${e(id.slice(-6))}</a>${
    canEdit ? `<button type="button" class="secondary small" data-sheet-remove="${e(id)}">Remove</button>` : ""
  }</li>`;
}

/** The app page's Connected apps tab: what this app is connected to (connected_apps flag). */
function connectionsPanel(site: SiteView, conns: AppConnections, opts: { isSiteOwner: boolean; canManage: boolean }): string {
  const owner = opts.isSiteOwner ? "your" : `${site.ownerEmail}'s`;
  const rows: string[] = [];
  // Open the connector's page and Remove it from the app: only for the app's owner, whose key it is.
  const actions = (name: string, page: string | null) =>
    opts.isSiteOwner
      ? `<div class="conn-actions">${page ? `<a class="ghost small" href="${e(page)}">Open</a>` : ""}<button type="button" class="secondary small" data-conn-remove="${e(name)}">Remove</button></div>`
      : "";
  if (conns.gemini.inApp) {
    rows.push(`<div class="conn" data-conn="gemini">
  <span class="conn-ic">${AI_LOGOS.gemini}</span>
  <div class="conn-txt">
    <strong>Google Gemini ${conns.gemini.connected ? `<span class="chip ok">Connected</span>` : `<span class="chip off">Not connected</span>`}</strong>
    <span>AI that writes, sorts and summarizes inside this app, with ${e(owner)} Gemini key.${conns.gemini.lastUsedAt ? ` Last used ${e(ago(conns.gemini.lastUsedAt))}.` : ""}</span>
    ${
      conns.gemini.connected
        ? ""
        : `<span class="conn-note">The key isn't connected any more, so this app can't use Gemini until it's connected again${opts.isSiteOwner ? ` on <a href="/connected/gemini">Google Gemini</a>` : ""}.</span>`
    }
  </div>
  ${actions("gemini", "/connected/gemini")}
</div>`);
  }
  for (const k of conns.connectors) {
    const page = `/connected/${encodeURIComponent(k.name)}`;
    rows.push(`<div class="conn" data-conn="${e(k.name)}">
  <span class="conn-ic">${connectorLogo(k.label ?? k.name)}</span>
  <div class="conn-txt">
    <strong>${e(k.label ?? k.name)} ${k.label ? `<span class="chip ok">Connected</span>` : `<span class="chip off">Missing</span>`}</strong>
    <span>${
      k.label
        ? `Only sent to ${e(k.hosts.join(", "))}, with ${e(owner)} key.${k.lastUsedAt ? ` Last used ${e(ago(k.lastUsedAt))}.` : ""}`
        : `${opts.isSiteOwner ? "You don't" : `${e(site.ownerEmail)} doesn't`} have a connector called ${e(k.name)} any more, so this app can't use it.`
    }</span>
  </div>
  ${actions(k.name, k.label ? page : null)}
</div>`);
  }
  // Adding a spreadsheet, in the Google Sheets row (owner only). An app gets its first one from the
  // AI that builds it (update_site's sheets), so apps that don't use Sheets never show it here.
  const sheetAdd = (label: string) => `<button type="button" class="linkish" data-sheet-add-open aria-expanded="false" aria-controls="sheet-add">${label}</button>
    <form class="sheet-add" id="sheet-add" data-sheet-add hidden>
      <input name="sheet" autocomplete="off" spellcheck="false" placeholder="https://docs.google.com/spreadsheets/d/..." aria-label="Google Sheets link">
      <button>Add it</button>
    </form>`;
  if (conns.sheets.ids.length) {
    rows.push(`<div class="conn" data-conn="sheets">
  <span class="conn-ic">${SHEETS_LOGO()}</span>
  <div class="conn-txt">
    <strong>Google Sheets ${conns.sheets.connected ? `<span class="chip ok">Connected</span>` : `<span class="chip off">Not connected</span>`}</strong>
    <span>Reads and adds rows to the spreadsheets listed here, with ${e(owner)} Google account, and nothing else in ${opts.isSiteOwner ? "your" : "their"} Drive.</span>
    ${conns.sheets.connected ? "" : `<span class="conn-note">Google Sheets isn't connected, so this app can't reach these spreadsheets. ${opts.isSiteOwner ? `Connect it on <a href="/connected">Connected apps</a>.` : `Ask ${e(site.ownerEmail)} to connect it.`}</span>`}
    <ul class="sheet-list" data-sheet-list>${conns.sheets.ids.map((id) => sheetItem(id, opts.isSiteOwner)).join("")}</ul>
    <p class="muted sheet-empty" data-sheet-empty${conns.sheets.ids.length ? " hidden" : ""}>No spreadsheets yet.</p>
    ${opts.isSiteOwner ? sheetAdd("+ Add a spreadsheet") : ""}
  </div>
</div>`);
  }
  for (const k of conns.keys) {
    const where = k.hosts.length ? `Only ever sent to ${k.hosts.join(", ")}, never shown in the app or to people you share it with.` : "Saved before keys listed where they may be sent, so the app can't use it until it's saved again with its hosts.";
    rows.push(`<div class="conn" data-key="${e(k.name)}">
  <span class="conn-ic key">${KEY_ICON}</span>
  <div class="conn-txt">
    <strong>${e(k.name)} <span class="chip ok">Key saved</span></strong>
    <span>${e(where)}</span>
    <form class="key-replace" data-key-form hidden>
      <input type="password" name="value" autocomplete="off" spellcheck="false" placeholder="Paste the new key" aria-label="New key for ${e(k.name)}">
      <button>Save key</button><button type="button" class="secondary" data-key-cancel>Cancel</button>
    </form>
  </div>
  ${
    opts.canManage
      ? `<div class="conn-actions">${k.hosts.length ? `<button type="button" class="secondary small" data-key-replace>Replace key</button>` : ""}<button type="button" class="secondary small" data-key-remove>Remove</button></div>`
      : ""
  }
</div>`);
  }
  return `<h2>Connected to this app</h2>
  <p class="muted" data-conn-intro${rows.length ? "" : " hidden"}>The services this app was built to use. To add another, ask your AI to use it in the app. Keys and settings are on each connector's page in <a href="/connected">Connected apps</a>.</p>
  <div class="conns" data-conns>${rows.join("\n")}</div>
  <div class="conn-empty" data-conn-empty${rows.length ? " hidden" : ""}><strong>Nothing connected yet.</strong><br>Connect AI, spreadsheets or other services on the <a href="/connected">Connected apps</a> page, then ask your AI to use them in this app.</div>`;
}

/** The roles on an app's People list, from its share lists. */
type Role = "viewer" | "editor" | "admin";
const ROLE_NAME: Record<Role, string> = { viewer: "Viewer", editor: "Editor", admin: "Admin" };

function roleOf(s: SiteView, email: string): Role {
  if (s.editors.includes(email)) return s.sharers.includes(email) ? "admin" : "editor";
  return "viewer";
}

/** The line under a person on the People list: their invite and account state. */
function personNote(opts: { pending?: Role; hasAccount: boolean }): string {
  if (opts.pending) return `Sign-up invite sent. Becomes ${aRole(opts.pending)} once they join Formelab.`;
  if (!opts.hasAccount) return "Invited, no Formelab account yet";
  return "Invited";
}
const aRole = (r: Role) => (r === "viewer" ? "a Viewer" : r === "editor" ? "an Editor" : "an Admin");

/** The People list: the owner first, then everyone the app is shared with by name. */
function peopleRows(s: SiteView, me: string, isOwner: boolean, canShare: boolean, accounts: Set<string>, pending: Map<string, Role>): string {
  const owner = `<li class="person"><span class="avatar" aria-hidden="true">${e(s.ownerEmail.slice(0, 1).toUpperCase())}</span><span class="pi"><span class="pe">${e(s.ownerEmail)}${s.ownerEmail === me ? " (you)" : ""}</span><span class="ps">Owner</span></span><span class="role-label">Owner</span></li>`;
  const rows = sharedWith(s).map((email) => {
    const role = roleOf(s, email);
    // The owner changes every role; Admins only Viewers (the backend lets only the owner choose editors).
    const roles = email === me ? "" : isOwner ? "viewer,editor,admin" : canShare && role === "viewer" ? "viewer" : "";
    const control = roles
      ? `<button type="button" class="rp-btn" data-person="${e(email)}" data-role="${role}" data-roles="${roles}" aria-haspopup="listbox" aria-expanded="false" aria-label="Role for ${e(email)}"><span>${ROLE_NAME[role]}</span>${ICON.chevron()}</button>`
      : `<span class="role-label">${ROLE_NAME[role]}</span>`;
    const note = personNote({ pending: pending.get(email), hasAccount: accounts.has(email) });
    return `<li class="person"><span class="avatar soft" aria-hidden="true">${e(email.slice(0, 1).toUpperCase())}</span><span class="pi"><span class="pe">${e(email)}${email === me ? " (you)" : ""}</span><span class="ps${pending.has(email) ? " pending" : ""}">${e(note)}</span></span>${control}</li>`;
  });
  return owner + rows.join("");
}

/** The note under the chat preview card, from what previews show now. */
function previewNote(s: SiteView): string {
  const lead = "This is what people see when the link is shared in iMessage, Slack or WhatsApp.";
  if (s.linkPreview === "private") return `${lead} Because the app is invited only, it shows a private card and the app's name stays hidden.`;
  return s.publicUrl ? `${lead} Because the link is public, it shows the app's name and picture.` : `${lead} It shows the app's name and picture.`;
}

/** An activity row as a sentence about who did it: "You turned on the public link". */
export function activitySentence(row: AuditRow, me: string): string {
  const s = describeActivity(row);
  const rest = s.slice(0, 1).toLowerCase() + s.slice(1);
  // Calls the app makes (Gemini, Sheets, keys) are the app's doing, whoever was using it.
  if ((HIGH_VOLUME_ACTIONS as readonly string[]).includes(row.action)) return `The app ${rest}`;
  return `${row.actor === me ? "You" : row.actor} ${rest}`;
}

const UPDATE_IDEAS = ["Add a search bar", "Make it work better on phones", "Add an export to spreadsheet button"];
/** Which saved key "Update with ..." uses: Gemini first (it's free), then the others. */
const UPDATE_ORDER: Builder[] = ["gemini", "claude", "openai", "grok"];

/** An app's own page: its name and share pill, then Sharing, Update and Activity tabs. */
export async function appSettingsPage(c: Context<AppEnv>, id: string): Promise<Response> {
  const site = await manageable(c, id);
  if (!site) return notFoundPage();
  const user = c.get("user");
  const mine = site.ownerEmail === user.email;
  const isOwner = site.canEditEditors;
  const name = appName(site);
  const row = await getSiteById(c.env, site.id);
  const [activity, responsesOn, preview] = await Promise.all([
    siteActivity(c.env, site.id, 8),
    // Responses follow the app's owner (the responses flag), like the runtime API.
    flagOnForOwner(c.env, "responses", site.ownerEmail),
    row ? appPreviewText(c.env, row) : Promise.resolve({ title: name, description: "" }),
  ]);
  // Update with AI: the person's own key rewrites the app (app_builder flag).
  const builderOn = !!c.get("features")?.has("app_builder");
  const keys = builderOn ? await builderKeys(c.env, user.email) : {};
  // The Connected apps tab is behind the connected_apps flag (admin panel → Features).
  const conns = c.get("features")?.has("connected_apps") ? await appConnections(c.env, site) : null;
  const provider = UPDATE_ORDER.find((b) => keys[b]);
  const access = accessOf(site);
  const isPublic = !!site.publicUrl;
  const lock = site.canShare ? "" : " disabled";
  const appHost = new URL(site.url).host;
  const ctx = ctxOf(c);
  const [starred, accounts, pending, ns] = await Promise.all([
    starredIds(ctx).then((s) => s.has(site.id)),
    peopleWithAccounts(ctx, site),
    pendingInvites(ctx, site.id),
    getNamespace(c.env, site.namespace),
  ]);
  const canCopy = user.active && !!ns && canPublishTo(user, ns);
  const pendingRoles = new Map(pending.map((p) => [p.email, p.role] as [string, Role]));
  const myRole = site.editors.includes(user.email) ? roleOf(site, user.email) : null;
  const state = {
    sheets: site.sheets,
    starred,
    accounts,
    pending: pending.map((p) => ({ email: p.email, role: p.role })),
    canCopy,
    id: site.id,
    url: site.url,
    publicUrl: site.publicUrl,
    title: site.title,
    fallbackName: site.mountPath || site.namespace,
    namespace: site.namespace,
    mountPath: site.mountPath,
    ownerEmail: site.ownerEmail,
    me: user.email,
    allowedEmails: site.allowedEmails,
    editors: site.editors,
    sharers: site.sharers,
    visibility: site.visibility,
    dataWrites: site.dataWrites,
    guestResponses: site.guestResponses,
    linkPreview: site.linkPreview,
    canShare: site.canShare,
    isOwner,
    responsesOn,
    next: mine ? "/" : "/?owner=others",
  };
  const tab = (key: string, label: string, selected = false) =>
    `<button type="button" role="tab" id="tab-${key}" aria-controls="panel-${key}" aria-selected="${selected}" tabindex="${selected ? 0 : -1}" data-tab="${key}">${label}</button>`;
  const setting = (key: string, title: string, hint: string, on: boolean, disabled = false, extra = "") =>
    `<div class="setting"${extra}><div class="setting-text"><strong id="lbl-${key}">${title}</strong><span>${hint}</span></div><label class="switch"><input type="checkbox" role="switch" data-setting="${key}" aria-labelledby="lbl-${key}"${on ? " checked" : ""}${disabled ? " disabled" : ""}><span aria-hidden="true"></span></label></div>`;
  const dropzone = (open: boolean) => `<div class="dropzone" data-dropzone${open ? "" : " hidden"}>
    <p><strong>Drop an .html or .zip file here</strong></p>
    <p class="muted">It replaces the app's files. Data, keys and sharing stay the same.</p>
    <label class="file-btn"><input type="file" class="sr" accept=".html,.htm,.zip" data-upload-file>Choose file</label>
  </div>`;
  const updatePanel = builderOn
    ? `<h2>What do you want to change?</h2>
  <p class="muted">Describe it in your own words. Your app's data and sharing stay just as they are.</p>
  <textarea data-update-prompt rows="4" maxlength="4000" placeholder="Add a dark mode, and a button to export everything as a spreadsheet" aria-label="What do you want to change?"></textarea>
  <div class="ideas" aria-label="Ideas">${UPDATE_IDEAS.map((i) => `<button type="button" class="idea" data-append-idea="${e(i)}">${e(i)}</button>`).join("")}</div>
  ${
    provider
      ? `<button type="button" class="update-btn" data-update="${provider}">Update with ${BUILDER_LABEL[provider]}</button>`
      : `<button type="button" class="update-btn" data-dialog="dlg-key-gemini" aria-haspopup="dialog">Add your free Gemini key to update with AI</button>`
  }
  <div class="progress" data-progress role="status" hidden><span class="spin-s" aria-hidden="true"></span><span data-progress-text></span></div>
  <p class="muted upload-alt">Have a file ready? <button type="button" class="linkish" data-show-upload aria-expanded="false">Upload a new version instead</button></p>
  ${dropzone(false)}
  ${provider ? "" : keyDialog("gemini", "gemini", keys)}`
    : `<h2>Upload a new version</h2>
  <p class="muted">A single <code>.html</code> file, or a <code>.zip</code> with <code>index.html</code> at the top.</p>
  ${dropzone(true)}`;
  const acts = activity
    .map((a) => `<li><span class="act-what">${e(activitySentence(a, user.email))}</span><span class="act-when">${e(ago(a.at))}</span></li>`)
    .join("");
  const body = `<div class="app-page" data-app-page data-state="${e(JSON.stringify(state))}">
<nav class="crumb" aria-label="Breadcrumb"><a href="${mine ? "/" : "/?owner=others"}">My apps</a> <span aria-hidden="true">/</span> <span data-name-text>${e(name)}</span></nav>
<section class="hero">
  ${thumb(site, "lg")}
  <div class="titlewrap">
    <div class="titlerow">
      <input class="title-input" data-title value="${e(site.title ?? "")}" placeholder="${e(state.fallbackName)}" maxlength="200" aria-label="App name">
      <button type="button" class="star-btn${starred ? " on" : ""}" data-star="${e(site.id)}" aria-pressed="${starred}" aria-label="Star this app" title="${starred ? "Unstar" : "Star"}">${ICON.star(24)}</button>
    </div>
    <div class="iconrow">
      <span class="sharepill ${access.kind}" data-pill>
        <button type="button" class="sp-access" data-goto-tab="sharing" aria-label="${e(access.label)}. Change who can open it" title="Change who can open it">${access.icon}<span>${e(access.label)}</span></button>
        <button type="button" class="sp-copy" data-copy-link aria-label="Copy link" title="Copy link">${ICON.link()}</button>
      </span>
      <span class="muted" data-updated>Updated ${e(ago(site.updatedAt))}</span>
    </div>
  </div>
  <div class="hero-actions">
    <a class="cta" href="${e(site.url)}" target="_blank" rel="noopener">Open app ${ICON.ext()}</a>
    <div class="menuwrap">
      <button type="button" class="icon-btn" data-menu-btn aria-haspopup="menu" aria-expanded="false" aria-controls="app-menu" aria-label="More">${ICON.more()}</button>
      <div class="menu" id="app-menu" role="menu" hidden>
        <button type="button" role="menuitem" data-dialog="dlg-install">Add to your phone or computer</button>
        ${canCopy ? `<button type="button" role="menuitem" data-copy-app>Make a copy</button>` : ""}
        ${isOwner ? `<hr><button type="button" role="menuitem" class="red" data-dialog="dlg-delete">Delete app</button>` : ""}
      </div>
    </div>
  </div>
</section>

<div class="tabbar" role="tablist" aria-label="App settings">
  ${tab("sharing", "Sharing", true)}${conns ? tab("connected", `Connected apps <span class="tab-badge" data-conn-count>${conns.count}</span>`) : ""}${tab("update", "Update")}${tab("activity", "Activity")}
</div>

<section class="panel" id="panel-sharing" role="tabpanel" aria-labelledby="tab-sharing">
  <div class="block">
    <div class="block-head">
      <h2>Who can open it</h2>
      <div class="seg" role="group" aria-label="Who can open it">
        <button type="button" aria-pressed="${!isPublic}" data-access-choice="invite"${lock}>${ICON.lock()}Invited only</button>
        <button type="button" aria-pressed="${isPublic}" data-access-choice="public"${lock}>${ICON.globe()}Public</button>
      </div>
    </div>
    ${site.canShare ? "" : `<p class="note">Only ${e(site.ownerEmail)} and the app's Admins can change who can open it.</p>`}
    <p class="muted" data-invite-hint${isPublic ? " hidden" : ""}>Only you and the people you invite below. They sign in to open it.</p>
    <p class="note" data-members-note${!isPublic && site.visibility === "all" ? "" : " hidden"}>Anyone signed in to Formelab can open it too.${site.canShare ? ` <button type="button" class="linkish" data-limit>Limit it to people you invite</button>` : ""}</p>
    <div class="pub-warn" data-public-warn${isPublic ? "" : " hidden"}>${ICON.alert()}<span><strong>Anyone with the link can open this app, no sign-in needed.</strong> They can see everything in it, including its data. Only share the link with people you trust. If it gets passed around, reset it below.</span></div>
    <div class="linkbox" data-linkbox${isPublic ? "" : " hidden"}>
      <code data-public-url>${e(site.publicUrl ?? "")}</code>
      <button type="button" class="small" data-copy-public>Copy link</button>
      <button type="button" class="small secondary" data-dialog="dlg-reset"${lock}>Reset link</button>
    </div>
    <div class="subblock">
      <h3 class="subhead">What they can do</h3>
      ${setting("dataWrites", "Viewers can add and change the app's data", "For polls, sign-up sheets and shared lists. When off, only you, Editors and Admins can.", site.dataWrites === "everyone")}
      ${responsesOn ? setting("guestResponses", "Anyone with the link can send answers", "No sign-in needed. For forms, sign-ups and RSVPs. Only you and your team see what people send.", site.guestResponses, !site.canShare, ` data-guest-row${isPublic ? "" : " hidden"}`) : ""}
    </div>
    <div class="subblock">
      <h3 class="subhead">Link preview in chats</h3>
      <div class="lp-wrap">
        <div class="lp" data-preview="full"${site.linkPreview === "full" ? "" : " hidden"}>
          <div class="lp-img ${hueClass(site.id)}">${thumb(site, "lg")}<span class="lp-appname" data-name-text>${e(name)}</span></div>
          <div class="lp-body"><strong data-name-text>${e(name)}</strong><span>${e(preview.description || "Made on Formelab.")}</span><span>${e(appHost)}</span></div>
        </div>
        <div class="lp" data-preview="private"${site.linkPreview === "private" ? "" : " hidden"}>
          <div class="lp-img brand"><span class="lp-logo"><span class="mark"></span>Formelab</span><span class="lp-tag">${ICON.lock(14)} A private app. Sign in to open it.</span></div>
          <div class="lp-body"><strong>A private app on Formelab</strong><span>Sign in to Formelab to open it.</span><span>${e(appHost)}</span></div>
        </div>
        <p class="muted lp-note" data-preview-note>${e(previewNote(site))}</p>
      </div>
    </div>
  </div>
  <div class="block">
    <h2>People</h2>
    <p class="muted">Invite by email and choose what each person can do. They'll find it under My apps.</p>
    ${
      site.canShare
        ? `<form class="invite" data-invite>
      <input type="text" name="emails" inputmode="email" autocomplete="off" placeholder="name@example.com, another@example.com" aria-label="Email addresses to invite">
      <button type="button" class="rp-btn invite-role" data-invite-role data-role="viewer" data-roles="${isOwner ? "viewer,editor,admin" : "viewer"}" aria-haspopup="listbox" aria-expanded="false" aria-label="Role"><span>Viewer</span>${ICON.chevron()}</button>
      <button>Invite</button>
    </form>`
        : ""
    }
    <div class="acct-note" data-acct-note role="status" hidden></div>
    ${
      isOwner
        ? ""
        : `<p class="owner-note" data-owner-note>${ICON.people(16)}<span><strong>${e(site.ownerEmail)}</strong> owns this app.${myRole ? ` You're ${aRole(myRole)}.` : ""}</span></p>`
    }
    <ul class="people" data-people>${peopleRows(site, user.email, isOwner, site.canShare, new Set(accounts), pendingRoles)}</ul>
  </div>
</section>

${
  conns
    ? `<section class="panel" id="panel-connected" role="tabpanel" aria-labelledby="tab-connected" hidden>
  ${connectionsPanel(site, conns, { isSiteOwner: site.ownerEmail === user.email, canManage: true })}
</section>

<dialog id="dlg-key-remove" class="howto-dialog confirm" aria-labelledby="dlg-key-remove-title">
  <div class="howto">
    <h2 id="dlg-key-remove-title">Remove the key <span data-key-remove-name></span>?</h2>
    <p>The app can't use it any more, so anything that needs it stops working until a key is saved again. The key itself is deleted for good.</p>
    <div class="dialog-actions"><button type="button" class="secondary" data-close>Keep it</button><button type="button" class="danger-solid" data-key-remove-go>Remove key</button></div>
  </div>
</dialog>

`
    : ""
}<section class="panel" id="panel-update" role="tabpanel" aria-labelledby="tab-update" hidden>
  ${updatePanel}
</section>

<section class="panel" id="panel-activity" role="tabpanel" aria-labelledby="tab-activity" hidden>
  <h2>Recent activity</h2>
  ${acts ? `<ol class="acts">${acts}</ol>` : `<p class="muted">Nothing yet.</p>`}
  <p><a href="/apps/${e(encodeURIComponent(site.id))}/activity">See all activity</a></p>
</section>
</div>

<dialog id="dlg-reset" class="howto-dialog confirm" aria-labelledby="dlg-reset-title">
  <div class="howto">
    <h2 id="dlg-reset-title">Reset the link?</h2>
    <p>You'll get a new link. The current one stops working right away, including for people who already opened it.</p>
    <div class="dialog-actions"><button type="button" class="secondary" data-close>Cancel</button><button type="button" data-reset-go>Reset link</button></div>
  </div>
</dialog>

<dialog id="dlg-transfer" class="howto-dialog confirm" aria-labelledby="dlg-transfer-title">
  <div class="howto">
    <h2 id="dlg-transfer-title">Make <span data-transfer-to></span> the owner?</h2>
    <p>They'll control <span data-name-text>${e(name)}</span>, including deleting it and transferring it again. You'll stay on as an Admin.</p>
    <label class="check-row"><input type="checkbox" data-transfer-ok> <span>I understand only the new owner can transfer it back.</span></label>
    <div class="dialog-actions"><button type="button" class="secondary" data-close>Cancel</button><button type="button" data-transfer-go disabled>Make owner</button></div>
  </div>
</dialog>

<dialog id="dlg-signup" class="howto-dialog confirm" aria-labelledby="dlg-signup-title">
  <div class="howto">
    <h2 id="dlg-signup-title"><span data-signup-email></span> needs a Formelab account</h2>
    <p><span data-signup-role></span>s sign in to make changes, so they need an account. We'll email them a link to join. They stay a Viewer until they sign up, then become <span data-signup-a-role></span> automatically.</p>
    <div class="dialog-actions"><button type="button" class="secondary" data-close>Cancel</button><button type="button" data-signup-go>Send sign-up invite</button></div>
  </div>
</dialog>

<dialog id="dlg-install" class="howto-dialog" aria-labelledby="dlg-install-title">
  <form method="dialog" class="dialog-close"><button aria-label="Close">×</button></form>
  <div class="howto">
    <h2 id="dlg-install-title">Add it to your phone or computer</h2>
    <p>Open the app, then add it to your home screen or install it from your browser. It gets its own icon and opens straight to the app. Everyone it's shared with can do the same.</p>
    ${installSteps(name)}
    <div class="dialog-actions"><a class="cta" href="${e(site.url)}" target="_blank" rel="noopener">Open app ${ICON.ext()}</a></div>
  </div>
</dialog>
${
  isOwner
    ? `
<dialog id="dlg-delete" class="howto-dialog confirm" aria-labelledby="dlg-delete-title">
  <div class="howto">
    <h2 id="dlg-delete-title">Delete <span data-name-text>${e(name)}</span>?</h2>
    <p>This removes its files, data and keys for good, and its address stops working. This can't be undone.</p>
    <label class="confirm-label"><span>Type <strong data-name-text>${e(name)}</strong> to confirm</span><input data-delete-input autocomplete="off" spellcheck="false"></label>
    <div class="dialog-actions"><button type="button" class="secondary" data-close>Keep it</button><button type="button" class="danger-solid" data-delete-go disabled>Delete forever</button></div>
  </div>
</dialog>`
    : ""
}`;
  return shell(c, user, "apps", body, name, { pageHead: false });
}

/**
 * My apps: the apps you own and the apps other people shared with you, as cards, starred ones first.
 * People on the waitlist can't make apps yet, so they see only what's shared with them.
 */
export async function dashboardPage(c: Context<AppEnv>): Promise<Response> {
  const ctx = ctxOf(c);
  const canMake = ctx.user.active;
  const [own, shared, stars] = await Promise.all([canMake ? listOwnSites(ctx) : Promise.resolve([]), listSharedSites(ctx), starredIds(ctx)]);
  const apps = [...own.map((s) => ({ ...s, mine: true })), ...shared.map((s) => ({ ...s, mine: false }))];
  const browser = apps.length
    ? appBrowser(apps.map((s) => ({ ...s, starred: stars.has(s.id) })), { me: ctx.user.email, canMake })
    : canMake
      ? `<section class="empty">
  <h2>What do you want to make?</h2>
  <p>A budget tracker, a sign-up sheet for your team, a tiny game. Describe it to your AI and it lands here, live.</p>
  <p><a class="cta" href="/new">+ New app</a></p>
</section>`
      : `<section>
  <p class="muted">Nothing yet. When someone adds your email to one of their apps, it shows up here.</p>
</section>`;
  return shell(c, ctx.user, "apps", `${canMake ? "" : waitlistedNotice}\n${browser}`);
}

/** How to install a web app, per device. install.js opens the one for the device in use. */
function installSteps(name: string): string {
  const n = e(name);
  const steps = (platform: string, title: string, items: string[]) =>
    `<details class="steps" data-steps="${platform}"><summary>${title}</summary><ol>${items.map((i) => `<li>${i}</li>`).join("")}</ol></details>`;
  return `<div class="install-steps">
    ${steps("ios", "iPhone and iPad", [
      "Open it in <strong>Safari</strong>.",
      "Tap the <strong>Share</strong> button (on newer iPhones it's in the <strong>•••</strong> menu).",
      "Tap <strong>Add to Home Screen</strong>, then <strong>Add</strong>.",
    ])}
    ${steps("android", "Android", [
      "Open it in <strong>Chrome</strong>.",
      "Tap <strong>⋮</strong> at the top right.",
      `Tap <strong>Install app</strong> (or <strong>Add to Home screen</strong>), then <strong>Install</strong>.`,
    ])}
    ${steps("desktop", "Windows, Mac, Linux or Chromebook, in Chrome or Edge", [
      "Open it in <strong>Chrome</strong> or <strong>Edge</strong>.",
      `Click the install icon at the right end of the address bar. Or, in Chrome, open <strong>⋮</strong> → <strong>Cast, save and share</strong> → <strong>Install ${n}</strong>; in Edge, <strong>…</strong> → <strong>Apps</strong> → <strong>Install this site as an app</strong>.`,
      "It opens in its own window, and you'll find it with your other apps, in the Dock or on the taskbar.",
    ])}
    ${steps("mac", "Mac, in Safari", [
      "Open it in <strong>Safari</strong>.",
      "Choose <strong>File</strong> → <strong>Add to Dock</strong>, then click <strong>Add</strong>.",
    ])}
    <p class="muted small">Firefox on a computer can't install apps yet. Use Chrome, Edge or Safari.</p>
  </div>`;
}

/** Get the app: install Formelab itself, and how to install the apps people make. */
export async function installPage(c: Context<AppEnv>): Promise<Response> {
  const ctx = ctxOf(c);
  const [own, shared] = await Promise.all([ctx.user.active ? listOwnSites(ctx) : Promise.resolve([]), listSharedSites(ctx)]);
  const apps = [...own, ...shared];
  const rows = apps
    .map(
      (s) => `<li>${thumb(s, "sm")}<span class="name">${e(appName(s))}</span><a class="ghost small" href="${e(s.url)}" target="_blank" rel="noopener">Open to install ↗</a></li>`,
    )
    .join("");
  const body = `<section class="install-hero">
  <img class="install-icon" src="/_assets/icon-192.png" alt="" width="96" height="96">
  <div>
    <h2>Formelab</h2>
    <p class="muted not-installed">Your lab, one tap away: new apps, shared apps and your AI connections.</p>
    <p class="installed-note">You're using the Formelab app. You're all set.</p>
    <p><button type="button" class="cta" data-install hidden>Install Formelab</button></p>
  </div>
</section>

<section class="not-installed">
  <h2>Install it on this device</h2>
  ${installSteps("Formelab")}
</section>

<section>
  <h2>Your apps, as apps</h2>
  <p class="muted">Every app on Formelab installs the same way: open it, then follow the steps above. It gets its own icon on your home screen or dock, and opens straight to the app in its own window, always on its latest version.</p>
  ${rows ? `<ul class="install-apps">${rows}</ul>` : `<p class="muted">No apps yet. Apps you make, and apps shared with you, show up here.</p>`}
</section>`;
  return shell(c, ctx.user, "install", body);
}

const IDEAS = [
  "A budget tracker where I add expenses by category and see a monthly total",
  "A sign-up sheet for our team lunch, with a spot for dietary needs",
  "A habit tracker with a streak for each habit",
];

const KEY_HELP: Record<Builder, { org: string; site: string; placeholder: string; intro: string; steps: string }> = {
  claude: {
    org: "Anthropic",
    site: "console.anthropic.com",
    placeholder: "sk-ant-…",
    intro: "What it uses is billed to your own Anthropic account.",
    steps: "<li>Make sure the account has credits. This is separate from a Claude Pro or Max plan.</li>",
  },
  openai: {
    org: "OpenAI",
    site: "platform.openai.com",
    placeholder: "sk-…",
    intro: "What it uses is billed to your own OpenAI account.",
    steps: "<li>Make sure the account has credits or billing set up. This is separate from a ChatGPT Plus or Pro plan.</li>",
  },
  gemini: {
    org: "Google",
    site: "Google AI Studio",
    placeholder: "AIza… or AQ.…",
    intro: "Google's free tier is enough to build apps: no credit card needed. It allows a few builds a minute and a daily limit, and Google may use free-tier requests to improve its products.",
    steps: "<li>Click <strong>Create API key</strong>. You don't need to set up billing.</li>",
  },
  grok: {
    org: "xAI",
    site: "console.x.ai",
    placeholder: "xai-…",
    intro: "What it uses is billed to your own xAI account.",
    steps: "<li>Make sure the account has credits. This is separate from a SuperGrok or X Premium plan.</li><li>Open <strong>API Keys</strong>.</li>",
  },
};

/** Gemini only builds here (its app can't be opened with an idea typed in). */
const buildsHereOnly = (b: Builder) => b === "gemini";

/** The dialog for saving (or removing) the person's own API key for a builder. */
function keyDialog(b: Builder, app: AiApp, keys: Partial<Record<Builder, { hint: string }>>): string {
  const who = BUILDERS[b];
  const help = KEY_HELP[b];
  const name = BUILDER_LABEL[b];
  return `<dialog id="dlg-key-${b}" class="howto-dialog" aria-labelledby="dlg-key-${b}-title">
  <form method="dialog" class="dialog-close"><button aria-label="Close">×</button></form>
  <div class="howto">
    <div class="dialog-head"><span class="ai-logo">${AI_LOGOS[app]}</span><h2 id="dlg-key-${b}-title">Build with ${name} right here</h2></div>
    <p>Paste an API key once. After that, <strong>Make it</strong> builds your app here and publishes it${buildsHereOnly(b) ? "" : `, with nothing to set up in the ${name} app`}. ${help.intro}</p>
    <ol>
      <li>Open <a href="${who.keyUrl}" target="_blank" rel="noopener">${help.site}</a> and sign in${b === "gemini" ? " with Google" : ""}.</li>
      ${help.steps}
      <li>${b === "gemini" ? "Copy the key" : "Create a key, copy it,"} and paste it below.</li>
    </ol>
    <form class="inline" data-action="builder-connect" data-provider="${b}">
      <input name="apiKey" type="password" autocomplete="off" required placeholder="${help.placeholder}" aria-label="${help.org} API key">
      <button>Save key</button>
    </form>
    <p class="muted">The key is encrypted and Formelab never shows it again.${
      b === "gemini"
        ? " It's the same key as Google Gemini under Connected apps: save or remove it in either place and it changes in both. Your apps can use it for AI features there."
        : " It's only used when you press Make it or Update."
    }</p>
    ${keys[b] ? `<p><button type="button" class="danger" data-action="builder-disconnect" data-provider="${b}">Remove my key …${e(keys[b]!.hint)}</button></p>` : ""}
    ${keys[b] || buildsHereOnly(b) ? "" : `<p class="muted">Rather use the ${name} app? <button type="button" class="linkish" data-make="${app}">Open it with your idea typed in</button> (needs <a href="/connect#${app}">Formelab connected</a> there).</p>`}
  </div>
</dialog>`;
}

/** New app: describe it and hand it to your AI (the easy path), or upload files you already have. */
export async function newAppPage(c: Context<AppEnv>): Promise<Response> {
  const ctx = ctxOf(c);
  if (!ctx.user.active) return dashboardPage(c);
  // Building here with an API key is behind the app_builder flag (admin panel → Features).
  const builderOn = !!c.get("features")?.has("app_builder");
  const [namespaces, connected, keys] = await Promise.all([
    listNamespaces(ctx),
    connectedAiApps(c.env, ctx.user),
    builderOn ? builderKeys(c.env, ctx.user.email) : Promise.resolve({} as Awaited<ReturnType<typeof builderKeys>>),
  ]);
  const own = namespaces.filter((n) => n.isOwner || n.editors.includes(ctx.user.email));
  const nsOptions = own.map((n) => `<option value="${e(n.label)}">`).join("");
  const domain = c.env.APP_DOMAIN;
  const state = (app: AiApp, setup: string) =>
    connected.has(app)
      ? `<span class="badge on"><span class="dot" aria-hidden="true"></span>Connected</span>`
      : `<a class="muted" href="/connect#${app}">${setup}</a>`;
  // Claude, ChatGPT and Grok: with the person's API key saved, "Make it" builds and publishes right here.
  // Without one, the button asks for a key, unless their Claude, ChatGPT or Grok app is already
  // connected to Formelab; then it opens that app with the idea typed in, as before.
  const MAKERS: { b: Builder; app: AiApp; label: string }[] = [
    { b: "claude", app: "claude", label: "Make it with Claude" },
    { b: "openai", app: "chatgpt", label: "Make it with ChatGPT" },
    { b: "gemini", app: "gemini", label: "Make it with Gemini" },
    { b: "grok", app: "grok", label: "Make it with Grok" },
  ];
  const aiName: Record<string, string> = { claude: "Claude", chatgpt: "ChatGPT", grok: "Grok" };
  // Gemini only builds here, so it shows only with the flag.
  const makers = MAKERS.filter(({ b }) => builderOn || !buildsHereOnly(b)).map(({ b, app, label }) => {
    const key = keys[b];
    // Opening the Claude or ChatGPT app with the idea typed in, for people who connected it.
    const canOpen = !buildsHereOnly(b) && connected.has(app);
    if (!builderOn) {
      return `<div class="make"><button type="button" class="make-btn" data-make="${app}"><span class="ai-mini">${AI_LOGOS[app]}</span>${label}</button>${state(app, `Connect ${aiName[app]} first`)}</div>`;
    }
    const btn = key
      ? `<button type="button" class="make-btn" data-build="${b}"><span class="ai-mini">${AI_LOGOS[app]}</span>${label}</button>`
      : canOpen
        ? `<button type="button" class="make-btn" data-make="${app}"><span class="ai-mini">${AI_LOGOS[app]}</span>${label}</button>`
        : `<button type="button" class="make-btn" data-dialog="dlg-key-${b}" aria-haspopup="dialog"><span class="ai-mini">${AI_LOGOS[app]}</span>${label}</button>`;
    const note = key
      ? `<span class="badge on"><span class="dot" aria-hidden="true"></span>Your API key …${e(key.hint)}</span><button type="button" class="linkish muted" data-dialog="dlg-key-${b}" aria-haspopup="dialog">Change key</button>`
      : canOpen
        ? `${state(app, "")}<button type="button" class="linkish muted" data-dialog="dlg-key-${b}" aria-haspopup="dialog">Or build it here with an API key</button>`
        : `<button type="button" class="linkish muted" data-dialog="dlg-key-${b}" aria-haspopup="dialog">${b === "gemini" ? "Add your free API key" : "Add your API key"}</button>`;
    return `<div class="make">${btn}${note}</div>`;
  }).join("\n    ");
  const keyDialogs = (builderOn ? MAKERS : []).map(({ b, app }) => keyDialog(b, app, keys)).join("\n");
  const body = `<section class="maker">
  <p class="eyebrow">The easy way</p>
  <h2>What do you want to make?</h2>
  <p>${builderOn ? "Describe it in your own words, then press Make it. With your API key saved, the app is built and published right here." : "Describe it in your own words. We'll open your AI with it typed in; press send and it builds the app and publishes it here."}</p>
  <textarea id="idea" rows="4" maxlength="4000" placeholder="${e(IDEAS[0]!)}" aria-label="Describe your app"></textarea>
  <div class="ideas" aria-label="Ideas to start from">${IDEAS.map((i) => `<button type="button" class="idea" data-idea="${e(i)}">${e(i)}</button>`).join("")}</div>
  ${
    builderOn
      ? `<label class="build-opt">Who can change its data <select id="build-data-writes">
    <option value="auto" selected>Decide for me</option>
    <option value="editors">Only me and editors</option>
    <option value="everyone">Everyone who can open it</option>
  </select></label>
  <p class="muted build-opt-hint">Decide for me: if the app saves things people share, like votes or sign-ups, everyone who can open it can change them; otherwise only you and editors can. You can change this later in the app's settings.</p>`
      : ""
  }
  <div class="make-row">
    ${makers}
    <div class="make">
      <button type="button" class="make-btn secondary" data-make="copy"><span class="ai-mini">${AI_LOGOS["claude-code"]}</span>Copy for Claude Code</button>
      ${state("claude-code", "Set up Claude Code")}
    </div>
  </div>
  <p class="muted">${builderOn ? "Building takes a minute or two." : "Claude: make sure Formelab is on under the <strong>+</strong> menu → Connectors. ChatGPT: pick <strong>Developer mode</strong> in the <strong>+</strong> menu and turn on Formelab."} New apps are private to you until you share them.</p>
</section>
${keyDialogs}

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
  <p class="muted">Your app gets its own address, like <code>https://&lt;name&gt;-7kq2.${e(domain)}/</code>.${own.length ? "" : " New here? Type a name for your space (it groups your apps) and we'll create it."}</p>
</section>`;
  return shell(c, ctx.user, "new", body);
}

/** Spaces (namespaces): the first part of an app's address, and who can publish into it. */
export async function spacesPage(c: Context<AppEnv>): Promise<Response> {
  const ctx = ctxOf(c);
  if (!ctx.user.active) return dashboardPage(c);
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
    <label>Password <input type="password" name="password" autocomplete="new-password" minlength="${MIN_PASSWORD_LENGTH}" maxlength="${MAX_PASSWORD_LENGTH}" required></label>
    <label>Confirm password <input type="password" name="confirm" autocomplete="new-password" minlength="${MIN_PASSWORD_LENGTH}" maxlength="${MAX_PASSWORD_LENGTH}" required></label>
    <button>Save password</button>
  </form>
  <p class="muted">Use at least ${MIN_PASSWORD_LENGTH} characters that are hard to guess: a few unrelated words works well. Next time, choose <strong>Continue with email</strong> and enter ${e(user.email)}; you can use this password or a one-time code. If you forget it, use <strong>Forgot password</strong> on the login screen.</p>
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
  return `${aiOrigin(c.env, c.req.url)}/login?return=${encodeURIComponent(back)}`;
}
