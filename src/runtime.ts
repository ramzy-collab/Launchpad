import { Hono } from "hono";
import { canManageSite, canViewSite } from "./auth";
import type { AppEnv } from "./env";
import { badRequest, err, forbidden, jsonError, notFound, onError } from "./errors";
import { kvDelete, kvGet, kvList, kvSet } from "./kv";
import { proxy, secretDelete, secretList, secretSet } from "./secrets";
import { getNamespace, getSiteByMount, validateMountPath } from "./sites";

/**
 * The per-app runtime API on `<ns>.DOMAIN/_api/*`. The parent sets c.var.user and
 * c.var.namespace. This router enforces the CSRF/origin rules and resolves the site
 * from Host + x-launchpad-mount, so an app can never address another namespace.
 */
export function runtimeApi() {
  const api = new Hono<AppEnv>();
  api.onError(onError);

  api.use("*", async (c, next) => {
    if (c.req.method === "OPTIONS") {
      // Never answer preflights permissively: no Access-Control-Allow-* headers.
      return jsonError(forbidden("Cross-origin requests are not allowed."));
    }
    const origin = c.req.header("origin");
    if (origin && origin !== new URL(c.req.url).origin) {
      return jsonError(forbidden("Cross-origin requests are not allowed."));
    }
    const mountHeader = c.req.header("x-launchpad-mount");
    if (!mountHeader) {
      return jsonError(badRequest("Missing x-launchpad-mount header.", "Call the API through the SDK: <script src=\"/_platform/sdk.js\"></script>."));
    }
    if (!/^\/([a-z0-9-]+(\/[a-z0-9-]+)*\/)?$/.test(mountHeader)) {
      return jsonError(badRequest("Malformed x-launchpad-mount header.", "Use the SDK; it sets this header for you."));
    }
    const ns = c.get("namespace");
    const site = await getSiteByMount(c.env, ns, validateMountPath(mountHeader));
    if (!site) return jsonError(notFound("App"));
    const nsRow = await getNamespace(c.env, ns);
    if (!nsRow || !canViewSite(c.get("user"), site, nsRow)) return jsonError(forbidden("You don't have access to this app."));
    c.set("site", site);
    await next();
    c.header("cache-control", "no-store");
  });

  api.get("/me", (c) => {
    const u = c.get("user");
    return c.json({ email: u.email, name: u.name });
  });

  // Keys may contain "/" (sent percent-encoded); take the raw remainder of the path.
  const keyFrom = (path: string) => {
    const raw = path.slice(path.indexOf("/_api/kv/") + "/_api/kv/".length);
    try {
      return decodeURIComponent(raw);
    } catch {
      throw badRequest("The key is not correctly URL-encoded.", "Use the SDK, which encodes keys for you.");
    }
  };

  api.get("/kv", async (c) => c.json(await kvList(c.env, c.get("site").id, c.req.query("prefix") ?? "")));
  api.get("/kv/*", async (c) => c.json(await kvGet(c.env, c.get("site").id, keyFrom(new URL(c.req.url).pathname))));
  api.put("/kv/*", async (c) => {
    const body = await c.req.text();
    if (body.length > 64 * 1024 * 4) throw err(413, "value_too_large", "Values can be at most 64 KB of JSON.", "Split the data across several keys.");
    return c.json(await kvSet(c.env, c.get("site").id, keyFrom(new URL(c.req.url).pathname), body));
  });
  api.delete("/kv/*", async (c) => c.json(await kvDelete(c.env, c.get("site").id, keyFrom(new URL(c.req.url).pathname))));

  const requireManage = async (c: { env: AppEnv["Bindings"]; get: <K extends keyof AppEnv["Variables"]>(k: K) => AppEnv["Variables"][K] }) => {
    const nsRow = await getNamespace(c.env, c.get("namespace"));
    if (!nsRow || !canManageSite(c.get("user"), c.get("site"), nsRow)) {
      throw forbidden("Only the app's owner or editors can manage its secrets.");
    }
  };

  api.get("/secrets", async (c) => c.json(await secretList(c.env, c.get("site").id)));
  api.put("/secrets/:name", async (c) => {
    await requireManage(c);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw badRequest("The body must be JSON like { \"value\": \"...\" }.", "Use launchpad.secrets.set(name, value).");
    }
    return c.json(await secretSet(c.env, c.get("site"), c.get("user"), c.req.param("name"), body));
  });
  api.delete("/secrets/:name", async (c) => {
    await requireManage(c);
    return c.json(await secretDelete(c.env, c.get("site"), c.get("user"), c.req.param("name")));
  });
  api.post("/secrets/:name/proxy", async (c) => {
    const len = Number(c.req.header("content-length") ?? 0);
    if (len > 2 * 1024 * 1024) throw err(413, "body_too_large", "The proxy request body is larger than 1 MB.", "Send less data.");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw badRequest("The body must be JSON like { \"url\": \"https://...\" }.", "Use launchpad.secrets.proxy(name, { url }).");
    }
    if (!body || typeof body !== "object") throw badRequest("The body must be a JSON object.", "Use launchpad.secrets.proxy(name, { url }).");
    return c.json(await proxy(c.env, c.get("site"), c.get("user"), c.req.param("name"), body as Record<string, unknown>));
  });

  api.notFound(() => jsonError(err(404, "not_found", "No such API endpoint.", "Check the SDK reference in /_platform/guide.md.")));
  return api;
}
