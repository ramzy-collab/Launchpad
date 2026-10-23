import { exports } from "cloudflare:workers";
import { env } from "cloudflare:workers";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey as JoseKey } from "jose";
import { zipSync, strToU8 } from "fflate";

export const DOMAIN = "example.com";
export const APP_DOMAIN = "example.app";
/** The web app. */
export const APP = `https://app.${DOMAIN}`;
export const ADMIN = `https://admin.${DOMAIN}`;
export const TEAM = "team.cloudflareaccess.com";
export const AUD = "test-aud";
export const OWNER = "owner@example.com";

type Keys = { privateKey: JoseKey; jwks: { keys: unknown[] } };
const g = globalThis as unknown as { __lpKeys?: Promise<Keys>; __lpOutbound?: OutboundHandler; __lpFetchPatched?: boolean };

export function accessKeys(): Promise<Keys> {
  g.__lpKeys ??= (async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
    const jwk = await exportJWK(publicKey);
    return { privateKey, jwks: { keys: [{ ...jwk, kid: "test-kid", alg: "RS256", use: "sig" }] } };
  })();
  return g.__lpKeys;
}

export type OutboundHandler = (req: Request) => Response | Promise<Response>;

/** Replace outbound fetch: Access certs are served from the test key; everything else goes to the handler. */
export function installFetchMock() {
  if (g.__lpFetchPatched) return;
  g.__lpFetchPatched = true;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    const url = new URL(req.url);
    if (url.hostname === TEAM && url.pathname === "/cdn-cgi/access/certs") {
      return Response.json((await accessKeys()).jwks);
    }
    if (url.hostname === DOMAIN || url.hostname.endsWith("." + DOMAIN) || url.hostname === APP_DOMAIN || url.hostname.endsWith("." + APP_DOMAIN) || url.hostname === "other.test") {
      return realFetch(input as RequestInfo, init);
    }
    if (g.__lpOutbound) return g.__lpOutbound(req);
    return new Response("no outbound handler", { status: 599 });
  }) as typeof fetch;
}

export function onOutbound(h: OutboundHandler | undefined) {
  g.__lpOutbound = h;
}

export async function accessJwt(email: string, opts: { aud?: string; iss?: string; expSecondsFromNow?: number; key?: JoseKey } = {}) {
  const { privateKey } = await accessKeys();
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email, type: "app" })
    .setProtectedHeader({ alg: "RS256", kid: "test-kid" })
    .setIssuer(opts.iss ?? `https://${TEAM}`)
    .setAudience(opts.aud ?? AUD)
    .setSubject("sub-" + email)
    .setIssuedAt(now - 10)
    .setExpirationTime(now + (opts.expSecondsFromNow ?? 300))
    .sign(opts.key ?? privateKey);
}

export interface CallOpts extends RequestInit {
  as?: string;
  token?: string;
  mount?: string;
  json?: unknown;
  /** Set false to omit the dashboard's x-formelab-request header on admin writes. */
  csrf?: boolean;
}

/** Calls the Worker. `as` signs an Access JWT; `token` sends a bearer token; `mount` sets x-formelab-mount. */
export async function call(url: string, opts: CallOpts = {}): Promise<Response> {
  const headers = new Headers(opts.headers);
  if (opts.as) headers.set("cf-access-jwt-assertion", await accessJwt(opts.as));
  if (opts.token) headers.set("authorization", `Bearer ${opts.token}`);
  if (opts.mount !== undefined) headers.set("x-formelab-mount", opts.mount);
  let body = opts.body;
  if (opts.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(opts.json);
  }
  const full = url.startsWith("http") ? url : resolvePath(url);
  if (opts.csrf !== false && new URL(full).pathname.startsWith("/_api/admin") && opts.method && opts.method !== "GET") headers.set("x-formelab-request", "1");
  return exports.default.fetch(new Request(full, { ...opts, headers, body, redirect: "manual" }));
}

/** The management API's admin-only endpoints, served only on the admin host (src/api.ts). */
const ADMIN_ONLY_API = /^\/_api\/admin\/(users|waitlist\/approve|features\/|test-plans\/)/;

/** Bare paths go to the host that serves them: the management API and web app on app.DOMAIN (its admin-only endpoints on the admin host), "/admin..." on the admin host, the rest on DOMAIN. */
export function resolvePath(path: string): string {
  if (ADMIN_ONLY_API.test(path)) return ADMIN + path;
  if (path.startsWith("/_api/admin")) return APP + path;
  if (path === "/app" || path.startsWith("/app/") || path.startsWith("/app?")) return APP + (path.slice(4) || "/");
  if (path === "/admin" || path.startsWith("/admin/") || path.startsWith("/admin?")) return ADMIN + (path.slice(6) || "/");
  return `https://${DOMAIN}${path}`;
}

/** The origin of the app published at <ns>/<mount>: its own host, https://<host_label>.APP_DOMAIN. */
export async function appAt(ns: string, mount = ""): Promise<string> {
  const row = await env.DB.prepare("SELECT host_label FROM sites WHERE namespace = ? AND mount_path = ?")
    .bind(ns, mount)
    .first<{ host_label: string }>();
  if (!row) throw new Error(`No app at ${ns}/${mount}`);
  return `https://${row.host_label}.${APP_DOMAIN}`;
}

let seq = 0;
/** A unique, valid namespace label per call so tests don't collide. */
export const uniq = (p = "ns") => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;

export async function publishHtml(as: string, namespace: string, mountPath: string, html: string, extra: Record<string, string> = {}) {
  const fd = new FormData();
  fd.set("file", new File([html], "index.html", { type: "text/html" }));
  fd.set("namespace", namespace);
  fd.set("mount_path", mountPath);
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  return call("/_api/admin/sites", { as, method: "POST", body: fd });
}

export async function publishZip(as: string, namespace: string, mountPath: string, files: Record<string, string | Uint8Array>, extra: Record<string, string> = {}) {
  const fd = new FormData();
  fd.set("file", new File([makeZip(files)], "site.zip", { type: "application/zip" }));
  fd.set("namespace", namespace);
  fd.set("mount_path", mountPath);
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  return call("/_api/admin/sites", { as, method: "POST", body: fd });
}

export function makeZip(files: Record<string, string | Uint8Array>): Uint8Array {
  const input: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(files)) input[k] = typeof v === "string" ? strToU8(v) : v;
  return zipSync(input);
}

export async function r2Keys(prefix: string): Promise<string[]> {
  const list = await env.BUCKET.list({ prefix });
  return list.objects.map((o) => o.key);
}

export const PAGE = (body: string) => `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;

/** A page with an icon, as the MCP publish tool requires. */
export const ICON = `<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E">`;
export const ICON_PAGE = (body: string) => `<!doctype html><html><head><title>t</title>${ICON}</head><body>${body}</body></html>`;
