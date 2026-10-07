import {
  AuthorizationError,
  CimdFetchError,
  OAuthProvider,
  type ConsentDescription,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import type { Context } from "hono";
import { getUser, userForDeployToken } from "./auth";
import { audit } from "./audit";
import type { AppEnv, Env } from "./env";
import { isDev } from "./env";
import { notFound } from "./errors";
import { handleMcp } from "./mcp";
import { plainPage } from "./serve";
import { escapeHtml as e } from "./util";

/**
 * OAuth 2.1 for the MCP endpoint, so hosted clients such as Claude chat (claude.ai custom
 * connectors) can connect with a "Connect" button instead of a pasted token.
 *
 * Only apex requests pass through the provider. It owns:
 *   /.well-known/oauth-authorization-server, /.well-known/oauth-protected-resource/mcp,
 *   /oauth/token, /oauth/register, and /mcp (token check, then mcpApiHandler).
 * Everything else goes to the apex Hono app, which owns /authorize: that page sits behind
 * Cloudflare Access, so the person approving is identified exactly like the dashboard.
 * Deploy tokens (fl_...) still work on /mcp through resolveExternalToken.
 */

export const AUTHORIZE_PATH = "/authorize";
export const TOKEN_PATH = "/oauth/token";
export const REGISTER_PATH = "/oauth/register";
export const MCP_SCOPE = "mcp";

/** Props stored with each grant / resolved for each deploy token; passed to the MCP handler. */
interface McpProps {
  email: string;
  via: "oauth" | "token";
}

/** The apex origin: https://DOMAIN in production, the request's own origin in dev (http://localhost:8787). */
export function apexOrigin(env: Env, requestUrl: string): string {
  return isDev(env) ? new URL(requestUrl).origin : `https://${env.DOMAIN.toLowerCase()}`;
}

const mcpApiHandler = {
  async fetch(req: Request, env: Env, ctx: ExecutionContext & { props?: McpProps }): Promise<Response> {
    const email = ctx.props?.email;
    const user = email ? await getUser(env, email) : null;
    if (!user) {
      return Response.json(
        { error: { code: "unauthorized", message: "This connection's account no longer exists.", hint: "Reconnect from your MCP client." } },
        { status: 401 },
      );
    }
    return handleMcp(req, env, user, ctx);
  },
};

type ApexHandler = { fetch: (req: Request, env: Env, ctx: ExecutionContext) => Response | Promise<Response> };

const providers = new Map<string, OAuthProvider<Env>>();

/** One provider per apex origin (the resource URL is fixed at construction). */
export function oauthProvider(origin: string, defaultHandler: ApexHandler): OAuthProvider<Env> {
  let provider = providers.get(origin);
  if (!provider) {
    const resource = `${origin}/mcp`;
    provider = new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler: mcpApiHandler as never,
      defaultHandler: defaultHandler as never,
      authorizeEndpoint: AUTHORIZE_PATH,
      tokenEndpoint: TOKEN_PATH,
      clientRegistrationEndpoint: REGISTER_PATH,
      clientIdMetadataDocumentEnabled: true,
      scopesSupported: [MCP_SCOPE, "offline_access"],
      requiredScopes: [MCP_SCOPE],
      resourceMetadata: { resource, authorization_servers: [origin], resource_name: "Formelab" },
      resolveExternalToken: async ({ token, env }) => {
        if (!token.startsWith("fl_")) return null;
        const user = await userForDeployToken(env, token);
        return user ? { props: { email: user.email, via: "token" } satisfies McpProps, audience: resource } : null;
      },
      onError: ({ code, internal }) => {
        console.warn("oauth error", code, internal?.category, internal?.reason);
      },
    });
    providers.set(origin, provider);
  }
  return provider;
}

function helpers(env: Env): OAuthHelpers {
  if (!env.OAUTH_PROVIDER) throw new Error("OAuth helpers are only available on the apex host");
  return env.OAUTH_PROVIDER;
}

// ---------------------------------------------------------------------------
// /authorize: consent page (behind Cloudflare Access)
// ---------------------------------------------------------------------------

function consentPage(user: string, d: ConsentDescription, handle: string): string {
  const who = d.clientDomain
    ? `Published by <strong>${e(d.clientDomain)}</strong>.`
    : "This app registered itself, so its name is not verified.";
  const local = d.redirectIsLoopback
    ? `<p class="warn"><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect ${e(d.clientName)} to Formelab</title>
<link rel="stylesheet" href="/_platform/dashboard.css">
<script src="/_platform/consent.js" defer></script>
</head>
<body>
<main class="consent">
<section>
  <h1>Connect ${e(d.clientName)} to Formelab?</h1>
  <p>${who} Access will be sent to <strong>${e(d.redirectHost)}</strong>.</p>
  ${local}
  <p>If you allow it, <strong>${e(d.clientName)}</strong> can act as <strong>${e(user)}</strong> on Formelab: list your namespaces and sites, publish and update apps, and delete sites.</p>
  <p class="muted">You can disconnect it at any time from the Formelab dashboard, under Connected apps.</p>
  <form method="post" action="${AUTHORIZE_PATH}" class="inline">
    <input type="hidden" name="handle" value="${e(handle)}">
    <button name="decision" value="approve">Allow</button>
    <button name="decision" value="deny" class="danger">Deny</button>
  </form>
</section>
</main>
</body>
</html>`;
}

const consentCsp = (redirectUri: string) => {
  let target = "";
  try {
    target = " " + new URL(redirectUri).origin;
  } catch {}
  // form-action also governs the redirect after the POST, so it must allow the client's origin.
  return `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'${target}`;
};

/**
 * The Allow/Deny form posts a one-time handle bound to this browser. If it fails here, the handle
 * was already used (a second click), expired, or belongs to another browser. The first case is
 * the common one and means the connection already went through.
 */
function consentSubmitFailure(err: unknown): Response {
  if (err instanceof AuthorizationError && !err.redirectTo) {
    return plainPage(
      400,
      "This page has already been used",
      "If Claude now shows Formelab as connected, you're all set and can close this tab. Otherwise, start connecting again from Claude.",
    );
  }
  return authorizationFailure(err);
}

function authorizationFailure(err: unknown): Response {
  if (err instanceof AuthorizationError && err.redirectTo) return Response.redirect(err.redirectTo, 302);
  if (err instanceof AuthorizationError) return plainPage(400, "Can't connect", err.description || "This connection request is not valid. Start again from the app.");
  if (err instanceof CimdFetchError) return plainPage(400, "Can't connect", "This app could not be verified. Try again later.");
  throw err;
}

export async function authorizeGet(c: Context<AppEnv>): Promise<Response> {
  const oauth = helpers(c.env);
  try {
    const request = await oauth.parseAuthRequest(c.req.raw);
    const details = await oauth.describeConsent(request);
    const consent = await oauth.beginConsent(request);
    consent.headers.set("content-type", "text/html; charset=utf-8");
    consent.headers.set("cache-control", "no-store");
    consent.headers.set("content-security-policy", consentCsp(details.redirectUri));
    consent.headers.set("x-content-type-options", "nosniff");
    consent.headers.set("referrer-policy", "no-referrer");
    return new Response(consentPage(c.get("user").email, details, consent.handle), { headers: consent.headers });
  } catch (err) {
    return authorizationFailure(err);
  }
}

export async function authorizePost(c: Context<AppEnv>): Promise<Response> {
  const oauth = helpers(c.env);
  const user = c.get("user");
  try {
    const form = await c.req.formData();
    const handle = String(form.get("handle") ?? "");
    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(c.req.raw, handle);
      denied.headers.set("location", denied.redirectTo);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    // One scope covers every Formelab tool; refresh tokens come with the code grant regardless.
    const scope = [MCP_SCOPE];
    const approved = await oauth.approveConsent(c.req.raw, handle, { scope });
    const client = await oauth.lookupClient(approved.request.clientId);
    const clientName = client?.clientName ?? approved.request.clientId;
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: user.email,
      metadata: { clientName, connectedAt: Date.now() },
      scope,
      props: { email: user.email, via: "oauth" } satisfies McpProps,
    });
    await audit(c.env, user.email, "oauth_connect", null, { client: clientName.slice(0, 100) });
    approved.headers.set("location", redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (err) {
    return consentSubmitFailure(err);
  }
}

// ---------------------------------------------------------------------------
// Connected apps (dashboard)
// ---------------------------------------------------------------------------

export interface ConnectionView {
  id: string;
  clientName: string;
  createdAt: number;
  expiresAt: number | null;
}

export async function listConnections(env: Env, email: string): Promise<ConnectionView[]> {
  if (!env.OAUTH_PROVIDER) return [];
  const { items } = await env.OAUTH_PROVIDER.listUserGrants(email, { limit: 100 });
  return items
    .map((g) => ({
      id: g.id,
      clientName: typeof g.metadata?.clientName === "string" ? g.metadata.clientName : g.clientId,
      createdAt: g.createdAt * (g.createdAt < 1e12 ? 1000 : 1),
      expiresAt: g.expiresAt ? g.expiresAt * (g.expiresAt < 1e12 ? 1000 : 1) : null,
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function revokeConnection(env: Env, email: string, grantId: string): Promise<void> {
  const mine = await listConnections(env, email);
  if (!mine.some((g) => g.id === grantId)) throw notFound("Connection");
  await helpers(env).revokeGrant(grantId, email);
  await audit(env, email, "oauth_disconnect", null, { grantId });
}
