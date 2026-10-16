import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { applyChanges } from "../src/changes";
import { ApiError } from "../src/errors";
import { getSiteByMount, publishSite, type Ctx } from "../src/sites";
import { call, ICON_PAGE, makeZip, OWNER, publishHtml, uniq } from "./helpers";

const enc = new TextEncoder();
const dec = new TextDecoder();
const base = () =>
  new Map<string, Uint8Array>([
    ["index.html", enc.encode("<h1>Hi</h1>\n<p>one</p>\n<p>two</p>\n")],
    ["app.js", enc.encode("let n = 1;\n")],
    ["logo.png", new Uint8Array([0x89, 0x50, 0xff, 0xfe])],
  ]);
const text = (files: Map<string, Uint8Array>, p: string) => dec.decode(files.get(p));
const fails = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    return e as ApiError;
  }
  throw new Error("expected an error");
};

describe("applyChanges", () => {
  it("applies edits in order, defaulting to index.html, and keeps other files", () => {
    const b = base();
    const { files, changed } = applyChanges(b, {
      edits: [
        { old_str: "<p>one</p>", new_str: "<p>uno</p>" },
        { old_str: "uno", new_str: "eins" },
        { path: "app.js", old_str: "1", new_str: "$& $1 $$" }, // inserted literally, not as a replace pattern
      ],
    });
    expect(text(files, "index.html")).toBe("<h1>Hi</h1>\n<p>eins</p>\n<p>two</p>\n");
    expect(text(files, "app.js")).toBe("let n = $& $1 $$;\n");
    expect(files.get("logo.png")).toBe(b.get("logo.png"));
    expect(changed).toEqual(["app.js", "index.html"]);
    expect(text(b, "index.html")).toContain("one"); // the base is untouched
  });

  it("refuses an edit whose old_str is missing or ambiguous, naming it", () => {
    let e = fails(() => applyChanges(base(), { edits: [{ old_str: "<h1>Hi</h1>", new_str: "x" }, { old_str: "nope", new_str: "x" }] }));
    expect(e.message).toBe("Edit 2 (index.html): old_str was not found.");
    expect(e.hint).toContain("read_file");
    e = fails(() => applyChanges(base(), { edits: [{ old_str: "<p>", new_str: "x" }] }));
    expect(e.message).toContain("matches 2 places");
    expect(fails(() => applyChanges(base(), { edits: [{ old_str: "", new_str: "x" }] })).message).toContain("non-empty old_str");
    expect(fails(() => applyChanges(base(), { edits: [{ path: "nope.js", old_str: "a", new_str: "b" }] })).hint).toContain("app.js");
    expect(fails(() => applyChanges(base(), { edits: [{ path: "logo.png", old_str: "P", new_str: "b" }] })).message).toContain("not a text file");
    expect(fails(() => applyChanges(base(), { edits: [] })).message).toContain("non-empty");
  });

  it("adds, replaces and deletes whole files, then applies edits on top", () => {
    const { files, changed } = applyChanges(base(), {
      files: { "app.js": "let n = 2;\n", "css/site.css": "body{}", "logo.png": null },
      edits: [{ path: "css/site.css", old_str: "body{}", new_str: "body{margin:0}" }],
    });
    expect([...files.keys()].sort()).toEqual(["app.js", "css/site.css", "index.html"]);
    expect(text(files, "app.js")).toBe("let n = 2;\n");
    expect(text(files, "css/site.css")).toBe("body{margin:0}");
    expect(changed).toEqual(["app.js", "css/site.css", "logo.png"]);
    expect(fails(() => applyChanges(base(), { files: { "gone.js": null } })).message).toContain("not in the app");
    expect(fails(() => applyChanges(base(), { files: { "../x": "a" } })).message).toContain("..");
    expect(fails(() => applyChanges(base(), { files: { "_api/x": "a" } })).message).toContain("reserved");
    expect(fails(() => applyChanges(base(), { files: { "a.js": 3 } })).message).toContain("text");
  });

  it("lays a partial upload over the app and removes deleted paths", () => {
    const { files } = applyChanges(base(), { overlay: new Map([["app.js", enc.encode("new")]]), deletes: ["logo.png"] });
    expect([...files.keys()].sort()).toEqual(["app.js", "index.html"]);
    expect(text(files, "app.js")).toBe("new");
  });
});

describe("publishing on top of a version", () => {
  it("refuses changes built on a version that has since been replaced", async () => {
    const ns = uniq();
    const ctx: Ctx = { env, user: { email: OWNER, name: null, isAdmin: false, active: true }, waitUntil: () => {} };
    const files = () => new Map([["index.html", enc.encode(ICON_PAGE("v"))]]);
    expect((await publishHtml(OWNER, ns, "", ICON_PAGE("v"))).status).toBe(201); // signs the owner up too
    const first = (await getSiteByMount(env, ns, ""))!.current_version;
    await publishSite(ctx, { namespace: ns, mountPath: "", files: files() });
    await expect(publishSite(ctx, { namespace: ns, mountPath: "", files: files(), expectedVersion: first })).rejects.toThrow("changed while");
    const now = (await getSiteByMount(env, ns, ""))!.current_version;
    await publishSite(ctx, { namespace: ns, mountPath: "", files: files(), expectedVersion: now });
  });
});

async function token(as = OWNER) {
  const res = await call("/_api/admin/tokens", { as, method: "POST", json: { name: "deploy-test", ttlHours: 1 } });
  return (await res.json<{ token: string }>()).token;
}

describe("deploy API: changed files only", () => {
  it("lists hashes, takes a partial zip and deletions, and keeps everything else", async () => {
    const t = await token();
    const ns = uniq();
    const full = new FormData();
    full.set("file", new File([makeZip({ "index.html": ICON_PAGE("v1"), "assets/a.js": "a1", "assets/b.js": "b1", "old.txt": "x" })], "site.zip"));
    full.set("namespace", ns);
    full.set("mount_path", "app");
    expect((await call("/_api/deploy/sites", { token: t, method: "POST", body: full })).status).toBe(201);

    const q = `namespace=${ns}&mount_path=app`;
    const manifest = await (await call(`/_api/deploy/sites/manifest?${q}`, { token: t })).json<{ files: { path: string; sha256: string }[] }>();
    expect(manifest.files.map((f) => f.path)).toEqual(["assets/a.js", "assets/b.js", "index.html", "old.txt"]);
    const sum = await (await call(`/_api/deploy/sites/manifest?${q}&format=sha256sum`, { token: t })).text();
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode("a1")))].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(sum).toContain(`${digest}  assets/a.js\n`);
    expect((await call(`/_api/deploy/sites/manifest?namespace=${ns}&mount_path=nope`, { token: t })).status).toBe(404);
    expect((await call(`/_api/deploy/sites/manifest?${q}`, { token: await token("other@example.com") })).status).toBe(404);

    // Both changed files share a folder: it must not be stripped as a zip's top-level folder.
    const part = new FormData();
    part.set("file", new File([makeZip({ "assets/a.js": "a2", "assets/c.js": "c2" })], "changed.zip"));
    part.set("namespace", ns);
    part.set("mount_path", "app");
    part.set("merge", "true");
    part.set("delete", "old.txt\n");
    const res = await call("/_api/deploy/sites", { token: t, method: "POST", body: part });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await res.json<{ url: string; changed: string[] }>();
    expect(body.changed).toEqual(["assets/a.js", "assets/c.js", "old.txt"]);
    const get = async (p: string) => (await call(body.url + p, { as: OWNER })).text();
    expect(await get("assets/a.js")).toBe("a2");
    expect(await get("assets/b.js")).toBe("b1");
    expect(await get("assets/c.js")).toBe("c2");
    expect(await get("")).toContain("v1");
    expect((await call(body.url + "old.txt", { as: OWNER })).status).toBe(404);

    // Deletions alone need no file.
    const del = new FormData();
    del.set("namespace", ns);
    del.set("mount_path", "app");
    del.set("merge", "true");
    del.set("delete", "assets/c.js");
    expect((await call("/_api/deploy/sites", { token: t, method: "POST", body: del })).status).toBe(200);
    expect((await call(body.url + "assets/c.js", { as: OWNER })).status).toBe(404);

    // JSON edits work through the deploy API too.
    const edit = await call("/_api/deploy/sites", { token: t, method: "POST", json: { namespace: ns, mount_path: "app", edits: [{ old_str: "v1", new_str: "v2" }] } });
    expect(edit.status).toBe(200);
    expect(await get("")).toContain("v2");
  });
});
