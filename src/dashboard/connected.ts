// Connected apps: the services a person's apps can use through Formelab, each with its own page
// (/connected/<name>): the apps built to use it, its settings and what happened to it. Built-in
// ones (Google Gemini, Google Sheets) and the person's own custom connectors. Behind the
// connected_apps flag.
import type { Context } from "hono";
import { ctxOf } from "../api";
import { appsUsing, connectorActivity, getConnector, listConnectors, planKeyMove, useCounts, type AppUse, type ConnectorView } from "../connectors";
import type { AppEnv } from "../env";
import { GEMINI_DAILY_DEFAULT, GEMINI_DAILY_MAX, GEMINI_MODEL_NAME, GEMINI_VIEWER_PER_DAY, geminiStatus } from "../gemini";
import { notFoundPage, plainPage } from "../serve";
import { siteName } from "../sites";
import { sheetsConfigured, sheetsStatus } from "../sheets";
import { ago, escapeHtml as e, parseJsonArray } from "../util";
import { AI_LOGOS } from "./logos";
import { connectorLogo, fmtTime, SHEETS_LOGO, shell } from "./page";
import { SERVICE_ICONS, SPRITE_URL } from "./services";

const on = (c: Context<AppEnv>) => !!c.get("features")?.has("connected_apps");

/** The coming-soon wall: each logo drawn once in a cached sprite and reused. */
function soonWall(compact: boolean): string {
  const tiles = Array.from({ length: Math.max(150, SERVICE_ICONS.length) }, (_, n) => {
    const i = n % SERVICE_ICONS.length;
    return `<svg class="svc" viewBox="0 0 48 48"><use href="${SPRITE_URL}#svc-${i}"/></svg>`;
  }).join("");
  return `<section class="soon-wall${compact ? " compact" : ""}">
  <div class="wall" aria-hidden="true">${tiles}</div>
  <div class="soon-card">
    <p class="eyebrow">${compact ? "More coming soon" : "Coming soon"}</p>
    <h2>Plug your apps into the tools you already use</h2>
    <p>${
      compact
        ? "Next up: Stripe, Gmail, Notion and more, built in. Until then, any service with an API key works as a custom connector."
        : "Soon you'll connect services like Google Sheets, Stripe, Gmail and Notion here, once, and any of your apps can use them. No keys to copy, no code to write."
    }</p>
    <p class="muted">Looking for Claude, ChatGPT or Gemini chat? They're under <a href="/connect">Connect your AI</a>.</p>
  </div>
</section>`;
}

const usedBy = (n: number) => (n ? `<strong>${n} app${n === 1 ? "" : "s"}</strong> use${n === 1 ? "s" : ""} it` : "Not used yet");

function tile(o: { href: string; logo: string; name: string; about: string; chip: string; foot?: string; side?: string }): string {
  return `<a class="cx-tile" href="${e(o.href)}">
  <span class="cx-top"><span class="conn-ic">${o.logo}</span>${o.chip}</span>
  <span class="cx-name">${e(o.name)}</span>
  <span class="cx-about">${e(o.about)}</span>
  ${o.foot !== undefined ? `<span class="cx-foot"><span>${o.foot}</span>${o.side ? `<span>${e(o.side)}</span>` : ""}</span>` : ""}
</a>`;
}

const CONNECTED = `<span class="chip ok">Connected</span>`;
const CUSTOM = `<span class="chip custom">Custom</span>`;

const GEMINI_ABOUT = "AI that writes, sorts and summarizes inside your apps.";
const SHEETS_ABOUT = "Read and add rows to the spreadsheets you pick.";

/** Connected apps: what's connected, what else there is, and + Custom connector. */
export async function connectedPage(c: Context<AppEnv>): Promise<Response> {
  const user = c.get("user");
  if (!on(c)) return shell(c, user, "connected", soonWall(false));
  const ctx = ctxOf(c);
  const [gemini, sheets, custom, counts, move, sheetsUse] = await Promise.all([
    geminiStatus(c.env, user.email),
    sheetsStatus(c.env, user.email),
    listConnectors(c.env, user.email),
    useCounts(c.env, user.email),
    planKeyMove(ctx),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM sites WHERE owner_email = ? AND json_array_length(sheets) > 0").bind(user.email).first<{ n: number }>(),
  ]);
  const geminiTile = (chip: string, foot?: string) =>
    tile({ href: "/connected/gemini", logo: AI_LOGOS.gemini ?? "", name: "Google Gemini", about: GEMINI_ABOUT, chip, foot, side: gemini.lastUsedAt ? `Used ${ago(gemini.lastUsedAt)}` : undefined });
  const sheetsTile = (chip: string, foot?: string) =>
    tile({ href: "/connected/google-sheets", logo: SHEETS_LOGO(), name: "Google Sheets", about: SHEETS_ABOUT, chip, foot, side: sheets.connected ? sheets.account : undefined });
  const connected: string[] = [];
  const more: string[] = [];
  const connect = `<span class="chip link">Connect</span>`;
  if (gemini.connected) connected.push(geminiTile(CONNECTED, usedBy(counts.get("gemini") ?? 0)));
  else more.push(geminiTile(connect));
  if (sheets.connected) connected.push(sheetsTile(CONNECTED, usedBy(sheetsUse?.n ?? 0)));
  else more.push(sheetsTile(sheetsConfigured(c.env) ? connect : `<span class="chip">Not set up yet</span>`));
  for (const k of custom) {
    connected.push(
      tile({ href: `/connected/${encodeURIComponent(k.name)}`, logo: connectorLogo(k.label), name: k.label, about: k.description || `Sent only to ${k.hosts.join(", ")}.`, chip: CUSTOM, foot: usedBy(counts.get(k.name) ?? 0), side: k.hosts[0] }),
    );
  }
  const moveable = move.moves.reduce((n, m) => n + m.apps.length, 0);
  const moveBox = move.moves.length
    ? `<section class="cx-move" aria-labelledby="cx-move-title">
  <div class="cx-move-txt">
    <h2 id="cx-move-title">Turn your saved keys into connectors</h2>
    <p>${moveable} key${moveable === 1 ? "" : "s"} saved in your apps can become ${move.moves.length === 1 ? "a connector" : `${move.moves.length} connectors`}: ${move.moves
      .map((m) => `<strong>${e(m.name)}</strong> (${e(m.apps.map((a) => a.name).join(", "))})`)
      .join(", ")}. Apps with the same key share one connector, and they keep working as they are.</p>
    ${move.kept.length ? `<p class="muted">${move.kept.length} stay${move.kept.length === 1 ? "s" : ""} in ${move.kept.length === 1 ? "its app" : "their apps"}: ${e(move.kept.map((k) => `${k.name} in ${k.app}`).join(", "))}.</p>` : ""}
  </div>
  <button type="button" class="secondary" data-action="keys-move">Turn them into connectors</button>
</section>`
    : "";
  const body = `<div class="page-head cx-head">
  <div><h1>Connected apps</h1><p>Connect a service once, then ask your AI to use it in an app. Open one to see the apps that use it.</p></div>
  <a class="cta" href="/connected/new">+ Custom connector</a>
</div>
${moveBox}
<section class="cx-group" aria-labelledby="cx-connected">
  <div class="cx-group-head"><h2 id="cx-connected">Connected</h2><p class="muted">Only you, and the apps built to use them, can use these.</p></div>
  ${connected.length ? `<div class="cx-grid">${connected.join("\n")}</div>` : `<div class="conn-empty"><strong>Nothing connected yet.</strong><br>Connect one below, or make a custom connector for any service with an API key.</div>`}
</section>
${
  more.length
    ? `<section class="cx-group" aria-labelledby="cx-more">
  <div class="cx-group-head"><h2 id="cx-more">More to connect</h2><p class="muted">Built into Formelab. Don't see yours? Make a <a href="/connected/new">custom connector</a>.</p></div>
  <div class="cx-grid">${more.join("\n")}</div>
</section>`
    : ""
}
${soonWall(true)}`;
  return shell(c, user, "connected", body, "Connected apps", { pageHead: false });
}

/** The top of a connector's page: back to Connected apps, its logo, name and state. */
function pageTop(logo: string, name: string, line: string, action = ""): string {
  return `<nav class="crumb" aria-label="Breadcrumb"><a href="/connected">Connected apps</a><span aria-hidden="true">/</span><span>${e(name)}</span></nav>
<div class="cx-page-head">
  <span class="conn-ic big">${logo}</span>
  <div class="cx-page-title"><h1>${e(name)}</h1><p>${line}</p></div>
  ${action}
</div>`;
}

/** Apps that use a connector, each with its calls in the last 30 days. */
function appsPanel(apps: AppUse[], what: string, empty: string): string {
  const rows = apps
    .map(
      (a) => `<li><span class="cx-app">${e((a.name[0] ?? "?").toUpperCase())}</span><span class="cx-app-txt"><a href="/apps/${e(encodeURIComponent(a.id))}">${e(a.name)}</a><span>${
        a.lastUsedAt ? `Last used ${e(ago(a.lastUsedAt))}` : "Not used in the last 30 days"
      }</span></span><span class="cx-num">${a.calls} ${what}${a.calls === 1 ? "" : "s"}</span></li>`,
    )
    .join("");
  return `<div class="cx-panel-head"><h2>Apps that use it</h2>${apps.length ? `<span class="muted">Last 30 days</span>` : ""}</div>
  ${apps.length ? `<ul class="cx-apps">${rows}</ul>` : `<div class="conn-empty">${empty}</div>`}`;
}

function activityList(items: { at: number; text: string }[]): string {
  if (!items.length) return "";
  return `<h2>Recent activity</h2>
  <ul class="cx-log">${items.map((i) => `<li><span>${e(i.text)}</span><time>${e(ago(i.at))}</time></li>`).join("")}</ul>`;
}

const ACTIVITY: Record<string, (d: Record<string, unknown>) => string> = {
  connector_create: () => "You made this connector",
  connector_update: (d) => `You changed its ${(Array.isArray(d.fields) ? d.fields.map(String) : []).map((f) => (f === "auth" ? "way of sending the key" : f === "hosts" ? "hosts" : f === "label" ? "name" : f)).join(", ") || "settings"}`,
  connector_key: () => "You replaced the key",
  connector_move: (d) => `You turned the saved keys${d.apps ? ` of ${d.apps} app${d.apps === 1 ? "" : "s"}` : ""} into this connector`,
};

/** /connected/<name>: one connector's page. */
export async function connectorPage(c: Context<AppEnv>): Promise<Response> {
  const user = c.get("user");
  if (!on(c)) return notFoundPage();
  const name = c.req.param("name") ?? "";
  if (name === "gemini") return geminiPage(c);
  if (name === "google-sheets") return sheetsPage(c);
  if (name === "new") return newConnectorPage(c);
  const k = await getConnector(c.env, user.email, name);
  if (!k) return plainPage(404, "Not found", "You don't have a connector by that name. It may have been deleted.");
  const [apps, log] = await Promise.all([appsUsing(c.env, user.email, k.name), connectorActivity(c.env, user.email, k.name)]);
  const path = k.hosts.find((h) => !h.startsWith("*.")) ? "/v1/..." : `https://${k.hosts[0]!.slice(2)}/...`;
  const sample =
    k.auth === "placeholder"
      ? `await formelab.secrets.proxy("${k.name}", {\n  url: "https://${k.hosts[0]!.replace(/^\*\./, "")}/...",\n  headers: { Authorization: "Bearer {{value}}" },\n});`
      : `const res = await formelab.connectors.fetch("${k.name}", "${path}", {\n  method: "POST",\n  body: { ... },\n});\nconst data = res.json();`;
  const body = `${pageTop(connectorLogo(k.label), k.label, `${CUSTOM} ${e(k.description || `Sent only to ${k.hosts.join(", ")}.`)}`)}
<div class="cx-cols">
  <section class="cx-panel">
    ${appsPanel(apps, "request", `No app uses ${e(k.label)} yet. Ask your AI to build an app with it, or to add it to one you have, for example "text me when a new lead comes in, with ${e(k.label)}".`)}
    <p class="muted">An app uses ${e(k.label)} when it's built to. To stop an app using it, remove it on the app's Connected apps tab.</p>
    <h2>How apps use it</h2>
    <p class="muted">The app names ${e(k.name)} in its code. Formelab adds the key on the way out, so it never reaches the app, its code or the people you share it with.</p>
    <pre class="cx-code">${e(sample)}</pre>
  </section>
  <section class="cx-panel">
    <h2>Settings</h2>
    <p class="muted">Changes save as you make them.</p>
    ${settingsFields(k)}
    <h2>Key</h2>
    <p class="muted">${k.hint ? `Saved, ending in <code>…${e(k.hint)}</code>.` : "Saved."} Nobody can see it again, including you.</p>
    <form class="inline" data-action="connector-key" data-name="${e(k.name)}">
      <input type="password" name="key" required autocomplete="off" spellcheck="false" placeholder="Paste the new key" aria-label="New key for ${e(k.label)}">
      <button class="secondary">Replace key</button>
    </form>
    ${activityList(log.map((l) => ({ at: l.at, text: (ACTIVITY[l.action] ?? (() => l.action))(l.detail) })))}
  </section>
</div>
<section class="cx-danger">
  <h2>Delete connector</h2>
  <p>${apps.length ? `${e(apps.map((a) => a.name).join(", "))} can't reach ${e(k.label)} after this.` : "No app uses it."} The key is deleted from Formelab.</p>
  <button type="button" class="danger" data-action="connector-delete" data-name="${e(k.name)}" data-label="${e(k.label)}" data-apps="${apps.length}">Delete ${e(k.label)}</button>
</section>`;
  return shell(c, user, "connected", body, k.label, { pageHead: false });
}

const AUTH_OPTIONS: [ConnectorView["auth"], string][] = [
  ["bearer", "Authorization: Bearer <key>"],
  ["header", "A header of its own, like X-API-Key"],
  ["query", "A query parameter, like ?api_key="],
  ["placeholder", "The app puts it in with {{value}}"],
];

/** Name, what it's for, hosts and how it's sent: on the new connector form, and its page (autosaved). */
function settingsFields(k: ConnectorView | null): string {
  const id = (f: string) => `cx-${f}`;
  const auth = k?.auth ?? "bearer";
  return `<div class="cx-form"${k ? ` data-connector-settings data-name="${e(k.name)}"` : ""}>
  <div class="cx-pair">
    <label for="${id("label")}">Name<input id="${id("label")}" name="label" required maxlength="60" value="${e(k?.label ?? "")}" placeholder="Quo"${k ? "" : " data-connector-label"}>
      <span class="hint">${k ? `Apps ask for it as <code>${e(k.name)}</code>.` : `Apps ask for it as <code data-connector-slug>…</code>.`}</span></label>
    <label for="${id("description")}"><span>What it's for <span class="muted">(optional)</span></span><input id="${id("description")}" name="description" maxlength="200" value="${e(k?.description ?? "")}" placeholder="Texts and calls from the business number"></label>
  </div>
  <div class="cx-pair">
    <label for="${id("hosts")}">Only send it to<input id="${id("hosts")}" name="hosts" required value="${e(k?.hosts.join(", ") ?? "")}" placeholder="api.quo.com" autocomplete="off" spellcheck="false">
      <span class="hint">The address of the service's API. Add more with commas; *.example.com allows its subdomains.</span></label>
    <label for="${id("auth")}">Send it as<select id="${id("auth")}" name="auth" data-connector-auth>${AUTH_OPTIONS.map(([v, t]) => `<option value="${v}"${v === auth ? " selected" : ""}>${e(t)}</option>`).join("")}</select>
      <span class="hint">The service's API docs say which. Most use the first one.</span></label>
  </div>
  <label for="${id("authName")}" data-connector-auth-name${auth === "header" || auth === "query" ? "" : " hidden"}>${auth === "query" ? "Query parameter" : "Header"}<input id="${id("authName")}" name="authName" value="${e(k?.authName ?? "")}" placeholder="${auth === "query" ? "api_key" : "X-API-Key"}" autocomplete="off" spellcheck="false"></label>
</div>`;
}

/** /connected/new: make a custom connector. */
async function newConnectorPage(c: Context<AppEnv>): Promise<Response> {
  const body = `<nav class="crumb" aria-label="Breadcrumb"><a href="/connected">Connected apps</a><span aria-hidden="true">/</span><span>Custom connector</span></nav>
<div class="page-head"><h1>Custom connector</h1><p>For any service that gives you an API key. Your apps use it without ever seeing the key.</p></div>
<section>
  <form data-action="connector-create" class="cx-new">
    ${settingsFields(null)}
    <label for="cx-key">API key<input id="cx-key" type="password" name="key" required autocomplete="off" spellcheck="false" placeholder="Paste the key">
      <span class="hint">Saved encrypted. Nobody can see it again, including you; you can replace it.</span></label>
    <p class="note">No app uses it yet. Once it's made, ask your AI to build an app with it, or to add it to one you have.</p>
    <div class="cx-actions"><a class="ghost" href="/connected">Cancel</a><button>Create connector</button></div>
  </form>
</section>`;
  return shell(c, c.get("user"), "connected", body, "Custom connector", { pageHead: false });
}

/** /connected/gemini */
async function geminiPage(c: Context<AppEnv>): Promise<Response> {
  const user = c.get("user");
  const [gemini, apps] = await Promise.all([geminiStatus(c.env, user.email), appsUsing(c.env, user.email, "gemini")]);
  const calls = apps.reduce((n, a) => n + a.calls, 0);
  const keyForm = `<form class="inline" data-action="service-connect" data-service="gemini">
      <input type="password" name="apiKey" required autocomplete="off" spellcheck="false" placeholder="Paste your Gemini API key" aria-label="Gemini API key">
      <button${gemini.connected ? ` class="secondary"` : ""}>${gemini.connected ? "Replace key" : "Connect"}</button>
    </form>`;
  const body = `${pageTop(
    AI_LOGOS.gemini ?? "",
    "Google Gemini",
    gemini.connected ? `${CONNECTED} with your key ending in <code>…${e(gemini.hint ?? "")}</code>. ${e(GEMINI_MODEL_NAME)}.` : `Give your apps AI: answering questions, summarizing, drafting, sorting, with ${e(GEMINI_MODEL_NAME)}.`,
  )}
<div class="cx-cols">
  <section class="cx-panel">
    ${appsPanel(apps, "call", `No app uses Gemini yet. Ask your AI for an app "that uses Gemini".`)}
    <p class="muted">An app uses Gemini when it's built to. To stop an app using it, remove it on the app's Connected apps tab.</p>
  </section>
  <section class="cx-panel">
    ${
      gemini.connected
        ? `<h2>Use</h2>
    <dl class="cx-facts"><dt>Calls, 30 days</dt><dd>${calls}</dd><dt>Today (UTC)</dt><dd>${gemini.usedToday ?? 0} of ${gemini.dailyLimit ?? GEMINI_DAILY_DEFAULT}</dd><dt>Added</dt><dd>${e(fmtTime(gemini.createdAt ?? null))}</dd></dl>
    <h2>Daily limit</h2>
    <p class="muted">Past the limit, Gemini stops answering in all your apps until tomorrow, so someone you share an app with can't run up your Google bill. Each person other than you can also use it at most ${GEMINI_VIEWER_PER_DAY} times a day.</p>
    <form class="inline" data-action="gemini-limit">
      <label>Most calls a day, all apps together <input type="number" name="dailyLimit" min="0" max="${GEMINI_DAILY_MAX}" step="1" value="${gemini.dailyLimit ?? GEMINI_DAILY_DEFAULT}"></label>
      <button class="secondary">Save</button>
    </form>
    <h2>Replace the key</h2>
    ${keyForm}`
        : `<h2>Connect it</h2>
    <ol>
      <li>Open <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Google AI Studio → API keys</a> and sign in with Google.</li>
      <li>Click <strong>Create API key</strong> and copy it.</li>
      <li>Paste it here and click <strong>Connect</strong>. Formelab checks it with Google first.</li>
    </ol>
    ${keyForm}`
    }
    <p class="muted">Your key is encrypted and never shown to apps or to anyone. Apps you share use your key, so calls from people you share them with count toward your Google usage.</p>
    ${c.get("features")?.has("app_builder") ? `<p class="muted">This is also the key behind <strong>Make it with Gemini</strong> on <a href="/new">New app</a>: save or remove it in either place and it changes in both.</p>` : ""}
  </section>
</div>
${
  gemini.connected
    ? `<section class="cx-danger">
  <h2>Disconnect</h2>
  <p>${apps.length ? `${e(apps.map((a) => a.name).join(", "))} can't use Gemini` : "Your apps can't use Gemini"} until you connect it again. Your key is deleted from Formelab.</p>
  <button type="button" class="danger" data-action="service-disconnect" data-service="gemini">Disconnect Google Gemini</button>
</section>`
    : ""
}`;
  return shell(c, user, "connected", body, "Google Gemini", { pageHead: false });
}

const SHEETS_OUTCOME: Record<string, [boolean, string]> = {
  connected: [true, "Connected. Your apps can use your Google Sheets now."],
  denied: [false, "You didn't allow access in Google, so nothing was connected."],
  expired: [false, "That sign-in took too long or was already used. Try Connect again."],
  failed: [false, "Google didn't complete the sign-in. Try Connect again."],
  scope: [false, "Google didn't give access to spreadsheets. Try again and leave the spreadsheets box ticked."],
};

/** /connected/google-sheets */
async function sheetsPage(c: Context<AppEnv>): Promise<Response> {
  const user = c.get("user");
  const sheets = await sheetsStatus(c.env, user.email);
  const ready = sheetsConfigured(c.env);
  const { results } = await c.env.DB.prepare(
    "SELECT id, title, mount_path, namespace, sheets FROM sites WHERE owner_email = ? AND json_array_length(sheets) > 0 ORDER BY title, mount_path",
  )
    .bind(user.email)
    .all<{ id: string; title: string | null; mount_path: string; namespace: string; sheets: string }>();
  const outcome = SHEETS_OUTCOME[c.req.query("sheets") ?? ""];
  const rows = results
    .map((s) => {
      const n = parseJsonArray(s.sheets).length;
      const name = siteName(s);
      return `<li><span class="cx-app">${e((name[0] ?? "?").toUpperCase())}</span><span class="cx-app-txt"><a href="/apps/${e(encodeURIComponent(s.id))}#connected">${e(name)}</a><span>Its spreadsheets are listed on its Connected apps tab</span></span><span class="cx-num">${n} spreadsheet${n === 1 ? "" : "s"}</span></li>`;
    })
    .join("");
  const body = `${pageTop(SHEETS_LOGO(), "Google Sheets", sheets.connected ? `${CONNECTED} as ${e(sheets.account ?? "")}.` : e(SHEETS_ABOUT))}
${outcome ? `<p class="cx-flash ${outcome[0] ? "ok" : "error"}" role="status">${e(outcome[1])}</p>` : ""}
<div class="cx-cols">
  <section class="cx-panel">
    <div class="cx-panel-head"><h2>Apps that use it</h2></div>
    ${results.length ? `<ul class="cx-apps">${rows}</ul>` : `<div class="conn-empty">No app uses Google Sheets yet. Ask your AI for an app "that saves to Google Sheets", and give it the spreadsheet's link.</div>`}
    <p class="muted">An app can only reach the spreadsheets listed for it, nothing else in your Drive.</p>
  </section>
  <section class="cx-panel">
    ${
      !ready
        ? `<p class="note">Google Sheets isn't set up on this Formelab yet: the admin needs to add a Google sign-in client first.</p>`
        : sheets.connected
          ? `<h2>Your Google account</h2>
    <dl class="cx-facts"><dt>Account</dt><dd>${e(sheets.account ?? "")}</dd><dt>Added</dt><dd>${e(fmtTime(sheets.createdAt ?? null))}</dd><dt>Last used</dt><dd>${e(fmtTime(sheets.lastUsedAt ?? null))}</dd></dl>
    <p><a class="ghost" href="/services/google-sheets/connect">Reconnect with Google</a></p>`
          : `<h2>Connect it</h2>
    <p class="muted">Let your apps read and add to your spreadsheets: a sign-up form that saves into a sheet, a dashboard over your numbers, a tracker everyone on your team can use. Sign in with Google once; no keys to copy.</p>
    <p><a class="cta" href="/services/google-sheets/connect">Connect with Google</a></p>
    <p class="muted">Google asks you to pick an account and allow access to your spreadsheets.</p>`
    }
    <p class="muted">Apps use your Google account, also when people you share them with use them. Your sign-in is encrypted and never shown to apps or people.</p>
  </section>
</div>
${
  sheets.connected
    ? `<section class="cx-danger">
  <h2>Disconnect</h2>
  <p>${results.length ? `${e(results.map((s) => s.title || s.mount_path).join(", "))} can't reach their spreadsheets` : "Your apps can't use Google Sheets"} until you connect it again.</p>
  <button type="button" class="danger" data-action="service-disconnect" data-service="google-sheets">Disconnect Google Sheets</button>
</section>`
    : ""
}`;
  return shell(c, user, "connected", body, "Google Sheets", { pageHead: false });
}

