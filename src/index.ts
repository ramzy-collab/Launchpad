import { Hono } from "hono";
import { managementApi } from "./api";
import { identifyBearer, identifyBrowser } from "./auth";
import { connectPage } from "./dashboard/connect";
import { dashboardPage, sharedPage } from "./dashboard/page";
import { homePage, loginPage } from "./dashboard/home";
import type { AppEnv, Env } from "./env";
import { forbidden, jsonError, onError, unauthorized } from "./errors";
import { CONSENT_JS, DASHBOARD_JS, FORMELAB_CSS, GUIDE_MD, HOME_CSS, SDK_JS, SITE_JS, THEME_JS } from "./generated/assets";
import { apexOrigin, AUTHORIZE_PATH, authorizeGet, authorizePost, oauthProvider } from "./oauth";
import { runtimeApi } from "./runtime";
import { appCallback, appHandoff, loginCallback, loginStart, logout, safeReturn, workosEnabled } from "./login";
import { plainPage, serveAppFile } from "./serve";
import { readCookie, SESSION_COOKIE } from "./session";
import { joinWaitlist } from "./waitlist";

const text = (body: string, type: string, cache = "no-cache") =>
  new Response(body, {
    headers: { "content-type": type, "cache-control": cache, "x-content-type-options": "nosniff" },
  });

const guide = () => text(GUIDE_MD, "text/markdown; charset=utf-8");
const unauthorizedPage = () => plainPage(401, "Sign-in required", "Log in to Formelab, then reload this page.");

/** Whether the request carries any sign-in at all (a session cookie or an Access JWT). */
const hasSignIn = (req: Request) => !!(readCookie(req, SESSION_COOKIE) || req.headers.get("cf-access-jwt-assertion"));

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

// Public pages: the home page with the waitlist, the login screen, the sign-in flow, and the
// files they load. Someone already signed in goes straight to their dashboard.
apex.get("/", async (c) => {
  if (hasSignIn(c.req.raw) && (await identifyBrowser(c.req.raw, c.env))) return c.redirect("/app", 302);
  return homePage();
});
apex.get("/login", async (c) => {
  const returnTo = safeReturn(c.req.query("return"));
  if (hasSignIn(c.req.raw) && (await identifyBrowser(c.req.raw, c.env))) return c.redirect(returnTo, 302);
  return loginPage({ workos: workosEnabled(c.env), returnTo });
});
apex.get("/auth/login", loginStart);
apex.get("/auth/callback", loginCallback);
apex.post("/_api/waitlist", async (c) => {
  await joinWaitlist(c.req.raw, c.env, (p) => c.executionCtx.waitUntil(p));
  return c.json({ ok: true });
});
const asset = (body: string, type: string) => () => text(body, type, "public, max-age=300");
apex.get("/_assets/formelab.css", asset(FORMELAB_CSS, "text/css; charset=utf-8"));
apex.get("/_assets/home.css", asset(HOME_CSS, "text/css; charset=utf-8"));
apex.get("/_assets/theme.js", asset(THEME_JS, "text/javascript; charset=utf-8"));
apex.get("/_assets/site.js", asset(SITE_JS, "text/javascript; charset=utf-8"));
apex.get("/_assets/dashboard.js", asset(DASHBOARD_JS, "text/javascript; charset=utf-8"));
apex.get("/_assets/consent.js", asset(CONSENT_JS, "text/javascript; charset=utf-8"));

// Everything else on the apex requires a sign-in: a Formelab session, or a Cloudflare Access
// identity. Pages send visitors without one to the login screen, then back.
apex.use("*", async (c, next) => {
  const who = await identifyBrowser(c.req.raw, c.env);
  if (!who) {
    if (c.req.path.startsWith("/_api/")) return jsonError(unauthorized());
    const url = new URL(c.req.url);
    const isAppPage = c.req.path === "/app" || c.req.path.startsWith("/app/");
    const toLogin = c.req.method === "GET" && (workosEnabled(c.env) || isAppPage);
    return toLogin ? c.redirect(`/login?return=${encodeURIComponent(url.pathname + url.search)}`, 302) : unauthorizedPage();
  }
  c.set("user", who.user);
  c.set("sessionId", who.sessionId);
  await next();
});

apex.post("/auth/logout", logout);
apex.get("/auth/app", (c) => appHandoff(c, (host) => namespaceOf(host, c.env)));

// The admin API is cookie-authenticated, so block cross-site writes.
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
apex.get("/app", async (c) => dashboardPage(c));
apex.get("/app/shared", async (c) => sharedPage(c));
apex.get("/app/connect", (c) => connectPage(c));
apex.notFound(() => plainPage(404, "Not found", "There is nothing here."));

// ---------------------------------------------------------------------------
// Namespace hosts: <ns>.DOMAIN
// ---------------------------------------------------------------------------

const nsApp = new Hono<AppEnv>();
nsApp.onError(onError);

nsApp.get("/healthz", () => text("ok", "text/plain; charset=utf-8", "no-store"));

// Namespace hosts get their own session from the apex (see login.ts).
nsApp.get("/_auth/callback", appCallback);

nsApp.use("*", async (c, next) => {
  c.set("namespace", namespaceOf(new URL(c.req.url).hostname, c.env)!);
  const who = await identifyBrowser(c.req.raw, c.env);
  if (!who) {
    if (c.req.path.startsWith("/_api/")) return jsonError(unauthorized());
    if (c.req.method === "GET" && workosEnabled(c.env)) {
      return c.redirect(`${apexOrigin(c.env, c.req.url)}/auth/app?return=${encodeURIComponent(c.req.url)}`, 302);
    }
    return unauthorizedPage();
  }
  c.set("user", who.user);
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
