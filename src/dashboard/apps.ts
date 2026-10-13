// The app browser on My apps and Shared with me: tiles grouped by space (the default) or a list
// with sortable columns, plus search, filters and sort. The server renders every app once in
// each view; dashboard.js filters, sorts and switches views in the browser.
import type { SiteView } from "../sites";
import { escapeHtml as e } from "../util";

export type BrowserApp = SiteView & { canManage: boolean };

const VIS = { restricted: "Only people you share with", all: "All Formelab members" } as const;
const VIS_SHORT = { restricted: "Private", all: "All members" } as const;

export const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** "just now", "5 minutes ago", "3 days ago", or a date for anything older than a month. */
export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  const unit = (n: number, u: string) => `${n} ${u}${n === 1 ? "" : "s"} ago`;
  if (s < 60) return "just now";
  if (s < 3600) return unit(Math.floor(s / 60), "minute");
  if (s < 86400) return unit(Math.floor(s / 3600), "hour");
  if (s < 30 * 86400) return unit(Math.floor(s / 86400), "day");
  return new Date(ms).toISOString().slice(0, 10);
}

/** A stable color for an app's thumbnail, from its name (one of eight classes; the CSP allows no inline styles). */
export function hueClass(key: string): string {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hue-${h % 8}`;
}

/** The app's icon (its favicon or logo), or its first letter on a colored square. */
export function thumb(s: SiteView, size: "" | "sm" | "lg" = ""): string {
  const cls = `thumb${size ? " " + size : ""}`;
  return s.iconUrl
    ? `<span class="${cls} has-icon" aria-hidden="true"><img src="${e(s.iconUrl)}" alt="" loading="lazy" decoding="async"></span>`
    : `<span class="${cls} ${hueClass(s.id)}" aria-hidden="true">${e(initial(s))}</span>`;
}

export const appName = (s: SiteView) => s.title || (s.mountPath ? s.mountPath : s.namespace);
export const initial = (s: SiteView) => (appName(s).match(/[\p{L}\p{N}]/u)?.[0] ?? "•").toUpperCase();

const GEAR = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;
const TILES_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>`;
const LIST_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/></svg>`;

/** The attributes the browser script filters and sorts on. */
function dataAttrs(s: BrowserApp, shared: boolean): string {
  const search = [appName(s), s.url, s.namespace, s.mountPath, shared ? s.ownerEmail : ""].join(" ").toLowerCase();
  return `data-app data-name="${e(appName(s).toLowerCase())}" data-space="${e(s.namespace)}" data-vis="${s.visibility}" data-updated="${s.updatedAt}" data-size="${s.totalBytes}"${
    shared ? ` data-owner="${e(s.ownerEmail)}" data-access="${s.canManage ? "edit" : "open"}"` : ""
  } data-search="${e(search)}"`;
}

const gear = (s: BrowserApp) =>
  s.canManage ? `<a class="gear" href="/apps/${e(encodeURIComponent(s.id))}" aria-label="Settings for ${e(appName(s))}" title="Settings">${GEAR}</a>` : "";

function tile(s: BrowserApp, shared: boolean, now: number): string {
  const path = s.mountPath ? `/${s.mountPath}/` : "/";
  return `<div class="tile" ${dataAttrs(s, shared)}>
  <a class="tile-link" href="${e(s.url)}" target="_blank" rel="noopener">
    ${thumb(s)}
    <span class="tile-title">${e(appName(s))}</span>
    <span class="tile-path">${e(path)}</span>
    <span class="tile-meta">${shared ? `${e(s.ownerEmail)} · ` : ""}${e(VIS_SHORT[s.visibility])} · ${e(ago(s.updatedAt, now))}</span>
  </a>
  ${gear(s)}
</div>`;
}

function row(s: BrowserApp, shared: boolean, now: number): string {
  return `<tr ${dataAttrs(s, shared)}>
  <td><a class="row-app" href="${e(s.url)}" target="_blank" rel="noopener">${thumb(s, "sm")}<span>${e(appName(s))}<span class="muted row-url">${e(s.url)}</span></span></a></td>
  <td>${e(s.namespace)}</td>
  ${shared ? `<td>${e(s.ownerEmail)}</td><td>${s.canManage ? "Can edit" : "Can open"}</td>` : `<td>${e(VIS[s.visibility])}${s.allowedEmails.length ? `<div class="muted">${e(s.allowedEmails.join(", "))}</div>` : ""}</td>`}
  <td class="nowrap">${e(ago(s.updatedAt, now))}</td>
  <td class="nowrap">${e(fmtBytes(s.totalBytes))}</td>
  <td>${gear(s)}</td>
</tr>`;
}

const sortHead = (key: string, label: string, current = false) =>
  `<th aria-sort="${current ? "descending" : "none"}"><button type="button" class="sort" data-sort="${key}">${label}<span class="arrow" aria-hidden="true"></span></button></th>`;

/** The full browser for a list of apps. `shared` adds the owner and your access (Shared with me). */
export function appBrowser(apps: BrowserApp[], opts: { shared: boolean }): string {
  const { shared } = opts;
  const now = Date.now();
  const spaces = [...new Set(apps.map((s) => s.namespace))].sort();
  const groups = spaces
    .map((ns) => {
      const inSpace = apps.filter((s) => s.namespace === ns);
      return `<div class="group" data-group="${e(ns)}">
  <h3>${e(ns)}</h3>
  <div class="tiles">${inSpace.map((s) => tile(s, shared, now)).join("")}</div>
</div>`;
    })
    .join("");
  const options = (list: [string, string][]) => list.map(([v, l]) => `<option value="${e(v)}">${e(l)}</option>`).join("");
  const filters = [
    spaces.length > 1 ? `<select data-filter="space" aria-label="Space">${options([["", "All spaces"], ...spaces.map((s): [string, string] => [s, s])])}</select>` : "",
    shared
      ? `<select data-filter="access" aria-label="Your access">${options([["", "Any access"], ["edit", "Can edit"], ["open", "Can open"]])}</select>`
      : `<select data-filter="vis" aria-label="Who can open it">${options([["", "Any visibility"], ["restricted", "Private"], ["all", "All members"]])}</select>`,
  ].join("");
  return `<div class="browser" data-browser data-view="tiles">
  <div class="browser-bar">
    <input type="search" data-q placeholder="Search apps" aria-label="Search apps">
    ${filters}
    <select data-sort-select aria-label="Sort">${options([["updated:desc", "Recently updated"], ["updated:asc", "Least recently updated"], ["name:asc", "Name A–Z"], ["name:desc", "Name Z–A"], ["size:desc", "Largest"], ["size:asc", "Smallest"]])}</select>
    <div class="view-toggle" role="group" aria-label="View">
      <button type="button" data-view="tiles" aria-pressed="true" title="Tiles">${TILES_ICON}<span class="sr">Tiles</span></button>
      <button type="button" data-view="list" aria-pressed="false" title="List">${LIST_ICON}<span class="sr">List</span></button>
    </div>
  </div>
  <div class="view-tiles">${groups}</div>
  <div class="view-list" hidden>
    <div class="scroll"><table><thead><tr>
      ${sortHead("name", "App")}${sortHead("space", "Space")}${shared ? sortHead("owner", "Owner") + sortHead("access", "Your access") : sortHead("vis", "Who can open it")}${sortHead("updated", "Updated", true)}${sortHead("size", "Size")}<th><span class="sr">Settings</span></th>
    </tr></thead><tbody>${apps.map((s) => row(s, shared, now)).join("")}</tbody></table></div>
  </div>
  <p class="muted no-match" data-no-match hidden>No apps match. Try a different search or filter.</p>
</div>`;
}
