// Installing Formelab, and every app on it, on a phone or computer (Progressive Web Apps).
//
// The web app (app.DOMAIN) has a manifest, icons and a service worker, so browsers offer to
// install it: Add to Home Screen on phones, Install in Chrome and Edge, Add to Dock in Safari.
// It then opens in its own window with its own icon.
//
// Published apps get the same without their makers doing anything: each app's HTML gets a
// <link rel="manifest"> pointing at a manifest Formelab writes for it (its title, its icon, and its
// own host as the app's scope), unless the app ships its own. The manifest needs the visitor's
// sign-in like the app itself (crossorigin="use-credentials"); the icon URLs in it are signed
// instead, because browsers don't always send cookies when they fetch icons to install them.
import type { Context } from "hono";
import type { AppEnv, Env } from "./env";
import { appsLabelOf } from "./hosts";
import { ICON_192_PNG, ICON_512_PNG, MASKABLE_512_PNG, APPLE_TOUCH_ICON_PNG, SW_JS } from "./generated/assets";
import { iconPathFor, iconResponse, letterIcon, pngSize } from "./icons";
import { extOf } from "./mime";
import { getSiteById, type SiteRow } from "./sites";
import { b64decode, escapeHtml } from "./util";

const CANVAS = "#FBFAF7";
const CANVAS_DARK = "#161514";

const NO_SNIFF = { "x-content-type-options": "nosniff" };
const manifestResponse = (body: unknown, cache: string) =>
  new Response(JSON.stringify(body), { headers: { ...NO_SNIFF, "content-type": "application/manifest+json", "cache-control": cache } });

// ---------------------------------------------------------------------------
// Formelab itself
// ---------------------------------------------------------------------------

/** The tags web app pages add to <head> so Formelab can be installed. */
export const PWA_HEAD = `<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/_assets/apple-touch-icon.png">
<meta name="theme-color" content="${CANVAS}" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="${CANVAS_DARK}" media="(prefers-color-scheme: dark)">
<meta name="apple-mobile-web-app-title" content="Formelab">`;

/** GET /manifest.webmanifest on the web app host (public: browsers fetch it without cookies). */
export function formelabManifest(): Response {
  return manifestResponse(
    {
      id: "/",
      name: "Formelab",
      short_name: "Formelab",
      description: "Your apps, made with AI and live on Formelab.",
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: CANVAS,
      theme_color: CANVAS,
      icons: [
        { src: "/_assets/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
        { src: "/_assets/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
        { src: "/_assets/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      ],
      shortcuts: [
        { name: "New app", url: "/new" },
        { name: "My apps", url: "/" },
        { name: "Shared with me", url: "/shared" },
      ],
    },
    "public, max-age=3600",
  );
}

const png = (b64: string) => {
  const bytes = b64decode(b64);
  return () => new Response(bytes, { headers: { ...NO_SNIFF, "content-type": "image/png", "cache-control": "public, max-age=86400" } });
};

/** The service worker and icons, served without sign-in. */
export const pwaRoutes: [string, () => Response][] = [
  ["/manifest.webmanifest", formelabManifest],
  [
    "/sw.js",
    () => new Response(SW_JS, { headers: { ...NO_SNIFF, "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" } }),
  ],
  ["/_assets/icon-192.png", png(ICON_192_PNG)],
  ["/_assets/icon-512.png", png(ICON_512_PNG)],
  ["/_assets/maskable-512.png", png(MASKABLE_512_PNG)],
  ["/_assets/apple-touch-icon.png", png(APPLE_TOUCH_ICON_PNG)],
];

// ---------------------------------------------------------------------------
// Published apps
// ---------------------------------------------------------------------------

type IconSite = SiteRow & { icon_path?: string | null };
type IconKind = "icon" | "letter";

async function sign(env: Env, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.SECRETS_KEK), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`pwa-icon:${message}`)));
  return [...mac.subarray(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A signed address for an app's icon (or its letter tile) on the app's own host, for this version. */
async function iconUrl(env: Env, site: SiteRow, kind: IconKind): Promise<string> {
  const sig = await sign(env, `${site.id}:${site.current_version}:${kind}`);
  return `/_platform/app-icon/${encodeURIComponent(site.id)}/${site.current_version}/${kind}/${sig}`;
}

/** GET /_platform/app-icon/:id/:version/:kind/:sig on an app's host. Public, but only with a valid signature. */
export async function appPwaIcon(c: Context<AppEnv>): Promise<Response> {
  const { id = "", version = "", kind = "", sig = "" } = c.req.param() as Record<string, string | undefined>;
  const notFound = () => new Response("Not found", { status: 404, headers: { ...NO_SNIFF, "content-type": "text/plain; charset=utf-8" } });
  if (kind !== "icon" && kind !== "letter") return notFound();
  if (sig !== (await sign(c.env, `${id}:${version}:${kind}`))) return notFound();
  const site = (await getSiteById(c.env, id)) as IconSite | null;
  if (!site || site.host_label !== appsLabelOf(new URL(c.req.url).hostname, c.env) || String(site.current_version) !== version) return notFound();
  const res =
    kind === "letter"
      ? new Response(letterIcon(site), { headers: { "content-type": "image/svg+xml" } })
      : await iconResponse(c.env, site);
  const headers = new Headers(res.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-security-policy", "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox");
  headers.set("cache-control", "public, max-age=86400");
  return new Response(res.body, { headers });
}

const appTitle = (site: SiteRow) => site.title || site.mount_path.split("/").pop() || site.namespace;

/** The icons for an app's manifest: its own when it's an SVG or a PNG of at least 144px, else its letter tile. */
async function manifestIcons(env: Env, site: IconSite) {
  const res = await iconResponse(env, site);
  const type = (res.headers.get("content-type") ?? "").split(";")[0]!;
  const bytes = new Uint8Array(await res.arrayBuffer());
  const own = (await iconPathFor(env, site)) !== "";
  if (own && type === "image/svg+xml") return [{ src: await iconUrl(env, site, "icon"), sizes: "any", type, purpose: "any" }];
  const size = type === "image/png" ? pngSize(bytes) : null;
  if (own && size && Math.min(size.width, size.height) >= 144) {
    return [{ src: await iconUrl(env, site, "icon"), sizes: `${size.width}x${size.height}`, type, purpose: "any" }];
  }
  return [{ src: await iconUrl(env, site, "letter"), sizes: "any", type: "image/svg+xml", purpose: "any" }];
}

/** GET /_platform/manifest.webmanifest on an app's host, for people who can open the app (checked before this runs). */
export async function appManifest(c: Context<AppEnv>): Promise<Response> {
  const site = c.get("site") as IconSite;
  const scope = "/";
  const name = appTitle(site);
  return manifestResponse(
    {
      id: scope,
      name,
      short_name: name,
      start_url: scope,
      scope,
      display: "standalone",
      background_color: "#FFFFFF",
      icons: await manifestIcons(c.env, site),
    },
    "private, no-cache",
  );
}

/**
 * The tags added to an app's HTML pages so it can be installed: a manifest link and, for
 * iPhones and iPads (which only use PNG home screen icons), an apple-touch-icon. Nothing is
 * added that the app already has.
 */
export async function appPwaTags(env: Env, site: IconSite, html: string): Promise<string> {
  const head = html.slice(0, 64 * 1024);
  const links = head.match(/<link\b[^>]*>/gi) ?? [];
  const has = (rel: RegExp) => links.some((tag) => rel.test(/\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag)?.slice(1).find((x) => x !== undefined) ?? ""));
  let tags = "";
  if (!has(/\bmanifest\b/i)) {
    tags += `<link rel="manifest" href="/_platform/manifest.webmanifest" crossorigin="use-credentials">`;
  }
  if (!has(/\bapple-touch-icon\b/i)) {
    const icon = await iconPathFor(env, site);
    if (icon.startsWith("data:image/png") || (icon && !icon.startsWith("data:") && extOf(icon) === "png")) {
      tags += `<link rel="apple-touch-icon" href="${escapeHtml(await iconUrl(env, site, "icon"))}">`;
    }
  }
  if (tags && !/<meta\b[^>]*name\s*=\s*["']?apple-mobile-web-app-title/i.test(head)) {
    tags += `<meta name="apple-mobile-web-app-title" content="${escapeHtml(appTitle(site))}">`;
  }
  return tags;
}
