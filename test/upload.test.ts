import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { ApiError } from "../src/errors";
import { filesFromUpload, filesFromZip, MAX_FILES, normalizeUploadPath } from "../src/upload";
import { makeZip, OWNER, publishZip, uniq } from "./helpers";

function rejects(fn: () => unknown, status: number, match?: RegExp) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).status).toBe(status);
    if (match) expect((e as ApiError).message).toMatch(match);
    return;
  }
  throw new Error("expected a rejection");
}

/** Rewrites the file name inside a zip (central + local headers) to an arbitrary byte string of the same length. */
function renameEntry(zip: Uint8Array, from: string, to: string): Uint8Array {
  expect(to.length).toBe(from.length);
  const out = zip.slice();
  const a = strToU8(from);
  const b = strToU8(to, true);
  for (let i = 0; i <= out.length - a.length; i++) {
    if (a.every((x, j) => out[i + j] === x)) out.set(b, i);
  }
  return out;
}

/** Marks every entry in the central directory as made by Unix with the given mode. */
function setUnixMode(zip: Uint8Array, name: string, mode: number): Uint8Array {
  const out = zip.slice();
  const dv = new DataView(out.buffer);
  const n = strToU8(name);
  for (let p = 0; p < out.length - 46; p++) {
    if (dv.getUint32(p, true) !== 0x02014b50) continue;
    const nameLen = dv.getUint16(p + 28, true);
    const entryName = out.subarray(p + 46, p + 46 + nameLen);
    if (entryName.length === n.length && entryName.every((x, i) => x === n[i])) {
      dv.setUint16(p + 4, (3 << 8) | 20, true);
      dv.setUint32(p + 38, (mode << 16) >>> 0, true);
    }
  }
  return out;
}

describe("security 8: upload validation", () => {
  it("accepts a normal zip", () => {
    const files = filesFromZip(makeZip({ "index.html": "<p>x</p>", "img/a.png": new Uint8Array([1, 2, 3]) }));
    expect([...files.keys()].sort()).toEqual(["img/a.png", "index.html"]);
  });

  it("normalizes paths and rejects traversal, absolute paths, backslashes and NUL bytes", () => {
    expect(normalizeUploadPath("a/./b//c.txt")).toBe("a/b/c.txt");
    expect(normalizeUploadPath("dir/")).toBeNull();
    for (const bad of ["../evil.html", "a/../../evil", "/etc/passwd", "C:/x", "a\\b.html", "a\0b"]) {
      rejects(() => normalizeUploadPath(bad), 400);
    }
  });

  it("rejects path traversal inside a real zip", () => {
    const zip = renameEntry(makeZip({ "index.html": "x", "aa/evil.html": "x" }), "aa/evil.html", "../evil.html");
    rejects(() => filesFromZip(zip), 400, /\.\./);
  });

  it("rejects backslash paths inside a real zip", () => {
    const zip = renameEntry(makeZip({ "index.html": "x", "a/b.html": "x" }), "a/b.html", "a\\b.html");
    rejects(() => filesFromZip(zip), 400, /backslash/);
  });

  it("rejects symlink entries", () => {
    const zip = setUnixMode(makeZip({ "index.html": "x", "link": "/etc/passwd" }), "link", 0o120777);
    rejects(() => filesFromZip(zip), 400, /symbolic link/);
  });

  it("rejects reserved paths", () => {
    for (const p of ["_api/x.json", "_platform/sdk.js", "_app/a.js", "healthz", "healthz/index.html"]) {
      rejects(() => filesFromZip(makeZip({ "index.html": "x", [p]: "1" })), 400, /reserved/);
    }
    // ...including after stripping a top-level folder.
    rejects(() => filesFromZip(makeZip({ "site/index.html": "x", "site/_api/x": "1" })), 400, /reserved/);
  });

  it("requires index.html at the root", () => {
    rejects(() => filesFromZip(makeZip({ "a/index.html": "x", "b.html": "y" })), 400, /index\.html/);
  });

  it("rejects oversized uploads", () => {
    const big = new Uint8Array(25 * 1024 * 1024 + 1);
    big.set([0x50, 0x4b, 3, 4]);
    rejects(() => filesFromZip(big), 413);
    rejects(() => filesFromUpload("x.html", big), 413);
  });

  it("rejects archives with too many files", () => {
    const files: Record<string, string> = { "index.html": "x" };
    for (let i = 0; i < MAX_FILES; i++) files[`f${i}.txt`] = "";
    rejects(() => filesFromZip(makeZip(files)), 413, /2000|files|entries/);
  });

  it("stops zip bombs while decompressing, even when the header lies about the size", () => {
    // 101 MB of zeros compresses to ~100 KB.
    const bomb = zipSync({ "index.html": strToU8("x"), "zeros.bin": new Uint8Array(101 * 1024 * 1024) }, { level: 9 });
    expect(bomb.length).toBeLessThan(1024 * 1024);
    rejects(() => filesFromZip(bomb), 413, /100 MB/);

    // Same, but with the declared uncompressed size forged to 1 byte.
    const forged = bomb.slice();
    const dv = new DataView(forged.buffer);
    for (let p = 0; p < forged.length - 4; p++) {
      if (dv.getUint32(p, true) === 0x02014b50) dv.setUint32(p + 24, 1, true);
      if (dv.getUint32(p, true) === 0x04034b50) dv.setUint32(p + 22, 1, true);
    }
    rejects(() => filesFromZip(forged), 413, /100 MB/);
  }, 30_000); // builds and inflates ~100 MB twice; slow under full-suite load

  it("rejects non-zip garbage and unknown file types", () => {
    rejects(() => filesFromZip(new Uint8Array([1, 2, 3, 4, 5])), 400);
    rejects(() => filesFromUpload("photo.png", new Uint8Array([1, 2, 3])), 400);
  });

  it("surfaces validation errors through the publish API with a hint", async () => {
    const zip = setUnixMode(makeZip({ "index.html": "x", "link": "/etc/passwd" }), "link", 0o120777);
    const fd = new FormData();
    fd.set("file", new File([zip], "s.zip"));
    fd.set("namespace", uniq());
    const { call } = await import("./helpers");
    const res = await call("/_api/admin/sites", { as: OWNER, method: "POST", body: fd });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string; message: string; hint: string } }>();
    expect(body.error.message).toMatch(/symbolic link/);
    expect(body.error.hint).toBeTruthy();
    expect((await publishZip(OWNER, uniq(), "", { "x/../../index.html": "x" })).status).toBe(400);
  });
});
