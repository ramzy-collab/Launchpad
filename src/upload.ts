import { Inflate } from "fflate";
import { badRequest, err } from "./errors";

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
export const MAX_FILES = 2000;

export type FileMap = Map<string, Uint8Array>;

const tooLarge = (message: string) =>
  err(413, "too_large", message, "Shrink the upload: remove unused images, videos or build artifacts, then try again.");
const invalidZip = (message: string) =>
  badRequest(message, "Upload a normal .zip file (no encryption) with index.html at its root, or a single .html file.");

const RESERVED_FIRST_SEGMENTS = new Set(["_api", "_platform", "_app"]);

/**
 * Normalizes a relative file path from an upload. Returns null for directory entries.
 * Throws on absolute paths, "..", backslashes, NUL bytes, and reserved prefixes.
 */
export function normalizeUploadPath(raw: string): string | null {
  if (raw.includes("\0")) throw invalidZip(`File path contains a NUL byte.`);
  if (raw.includes("\\")) throw invalidZip(`File path "${clip(raw)}" contains a backslash.`);
  if (raw.startsWith("/") || /^[a-zA-Z]:/.test(raw)) throw invalidZip(`File path "${clip(raw)}" is absolute.`);
  const parts: string[] = [];
  for (const seg of raw.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") throw invalidZip(`File path "${clip(raw)}" contains "..".`);
    parts.push(seg);
  }
  if (parts.length === 0) return null;
  if (raw.endsWith("/")) return null;
  return parts.join("/");
}

export function checkReserved(path: string) {
  const first = path.split("/")[0]!;
  if (RESERVED_FIRST_SEGMENTS.has(first) || first === "healthz") {
    throw badRequest(
      `The upload contains "${clip(path)}", which is under a reserved path (/_api/, /_platform/, /_app/, /healthz).`,
      "Rename or move that file. Those paths belong to the platform.",
    );
  }
}

const clip = (s: string) => (s.length > 120 ? s.slice(0, 117) + "..." : s);

/** Accepts a single HTML document as the whole site. */
export function filesFromHtml(html: string): FileMap {
  const bytes = new TextEncoder().encode(html);
  if (bytes.length > MAX_UPLOAD_BYTES) throw tooLarge("The HTML file is larger than 25 MB.");
  return new Map([["index.html", bytes]]);
}

interface CentralEntry {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  isSymlink: boolean;
  isDir: boolean;
}

function readCentralDirectory(buf: Uint8Array): CentralEntry[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // End of central directory record: scan backwards (comment can be up to 65535 bytes).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw invalidZip("This file is not a valid zip archive.");
  const count = dv.getUint16(eocd + 10, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  if (count === 0xffff || cdOffset === 0xffffffff) throw invalidZip("ZIP64 archives are not supported.");
  if (count > MAX_FILES) throw tooLarge(`The zip has ${count} entries; the limit is ${MAX_FILES} files.`);
  if (cdOffset + cdSize > buf.length) throw invalidZip("The zip archive is truncated or corrupt.");

  const decoder = new TextDecoder("utf-8");
  const entries: CentralEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || dv.getUint32(p, true) !== 0x02014b50) throw invalidZip("The zip central directory is corrupt.");
    const madeBy = dv.getUint16(p + 4, true) >> 8;
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const compressedSize = dv.getUint32(p + 20, true);
    const uncompressedSize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const externalAttrs = dv.getUint32(p + 38, true);
    const localOffset = dv.getUint32(p + 42, true);
    if (p + 46 + nameLen > buf.length) throw invalidZip("The zip central directory is corrupt.");
    const name = decoder.decode(buf.subarray(p + 46, p + 46 + nameLen));
    const unixMode = externalAttrs >>> 16;
    // Unix (3) and macOS (19) archivers record the file type in the high bits.
    const isSymlink = (madeBy === 3 || madeBy === 19) && (unixMode & 0o170000) === 0o120000;
    const isDir = name.endsWith("/") || ((madeBy === 3 || madeBy === 19) && (unixMode & 0o170000) === 0o040000);
    entries.push({ name, method, flags, compressedSize, uncompressedSize, localOffset, isSymlink, isDir });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function inflateLimited(data: Uint8Array, budget: { remaining: number }, name: string): Uint8Array {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let overflow = false;
  const inflater = new Inflate((chunk) => {
    if (overflow) return;
    size += chunk.length;
    budget.remaining -= chunk.length;
    if (budget.remaining < 0) {
      overflow = true;
      return;
    }
    chunks.push(chunk);
  });
  const STEP = 16 * 1024; // small steps bound how far one push can overshoot the budget
  try {
    for (let off = 0; off < data.length && !overflow; off += STEP) {
      inflater.push(data.subarray(off, Math.min(off + STEP, data.length)), off + STEP >= data.length);
    }
  } catch {
    throw invalidZip(`Could not decompress "${clip(name)}"; the zip may be corrupt.`);
  }
  if (overflow) throw tooLarge("The zip expands to more than 100 MB.");
  const out = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/**
 * Unzips an upload into a file map, enforcing every limit while decompressing:
 * 25 MB compressed, 100 MB uncompressed in total, 2,000 files, no symlinks,
 * no traversal, no reserved paths, and index.html at the root (after stripping
 * a single shared top-level folder).
 */
export function filesFromZip(zip: Uint8Array): FileMap {
  if (zip.length > MAX_UPLOAD_BYTES) throw tooLarge("The upload is larger than 25 MB.");
  const entries = readCentralDirectory(zip);
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);

  // First pass: validate names and declared sizes before decompressing anything.
  const files: { path: string; entry: CentralEntry }[] = [];
  let declared = 0;
  for (const e of entries) {
    if (e.isSymlink) throw invalidZip(`The zip contains a symbolic link ("${clip(e.name)}"). Symlinks are not allowed.`);
    const path = normalizeUploadPath(e.name);
    if (path === null || e.isDir) continue;
    if (e.flags & 1) throw invalidZip("Encrypted zip entries are not supported.");
    if (e.method !== 0 && e.method !== 8) throw invalidZip(`"${clip(e.name)}" uses an unsupported compression method.`);
    declared += e.uncompressedSize;
    if (declared > MAX_TOTAL_BYTES) throw tooLarge("The zip expands to more than 100 MB.");
    files.push({ path, entry: e });
  }
  if (files.length > MAX_FILES) throw tooLarge(`The zip has more than ${MAX_FILES} files.`);
  if (files.length === 0) throw invalidZip("The zip is empty.");

  // Strip one shared top-level folder ("my-app/index.html" -> "index.html").
  const firstSegs = new Set(files.map((f) => (f.path.includes("/") ? f.path.split("/")[0] : "")));
  if (firstSegs.size === 1 && !firstSegs.has("")) {
    const prefix = [...firstSegs][0] + "/";
    for (const f of files) f.path = f.path.slice(prefix.length);
  }
  const out: FileMap = new Map();
  for (const f of files) {
    checkReserved(f.path);
    if (out.has(f.path)) throw invalidZip(`The zip contains "${clip(f.path)}" more than once.`);
    out.set(f.path, new Uint8Array(0));
  }
  if (!out.has("index.html")) {
    throw badRequest("The zip has no index.html at its root.", "Put index.html at the top level of the zip (or inside a single top-level folder).");
  }

  // Second pass: decompress with a running budget so a zip bomb is stopped early,
  // regardless of the sizes the archive claims.
  const budget = { remaining: MAX_TOTAL_BYTES };
  for (const f of files) {
    const e = f.entry;
    const lo = e.localOffset;
    if (lo + 30 > zip.length || dv.getUint32(lo, true) !== 0x04034b50) throw invalidZip("The zip archive is corrupt.");
    const start = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true);
    const end = start + e.compressedSize;
    if (end > zip.length) throw invalidZip("The zip archive is truncated.");
    const raw = zip.subarray(start, end);
    let data: Uint8Array;
    if (e.method === 0) {
      budget.remaining -= raw.length;
      if (budget.remaining < 0) throw tooLarge("The zip expands to more than 100 MB.");
      data = raw.slice();
    } else {
      data = inflateLimited(raw, budget, e.name);
    }
    out.set(f.path, data);
  }
  return out;
}

const looksLikeZip = (b: Uint8Array) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5);

/** Turns an uploaded file (by name and bytes) into a file map. */
export function filesFromUpload(filename: string, bytes: Uint8Array): FileMap {
  if (bytes.length > MAX_UPLOAD_BYTES) throw tooLarge("The upload is larger than 25 MB.");
  const lower = filename.toLowerCase();
  if (lower.endsWith(".zip") || looksLikeZip(bytes)) return filesFromZip(bytes);
  if (lower.endsWith(".html") || lower.endsWith(".htm") || lower === "" || lower === "blob") {
    return filesFromHtml(new TextDecoder().decode(bytes));
  }
  throw badRequest(`Unsupported file type: "${clip(filename)}".`, "Upload a single .html file or a .zip with index.html at its root.");
}
