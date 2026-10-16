import { describe, expect, it } from "vitest";
import { call, ICON_PAGE, OWNER, PAGE, publishHtml, uniq, appAt } from "./helpers";

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
    expect(names).toEqual(["delete_site", "fetch", "get_guide", "list_namespaces", "list_sites", "publish", "read_file", "search", "update_site", "whoami"]);
    const del = result.tools.find((x: { name: string }) => x.name === "delete_site");
    expect(del.description).toMatch(/permanent/i);
  });

  it("publishes, lists, updates and deletes a hello-world app", async () => {
    const t = await token();
    const ns = uniq();
    expect((await tool(t, "whoami")).data.email).toBe(OWNER);

    const pub = await tool(t, "publish", { html: ICON_PAGE("<h1>Hello, world</h1>"), namespace: ns, mount_path: "hello", title: "Hello" });
    expect(pub.isError).toBe(false);
    expect(pub.data.url).toBe(`${await appAt(ns, "hello")}/`);
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

  it("updates an app with edits and partial files instead of the whole app", async () => {
    const t = await token();
    const ns = uniq();
    const pub = await tool(t, "publish", { html: ICON_PAGE("<h1>Count</h1><p>v1</p>"), namespace: ns, mount_path: "c", title: "Count" });
    expect(pub.isError).toBe(false);
    const kv = (init: Parameters<typeof call>[1] = {}) => call(`${pub.data.url}_api/kv/hits`, { as: OWNER, mount: "/c/", ...init });
    expect((await kv({ method: "PUT", body: "7" })).status).toBe(200);

    const ed = await tool(t, "publish", { namespace: ns, mount_path: "c", edits: [{ old_str: "<p>v1</p>", new_str: "<p>v2</p><script src=\"app.js\"></script>" }] });
    expect(ed.isError, ed.text).toBe(false);
    expect(ed.data).toMatchObject({ url: pub.data.url, replaced: true, changed: ["index.html"] });
    expect(await (await call(pub.data.url, { as: OWNER })).text()).toContain("<p>v2</p>");

    const fl = await tool(t, "publish", { namespace: ns, mount_path: "c", files: { "app.js": "console.log(1)" }, edits: [{ path: "app.js", old_str: "1", new_str: "2" }] });
    expect(fl.data.site.fileCount).toBe(2);
    expect(await (await call(`${pub.data.url}app.js`, { as: OWNER })).text()).toBe("console.log(2)");
    expect(await (await call(pub.data.url, { as: OWNER })).text()).toContain("<p>v2</p>"); // untouched
    // Data and settings are kept, as with a whole publish.
    expect(await (await kv()).json()).toEqual({ value: 7 });
    expect(fl.data.site.title).toBe("Count");

    // A failed edit publishes nothing.
    const bad = await tool(t, "publish", { namespace: ns, mount_path: "c", edits: [{ old_str: "v2", new_str: "v3" }, { old_str: "missing", new_str: "x" }] });
    expect(bad.isError).toBe(true);
    expect(bad.data.error.message).toBe("Edit 2 (index.html): old_str was not found.");
    expect(await (await call(pub.data.url, { as: OWNER })).text()).toContain("<p>v2</p>");

    // A new app from files alone; edits need an existing app; whole app and changes don't mix.
    expect((await tool(t, "publish", { namespace: ns, mount_path: "f", files: { "index.html": ICON_PAGE("from files"), "a.css": "" } })).data.site.fileCount).toBe(2);
    expect((await tool(t, "publish", { namespace: ns, mount_path: "nope", edits: [{ old_str: "a", new_str: "b" }] })).data.error.code).toBe("not_found");
    expect((await tool(t, "publish", { namespace: ns, mount_path: "c", html: ICON_PAGE("x"), edits: [{ old_str: "a", new_str: "b" }] })).data.error.message).toContain("not both");

    // Someone who can't manage the app learns nothing about its contents.
    const other = await tool(await token("mallory@example.com"), "publish", { namespace: ns, mount_path: "c", edits: [{ old_str: "secret", new_str: "x" }] });
    expect(other.data.error.code).toBe("not_yours");
  });

  it("reads an app's files whole, in pages for large ones", async () => {
    const t = await token();
    const ns = uniq();
    const big = "x".repeat(600 * 1024);
    const { makeZip } = await import("./helpers");
    const zip = makeZip({ "index.html": ICON_PAGE("<p>hello</p>"), "big.js": `/*${big}*/`, "logo.png": new Uint8Array([0x89, 0x50, 0xff, 0xfe]) });
    let b64 = "";
    for (const byte of zip) b64 += String.fromCharCode(byte);
    expect((await tool(t, "publish", { zip_base64: btoa(b64), namespace: ns, mount_path: "r" })).isError).toBe(false);

    const idx = await tool(t, "read_file", { namespace: ns, mount_path: "r" });
    expect(idx.text).toContain("File: index.html");
    expect(idx.text).toContain("big.js (");
    expect(idx.text.endsWith(ICON_PAGE("<p>hello</p>"))).toBe(true);

    const p1 = await tool(t, "read_file", { namespace: ns, mount_path: "r", path: "big.js" });
    const next = Number(/offset (\d+)/.exec(p1.text)?.[1]);
    expect(next).toBe(512 * 1024);
    const p2 = await tool(t, "read_file", { namespace: ns, mount_path: "r", path: "big.js", offset: next });
    expect(p2.text).not.toContain("More follows");
    const body = (r: string) => r.slice(r.indexOf("\n\n") + 2);
    expect(body(p1.text) + body(p2.text)).toBe(`/*${big}*/`);

    expect((await tool(t, "read_file", { namespace: ns, mount_path: "r", path: "logo.png" })).text).toContain("binary file");
    const missing = await tool(t, "read_file", { namespace: ns, mount_path: "r", path: "nope.js" });
    expect(missing.isError).toBe(true);
    expect(missing.data.error.hint).toContain("big.js");
    expect((await tool(await token("mallory@example.com"), "read_file", { namespace: ns, mount_path: "r" })).data.error.code).toBe("not_found");
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
