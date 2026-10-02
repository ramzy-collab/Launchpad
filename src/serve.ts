import { canViewSite } from "./auth";
import type { Env, User } from "./env";
import { extOf, contentTypeFor, isHtmlPath } from "./mime";
import { getNamespace, resolveSiteForPath, type SiteRow } from "./sites";
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

/** Inserts <base href="/<mount>/"> as the first child of <head> (or synthesizes one). */
async function injectBase(res: Response, baseHref: string): Promise<Response> {
  const tag = `<base href="${escapeHtml(baseHref)}">`;
  const text = await res.text();
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

/**
 * Serves an app file for `<ns>.DOMAIN`. Identity has already been established;
 * this does mount resolution, the visibility check, and file lookup.
 */
export async function serveAppFile(req: Request, env: Env, ns: string, user: User): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { ...BASE_HEADERS, allow: "GET, HEAD" } });
  }
  const url = new URL(req.url);
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return plainPage(400, "Bad request", "The address is not valid.");
  }
  if (path.includes("\0") || path.split("/").includes("..")) return plainPage(400, "Bad request", "The address is not valid.");

  const site = await resolveSiteForPath(env, ns, path);
  if (!site) return plainPage(404, "Not found", "There is no app at this address.");
  const nsRow = await getNamespace(env, ns);
  if (!nsRow || !canViewSite(user, site, nsRow)) {
    return plainPage(403, "Access denied", "You don't have access to this app. Ask its owner to add your email to the allow-list.");
  }

  const mountPrefix = site.mount_path ? `/${site.mount_path}/` : "/";
  if (site.mount_path && path === `/${site.mount_path}`) {
    return new Response(null, { status: 301, headers: { ...BASE_HEADERS, location: mountPrefix + url.search } });
  }
  const rel = path.slice(mountPrefix.length);
  return serveFromSite(req, env, site, rel, mountPrefix);
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
      headers.set("cache-control", "public, max-age=300");
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
    return html ? injectBase(res, baseHref) : res;
  }
  return plainPage(404, "Not found", "This app has no file at this address.");
}
