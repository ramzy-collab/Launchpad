// Link previews: what iMessage, Slack, WhatsApp, Discord and other apps show when someone shares a
// Formelab link (a title, a line of description and a big image).
//
// Apps need a sign-in, and the services that fetch link previews never have one. So on an app's
// host those fetchers (recognized by their user agent) get a small page with the app's preview
// tags instead of the sign-in redirect; people sign in exactly as before. The picture is the
// app's own: a share illustration it ships (share.svg, or an og:image in index.html), found when
// it's published like its icon, or else a card drawn from its icon, name and description. It's
// public, at /_platform/share.png on the app's host, as a PNG (the only kind every service shows).
//
// Formelab's own pages (the home page, login and the web app) share a brand card, /_assets/share.png.
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
import type { Context } from "hono";
import type { AppEnv, Env } from "./env";
import { ASSET_VERSION, DISPLAY_FONT_TTF, TEXT_FONT_TTF } from "./generated/assets";
import { aiOrigin, siteOrigin } from "./hosts";
import { appFiles, attr, hueOf, iconPathFor, iconResponse, letterOf, pngSize, resolveHref } from "./icons";
import { contentTypeFor, extOf } from "./mime";
import { appTitle, iconUrl } from "./pwa";
import type { SiteRow } from "./sites";
import { b64decode, b64encode, escapeHtml as e } from "./util";

type ShareSite = SiteRow & { icon_path?: string | null; share_path?: string | null };

/** The size services show large previews at (1.91:1). */
export const SHARE_W = 1200;
export const SHARE_H = 630;
const HEAD_BYTES = 192 * 1024;
const MAX_DATA_URI = 160 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_SVG_BYTES = 1024 * 1024;
const RASTER = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const WELL_KNOWN = ["share.svg", "share.png", "share.jpg", "og-image.png", "og-image.jpg", "og.png", "og.jpg", "preview.svg", "preview.png"];

const CANVAS = "#FBFAF7";
const INK = "#1C1B19";
const INK_SOFT = "#6B6862";
const ACCENT = "#5B4CF5";
const CORAL = "#FF6B4A";
const YELLOW = "#FFC93C";

// ---------------------------------------------------------------------------
// Who is asking
// ---------------------------------------------------------------------------

// The fetchers of link previews. iMessage's says facebookexternalhit and Twitterbot; Signal's says
// WhatsApp. In-app browsers (Facebook, LinkedIn, Snapchat, Teams) have their own names and aren't
// matched, so people opening a link inside those apps still sign in.
const PREVIEW_BOT =
  /facebookexternalhit|facebot|twitterbot|slackbot|slack-imgproxy|discordbot|^whatsapp\b|telegrambot|linkedinbot|skypeuripreview|microsoftpreview|applebot|pinterest|redditbot|embedly|iframely|vkshare|mastodon|bluesky|cardyb|bitlybot|google-pagerenderer|zoombot|chatgpt-user|claudebot|claude-user/i;

/** Whether a request comes from a service fetching a link preview (not a person). */
export const isPreviewBot = (req: Request) => PREVIEW_BOT.test(req.headers.get("user-agent") ?? "");

// ---------------------------------------------------------------------------
// The app's own preview image, title and description
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decodeEntities = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, n: string) => {
    if (n[0] === "#") {
      const code = n[1] === "x" || n[1] === "X" ? parseInt(n.slice(2), 16) : parseInt(n.slice(1), 10);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[n.toLowerCase()] ?? m;
  });
const tidy = (s: string, max: number) => {
  const t = decodeEntities(s).replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
};

/** index.html's <meta> tags, as [property or name, content]. */
function metaTags(html: string): [string, string][] {
  return (html.slice(0, HEAD_BYTES).match(/<meta\b[^>]*>/gi) ?? []).map((tag) => [
    (attr(tag, "property") ?? attr(tag, "name") ?? "").toLowerCase(),
    attr(tag, "content") ?? "",
  ]);
}

/**
 * The app's share image among its files: what index.html names as its og:image (a file in the
 * app, a small data: URI or an https URL), else a well-known name like share.svg. "" when none.
 */
export function findShareImage(paths: Iterable<string>, indexHtml: string, mount: string): string {
  const files = new Set(paths);
  const usable = (p: string) => (RASTER.has(extOf(p)) || extOf(p) === "svg") && files.has(p);
  for (const [key, raw] of metaTags(indexHtml)) {
    if (key !== "og:image" && key !== "og:image:url" && key !== "twitter:image") continue;
    const value = decodeEntities(raw.trim());
    if (/^data:image\/(png|jpeg|gif|webp|svg\+xml)[;,]/i.test(value)) {
      if (value.length <= MAX_DATA_URI) return value;
      continue;
    }
    if (/^https:\/\/[^\s"'<>]+$/i.test(value)) {
      if (value.length <= 2048) return value;
      continue;
    }
    const p = resolveHref(value, mount);
    if (p && usable(p)) return p;
  }
  return WELL_KNOWN.find(usable) ?? "";
}

/** The site's share image (see sites.share_path), looking for it (and remembering it) if it hasn't been yet. */
export async function sharePathFor(env: Env, site: ShareSite): Promise<string> {
  if (typeof site.share_path === "string") return site.share_path;
  const { paths, indexHtml } = await appFiles(env, site, HEAD_BYTES);
  const share = findShareImage(paths, indexHtml, site.mount_path);
  await env.DB.prepare("UPDATE sites SET share_path = ? WHERE id = ? AND current_version = ?").bind(share, site.id, site.current_version).run();
  site.share_path = share;
  return share;
}

/** The title and description a preview shows: the app's settings, else what its index.html says. */
export async function appPreviewText(env: Env, site: SiteRow): Promise<{ title: string; description: string }> {
  const obj = await env.BUCKET.get(`sites/${site.id}/${site.current_version}/index.html`, { range: { offset: 0, length: 64 * 1024 } });
  const html = obj ? await obj.text() : "";
  const metas = metaTags(html);
  const meta = (...keys: string[]) => keys.map((k) => metas.find(([key, v]) => key === k && v.trim())?.[1]).find(Boolean) ?? "";
  const docTitle = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "";
  return {
    title: tidy(site.title || meta("og:title", "twitter:title") || docTitle || appTitle(site), 120),
    description: tidy(meta("og:description", "description", "twitter:description"), 300),
  };
}

// ---------------------------------------------------------------------------
// Drawing: SVG to PNG with resvg (WebAssembly), with Formelab's fonts bundled
// ---------------------------------------------------------------------------

let ready: Promise<void> | undefined;
let fonts: Uint8Array[] | undefined;

/** An SVG drawn as a PNG, SHARE_W wide (or SHARE_W tall, for a tall picture). External images are never loaded. */
export async function svgToPng(svg: string): Promise<Uint8Array> {
  ready ??= initWasm(resvgWasm).catch((err) => {
    ready = undefined;
    throw err;
  });
  await ready;
  fonts ??= [b64decode(DISPLAY_FONT_TTF), b64decode(TEXT_FONT_TTF)];
  const font = { fontBuffers: fonts, defaultFontFamily: "Inter", sansSerifFamily: "Inter", serifFamily: "Inter", monospaceFamily: "Inter" };
  let r = new Resvg(svg, { font, fitTo: { mode: "width", value: SHARE_W } });
  if (r.height > r.width * 1.5) {
    r.free();
    r = new Resvg(svg, { font, fitTo: { mode: "height", value: SHARE_W } });
  }
  try {
    const img = r.render();
    const png = img.asPng();
    img.free();
    return png;
  } finally {
    r.free();
  }
}

const xml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A rough width for a line of text, in px: enough to wrap titles without measuring glyphs. */
function textWidth(s: string, size: number): number {
  let w = 0;
  for (const ch of s) w += /[\sil.,:;'|!()[\]ftjI1]/.test(ch) ? 0.32 : /[mwMW@%&]/.test(ch) ? 0.9 : /[A-Z0-9#?]/.test(ch) ? 0.68 : 0.57;
  return w * size;
}

/** Words wrapped to lines no wider than `max`, at most `lines` of them (the last ending in … if cut). */
export function wrap(text: string, size: number, max: number, lines: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (let word of text.split(/\s+/).filter(Boolean)) {
    while (textWidth(word, size) > max) {
      const chars = [...word];
      let i = chars.length - 1;
      while (i > 1 && textWidth(chars.slice(0, i).join(""), size) > max) i--;
      if (cur) out.push(cur), (cur = "");
      out.push(chars.slice(0, i).join(""));
      word = chars.slice(i).join("");
    }
    const next = cur ? `${cur} ${word}` : word;
    if (textWidth(next, size) <= max) cur = next;
    else {
      if (cur) out.push(cur);
      cur = word;
    }
  }
  if (cur) out.push(cur);
  if (out.length > lines) {
    let last = out[lines - 1]!;
    out.length = lines;
    while (last && textWidth(last + "…", size) > max) last = [...last].slice(0, -1).join("").trimEnd();
    out[lines - 1] = last + "…";
  }
  return out;
}

const tspans = (lines: string[], x: number, first: number, step: number) =>
  lines.map((l, i) => `<tspan x="${x}" y="${first + i * step}">${xml(l)}</tspan>`).join("");

/** Formelab's mark: the tilted violet square with its coral dot, `size` px wide, at x, y. */
const mark = (x: number, y: number, size: number, letter = true) => {
  const s = size / 38;
  return `<g transform="translate(${x} ${y}) scale(${s})"><rect width="38" height="38" rx="12" fill="${ACCENT}" transform="rotate(-6 19 19)"/>` +
    (letter ? `<text x="19" y="28" text-anchor="middle" font-family="Bricolage Grotesque" font-weight="800" font-size="25" fill="#fff">F</text>` : "") +
    `<circle cx="37" cy="1" r="6" fill="${CORAL}"/></g>`;
};

/** The card drawn for an app without its own share image: its icon on its color, its name and description. */
export function appCardSvg(opts: { title: string; description: string; hue: string; icon: string | null; letter: string }): string {
  const x = 88;
  const max = 600;
  let size = 76;
  let title = wrap(opts.title, size, max, 2);
  if (title.length === 2 && wrap(opts.title, size, max, 3).length > 2) {
    size = 60;
    title = wrap(opts.title, size, max, 3);
  }
  const step = Math.round(size * 1.08);
  const top = 118 + size;
  const descTop = top + (title.length - 1) * step + 64;
  const desc = opts.description ? wrap(opts.description, 30, max, title.length > 2 ? 2 : 3) : [];
  const art = opts.icon
    ? `<image href="${xml(opts.icon)}" x="-100" y="-100" width="200" height="200" preserveAspectRatio="xMidYMid meet"/>`
    : `<text x="0" y="58" text-anchor="middle" font-family="Bricolage Grotesque" font-weight="800" font-size="168" fill="${opts.hue}">${xml(opts.letter)}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${SHARE_W}" height="${SHARE_H}" viewBox="0 0 ${SHARE_W} ${SHARE_H}">
<rect width="${SHARE_W}" height="${SHARE_H}" fill="${CANVAS}"/>
<g transform="translate(936 300)">
  <rect x="-210" y="-210" width="420" height="420" rx="96" fill="${opts.hue}" transform="rotate(-6)"/>
  <circle cx="198" cy="-196" r="40" fill="${YELLOW}"/>
  <circle cx="-226" cy="186" r="16" fill="${CORAL}"/>
  <rect x="-136" y="-128" width="272" height="272" rx="64" fill="#000" opacity=".12" transform="rotate(4)"/>
  <rect x="-136" y="-136" width="272" height="272" rx="64" fill="#fff" transform="rotate(4)"/>
  <g transform="rotate(4)">${art}</g>
</g>
<text font-family="Bricolage Grotesque" font-weight="800" font-size="${size}" letter-spacing="${(-size * 0.03).toFixed(1)}" fill="${INK}">${tspans(title, x, top, step)}</text>
${desc.length ? `<text font-family="Inter" font-weight="600" font-size="30" fill="${INK_SOFT}">${tspans(desc, x, descTop, 42)}</text>` : ""}
${mark(x, 524, 44)}
<text x="${x + 64}" y="556" font-family="Inter" font-weight="600" font-size="27" fill="${INK_SOFT}">Made with <tspan fill="${INK}">Formelab</tspan></text>
</svg>`;
}

/** Formelab's own card: the home page's headline. */
export function formelabCardSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SHARE_W}" height="${SHARE_H}" viewBox="0 0 ${SHARE_W} ${SHARE_H}">
<rect width="${SHARE_W}" height="${SHARE_H}" fill="${CANVAS}"/>
<g transform="translate(1012 150)">
  <rect x="-92" y="-92" width="184" height="184" rx="52" fill="${ACCENT}" transform="rotate(-8)"/>
  <circle cx="92" cy="-88" r="30" fill="${YELLOW}"/>
  <circle cx="-118" cy="104" r="13" fill="${CORAL}"/>
  <text x="0" y="40" text-anchor="middle" font-family="Bricolage Grotesque" font-weight="800" font-size="120" fill="#fff" transform="rotate(-8)">F</text>
</g>
${mark(88, 80, 48)}
<text x="152" y="118" font-family="Bricolage Grotesque" font-weight="800" font-size="40" fill="${INK}">Formelab</text>
<text x="80" y="388" font-family="Bricolage Grotesque" font-weight="800" font-size="150" letter-spacing="-6" fill="${INK}">SaaS is <tspan fill="${ACCENT}">dead.</tspan></text>
<rect x="64" y="316" width="372" height="18" rx="9" fill="${CORAL}" opacity=".92" transform="rotate(-3 250 325)"/>
<text x="88" y="478" font-family="Inter" font-weight="600" font-size="38" fill="${INK_SOFT}">Software that fits you, not the other way around.</text>
<text x="88" y="560" font-family="Inter" font-weight="600" font-size="28" fill="${INK_SOFT}">Describe what you need, and Formelab makes it real.</text>
</svg>`;
}

// ---------------------------------------------------------------------------
// The images
// ---------------------------------------------------------------------------

const IMAGE_HEADERS = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; sandbox",
  "cache-control": "public, max-age=86400",
};

/** Serves an image from the Cache API when it's there, else makes it and caches it. */
async function cached(c: Context<AppEnv>, key: string, make: () => Promise<Response>): Promise<Response> {
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  const req = new Request(key);
  const hit = await cache?.match(req);
  if (hit) return hit;
  const res = await make();
  if (cache && res.ok) c.executionCtx.waitUntil(cache.put(req, res.clone()).catch(() => {}));
  return res;
}

const pngResponse = (png: Uint8Array) => new Response(png, { headers: { ...IMAGE_HEADERS, "content-type": "image/png" } });

/** An app's icon as a data: URI resvg can draw (PNG, JPEG, GIF or SVG), or null for its letter. */
async function iconDataUri(env: Env, site: ShareSite): Promise<string | null> {
  if (!(await iconPathFor(env, site))) return null;
  const res = await iconResponse(env, site);
  const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim();
  if (!["image/png", "image/jpeg", "image/gif", "image/svg+xml"].includes(type)) return null;
  const bytes = new Uint8Array(await res.arrayBuffer());
  return bytes.length && bytes.length <= 1024 * 1024 ? `data:${type};base64,${b64encode(bytes)}` : null;
}

/** The app's own share image as a PNG (or as it is, for a PNG, JPEG, GIF or WebP); null if it has none that works. */
async function ownShareImage(env: Env, site: ShareSite): Promise<Response | null> {
  const share = await sharePathFor(env, site);
  if (!share || share.startsWith("https://")) return null;
  let bytes: Uint8Array;
  let type: string;
  if (share.startsWith("data:")) {
    const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(share);
    if (!m) return null;
    type = m[1]!.toLowerCase();
    try {
      bytes = m[2] ? b64decode(m[3]!) : new TextEncoder().encode(decodeURIComponent(m[3]!));
    } catch {
      return null;
    }
  } else {
    const obj = await env.BUCKET.get(`sites/${site.id}/${site.current_version}/${share}`);
    if (!obj || obj.size > MAX_IMAGE_BYTES) return null;
    bytes = new Uint8Array(await obj.arrayBuffer());
    type = contentTypeFor(share).split(";")[0]!;
  }
  if (type === "image/svg+xml") {
    if (bytes.length > MAX_SVG_BYTES) return null;
    try {
      return pngResponse(await svgToPng(new TextDecoder().decode(bytes)));
    } catch {
      return null; // not an SVG resvg can draw: fall back to the card
    }
  }
  if (!/^image\/(png|jpeg|gif|webp)$/.test(type) || !bytes.length) return null;
  return new Response(bytes, { headers: { ...IMAGE_HEADERS, "content-type": type } });
}

/** GET /_platform/share.png on an app's host: its preview image, public (see the top of this file). */
export async function appShareImage(c: Context<AppEnv>): Promise<Response> {
  const site = c.get("site") as ShareSite;
  const key = `${siteOrigin(c.env, site.host_label, c.req.url)}/_platform/share.png?v=${encodeURIComponent(site.current_version)}`;
  return cached(c, key, async () => {
    const own = await ownShareImage(c.env, site);
    if (own) return own;
    const { title, description } = await appPreviewText(c.env, site);
    return pngResponse(await svgToPng(appCardSvg({ title, description, hue: hueOf(site), icon: await iconDataUri(c.env, site), letter: letterOf(site) })));
  });
}

/** GET /_assets/share.png on Formelab's own hosts: the brand card. */
export async function formelabShareImage(c: Context<AppEnv>): Promise<Response> {
  return cached(c, `${aiOrigin(c.env, c.req.url)}/_assets/share.png?v=${ASSET_VERSION}`, async () => pngResponse(await svgToPng(formelabCardSvg())));
}

// ---------------------------------------------------------------------------
// The tags
// ---------------------------------------------------------------------------

export interface ShareInfo {
  title: string;
  description: string;
  url: string;
  image: string;
  imageAlt: string;
  /** Known only for images Formelab draws. */
  imageSize?: { width: number; height: number };
}

/** Open Graph and Twitter card tags, read by iMessage, Slack, WhatsApp, Discord, LinkedIn and the rest. */
export function shareTags(s: ShareInfo): string {
  const tags = [
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="Formelab">`,
    `<meta property="og:title" content="${e(s.title)}">`,
    s.description ? `<meta property="og:description" content="${e(s.description)}">` : "",
    `<meta property="og:url" content="${e(s.url)}">`,
    `<meta property="og:image" content="${e(s.image)}">`,
    s.imageSize ? `<meta property="og:image:width" content="${s.imageSize.width}">\n<meta property="og:image:height" content="${s.imageSize.height}">` : "",
    `<meta property="og:image:alt" content="${e(s.imageAlt)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${e(s.title)}">`,
    s.description ? `<meta name="twitter:description" content="${e(s.description)}">` : "",
    `<meta name="twitter:image" content="${e(s.image)}">`,
  ];
  return tags.filter(Boolean).join("\n");
}

export const FORMELAB_DESCRIPTION = "Software that fits you, not the other way around. Describe what you need, and Formelab makes it real.";

/** The tags for Formelab's own pages. */
export function formelabShareTags(env: Env, requestUrl: string, title = "Formelab", description = FORMELAB_DESCRIPTION): string {
  const url = new URL(requestUrl);
  return shareTags({
    title,
    description,
    url: url.origin + url.pathname,
    image: `${aiOrigin(env, requestUrl)}/_assets/share.png?v=${ASSET_VERSION}`,
    imageAlt: "Formelab: SaaS is dead. Software that fits you, not the other way around.",
    imageSize: { width: SHARE_W, height: SHARE_H },
  });
}

function previewPage(title: string, description: string, tags: string, icon: string, open: string): Response {
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)}</title>
${description ? `<meta name="description" content="${e(description)}">\n` : ""}<meta name="robots" content="noindex">
<link rel="icon" href="${e(icon)}">
<link rel="apple-touch-icon" href="${e(icon)}">
${tags}
</head>
<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:${INK}">
<h1>${e(title)}</h1>
${description ? `<p>${e(description)}</p>\n` : ""}<p><a href="${e(open)}">Open it on Formelab</a></p>
</body>
</html>`;
  return new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex",
      "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    },
  });
}

/** What a link preview fetcher gets for an app instead of the sign-in redirect. */
export async function appPreviewPage(c: Context<AppEnv>): Promise<Response> {
  const site = c.get("site") as ShareSite;
  const origin = siteOrigin(c.env, site.host_label, c.req.url);
  const { title, description } = await appPreviewText(c.env, site);
  const share = await sharePathFor(c.env, site);
  const tags = shareTags({
    title,
    description: description || "Made with Formelab.",
    url: origin + new URL(c.req.url).pathname,
    image: share.startsWith("https://") ? share : `${origin}/_platform/share.png?v=${encodeURIComponent(site.current_version)}`,
    imageAlt: `${title}, made with Formelab`,
    imageSize: share === "" ? { width: SHARE_W, height: SHARE_H } : share.startsWith("https://") ? undefined : await ownShareSize(c.env, site, share),
  });
  const icon = origin + (await iconUrl(c.env, site, (await iconPathFor(c.env, site)) ? "icon" : "letter"));
  return previewPage(title, description || "Made with Formelab.", tags, icon, `${aiOrigin(c.env, c.req.url)}/auth/app?return=${encodeURIComponent(c.req.url)}`);
}

/** The size of the app's own share image when it's a PNG (an SVG is drawn to fit, so its height isn't known up front). */
async function ownShareSize(env: Env, site: SiteRow, share: string): Promise<{ width: number; height: number } | undefined> {
  if (share.startsWith("data:image/svg") || extOf(share) === "svg") return undefined;
  if (share.startsWith("data:image/png;base64,")) {
    try {
      return pngSize(b64decode(share.slice(22, 22 + 64))) ?? undefined;
    } catch {
      return undefined;
    }
  }
  if (extOf(share) !== "png") return undefined;
  const obj = await env.BUCKET.get(`sites/${site.id}/${site.current_version}/${share}`, { range: { offset: 0, length: 33 } });
  return obj ? (pngSize(new Uint8Array(await obj.arrayBuffer())) ?? undefined) : undefined;
}

/** What a link preview fetcher gets for Formelab's own signed-in pages (the web app). */
export function formelabPreviewPage(c: Context<AppEnv>): Response {
  const icon = `${new URL(c.req.url).origin}/_assets/apple-touch-icon.png`;
  return previewPage("Formelab", FORMELAB_DESCRIPTION, formelabShareTags(c.env, c.req.url), icon, c.req.url);
}
