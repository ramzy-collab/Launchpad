// The hosts Formelab answers on.
//
//   DOMAIN (formelab.ai)             home page, sign-in, waitlist, the MCP connector and OAuth
//   app.DOMAIN                       the web app: My apps, Shared with me, Connect your AI
//   admin.DOMAIN                     the admin panel (its own, shorter session)
//   <host_label>.APP_DOMAIN          one published app each, e.g. hoops-7kq2.formelab.app
//   APP_DOMAIN                       the web app's old address, redirected to app.DOMAIN
//   <ns>.APP_DOMAIN, <ns>.DOMAIN     old app addresses (<ns>/<mount>/...), redirected to the app's host
//
// Every app gets its own host so browsers keep apps apart (each is its own origin), and
// APP_DOMAIN holds nothing but published apps, so they're never same-site with Formelab itself.
import type { Env } from "./env";
import { isDev } from "./env";

export const ADMIN_LABEL = "admin";
export const WEB_LABEL = "app";

const lower = (s: string) => s.toLowerCase();
export const aiHost = (env: Env) => lower(env.DOMAIN);
/** The web app. */
export const appHost = (env: Env) => `${WEB_LABEL}.${aiHost(env)}`;
export const adminHost = (env: Env) => `${ADMIN_LABEL}.${aiHost(env)}`;
/** The domain published apps live under. */
export const appsDomain = (env: Env) => lower(env.APP_DOMAIN);

/** https://<host>, or in dev the request's own scheme and port with that host. */
function originFor(env: Env, host: string, requestUrl?: string): string {
  if (isDev(env) && requestUrl) {
    const u = new URL(requestUrl);
    return `${u.protocol}//${host}${u.port ? ":" + u.port : ""}`;
  }
  return `https://${host}`;
}

export const aiOrigin = (env: Env, requestUrl?: string) => originFor(env, aiHost(env), requestUrl);
/** The web app's origin. */
export const appOrigin = (env: Env, requestUrl?: string) => originFor(env, appHost(env), requestUrl);
export const adminOrigin = (env: Env, requestUrl?: string) => originFor(env, adminHost(env), requestUrl);
/** A published app's origin, from its host label. */
export const siteOrigin = (env: Env, hostLabel: string, requestUrl?: string) => originFor(env, `${hostLabel}.${appsDomain(env)}`, requestUrl);

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** "<label>.<parent>" -> "<label>"; null for the parent itself, deeper subdomains, or other hosts. */
function labelUnder(hostname: string, parent: string): string | null {
  const host = lower(hostname);
  if (!host.endsWith("." + parent)) return null;
  const label = host.slice(0, -(parent.length + 1));
  return LABEL.test(label) ? label : null;
}

/** The label of a host under APP_DOMAIN: an app's host label, or an old namespace address. */
export const appsLabelOf = (hostname: string, env: Env) => labelUnder(hostname, appsDomain(env));

/** An old app address "<ns>.DOMAIN" (not one of Formelab's own hosts), or null. */
export const legacyNamespaceOf = (hostname: string, env: Env) => {
  const label = labelUnder(hostname, aiHost(env));
  return label && label !== ADMIN_LABEL && label !== WEB_LABEL ? label : null;
};

/**
 * "ai", "admin" and "app" are Formelab's own hosts; "apps-root" is APP_DOMAIN itself (the web app's
 * old address); "apps" is any <label>.APP_DOMAIN (an app, or an old namespace address: which one
 * takes a database lookup); "legacy-ns" is <ns>.DOMAIN.
 */
export type HostKind = "ai" | "admin" | "app" | "apps-root" | "apps" | "legacy-ns" | "unknown";

export function hostKind(hostname: string, env: Env): HostKind {
  const host = lower(hostname);
  if (host === aiHost(env)) return "ai";
  if (host === adminHost(env)) return "admin";
  if (host === appHost(env)) return "app";
  if (host === appsDomain(env)) return "apps-root";
  if (appsLabelOf(host, env)) return "apps";
  if (legacyNamespaceOf(host, env)) return "legacy-ns";
  return "unknown";
}
