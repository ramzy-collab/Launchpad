import { Hono } from "hono";
import { managementApi } from "./api";
import { identifyBearer, identifyHuman } from "./auth";
import { dashboardPage } from "./dashboard/page";
import type { AppEnv, Env } from "./env";
import { forbidden, jsonError, onError, unauthorized } from "./errors";
import { DASHBOARD_CSS, DASHBOARD_JS, GUIDE_MD, SDK_JS } from "./generated/assets";
import { apexOrigin, AUTHORIZE_PATH, authorizeGet, authorizePost, oauthProvider } from "./oauth";
import { runtimeApi } from "./runtime";
import { plainPage, serveAppFile } from "./serve";

const text = (body: string, type: string, cache = "no-cache") =>
  new Response(body, {
    headers: { "content-type": type, "cache-control": cache, "x-content-type-options": "nosniff" },
  });

const guide = () => text(GUIDE_MD, "text/markdown; charset=utf-8");
const unauthorizedPage = () =>
  plainPage(401, "Sign-in required", "This page is protected by Cloudflare Access. Reload to sign in.");

// ---------------------------------------------------------------------------
// Apex: DOMAIN
// ---------------------------------------------------------------------------

const apex = new Hono<AppEnv>();
apex.onError(onError);

apex.get("/healthz", () => text("ok", "text/plain; charset=utf-8", "no-store"));

// Bearer-token paths (Access bypasses these; the Worker authenticates them itself).
apex.use("/_api/deploy/*", async (c, next) => {
  const user = await identifyBearer(c.req.raw, c.env);
  if (!user) return jsonError(unauthorized());
  c.set("user", user);
  await next();
});
apex.route("/_api/deploy", managementApi("deploy"));

// /mcp, /oauth/* and /.well-known/oauth-* are answered by the OAuth provider before this app
// (see the default export); it validates OAuth access tokens and fl_ deploy tokens for /mcp.

// Everything else on the apex requires a Cloudflare Access identity.
apex.use("*", async (c, next) => {
  const user = await identifyHuman(c.req.raw, c.env);
  if (!user) return c.req.path.startsWith("/_api/") ? jsonError(unauthorized()) : unauthorizedPage();
  c.set("user", user);
  await next();
});

// The admin API is cookie-authenticated (via Access), so block cross-site writes.
apex.use("/_api/admin/*", async (c, next) => {
  const origin = c.req.header("origin");
  if (origin && origin !== new URL(c.req.url).origin) return jsonError(forbidden("Cross-origin requests are not allowed."));
  if (c.req.method !== "GET" && c.req.method !== "HEAD" && c.req.header("x-formelab-request") !== "1") {
    return jsonError(forbidden("Missing x-formelab-request header."));
  }
  await next();
});
apex.route("/_api/admin", managementApi("admin"));

// OAuth consent for MCP clients such as Claude chat. Behind Access like the dashboard.
apex.get(AUTHORIZE_PATH, authorizeGet);
apex.post(AUTHORIZE_PATH, authorizePost);

apex.get("/_platform/guide.md", guide);
apex.get("/_platform/dashboard.js", () => text(DASHBOARD_JS, "text/javascript; charset=utf-8"));
apex.get("/_platform/dashboard.css", () => text(DASHBOARD_CSS, "text/css; charset=utf-8"));
apex.get("/", async (c) => dashboardPage(c));
apex.notFound(() => plainPage(404, "Not found", "There is nothing here."));

// ---------------------------------------------------------------------------
// Namespace hosts: <ns>.DOMAIN
// ---------------------------------------------------------------------------

const nsApp = new Hono<AppEnv>();
nsApp.onError(onError);

nsApp.get("/healthz", () => text("ok", "text/plain; charset=utf-8", "no-store"));

nsApp.use("*", async (c, next) => {
  c.set("namespace", namespaceOf(new URL(c.req.url).hostname, c.env)!);
  const user = await identifyHuman(c.req.raw, c.env);
  if (!user) return c.req.path.startsWith("/_api/") ? jsonError(unauthorized()) : unauthorizedPage();
  c.set("user", user);
  await next();
});

nsApp.get("/_platform/sdk.js", () => text(SDK_JS, "text/javascript; charset=utf-8", "public, max-age=300"));
nsApp.get("/_platform/guide.md", guide);
nsApp.all("/_platform/*", () => plainPage(404, "Not found", "There is nothing here."));
nsApp.route("/_api", runtimeApi());
nsApp.all("/_api", () => jsonError(forbidden("Not an API endpoint.")));
nsApp.all("*", (c) => serveAppFile(c.req.raw, c.env, c.get("namespace"), c.get("user")));

// ---------------------------------------------------------------------------
// Host dispatch
// ---------------------------------------------------------------------------

const NS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** "<ns>.DOMAIN" -> "<ns>"; null for the apex, deeper subdomains, or other hosts. */
function namespaceOf(hostname: string, env: Env): string | null {
  const host = hostname.toLowerCase();
  const domain = env.DOMAIN.toLowerCase();
  if (!host.endsWith("." + domain)) return null;
  const label = host.slice(0, -(domain.length + 1));
  return NS_LABEL.test(label) ? label : null;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const host = new URL(req.url).hostname.toLowerCase();
    if (host === env.DOMAIN.toLowerCase()) {
      return oauthProvider(apexOrigin(env, req.url), apex as never).fetch(req, env, ctx);
    }
    if (namespaceOf(host, env)) return nsApp.fetch(req, env, ctx);
    return plainPage(404, "Not found", "Unknown host.");
  },
} satisfies ExportedHandler<Env>;
