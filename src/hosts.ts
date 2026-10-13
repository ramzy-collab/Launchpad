// The hosts Formelab answers on.
//
//   DOMAIN (formelab.ai)          home page, sign-in, waitlist, the MCP connector and OAuth
//   admin.DOMAIN                  the admin panel (its own, shorter session)
//   APP_DOMAIN (formelab.app)     the web app: My lab, Shared with me, Connect your AI
//   <ns>.APP_DOMAIN               published apps
//   <ns>.DOMAIN                   old app addresses, redirected to <ns>.APP_DOMAIN
import type { Env } from "./env";
import { isDev } from "./env";

export const ADMIN_LABEL = "admin";

const lower = (s: string) => s.toLowerCase();
export const aiHost = (env: Env) => lower(env.DOMAIN);
export const appHost = (env: Env) => lower(env.APP_DOMAIN);
export const adminHost = (env: Env) => `${ADMIN_LABEL}.${aiHost(env)}`;

/** https://<host>, or in dev the request's own scheme and port with that host. */
function originFor(env: Env, host: string, requestUrl?: string): string {
  if (isDev(env) && requestUrl) {
    const u = new URL(requestUrl);
    return `${u.protocol}//${host}${u.port ? ":" + u.port : ""}`;
  }
  return `https://${host}`;
}

export const aiOrigin = (env: Env, requestUrl?: string) => originFor(env, aiHost(env), requestUrl);
export const appOrigin = (env: Env, requestUrl?: string) => originFor(env, appHost(env), requestUrl);
export const adminOrigin = (env: Env, requestUrl?: string) => originFor(env, adminHost(env), requestUrl);
export const nsOrigin = (env: Env, ns: string, requestUrl?: string) => originFor(env, `${ns}.${appHost(env)}`, requestUrl);

const NS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** "<label>.<parent>" -> "<label>"; null for the parent itself, deeper subdomains, or other hosts. */
function labelUnder(hostname: string, parent: string): string | null {
  const host = lower(hostname);
  if (!host.endsWith("." + parent)) return null;
  const label = host.slice(0, -(parent.length + 1));
  return NS_LABEL.test(label) ? label : null;
}

/** The namespace a published-app host belongs to ("<ns>.APP_DOMAIN"), or null. */
export const namespaceOf = (hostname: string, env: Env) => labelUnder(hostname, appHost(env));

/** An old app address "<ns>.DOMAIN" (not the admin host), or null. */
export const legacyNamespaceOf = (hostname: string, env: Env) => {
  const label = labelUnder(hostname, aiHost(env));
  return label && label !== ADMIN_LABEL ? label : null;
};

export type HostKind = "ai" | "admin" | "app" | "ns" | "legacy-ns" | "unknown";

export function hostKind(hostname: string, env: Env): HostKind {
  const host = lower(hostname);
  if (host === aiHost(env)) return "ai";
  if (host === adminHost(env)) return "admin";
  if (host === appHost(env)) return "app";
  if (namespaceOf(host, env)) return "ns";
  if (legacyNamespaceOf(host, env)) return "legacy-ns";
  return "unknown";
}
