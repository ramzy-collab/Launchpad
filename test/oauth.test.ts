import { describe, expect, it } from "vitest";
import { afterEach } from "vitest";
import { accessJwt, call, onOutbound, OWNER, uniq } from "./helpers";

const ORIGIN = "https://example.com";
const RESOURCE = `${ORIGIN}/mcp`;
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}

async function register(name = "Claude") {
  const res = await call(`${ORIGIN}/oauth/register`, {
    method: "POST",
    json: {
      client_name: name,
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return (await res.json<{ client_id: string }>()).client_id;
}

function authorizeUrl(clientId: string, challenge: string, state = "st-" + uniq()) {
  const u = new URL(`${ORIGIN}/authorize`);
  u.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "mcp",
    state,
    resource: RESOURCE,
  }).toString();
  return { url: u.toString(), state };
}

const cookiesFrom = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

/** Runs consent as `as` and returns the redirect Location. */
async function consent(url: string, decision: "approve" | "deny", as = OWNER) {
  const page = await call(url, { as });
  expect(page.status, await page.clone().text()).toBe(200);
  const html = await page.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)![1]!;
  const form = new URLSearchParams({ handle, decision });
  const res = await call(`${ORIGIN}/authorize`, {
    as,
    method: "POST",
    headers: { cookie: cookiesFrom(page), "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
    body: form.toString(),
  });
  expect(res.status, await res.clone().text()).toBe(302);
  return new URL(res.headers.get("location")!);
}

async function exchange(clientId: string, code: string, verifier: string) {
  const res = await call(`${ORIGIN}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: RESOURCE }).toString(),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return res.json<{ access_token: string; refresh_token?: string; token_type: string; scope?: string }>();
}

async function connect(as = OWNER) {
  const clientId = await register();
  const { verifier, challenge } = await pkce();
  const { url, state } = authorizeUrl(clientId, challenge);
  const loc = await consent(url, "approve", as);
  expect(loc.origin + loc.pathname).toBe(REDIRECT);
  expect(loc.searchParams.get("state")).toBe(state);
  const tokens = await exchange(clientId, loc.searchParams.get("code")!, verifier);
  return { clientId, tokens };
}

async function mcpCall(token: string, name: string, args: Record<string, unknown> = {}) {
  return call(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    json: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
  });
}

afterEach(() => onOutbound(undefined));

describe("OAuth for MCP (Claude chat connector)", () => {
  it("accepts clients identified by a Client ID Metadata Document URL", async () => {
    const clientId = "https://claude.ai/oauth/mcp-client-metadata.json";
    onOutbound(async (req) => {
      if (req.url !== clientId) return new Response("not found", { status: 404 });
      return Response.json({ client_id: clientId, client_name: "Claude", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" });
    });
    const { verifier, challenge } = await pkce();
    const { url } = authorizeUrl(clientId, challenge);
    const page = await call(url, { as: OWNER });
    expect(page.status, await page.clone().text()).toBe(200);
    const html = await page.text();
    expect(html).toContain("Published by <strong>claude.ai</strong>");
    const loc = await consent(url, "approve");
    const tokens = await exchange(clientId, loc.searchParams.get("code")!, verifier);
    expect((await mcpCall(tokens.access_token, "whoami")).status).toBe(200);
  });

  it("publishes discovery metadata for the MCP resource and the authorization server", async () => {
    const unauth = await call(`${ORIGIN}/mcp`, { method: "POST", json: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    expect(unauth.status).toBe(401);
    const challenge = unauth.headers.get("www-authenticate")!;
    expect(challenge).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`);

    const prm = await (await call(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`)).json<{ resource: string; authorization_servers: string[] }>();
    expect(prm.resource).toBe(RESOURCE);
    expect(prm.authorization_servers).toEqual([ORIGIN]);

    const as = await (await call(`${ORIGIN}/.well-known/oauth-authorization-server`)).json<Record<string, unknown>>();
    expect(as.issuer).toBe(ORIGIN);
    expect(as.authorization_endpoint).toBe(`${ORIGIN}/authorize`);
    expect(as.token_endpoint).toBe(`${ORIGIN}/oauth/token`);
    expect(as.registration_endpoint).toBe(`${ORIGIN}/oauth/register`);
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
  });

  it("does not expose OAuth endpoints on namespace hosts", async () => {
    const res = await call(`https://${uniq()}.example.com/.well-known/oauth-authorization-server`, { as: OWNER });
    expect(res.status).toBe(404);
  });

  it("runs the full flow: register, sign in, approve, exchange, call MCP tools", async () => {
    const { tokens } = await connect();
    expect(tokens.token_type.toLowerCase()).toBe("bearer");
    expect(tokens.refresh_token).toBeTruthy();
    const res = await mcpCall(tokens.access_token, "whoami");
    expect(res.status).toBe(200);
    const body = await res.json<{ result: { content: { text: string }[] } }>();
    expect(JSON.parse(body.result.content[0]!.text).email).toBe(OWNER);
  });

  it("acts as the person who approved, with their permissions", async () => {
    const ns = uniq();
    const owner = await connect(OWNER);
    const pub = await mcpCall(owner.tokens.access_token, "publish", { html: "<!doctype html><html><head></head><body>x</body></html>", namespace: ns, mount_path: "" });
    expect(((await pub.json()) as { result: { isError?: boolean } }).result.isError).toBeFalsy();
    const other = await connect("someone@example.com");
    const del = await mcpCall(other.tokens.access_token, "delete_site", { namespace: ns, mount_path: "" });
    const result = ((await del.json()) as { result: { isError?: boolean; content: { text: string }[] } }).result;
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("forbidden");
  });

  it("requires an Access sign-in on /authorize", async () => {
    const clientId = await register();
    const { challenge } = await pkce();
    const res = await call(authorizeUrl(clientId, challenge).url);
    expect(res.status).toBe(401);
    // A forged identity header is not a sign-in either.
    const forged = await call(authorizeUrl(clientId, challenge).url, { headers: { "cf-access-authenticated-user-email": OWNER } });
    expect(forged.status).toBe(401);
  });

  it("sends the user back with access_denied when they click Deny", async () => {
    const clientId = await register();
    const { challenge } = await pkce();
    const { url, state } = authorizeUrl(clientId, challenge);
    const loc = await consent(url, "deny");
    expect(loc.searchParams.get("error")).toBe("access_denied");
    expect(loc.searchParams.get("state")).toBe(state);
    expect(loc.searchParams.get("code")).toBeNull();
  });

  it("refuses an approval without the browser-bound consent cookie (no CSRF)", async () => {
    const clientId = await register();
    const { challenge } = await pkce();
    const page = await call(authorizeUrl(clientId, challenge).url, { as: OWNER });
    const handle = /name="handle" value="([^"]+)"/.exec(await page.text())![1]!;
    const res = await call(`${ORIGIN}/authorize`, {
      as: OWNER,
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ handle, decision: "approve" }).toString(),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("explains a second click on Allow instead of a bare error, and the first one still connects", async () => {
    const clientId = await register();
    const { verifier, challenge } = await pkce();
    const page = await call(authorizeUrl(clientId, challenge).url, { as: OWNER });
    const html = await page.text();
    expect(html).toContain('<script src="/_assets/consent.js" defer></script>');
    const handle = /name="handle" value="([^"]+)"/.exec(html)![1]!;
    const submit = () =>
      call(`${ORIGIN}/authorize`, {
        as: OWNER,
        method: "POST",
        headers: { cookie: cookiesFrom(page), "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ handle, decision: "approve" }).toString(),
      });
    const first = await submit();
    expect(first.status).toBe(302);
    const second = await submit();
    expect(second.status).toBe(400);
    expect(await second.text()).toContain("already been used");
    const code = new URL(first.headers.get("location")!).searchParams.get("code")!;
    const tokens = await exchange(clientId, code, verifier);
    expect((await mcpCall(tokens.access_token, "whoami")).status).toBe(200);
  });

  it("serves the consent script, allowed by the page's CSP", async () => {
    const js = await call(`${ORIGIN}/_assets/consent.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("javascript");
    const clientId = await register();
    const { challenge } = await pkce();
    const page = await call(authorizeUrl(clientId, challenge).url, { as: OWNER });
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
  });

  it("escapes the client's self-chosen name and forbids framing", async () => {
    const clientId = await register(`<script>alert(1)</script>`);
    const { challenge } = await pkce();
    const page = await call(authorizeUrl(clientId, challenge).url, { as: OWNER });
    const html = await page.text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("claude.ai"); // where tokens will go
    const csp = page.headers.get("content-security-policy")!;
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self' https://claude.ai");
  });

  it("rejects an unregistered redirect URI without redirecting", async () => {
    const clientId = await register();
    const { challenge } = await pkce();
    const u = new URL(authorizeUrl(clientId, challenge).url);
    u.searchParams.set("redirect_uri", "https://evil.test/callback");
    const res = await call(u.toString(), { as: OWNER });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("rejects a wrong PKCE verifier", async () => {
    const clientId = await register();
    const { challenge } = await pkce();
    const loc = await consent(authorizeUrl(clientId, challenge).url, "approve");
    const res = await call(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: loc.searchParams.get("code")!, redirect_uri: REDIRECT, client_id: clientId, code_verifier: "wrong".repeat(10) }).toString(),
    });
    expect(res.status).toBe(400);
  });

  it("lists connected apps on the dashboard, and disconnecting revokes access", async () => {
    const email = `conn-${uniq()}@example.com`;
    const { tokens } = await connect(email);
    const list = await (await call("/_api/admin/connections", { as: email })).json<{ id: string; clientName: string }[]>();
    expect(list.map((c) => c.clientName)).toEqual(["Claude"]);
    const html = await (await call("/app", { as: email })).text();
    expect(html).toContain("Connected apps");
    expect(html).toContain(">Claude<");

    // Someone else can't disconnect it.
    expect((await call(`/_api/admin/connections/${list[0]!.id}`, { as: "mallory@example.com", method: "DELETE" })).status).toBe(404);
    expect((await mcpCall(tokens.access_token, "whoami")).status).toBe(200);

    expect((await call(`/_api/admin/connections/${list[0]!.id}`, { as: email, method: "DELETE" })).status).toBe(200);
    expect((await mcpCall(tokens.access_token, "whoami")).status).toBe(401);
    expect(await (await call("/_api/admin/connections", { as: email })).json()).toEqual([]);
  });

  it("deploy tokens cannot manage connections", async () => {
    const { token } = await (await call("/_api/admin/tokens", { as: OWNER, method: "POST", json: { name: "t" } })).json<{ token: string }>();
    expect((await call("/_api/deploy/connections/x", { token, method: "DELETE" })).status).toBe(403);
    expect((await call("/_api/deploy/connections", { token })).status).toBe(403);
  });

  it("still accepts fl_ deploy tokens on /mcp", async () => {
    const { token } = await (await call("/_api/admin/tokens", { as: OWNER, method: "POST", json: { name: "cc" } })).json<{ token: string }>();
    const res = await mcpCall(token, "whoami");
    expect(res.status).toBe(200);
    // ...but not revoked or garbage ones.
    expect((await mcpCall("fl_" + "a".repeat(52), "whoami")).status).toBe(401);
    expect((await mcpCall("not-a-token", "whoami")).status).toBe(401);
  });

  it("an Access JWT is not an MCP credential", async () => {
    const jwt = await accessJwt(OWNER);
    const res = await call(`${ORIGIN}/mcp`, { method: "POST", headers: { authorization: `Bearer ${jwt}` }, json: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    expect(res.status).toBe(401);
  });
});
