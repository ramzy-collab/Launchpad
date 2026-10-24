// App icons for the web app's tiles: the favicon or logo an app ships with.
//
// sites.icon_path holds what was found: NULL = not looked for yet (apps published before icons),
// "" = none, a file path inside the app, or a small data: URI from index.html. It is found at
// publish time, or the first time the icon is asked for. The icon is served from the web app
// host to people who can open the app; apps without one get a letter tile.
import { canViewSite } from "./auth";
import type { Ctx, SiteRow } from "./sites";
import { getNamespace, getSiteById, listObjects, siteName, versionPrefix } from "./sites";
import { contentTypeFor, extOf } from "./mime";
import { b64decode } from "./util";

const IMAGE_EXT = new Set(["png", "svg", "ico", "jpg", "jpeg", "gif", "webp", "avif"]);
const WELL_KNOWN = ["apple-touch-icon.png", "favicon.svg", "favicon.png", "favicon.ico", "icon.svg", "icon.png", "logo.svg", "logo.png"];
const MAX_DATA_URI = 48 * 1024;
const MAX_ICON_BYTES = 1024 * 1024;

/** An attribute's value in an HTML tag, or null. */
export const attr = (tag: string, name: string) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "").trim() : null;
};

/** A file path inside the app for an href in its index.html, or null for anything outside it. */
export function resolveHref(href: string, mount: string): string | null {
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

/** The current version's file paths and the start of its index.html, for finding its icon and preview image. */
export async function appFiles(env: Ctx["env"], site: SiteRow, headBytes = 64 * 1024): Promise<{ paths: string[]; indexHtml: string }> {
  const prefix = versionPrefix(site);
  const paths: string[] = [];
  for await (const page of listObjects(env.BUCKET, prefix)) {
    paths.push(...page.map((o) => o.key.slice(prefix.length)));
    if (paths.length >= 5000) break;
  }
  const index = await env.BUCKET.get(prefix + "index.html", { range: { offset: 0, length: headBytes } });
  return { paths, indexHtml: index ? await index.text() : "" };
}

/** The icon for a site, looking for it (and remembering the answer) if it hasn't been yet. */
export async function iconPathFor(env: Ctx["env"], site: SiteRow): Promise<string> {
  if (typeof site.icon_path === "string") return site.icon_path;
  const { paths, indexHtml } = await appFiles(env, site);
  const icon = findIcon(paths, indexHtml, site.mount_path);
  await env.DB.prepare("UPDATE sites SET icon_path = ? WHERE id = ? AND current_version = ?").bind(icon, site.id, site.current_version).run();
  return icon;
}

const HUES = ["#5B4CF5", "#FF6B4A", "#2BC48A", "#F5A623", "#E5487D", "#3B82F6", "#14B8A6", "#8B5CF6"];
/** Escapes text for SVG markup. */
export const xml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Which of the eight app colors an app gets: HUES here, the hue-N classes in the web app. */
export function hueIndex(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % HUES.length;
}

/** The app's color: the same one its letter tile and the web app's hue-N class use. */
export const hueOf = (site: Pick<SiteRow, "id">) => HUES[hueIndex(site.id)]!;

/** The letter on an app's tile. */
export const letterOf = (site: SiteRow) => (siteName(site).match(/[\p{L}\p{N}]/u)?.[0] ?? "•").toUpperCase();

/** The letter tile, as an SVG, for apps without an icon. */
export function letterIcon(site: SiteRow): string {
  const letter = letterOf(site);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="18" fill="${hueOf(site)}"/><text x="32" y="43" text-anchor="middle" font-family="system-ui,sans-serif" font-size="30" font-weight="800" fill="#fff">${xml(letter)}</text></svg>`;
}

// An icon is untrusted content from the app. Served from the web app's own host, an SVG opened
// directly could run script there, so it gets a sandboxing CSP that allows nothing to run.
export const ICON_HEADERS = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
  "cache-control": "private, max-age=86400",
};

/** GET /apps/:id/icon on the web app host: the app's icon, for people who can open the app. */
export async function appIcon(ctx: Ctx, id: string): Promise<Response> {
  const site = await getSiteById(ctx.env, id);
  const ns = site ? await getNamespace(ctx.env, site.namespace) : null;
  if (!site || !ns || !canViewSite(ctx.user, site, ns)) {
    return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  return iconResponse(ctx.env, site);
}

/** The app's icon as a response (its own, or the letter tile). The caller checks who may see it. */
export async function iconResponse(env: Ctx["env"], site: SiteRow): Promise<Response> {
  const icon = await iconPathFor(env, site);
  if (icon.startsWith("data:")) {
    const data = decodeDataUri(icon);
    if (data?.bytes.length) return new Response(data.bytes, { headers: { ...ICON_HEADERS, "content-type": data.type } });
  } else if (icon) {
    const obj = await env.BUCKET.get(versionPrefix(site) + icon);
    if (obj && obj.size <= MAX_ICON_BYTES) return new Response(obj.body, { headers: { ...ICON_HEADERS, "content-type": contentTypeFor(icon) } });
  }
  return new Response(letterIcon(site), { headers: { ...ICON_HEADERS, "content-type": "image/svg+xml" } });
}

/** A data: URI's media type (lowercase) and bytes, or null when it isn't one or doesn't decode. */
export function decodeDataUri(uri: string): { type: string; bytes: Uint8Array } | null {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(uri);
  if (!m) return null;
  try {
    return { type: m[1]!.toLowerCase(), bytes: m[2] ? b64decode(m[3]!) : new TextEncoder().encode(decodeURIComponent(m[3]!)) };
  } catch {
    return null;
  }
}

/** Width and height of a PNG, from its header; null for anything else. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 24 || sig.some((b, i) => bytes[i] !== b)) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: v.getUint32(16), height: v.getUint32(20) };
}
