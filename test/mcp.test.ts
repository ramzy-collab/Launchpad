import { describe, expect, it } from "vitest";
import { call, ICON_PAGE, OWNER, PAGE, publishHtml, uniq } from "./helpers";

const publishHtmlPlain = (ns: string) => publishHtml(OWNER, ns, "plain", PAGE("no icon"));

async function token(as = OWNER) {
  const res = await call("/_api/admin/tokens", { as, method: "POST", json: { name: "mcp", ttlHours: 1 } });
  return (await res.json<{ token: string }>()).token;
}

let id = 0;
async function rpc(t: string, method: string, params?: unknown) {
  const res = await call("/mcp", {
    method: "POST",
    token: t,
    headers: { accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    json: { jsonrpc: "2.0", id: ++id, method, params },
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return res.json<{ result?: any; error?: any }>();
}

const tool = async (t: string, name: string, args: Record<string, unknown> = {}) => {
  const { result } = await rpc(t, "tools/call", { name, arguments: args });
  const text = result.content[0].text as string;
  return { isError: !!result.isError, text, data: (() => { try { return JSON.parse(text); } catch { return text; } })() };
};

describe("MCP server", () => {
  it("shows Claude Code as connected once it uses an access key", async () => {
    const email = `cc-${uniq()}@example.com`;
    const t = await token(email);
    const claudeTile = async () => {
      const html = await (await call("/app/connect", { as: email })).text();
      const at = html.indexOf('data-dialog="dlg-claude-code"');
      return { tile: html.slice(at, html.indexOf("</button>", at)), html };
    };
    expect((await claudeTile()).tile).not.toContain("Connected</span>");
    await rpc(t, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2.1.0" } });
    let page = await claudeTile();
    for (let i = 0; i < 20 && !page.tile.includes("Connected</span>"); i++) {
      await new Promise((r) => setTimeout(r, 25)); // the name is saved in the background
      page = await claudeTile();
    }
    expect(page.tile).toContain("Connected</span>");
    expect(page.html).toContain('claude-code with the access key &quot;mcp&quot;');
    expect(page.html).toContain('data-action="token-revoke"');
    expect(await (await call("/app/keys", { as: email })).text()).toContain("<td>claude-code</td>");
    // The Claude (chat) tile isn't affected.
    const chat = page.html.slice(page.html.indexOf('data-dialog="dlg-claude"'), page.html.indexOf("</button>", page.html.indexOf('data-dialog="dlg-claude"')));
    expect(chat).not.toContain("Connected</span>");
  });

  it("requires a valid bearer token", async () => {
    const res = await call("/mcp", { method: "POST", json: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("initializes and lists all tools", async () => {
    const t = await token();
    const init = await rpc(t, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(init.result.serverInfo.name).toBe("formelab");
    const { result } = await rpc(t, "tools/list");
    const names = result.tools.map((x: { name: string }) => x.name).sort();
    expect(names).toEqual(["delete_site", "fetch", "get_guide", "list_namespaces", "list_sites", "publish", "search", "update_site", "whoami"]);
    const del = result.tools.find((x: { name: string }) => x.name === "delete_site");
    expect(del.description).toMatch(/permanent/i);
  });

  it("publishes, lists, updates and deletes a hello-world app", async () => {
    const t = await token();
    const ns = uniq();
    expect((await tool(t, "whoami")).data.email).toBe(OWNER);

    const pub = await tool(t, "publish", { html: ICON_PAGE("<h1>Hello, world</h1>"), namespace: ns, mount_path: "hello", title: "Hello" });
    expect(pub.isError).toBe(false);
    expect(pub.data.url).toBe(`https://${ns}.example.app/hello/`);
    const page = await call(pub.data.url, { as: OWNER });
    expect(await page.text()).toContain("Hello, world");

    expect((await tool(t, "list_namespaces")).data.map((n: { label: string }) => n.label)).toContain(ns);
    const sites = (await tool(t, "list_sites", { namespace: ns })).data;
    expect(sites.map((s: { mountPath: string }) => s.mountPath)).toEqual(["hello"]);

    const upd = await tool(t, "update_site", { namespace: ns, mount_path: "hello", title: "Renamed", visibility: "restricted" });
    expect(upd.data).toMatchObject({ title: "Renamed", visibility: "restricted", spa: false });

    expect((await tool(t, "delete_site", { namespace: ns, mount_path: "hello" })).data).toEqual({ ok: true });
    expect((await call(pub.data.url, { as: OWNER })).status).toBe(404);
  });

  it("refuses apps without an icon, telling the AI how to add one", async () => {
    const t = await token();
    const ns = uniq();
    const r = await tool(t, "publish", { html: PAGE("no icon"), namespace: ns, mount_path: "x" });
    expect(r.isError).toBe(true);
    expect(r.data.error.code).toBe("icon_required");
    expect(r.data.error.hint).toContain('<link rel=\"icon\"'.replace(/\\/g, ""));
    // Nothing was published.
    const listed = await tool(t, "list_sites", { namespace: ns });
    expect(JSON.stringify(listed.data)).not.toContain('"mountPath":"x"');
    // A zip with an icon.svg file works too.
    const { makeZip } = await import("./helpers");
    const zip = makeZip({ "index.html": `<!doctype html><head><link rel="icon" href="icon.svg"></head><p>ok`, "icon.svg": "<svg xmlns='http://www.w3.org/2000/svg'/>" });
    let b64 = "";
    for (const byte of zip) b64 += String.fromCharCode(byte);
    expect((await tool(t, "publish", { zip_base64: btoa(b64), namespace: ns, mount_path: "y" })).isError).toBe(false);
    // The web app's own upload doesn't require one.
    expect((await publishHtmlPlain(ns)).status).toBe(201);
  });

  it("publishes a zip and requires exactly one of html / zip_base64", async () => {
    const t = await token();
    const { makeZip } = await import("./helpers");
    const zip = makeZip({ "index.html": ICON_PAGE("zipped"), "a.css": "body{}" });
    let b64 = "";
    for (const byte of zip) b64 += String.fromCharCode(byte);
    const pub = await tool(t, "publish", { zip_base64: btoa(b64), namespace: uniq(), mount_path: "" });
    expect(pub.data.site.fileCount).toBe(2);

    const both = await tool(t, "publish", { html: "x", zip_base64: "eA==", namespace: uniq(), mount_path: "" });
    expect(both.isError).toBe(true);
    expect(both.data.error.hint).toBeTruthy();
    const neither = await tool(t, "publish", { namespace: uniq(), mount_path: "" });
    expect(neither.isError).toBe(true);
  });

  it("returns permission errors as tool errors with hints", async () => {
    const ns = uniq();
    await tool(await token(), "publish", { html: ICON_PAGE("x"), namespace: ns, mount_path: "" });
    // Private by default: to someone else the app doesn't exist.
    const r = await tool(await token("mallory@example.com"), "delete_site", { namespace: ns, mount_path: "" });
    expect(r.isError).toBe(true);
    expect(r.data.error.code).toBe("not_found");
    expect(r.data.error.hint).toBeTruthy();
  });

  it("serves the guide", async () => {
    const r = await tool(await token(), "get_guide");
    expect(r.text).toContain("# Building apps for Formelab");
    expect(r.text).toContain("secrets.proxy");
  });
});
