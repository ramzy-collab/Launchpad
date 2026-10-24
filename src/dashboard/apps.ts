// The app browser on My apps and Shared with me: a grid of cards, starred apps first, with search,
// a space filter and sort. The server renders every card once; dashboard.js filters, sorts and
// moves starred cards up (stars live in the browser until they're saved per person).
import type { SiteView } from "../sites";
import { escapeHtml as e } from "../util";

export type BrowserApp = SiteView & { canManage: boolean; starred?: boolean };

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

const svg = (body: string, size = 18) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

/** Line icons shared by the app cards and the app's page. */
export const ICON = {
  lock: (n = 15) => svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>', n),
  people: (n = 15) => svg('<circle cx="9" cy="8" r="3.5"/><circle cx="17" cy="9" r="2.5"/><path d="M2 20c0-3.5 3-5.5 7-5.5s7 2 7 5.5M16 14.5c3 0 6 1.5 6 4.5"/>', n),
  globe: (n = 15) => svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z"/>', n),
  link: (n = 16) => svg('<path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>', n),
  star: (n = 20) => svg('<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>', n),
  gear: (n = 19) =>
    svg(
      '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
      n,
    ),
  search: (n = 18) => svg('<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>', n),
  sliders: (n = 18) => svg('<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>', n),
  ext: (n = 14) => svg('<path d="M7 17L17 7M9 7h8v8"/>', n),
  alert: (n = 18) => svg('<path d="M10.3 3.9L2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>', n),
  chevron: (n = 14) => svg('<path d="M6 9l6 6 6-6"/>', n),
  more: (n = 18) => `<svg width="${n}" height="${n}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>`,
};

/** Everyone the app is shared with by name (viewers and editors), not counting its owner. */
export const sharedWith = (s: SiteView) => [...new Set([...s.allowedEmails, ...s.editors])].filter((x) => x !== s.ownerEmail);

export type Access = { kind: "public" | "members" | "shared" | "private"; label: string; icon: string };

/** Who can open the app, for its card chip and the share pill on its page. */
export function accessOf(s: SiteView): Access {
  if (s.publicUrl) return { kind: "public", label: "Public", icon: ICON.globe(13) };
  if (s.visibility === "all") return { kind: "members", label: "Formelab members", icon: ICON.people(13) };
  const n = sharedWith(s).length;
  return n ? { kind: "shared", label: `Shared with ${n}`, icon: ICON.people(13) } : { kind: "private", label: "Only you", icon: ICON.lock(13) };
}

/** The link that works for how the app is shared: its public link when it has one, else its address. */
export const shareUrl = (s: SiteView) => s.publicUrl ?? s.url;

function card(s: BrowserApp, shared: boolean, now: number): string {
  const name = appName(s);
  const search = [name, s.namespace, s.mountPath, shared ? s.ownerEmail : ""].join(" ").toLowerCase();
  const access = accessOf(s);
  const chip = shared
    ? `<span class="chip">${s.canManage ? "Can edit" : "Can open"}</span>`
    : `<span class="chip ${access.kind}">${access.icon} ${e(access.label)}</span>`;
  const gear = s.canManage
    ? `<a class="ac-btn gear" href="/apps/${e(encodeURIComponent(s.id))}" aria-label="Settings for ${e(name)}" title="Settings">${ICON.gear()}</a>`
    : "";
  return `<div class="appcard" data-app data-id="${e(s.id)}" data-name="${e(name.toLowerCase())}" data-space="${e(s.namespace)}" data-updated="${s.updatedAt}" data-created="${s.createdAt}" data-search="${e(search)}" data-access="${shared ? "" : access.kind}" data-shared-n="${sharedWith(s).length}" data-copy-url="${e(shareUrl(s))}">
  <span class="ac-art ${hueClass(s.id)}" aria-hidden="true">${s.iconUrl ? `<img src="${e(s.iconUrl)}" alt="" loading="lazy" decoding="async">` : e(initial(s))}</span>
  <a class="ac-open" href="${e(s.url)}" target="_blank" rel="noopener"><span class="sr">Open ${e(name)}</span></a>
  <div class="ac-top">${thumb(s)}
    <button type="button" class="ac-btn star${s.starred ? " on" : ""}" data-star="${e(s.id)}" aria-pressed="${!!s.starred}" aria-label="Star ${e(name)}" title="${s.starred ? "Unstar" : "Star"}">${ICON.star()}</button>
    ${gear}
  </div>
  <div class="ac-name${s.title ? "" : " untitled"}">${e(name)}</div>
  <div class="ac-sub">${shared ? `${e(s.ownerEmail)} · ` : ""}${e(s.namespace)} · <span class="ac-updated">Updated </span>${e(ago(s.updatedAt, now))}</div>
  <div class="ac-foot">${chip}<button type="button" class="ac-btn copy" data-copy-link aria-label="Copy link to ${e(name)}" title="Copy link">${ICON.link()}</button></div>
</div>`;
}

/** The full browser for a list of apps. `shared` shows each app's owner and your access (Shared with me). */
export function appBrowser(apps: BrowserApp[], opts: { shared: boolean }): string {
  const { shared } = opts;
  const now = Date.now();
  const spaces = [...new Set(apps.map((s) => s.namespace))].sort();
  const options = (list: [string, string][]) => list.map(([v, l]) => `<option value="${e(v)}">${e(l)}</option>`).join("");
  return `<div class="browser" data-browser>
  <div class="browser-bar">
    <label class="search">${ICON.search()}<input type="search" data-q placeholder="Search ${shared ? "apps" : "your apps"}" aria-label="Search ${shared ? "apps" : "your apps"}"></label>
    <button type="button" class="filters-toggle" data-filters-toggle aria-expanded="false" aria-controls="app-filters" aria-label="Filter and sort" title="Filter and sort">${ICON.sliders()}<span class="filters-dot" data-filters-dot hidden></span></button>
    <div class="bar-filters" id="app-filters">
      ${spaces.length > 1 ? `<select data-filter="space" aria-label="Space">${options([["", "All spaces"], ...spaces.map((s): [string, string] => [s, s])])}</select>` : ""}
      <select data-sort-select aria-label="Sort">${options([["updated", "Recently changed"], ["created", "Newest first"], ["name", "Name A to Z"]])}</select>
    </div>
  </div>
  <div class="group starred" data-starred hidden>
    <h3 class="group-head"><span class="star-mark" aria-hidden="true">★</span> Starred</h3>
    <div class="cards" data-starred-cards></div>
    <p class="star-hint" data-star-hint hidden>${ICON.star()}<span>Star the apps you use most and they'll wait for you up here.</span></p>
  </div>
  <div class="group" data-rest>
    <h3 class="group-head" data-rest-head hidden>Everything else</h3>
    <div class="cards" data-rest-cards>${apps.map((s) => card(s, shared, now)).join("")}</div>
  </div>
  <div class="no-match" data-no-match hidden>
    <h2 data-no-match-text>Nothing matches</h2>
    <p class="muted">Try a different word, or look in another space.</p>
    <button type="button" class="secondary" data-clear>Show all apps</button>
  </div>
</div>`;
}
