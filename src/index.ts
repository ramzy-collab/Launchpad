import { Hono, type Context, type MiddlewareHandler } from "hono";
import { ctxOf, managementApi } from "./api";
import { identifyBearer, identifyBrowser } from "./auth";
import { adminPage, testPlanPage } from "./dashboard/admin";
import { ANSWERS_PATH, answersRoute, showAnswersLink } from "./answers";
import { connectPage } from "./dashboard/connect";
import { SERVICES_SPRITE } from "./dashboard/services";
import { appIcon } from "./icons";
import { sheetsCallback, sheetsConnect } from "./sheets";
import { connectedPage, connectorPage } from "./dashboard/connected";
import { enabledFlags, withFlags } from "./flags";
import { accountPage, appActivityPage, appResponsesCsv, appSettingsPage, dashboardPage, installPage, keysPage, newAppPage, spacesPage } from "./dashboard/page";
import { homePage } from "./dashboard/home";
import { forgotGet, forgotPost, resetGet, resetPost, signInCode, signInGet, signInPost } from "./signin";
import type { AppEnv, Env } from "./env";
import { forbidden, jsonError, onError, unauthorized } from "./errors";
import { ASSET_VERSION, CONSENT_JS, DASHBOARD_JS, FORMELAB_CSS, GUIDE_MD, HOME_CSS, INSTALL_JS, VIZ_JS, SDK_JS, SIGNIN_JS, SITE_JS, THEME_JS } from "./generated/assets";
import { apexOrigin, AUTHORIZE_PATH, authorizeGet, authorizePost, oauthProvider } from "./oauth";
import { runtimeApi } from "./runtime";
import { appCallback, appHandoff, handoffStart, loginCallback, loginStart, logout, safeReturn, workosEnabled } from "./login";
import { legacyAppRedirect, noAccessPage, plainPage, serveAppFile } from "./serve";
import { cookieHeader, readCookie, SESSION_COOKIE } from "./session";
import { adminOrigin, aiOrigin, appOrigin, appsLabelOf, hostKind, legacyNamespaceOf } from "./hosts";
import { canManageSite, canViewSite } from "./auth";
import { getNamespace, getSiteByHostLabel, isPublicLinkToken, PUBLIC_LINK_PATH, type SiteRow } from "./sites";
import { joinWaitlist } from "./waitlist";
import { GUEST, isPageView, recordAppVisit } from "./usage";
import { appManifest, appPwaIcon, pwaRoutes } from "./pwa";
import { appPreviewPage, appShareImage, formelabPreviewPage, formelabShareImage, formelabShareTags, isPreviewBot } from "./share";

const text = (body: string, type: string, cache = "no-cache") =>
  new Response(body, {
    headers: { "content-type": type, "cache-control": cache, "x-content-type-options": "nosniff" },
  });

/** The build guide, without the sections on features this person doesn't have yet. */
const guide = async (c: Context<AppEnv>) => text(withFlags(GUIDE_MD, await enabledFlags(c.env, c.get("user") ?? null)), "text/markdown; charset=utf-8");
const unauthorizedPage = () => plainPage(401, "Sign-in required", "Log in to Formelab, then reload this page.");

/** Whether the request carries any sign-in at all (a session cookie or an Access JWT). */
/**
 * Pages link assets with ?v=<hash of this build's assets>. A request for another build's version
 * (during a deploy, a new page can reach an old copy of the Worker) is answered but not cached, so
 * the browser doesn't keep a stale stylesheet under the new address.
 */
const asset = (body: string, type: string) => (c: Context<AppEnv>) =>
  text(body, type, c.req.query("v") === ASSET_VERSION ? "public, max-age=300" : "no-store");
const assetRoutes: [string, (c: Context<AppEnv>) => Response][] = [
  ["/_assets/formelab.css", asset(FORMELAB_CSS, "text/css; charset=utf-8")],
  ["/_assets/home.css", asset(HOME_CSS, "text/css; charset=utf-8")],
  ["/_assets/theme.js", asset(THEME_JS, "text/javascript; charset=utf-8")],
  ["/_assets/site.js", asset(SITE_JS, "text/javascript; charset=utf-8")],
  ["/_assets/signin.js", asset(SIGNIN_JS, "text/javascript; charset=utf-8")],
  ["/_assets/dashboard.js", asset(DASHBOARD_JS, "text/javascript; charset=utf-8")],
  ["/_assets/viz.js", asset(VIZ_JS, "text/javascript; charset=utf-8")],
  ["/_assets/consent.js", asset(CONSENT_JS, "text/javascript; charset=utf-8")],
  ["/_assets/install.js", asset(INSTALL_JS, "text/javascript; charset=utf-8")],
  ["/_assets/services.svg", asset(SERVICES_SPRITE, "image/svg+xml")],
];

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
  if (hasSignIn(c.req.raw) && (await identifyBrowser(c.req.raw, c.env))) return c.redirect(`${appOrigin(c.env, c.req.url)}/`, 302);
  return homePage(formelabShareTags(c.env, c.req.url, "Formelab: SaaS is dead"));
});
// Formelab's own sign-in page (see signin.ts); Google and stray WorkOS sign-ins use /auth/*.
apex.get("/login", signInGet);
apex.post("/login", signInPost);
apex.post("/login/code", signInCode);
apex.get("/login/forgot", forgotGet);
apex.post("/login/forgot", forgotPost);
apex.get("/reset-password", resetGet);
apex.post("/reset-password", resetPost);
apex.get("/auth/login", loginStart);
apex.get("/auth/callback", loginCallback);
apex.post("/_api/waitlist", async (c) => {
  await joinWaitlist(c.req.raw, c.env, (p) => c.executionCtx.waitUntil(p));
  return c.json({ ok: true });
});
for (const [path, handler] of assetRoutes) apex.get(path, handler);
apex.get("/_assets/share.png", formelabShareImage);

// Old dashboard and admin addresses on DOMAIN move to their own hosts.
const moved = (origin: typeof appOrigin, prefix: string) => (c: Context<AppEnv>) => {
  const url = new URL(c.req.url);
  return c.redirect(`${origin(c.env, c.req.url)}${url.pathname.slice(prefix.length) || "/"}${url.search}`, 301);
};
apex.get("/app", moved(appOrigin, "/app"));
apex.get("/app/*", moved(appOrigin, "/app"));
apex.get("/admin", moved(adminOrigin, "/admin"));
apex.get("/admin/*", moved(adminOrigin, "/admin"));

// Everything else on DOMAIN requires a sign-in: a Formelab session, or a Cloudflare Access
// identity. Pages send visitors without one to the login screen, then back.
apex.use("*", async (c, next) => {
  const who = await identifyBrowser(c.req.raw, c.env);
  if (!who) {
    if (c.req.path.startsWith("/_api/")) return jsonError(unauthorized());
    const url = new URL(c.req.url);
    const toLogin = c.req.method === "GET" && (workosEnabled(c.env) || c.req.path === "/auth/app");
    return toLogin ? c.redirect(`/login?return=${encodeURIComponent(url.pathname + url.search)}`, 302) : unauthorizedPage();
  }
  c.set("user", who.user);
  c.set("sessionId", who.sessionId);
  await next();
});

apex.post("/auth/logout", logout);
apex.get("/auth/app", appHandoff);

// OAuth consent for MCP clients such as Claude chat.
apex.get(AUTHORIZE_PATH, authorizeGet);
apex.post(AUTHORIZE_PATH, authorizePost);

apex.get("/_platform/guide.md", guide);
apex.notFound(() => plainPage(404, "Not found", "There is nothing here."));

// ---------------------------------------------------------------------------
// Signed-in hosts: the web app (app.DOMAIN) and the admin panel (admin.DOMAIN)
// ---------------------------------------------------------------------------

/** The web app: pages without a sign-in go to DOMAIN, which signs the visitor in and hands the session back. */
const requireSignIn: MiddlewareHandler<AppEnv> = async (c, next) => {
  const who = await identifyBrowser(c.req.raw, c.env);
  if (!who) {
    if (c.req.path.startsWith("/_api/")) return jsonError(unauthorized());
    // Link previews (iMessage, Slack, ...) get Formelab's card instead of the sign-in redirect.
    if ((c.req.method === "GET" || c.req.method === "HEAD") && isPreviewBot(c.req.raw)) return formelabPreviewPage(c);
    if (c.req.method !== "GET") return unauthorizedPage();
    return handoffStart(c, c.req.url);
  }
  c.set("user", who.user);
  c.set("sessionId", who.sessionId);
  await next();
};

/** The admin panel signs people in itself (see login.ts), separately from the web app. */
const requireAdminSignIn: MiddlewareHandler<AppEnv> = async (c, next) => {
  const who = await identifyBrowser(c.req.raw, c.env);
  if (!who) {
    if (c.req.path.startsWith("/_api/")) return jsonError(unauthorized());
    if (c.req.method !== "GET" || !workosEnabled(c.env)) return unauthorizedPage();
    const url = new URL(c.req.url);
    return c.redirect(`/login?return=${encodeURIComponent(url.pathname + url.search)}`, 302);
  }
  c.set("user", who.user);
  c.set("sessionId", who.sessionId);
  await next();
};

/** The management API is cookie-authenticated here, so block cross-site writes. */
const sameOriginWrites: MiddlewareHandler<AppEnv> = async (c, next) => {
  const origin = c.req.header("origin");
  if (origin && origin !== new URL(c.req.url).origin) return jsonError(forbidden("Cross-origin requests are not allowed."));
  if (c.req.method !== "GET" && c.req.method !== "HEAD" && c.req.header("x-formelab-request") !== "1") {
    return jsonError(forbidden("Missing x-formelab-request header."));
  }
  await next();
};

/** The web app and admin panel share these; `requireSignIn` decides how each signs people in. */
function signedInHost(requireSignIn: MiddlewareHandler<AppEnv>, routes: (app: Hono<AppEnv>) => void) {
  const app = new Hono<AppEnv>();
  app.onError(onError);
  app.get("/healthz", () => text("ok", "text/plain; charset=utf-8", "no-store"));
  for (const [path, handler] of assetRoutes) app.get(path, handler);
  routes(app);
  app.use("*", requireSignIn);
  app.use("*", async (c, next) => {
    c.set("features", await enabledFlags(c.env, c.get("user")));
    await next();
  });
  app.post("/auth/logout", logout);
  app.use("/_api/admin/*", sameOriginWrites);
  app.route("/_api/admin", managementApi("admin"));
  app.get("/_platform/guide.md", guide);
  return app;
}

// The web app: My apps, New app, Spaces, Connect your AI, Connected apps, Access keys.
// Its manifest, icons and service worker (pwa.ts) are public, since browsers fetch them without cookies.
const webApp = signedInHost(requireSignIn, (app) => {
  app.get("/_auth/callback", appCallback);
  for (const [path, handler] of pwaRoutes) app.get(path, handler);
  app.get("/_assets/share.png", formelabShareImage);
});
webApp.get("/", async (c) => dashboardPage(c));
// Shared with me is part of My apps now: old links (emails, bookmarks, home screen shortcuts) open it filtered.
webApp.get("/shared", (c) => c.redirect("/?owner=others", 301));
webApp.get("/new", (c) => newAppPage(c));
webApp.get("/spaces", (c) => spacesPage(c));
webApp.get("/connect", (c) => connectPage(c));
webApp.get("/connected", (c) => connectedPage(c));
webApp.get("/connected/:name", (c) => connectorPage(c));
// Google Sheets sign-in (connected apps; behind the connected_apps flag).
webApp.use("/services/*", async (c, next) => {
  if (!c.get("features").has("connected_apps")) return plainPage(404, "Not found", "There is nothing here.");
  await next();
});
webApp.get("/services/google-sheets/connect", sheetsConnect);
webApp.get("/services/google-sheets/callback", sheetsCallback);
webApp.get("/keys", (c) => keysPage(c));
webApp.get("/account", (c) => accountPage(c));
webApp.get("/install", (c) => installPage(c));
webApp.get("/apps/:id", (c) => appSettingsPage(c, c.req.param("id")));
webApp.get("/apps/:id/icon", (c) => appIcon(ctxOf(c), c.req.param("id")));
webApp.get("/apps/:id/activity", (c) => appActivityPage(c, c.req.param("id")));
webApp.get("/apps/:id/responses.csv", (c) => appResponsesCsv(c, c.req.param("id")));
webApp.notFound(() => plainPage(404, "Not found", "There is nothing here."));

// The admin panel (admins only; adminPage answers 404 to everyone else).
const adminApp = signedInHost(requireAdminSignIn, (app) => {
  app.get("/login", signInGet);
  app.post("/login", signInPost);
  app.post("/login/code", signInCode);
  app.get("/login/forgot", forgotGet);
  app.post("/login/forgot", forgotPost);
  app.get("/reset-password", resetGet);
  app.post("/reset-password", resetPost);
  app.get("/auth/login", loginStart);
  app.get("/auth/callback", loginCallback);
});
adminApp.get("/", (c) => adminPage(c, "overview"));
adminApp.get("/metrics", (c) => adminPage(c, "metrics"));
adminApp.get("/users", (c) => adminPage(c, "users"));
adminApp.get("/waitlist", (c) => adminPage(c, "waitlist"));
adminApp.get("/activity", (c) => adminPage(c, "activity"));
adminApp.get("/features", (c) => adminPage(c, "features"));
adminApp.get("/changelog", (c) => adminPage(c, "changelog"));
adminApp.get("/vendors", (c) => adminPage(c, "vendors"));
adminApp.get("/test-plans", (c) => adminPage(c, "testplans"));
adminApp.get("/test-plans/:slug", (c) => testPlanPage(c, c.req.param("slug")));
adminApp.notFound(() => plainPage(404, "Not found", "There is nothing here."));
// ---------------------------------------------------------------------------
// App hosts: <host_label>.APP_DOMAIN, one published app each
// ---------------------------------------------------------------------------

/** The app each app-host request is for, found by appsHost before siteApp runs. */
const siteOf = new WeakMap<Request, SiteRow>();

const siteApp = new Hono<AppEnv>();
siteApp.onError(onError);
siteApp.use("*", async (c, next) => {
  c.set("site", siteOf.get(c.req.raw)!);
  await next();
});

siteApp.get("/healthz", () => text("ok", "text/plain; charset=utf-8", "no-store"));

// Each app host gets its own session from the apex (see login.ts).
siteApp.get("/_auth/callback", appCallback);
// App icons for installing an app: signed addresses from its manifest, so no sign-in (see pwa.ts).
siteApp.get("/_platform/app-icon/:id/:version/:kind/:sig", appPwaIcon);
// The app's link preview image, public so iMessage, Slack and others can show it (see share.ts).
siteApp.get("/_platform/share.png", appShareImage);

// "Anyone with the link" (see sites.ts publicLinkUrl): the link drops a cookie holding its secret on
// this host and opens the app. Visitors it lets in are guests: they can look, not change anything.
// Making a new link or turning it off changes the secret, which locks those cookies out again.
const PUBLIC_LINK_COOKIE = "__Host-fl_link";
const PUBLIC_LINK_TTL_S = 30 * 24 * 3600;
const hasPublicLink = (site: SiteRow, req: Request) => {
  const held = readCookie(req, PUBLIC_LINK_COOKIE);
  return !!site.public_link && !!held && held === site.public_link;
};

siteApp.get(`${PUBLIC_LINK_PATH}:token`, (c) => {
  const site = c.get("site");
  const token = c.req.param("token");
  if (!isPublicLinkToken(token) || token !== site.public_link) {
    return plainPage(404, "Link not working", "This link to the app was turned off or replaced. Ask whoever sent it for a new one.");
  }
  // Link previews (iMessage, Slack, ...) of a public link get the app's card, like its plain address.
  if (isPreviewBot(c.req.raw)) return appPreviewPage(c);
  const headers = new Headers({ location: "/", "cache-control": "no-store", "referrer-policy": "no-referrer" });
  headers.append("set-cookie", cookieHeader(PUBLIC_LINK_COOKIE, token, PUBLIC_LINK_TTL_S));
  return new Response(null, { status: 302, headers });
});

// Guests who want to be themselves in the app (formelab.signIn()): sign in on the apex, then back.
siteApp.get("/_platform/sign-in", (c) => {
  const back = new URL(safeReturn(c.req.query("return"), "/"), c.req.url);
  return handoffStart(c, back.toString());
});

// Everything else: a signed-in person who may open this app, or a guest with its public link.
siteApp.use("*", async (c, next) => {
  const site = c.get("site");
  const who = await identifyBrowser(c.req.raw, c.env);
  const nsRow = who ? await getNamespace(c.env, site.namespace) : null;
  const allowed = !!who && !!nsRow && canViewSite(who.user, site, nsRow);
  if (!allowed && hasPublicLink(site, c.req.raw)) {
    c.set("guest", true);
    c.set("namespace", site.namespace);
    // Guests are anonymous: their page views count toward the app's views, not its visitors.
    if (isPageView(c.req.raw)) c.executionCtx.waitUntil(recordAppVisit(c.env, site.id, GUEST, false).catch(() => {}));
    return next();
  }
  if (!who) {
    if (c.req.path.startsWith("/_api/")) return jsonError(unauthorized());
    // Link previews (iMessage, Slack, ...) get the app's title and image instead of the sign-in redirect.
    if ((c.req.method === "GET" || c.req.method === "HEAD") && !c.req.path.startsWith("/_") && isPreviewBot(c.req.raw)) return appPreviewPage(c);
    if (c.req.method === "GET" && workosEnabled(c.env)) return handoffStart(c, c.req.url);
    return unauthorizedPage();
  }
  if (!allowed) {
    return c.req.path.startsWith("/_api/") ? jsonError(forbidden("You don't have access to this app.")) : noAccessPage(site, who.user);
  }
  c.set("user", who.user);
  c.set("namespace", site.namespace);
  // Someone opening one of the app's pages counts toward its visitors (admin panel → Metrics).
  if (isPageView(c.req.raw)) {
    c.executionCtx.waitUntil(recordAppVisit(c.env, site.id, who.user.email, canManageSite(who.user, site, nsRow)).catch(() => {}));
  }
  await next();
});

siteApp.get("/_platform/sdk.js", () => text(SDK_JS, "text/javascript; charset=utf-8", "public, max-age=300"));
siteApp.get("/_platform/guide.md", guide);
siteApp.get("/_platform/manifest.webmanifest", appManifest);
siteApp.all("/_platform/*", () => plainPage(404, "Not found", "There is nothing here."));
siteApp.route("/_api", runtimeApi());
siteApp.all("/_api", () => jsonError(forbidden("Not an API endpoint.")));
// Apps that collect answers get a page listing them, for their owner and editors (answers.ts).
siteApp.get(ANSWERS_PATH, (c, next) => answersRoute(c, next));
siteApp.get(`${ANSWERS_PATH}.csv`, (c, next) => answersRoute(c, next, true));
siteApp.all("*", (c) =>
  serveAppFile(c.req.raw, c.env, c.get("site"), {
    answersLink: c.get("guest") ? undefined : (html) => showAnswersLink(c.env, c.get("site"), c.get("user"), html),
  }),
);

/** <label>.APP_DOMAIN: the app with that host label, or else an old namespace address to redirect. */
async function appsHost(req: Request, env: Env, ctx: ExecutionContext, label: string): Promise<Response> {
  if (new URL(req.url).pathname === "/healthz") return text("ok", "text/plain; charset=utf-8", "no-store");
  const site = await getSiteByHostLabel(env, label);
  if (site) {
    siteOf.set(req, site);
    return siteApp.fetch(req, env, ctx);
  }
  if (await getNamespace(env, label)) return legacyAppRedirect(req, env, label);
  return plainPage(404, "Not found", "There is no app at this address.");
}

// ---------------------------------------------------------------------------
// Host dispatch
// ---------------------------------------------------------------------------

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    switch (hostKind(url.hostname, env)) {
      case "ai":
        return oauthProvider(apexOrigin(env, req.url), apex as never).fetch(req, env, ctx);
      case "app":
        return webApp.fetch(req, env, ctx);
      case "admin":
        return adminApp.fetch(req, env, ctx);
      case "apps":
        return appsHost(req, env, ctx, appsLabelOf(url.hostname, env)!);
      case "apps-root":
        // The web app used to live at APP_DOMAIN; it's at app.DOMAIN now.
        return Response.redirect(`${appOrigin(env, req.url)}${url.pathname}${url.search}`, 301);
      case "legacy-ns": {
        // Apps used to live at <ns>.DOMAIN/<mount>/; each has its own host now.
        const ns = legacyNamespaceOf(url.hostname, env)!;
        return (await getNamespace(env, ns)) ? legacyAppRedirect(req, env, ns) : plainPage(404, "Not found", "Unknown host.");
      }
      default:
        return plainPage(404, "Not found", "Unknown host.");
    }
  },
} satisfies ExportedHandler<Env>;
