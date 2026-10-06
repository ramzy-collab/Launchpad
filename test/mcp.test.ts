import { describe, expect, it } from "vitest";
import { call, OWNER, PAGE, uniq } from "./helpers";

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
    expect(names).toEqual(["delete_site", "get_guide", "list_namespaces", "list_sites", "publish", "update_site", "whoami"]);
    const del = result.tools.find((x: { name: string }) => x.name === "delete_site");
    expect(del.description).toMatch(/permanent/i);
  });

  it("publishes, lists, updates and deletes a hello-world app", async () => {
    const t = await token();
    const ns = uniq();
    expect((await tool(t, "whoami")).data.email).toBe(OWNER);

    const pub = await tool(t, "publish", { html: PAGE("<h1>Hello, world</h1>"), namespace: ns, mount_path: "hello", title: "Hello" });
    expect(pub.isError).toBe(false);
    expect(pub.data.url).toBe(`https://${ns}.example.com/hello/`);
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

  it("publishes a zip and requires exactly one of html / zip_base64", async () => {
    const t = await token();
    const { makeZip } = await import("./helpers");
    const zip = makeZip({ "index.html": PAGE("zipped"), "a.css": "body{}" });
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
    await tool(await token(), "publish", { html: PAGE("x"), namespace: ns, mount_path: "" });
    const r = await tool(await token("mallory@example.com"), "delete_site", { namespace: ns, mount_path: "" });
    expect(r.isError).toBe(true);
    expect(r.data.error.code).toBe("forbidden");
  });

  it("serves the guide", async () => {
    const r = await tool(await token(), "get_guide");
    expect(r.text).toContain("# Building apps for Formelab");
    expect(r.text).toContain("secrets.proxy");
  });
});
