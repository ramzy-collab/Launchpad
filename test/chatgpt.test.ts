import { describe, expect, it } from "vitest";
import { call, OWNER, PAGE, publishHtml, uniq } from "./helpers";

const ORIGIN = "https://example.com";
const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const FORM = { "content-type": "application/x-www-form-urlencoded" };

/** Connects the way ChatGPT does: DCR, then authorization code + PKCE. */
async function connectLikeChatGPT(authMethod: "none" | "client_secret_post", as = OWNER, sendResource = false) {
  const reg = await call(`${ORIGIN}/oauth/register`, {
    method: "POST",
    json: { client_name: "ChatGPT", redirect_uris: [REDIRECT], token_endpoint_auth_method: authMethod, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] },
  });
  expect(reg.status, await reg.clone().text()).toBe(201);
  const client = await reg.json<{ client_id: string; client_secret?: string }>();

  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const params: Record<string, string> = { response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "s" + uniq() };
  if (sendResource) params.resource = `${ORIGIN}/mcp`;
  const page = await call(`${ORIGIN}/authorize?${form(params)}`, { as });
  expect(page.status, await page.clone().text()).toBe(200);
  const html = await page.text();
  expect(html).toContain("Connect ChatGPT to Formelab?");
  expect(html).toContain("<strong>chatgpt.com</strong>");
  expect(page.headers.get("content-security-policy")).toContain("form-action 'self' https://chatgpt.com");
  const handle = /name="handle" value="([^"]+)"/.exec(html)![1]!;
  const cookie = page.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const approved = await call(`${ORIGIN}/authorize`, { as, method: "POST", headers: { ...FORM, cookie }, body: form({ handle, decision: "approve" }) });
  expect(approved.status).toBe(302);
  const loc = new URL(approved.headers.get("location")!);
  expect(loc.origin + loc.pathname).toBe(REDIRECT);

  const tokenBody: Record<string, string> = { grant_type: "authorization_code", code: loc.searchParams.get("code")!, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: verifier };
  if (client.client_secret) tokenBody.client_secret = client.client_secret;
  const tok = await call(`${ORIGIN}/oauth/token`, { method: "POST", headers: FORM, body: form(tokenBody) });
  expect(tok.status, await tok.clone().text()).toBe(200);
  const tokens = await tok.json<{ access_token: string; refresh_token: string }>();

  // Refresh, as a long-lived connector does every hour.
  const refreshBody: Record<string, string> = { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id };
  if (client.client_secret) refreshBody.client_secret = client.client_secret;
  const refreshed = await call(`${ORIGIN}/oauth/token`, { method: "POST", headers: FORM, body: form(refreshBody) });
  expect(refreshed.status, await refreshed.clone().text()).toBe(200);
  return (await refreshed.json<{ access_token: string }>()).access_token;
}

async function tool(token: string, name: string, args: Record<string, unknown> = {}) {
  const res = await call(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    json: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
  });
  expect(res.status).toBe(200);
  const { result } = await res.json<{ result: { isError?: boolean; content: { text: string }[] } }>();
  const text = result.content[0]!.text;
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { isError: !!result.isError, data };
}

describe("ChatGPT connector", () => {
  for (const method of ["none", "client_secret_post"] as const) {
    it(`connects as a ${method === "none" ? "public" : "confidential"} client, refreshes, and calls tools`, async () => {
      const token = await connectLikeChatGPT(method);
      expect((await tool(token, "whoami")).data.email).toBe(OWNER);
    });
  }

  it("works when the client sends an explicit resource indicator too", async () => {
    const token = await connectLikeChatGPT("none", OWNER, true);
    expect((await tool(token, "whoami")).data.email).toBe(OWNER);
  });

  it("search finds your apps and the guide; fetch returns details and source", async () => {
    const ns = uniq();
    await publishHtml(OWNER, ns, "budget", PAGE("<h1>Budget tracker</h1>"), { title: "Budget tracker" });
    await publishHtml(OWNER, ns, "notes", PAGE("notes"), { title: "Notes" });
    const token = await connectLikeChatGPT("none");

    const found = await tool(token, "search", { query: `budget ${ns}` });
    expect(found.data.results).toEqual([{ id: expect.stringMatching(/^site:s_/), title: "Budget tracker", url: `https://${ns}.example.com/budget/` }]);

    const all = await tool(token, "search", { query: "" });
    const ids = all.data.results.map((r: { id: string }) => r.id);
    expect(ids).toContain("guide");
    expect(all.data.results.filter((r: { url: string }) => r.url.startsWith(`https://${ns}.`)).length).toBe(2);

    const site = await tool(token, "fetch", { id: found.data.results[0].id });
    expect(site.data).toMatchObject({ id: found.data.results[0].id, title: "Budget tracker", url: `https://${ns}.example.com/budget/`, metadata: { namespace: ns, mountPath: "budget" } });
    expect(site.data.text).toContain("<h1>Budget tracker</h1>");

    const guide = await tool(token, "fetch", { id: "guide" });
    expect(guide.data.text).toContain("# Building apps for Formelab");
    expect(guide.data.url).toBe(`${ORIGIN}/_platform/guide.md`);
  });

  it("fetch follows app visibility: no peeking at someone else's restricted app", async () => {
    const ns = uniq();
    const res = await publishHtml(OWNER, ns, "private", PAGE("top secret"), { visibility: "restricted" });
    const { site } = await res.json<{ site: { id: string } }>();
    const token = await connectLikeChatGPT("none", "stranger@example.com");
    const denied = await tool(token, "fetch", { id: `site:${site.id}` });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied.data)).not.toContain("top secret");
    expect((await tool(token, "search", { query: ns })).data.results).toEqual([]);
    expect((await tool(token, "fetch", { id: "site:../../etc" })).isError).toBe(true);
  });
});
