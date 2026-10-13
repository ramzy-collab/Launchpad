// App icons for the web app's tiles: the favicon or logo an app ships with.
//
// sites.icon_path holds what was found: NULL = not looked for yet (apps published before icons),
// "" = none, a file path inside the app, or a small data: URI from index.html. It is found at
// publish time, or the first time the icon is asked for. The icon is served from the web app
// host to people who can open the app; apps without one get a letter tile.
import { canViewSite } from "./auth";
import type { Ctx, SiteRow } from "./sites";
import { getNamespace, getSiteById } from "./sites";
import { contentTypeFor, extOf } from "./mime";
import { b64decode } from "./util";

const IMAGE_EXT = new Set(["png", "svg", "ico", "jpg", "jpeg", "gif", "webp", "avif"]);
const WELL_KNOWN = ["apple-touch-icon.png", "favicon.svg", "favicon.png", "favicon.ico", "icon.svg", "icon.png", "logo.svg", "logo.png"];
const MAX_DATA_URI = 48 * 1024;
const MAX_ICON_BYTES = 1024 * 1024;

const attr = (tag: string, name: string) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "").trim() : null;
};

/** A file path inside the app for an href in its index.html, or null for anything outside it. */
function resolveHref(href: string, mount: string): string | null {
  let p = href.split(/[?#]/)[0]!;
  if (/^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith("//")) return null;
  try {
    p = decodeURIComponent(p);
  } catch {
    return null;
  }
  if (p.startsWith("/")) {
    p = p.slice(1);
    if (mount && p.startsWith(mount + "/")) p = p.slice(mount.length + 1);
  }
  p = p.replace(/^(\.\/)+/, "");
  if (!p || p.split("/").some((s) => s === ".." || s === ".")) return null;
  return p;
}

/**
 * The best icon among an app's files: what index.html links as its icon (apple-touch-icon first,
 * then SVG, then any icon), else a well-known file name at the app's root. "" when there's none.
 */
export function findIcon(paths: Iterable<string>, indexHtml: string, mount: string): string {
  const files = new Set(paths);
  const isImage = (p: string) => IMAGE_EXT.has(extOf(p)) && files.has(p);
  const links: { score: number; value: string }[] = [];
  for (const tag of indexHtml.slice(0, 64 * 1024).match(/<link\b[^>]*>/gi) ?? []) {
    const rel = (attr(tag, "rel") ?? "").toLowerCase();
    const href = attr(tag, "href");
    if (!href || !/\bicon\b|apple-touch-icon/.test(rel)) continue;
    const score = rel.includes("apple-touch-icon") ? 3 : /\.svg($|[?#])|image\/svg/i.test(href + " " + (attr(tag, "type") ?? "")) ? 2 : 1;
    if (/^data:image\/(png|svg\+xml|x-icon|vnd\.microsoft\.icon|jpeg|gif|webp)[;,]/i.test(href)) {
      if (href.length <= MAX_DATA_URI) links.push({ score, value: href });
      continue;
    }
    const p = resolveHref(href, mount);
    if (p && isImage(p)) links.push({ score, value: p });
  }
  links.sort((a, b) => b.score - a.score);
  if (links[0]) return links[0].value;
  return WELL_KNOWN.find(isImage) ?? "";
}

/** The icon for a site, looking for it (and remembering the answer) if it hasn't been yet. */
export async function iconPathFor(env: Ctx["env"], site: SiteRow & { icon_path?: string | null }): Promise<string> {
  if (typeof site.icon_path === "string") return site.icon_path;
  const prefix = `sites/${site.id}/${site.current_version}/`;
  const paths: string[] = [];
  let cursor: string | undefined;
  do {
    const list = await env.BUCKET.list({ prefix, cursor, limit: 1000 });
    for (const o of list.objects) paths.push(o.key.slice(prefix.length));
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor && paths.length < 5000);
  const index = await env.BUCKET.get(prefix + "index.html", { range: { offset: 0, length: 64 * 1024 } });
  const icon = findIcon(paths, index ? await index.text() : "", site.mount_path);
  await env.DB.prepare("UPDATE sites SET icon_path = ? WHERE id = ? AND current_version = ?").bind(icon, site.id, site.current_version).run();
  return icon;
}

const HUES = ["#5B4CF5", "#FF6B4A", "#2BC48A", "#F5A623", "#E5487D", "#3B82F6", "#14B8A6", "#8B5CF6"];
const xml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The letter tile, as an SVG, for apps without an icon. Same colors as the tiles' hue-N classes. */
export function letterIcon(site: SiteRow): string {
  let h = 0;
  for (const ch of site.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const name = site.title || site.mount_path || site.namespace;
  const letter = (name.match(/[\p{L}\p{N}]/u)?.[0] ?? "•").toUpperCase();
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="18" fill="${HUES[h % 8]}"/><text x="32" y="43" text-anchor="middle" font-family="system-ui,sans-serif" font-size="30" font-weight="800" fill="#fff">${xml(letter)}</text></svg>`;
}

// An icon is untrusted content from the app. Served from the web app's own host, an SVG opened
// directly could run script there, so it gets a sandboxing CSP that allows nothing to run.
const ICON_HEADERS = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
  "cache-control": "private, max-age=86400",
};

/** GET /apps/:id/icon on the web app host: the app's icon, for people who can open the app. */
export async function appIcon(ctx: Ctx, id: string): Promise<Response> {
  const notFound = () => new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  const site = (await getSiteById(ctx.env, id)) as (SiteRow & { icon_path?: string | null }) | null;
  const ns = site ? await getNamespace(ctx.env, site.namespace) : null;
  if (!site || !ns || !canViewSite(ctx.user, site, ns)) return notFound();
  const icon = await iconPathFor(ctx.env, site);
  if (icon.startsWith("data:")) {
    const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(icon);
    if (m) {
      let body: Uint8Array;
      try {
        body = m[2] ? b64decode(m[3]!) : new TextEncoder().encode(decodeURIComponent(m[3]!));
      } catch {
        body = new Uint8Array();
      }
      if (body.length) return new Response(body, { headers: { ...ICON_HEADERS, "content-type": m[1]! } });
    }
  } else if (icon) {
    const obj = await ctx.env.BUCKET.get(`sites/${site.id}/${site.current_version}/${icon}`);
    if (obj && obj.size <= MAX_ICON_BYTES) return new Response(obj.body, { headers: { ...ICON_HEADERS, "content-type": contentTypeFor(icon) } });
  }
  return new Response(letterIcon(site), { headers: { ...ICON_HEADERS, "content-type": "image/svg+xml" } });
}
