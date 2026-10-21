import type { Env, User } from "./env";
import { extOf, contentTypeFor, isHtmlPath } from "./mime";
import { resolveSiteForPath, siteUrl, type SiteRow } from "./sites";
import { appPwaTags } from "./pwa";
import { escapeHtml } from "./util";

const BASE_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};

export function plainPage(status: number, title: string, message: string): Response {
  const body = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head><body style="font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#222"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`;
  return new Response(body, {
    status,
    headers: { ...BASE_HEADERS, "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * Inserts <base href="/"> as the first child of <head> (or synthesizes one), followed by
 * the tags that let the app be installed on a device (see pwa.ts).
 */
async function injectHead(res: Response, env: Env, site: SiteRow, baseHref: string): Promise<Response> {
  const text = await res.text();
  const tag = `<base href="${escapeHtml(baseHref)}">` + (await appPwaTags(env, site, text));
  if (/<head[\s>]/i.test(text)) {
    return new HTMLRewriter()
      .on("head", {
        element(el) {
          el.prepend(tag, { html: true });
        },
      })
      .transform(new Response(text, res));
  }
  // No <head>: put one right after <html ...> or the doctype, or at the very start.
  const m = /<html[^>]*>/i.exec(text) ?? /<!doctype[^>]*>/i.exec(text);
  const at = m ? m.index + m[0].length : 0;
  return new Response(text.slice(0, at) + `<head>${tag}</head>` + text.slice(at), res);
}

function candidatesFor(rel: string, spa: boolean): string[] {
  if (rel === "" || rel.endsWith("/")) return [rel + "index.html"];
  if (extOf(rel)) return [rel];
  const c = [`${rel}/index.html`, `${rel}.html`, rel];
  if (spa) c.push("index.html");
  return c;
}

/** The page for someone who signed in but may not open the app. */
export function noAccessPage(site: SiteRow, user: User): Response {
  if (site.visibility === "all" && !user.active) {
    return plainPage(403, "Not yet", "This app is open to Formelab members, and your account is still on the waitlist. You'll be able to open it once you're let in, or if its owner shares it with you.");
  }
  return plainPage(403, "Access denied", "You don't have access to this app. Ask its owner to add your email to the allow-list.");
}

/**
 * Serves a file of the app on its own host (<host_label>.APP_DOMAIN). Identity and the
 * visibility check have already happened; this does the file lookup.
 */
export async function serveAppFile(req: Request, env: Env, site: SiteRow): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { ...BASE_HEADERS, allow: "GET, HEAD" } });
  }
  let path: string;
  try {
    path = decodeURIComponent(new URL(req.url).pathname);
  } catch {
    return plainPage(400, "Bad request", "The address is not valid.");
  }
  if (path.includes("\0") || path.split("/").includes("..")) return plainPage(400, "Bad request", "The address is not valid.");
  return serveFromSite(req, env, site, path.slice(1), "/");
}

/**
 * Old app addresses, <ns>.APP_DOMAIN/<mount>/<rest> (and <ns>.DOMAIN/...): a permanent redirect to
 * the app's own host, keeping <rest> and the query. Nothing is served here any more.
 */
export async function legacyAppRedirect(req: Request, env: Env, ns: string): Promise<Response> {
  const url = new URL(req.url);
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return plainPage(400, "Bad request", "The address is not valid.");
  }
  if (path === "/healthz") return new Response("ok", { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  if (/^\/_(api|platform|auth)(\/|$)/.test(path)) return plainPage(404, "Not found", "Apps have moved to their own addresses. Open the app again from Formelab.");
  const site = await resolveSiteForPath(env, ns, path);
  if (!site) return plainPage(404, "Not found", "There is no app at this address.");
  const rest = site.mount_path ? path.slice(site.mount_path.length + 1) || "/" : path;
  const encoded = rest.split("/").map(encodeURIComponent).join("/");
  return new Response(null, {
    status: 301,
    headers: { ...BASE_HEADERS, "cache-control": "public, max-age=3600", location: siteUrl(env, site, req.url).slice(0, -1) + encoded + url.search },
  });
}

async function serveFromSite(req: Request, env: Env, site: SiteRow, rel: string, baseHref: string): Promise<Response> {
  const prefix = `sites/${site.id}/${site.current_version}/`;
  for (const candidate of candidatesFor(rel, !!site.spa)) {
    const obj = await env.BUCKET.get(prefix + candidate, {
      onlyIf: isHtmlPath(candidate) ? undefined : req.headers,
    });
    if (!obj) continue;
    const html = isHtmlPath(candidate);
    const headers = new Headers(BASE_HEADERS);
    headers.set("content-type", contentTypeFor(candidate));
    if (html) {
      headers.set("cache-control", "no-cache");
    } else {
      // Shared caches may keep files of apps anyone can open; a restricted app's stay in the browser (audit A11).
      headers.set("cache-control", `${site.visibility === "all" || site.public_link ? "public" : "private"}, max-age=300`);
      headers.set("etag", obj.httpEtag);
    }
    if (!("body" in obj) || !obj.body) {
      // Conditional request matched (If-None-Match): not modified.
      return new Response(null, { status: 304, headers });
    }
    if (req.method === "HEAD") {
      headers.set("content-length", String(obj.size));
      return new Response(null, { status: 200, headers });
    }
    const res = new Response(obj.body, { status: 200, headers });
    return html ? injectHead(res, env, site, baseHref) : res;
  }
  return plainPage(404, "Not found", "This app has no file at this address.");
}
