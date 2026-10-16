import { filesFromJson } from "./api";
import { canManageSite } from "./auth";
import { badRequest, err } from "./errors";
import { currentFiles, getNamespace, getSiteByMount, validateLabel, validateMountPath, type Ctx } from "./sites";
import { checkReserved, MAX_FILES, MAX_TOTAL_BYTES, normalizeUploadPath, type FileMap } from "./upload";

// Publishing changes instead of a whole app: an AI sends a few find-and-replace edits or the text
// files it changed, a deploy script sends a zip of just the files that differ. Everything else is
// carried over from the app's live version on the server, so a one-line fix to a large app costs
// a few hundred bytes instead of the whole app.

/** What to change, on top of the app's current files. Applied in this order. */
export interface Changes {
  /** Files laid over the current ones, e.g. a zip of only the changed files. */
  overlay?: FileMap;
  /** Text files to add or replace, by path; null deletes the file. */
  files?: unknown;
  /** Paths to delete. */
  deletes?: unknown;
  /** Exact find-and-replace edits: [{ path?, old_str, new_str }], path defaulting to index.html. */
  edits?: unknown;
}

const MAX_EDITS = 500;
const NOTHING_PUBLISHED = "No changes were published.";

export const hasChanges = (c: Changes) =>
  c.overlay !== undefined || c.files !== undefined || c.deletes !== undefined || c.edits !== undefined;

function changePath(raw: unknown, what: string): string {
  if (typeof raw !== "string") throw badRequest(`${what} must be a file path string.`, NOTHING_PUBLISHED);
  const path = normalizeUploadPath(raw);
  if (path === null) throw badRequest(`${what} "${raw}" is not a file path.`, `Use a path like "index.html" or "js/app.js". ${NOTHING_PUBLISHED}`);
  checkReserved(path);
  return path;
}

function count(hay: string, needle: string): number {
  let n = 0;
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + needle.length)) n++;
  return n;
}

const listOf = (files: Map<string, unknown>) => {
  const paths = [...files.keys()].sort();
  return paths.length > 30 ? `${paths.slice(0, 30).join(", ")}, … (${paths.length} files)` : paths.join(", ");
};

/**
 * Applies `changes` to a copy of `base` and returns the new file map and the paths it touched.
 * All or nothing: any invalid change throws before anything is published.
 */
export function applyChanges(base: FileMap, changes: Changes): { files: FileMap; changed: string[] } {
  const files: FileMap = new Map(base);
  const changed = new Set<string>();
  const enc = new TextEncoder();

  for (const [path, data] of changes.overlay ?? []) {
    files.set(path, data);
    changed.add(path);
  }

  if (changes.files !== undefined) {
    const f = changes.files;
    if (!f || typeof f !== "object" || Array.isArray(f)) {
      throw badRequest("files must be an object of { path: text }.", `Use null as the text to delete a file. ${NOTHING_PUBLISHED}`);
    }
    for (const [raw, text] of Object.entries(f as Record<string, unknown>)) {
      const path = changePath(raw, "A key in files");
      if (text === null) {
        if (!files.delete(path)) throw badRequest(`files says to delete "${path}", which is not in the app.`, `The app has: ${listOf(files)}. ${NOTHING_PUBLISHED}`);
      } else if (typeof text === "string") {
        files.set(path, enc.encode(text));
      } else {
        throw badRequest(`files["${path}"] must be the file's text, or null to delete it.`, NOTHING_PUBLISHED);
      }
      changed.add(path);
    }
  }

  if (changes.deletes !== undefined) {
    if (!Array.isArray(changes.deletes)) throw badRequest("delete must be a list of file paths.", NOTHING_PUBLISHED);
    for (const raw of changes.deletes) {
      const path = changePath(raw, "A path in delete");
      if (!files.delete(path)) throw badRequest(`delete names "${path}", which is not in the app.`, NOTHING_PUBLISHED);
      changed.add(path);
    }
  }

  if (changes.edits !== undefined) {
    const edits = changes.edits;
    if (!Array.isArray(edits) || edits.length === 0) throw badRequest("edits must be a non-empty list.", NOTHING_PUBLISHED);
    if (edits.length > MAX_EDITS) throw badRequest(`Too many edits (${edits.length}); the limit is ${MAX_EDITS}.`, "Send the changed files whole with files instead.");
    // Edited files stay decoded until every edit has been applied.
    const texts = new Map<string, string>();
    const dec = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    edits.forEach((e: unknown, i) => {
      const n = `Edit ${i + 1}`;
      if (!e || typeof e !== "object") throw badRequest(`${n} must be an object with old_str and new_str.`, NOTHING_PUBLISHED);
      const { path: rawPath, old_str: oldStr, new_str: newStr } = e as Record<string, unknown>;
      const path = rawPath === undefined || rawPath === "" ? "index.html" : changePath(rawPath, `${n}'s path`);
      if (typeof oldStr !== "string" || oldStr === "") throw badRequest(`${n} (${path}) needs a non-empty old_str.`, NOTHING_PUBLISHED);
      if (typeof newStr !== "string") throw badRequest(`${n} (${path}) needs new_str (use "" to delete old_str).`, NOTHING_PUBLISHED);
      let text = texts.get(path);
      if (text === undefined) {
        const data = files.get(path);
        if (!data) throw badRequest(`${n}: "${path}" is not in the app.`, `The app has: ${listOf(files)}. ${NOTHING_PUBLISHED}`);
        try {
          text = dec.decode(data);
        } catch {
          throw badRequest(`${n}: "${path}" is not a text file, so it can't be edited.`, `Replace it with a zip instead. ${NOTHING_PUBLISHED}`);
        }
      }
      const found = count(text, oldStr);
      if (found === 0) {
        throw badRequest(
          `${n} (${path}): old_str was not found.`,
          `Copy old_str exactly from the app's current source (read it with read_file), including spaces and line breaks; earlier edits in the list are applied first. ${NOTHING_PUBLISHED}`,
        );
      }
      if (found > 1) {
        throw badRequest(`${n} (${path}): old_str matches ${found} places.`, `Include more of the surrounding text so it matches exactly once. ${NOTHING_PUBLISHED}`);
      }
      const at = text.indexOf(oldStr);
      texts.set(path, text.slice(0, at) + newStr + text.slice(at + oldStr.length));
      changed.add(path);
    });
    for (const [path, text] of texts) files.set(path, enc.encode(text));
  }

  if (files.size > MAX_FILES) throw err(413, "too_large", `The app would have ${files.size} files; the limit is ${MAX_FILES}.`, NOTHING_PUBLISHED);
  let total = 0;
  for (const d of files.values()) total += d.length;
  if (total > MAX_TOTAL_BYTES) throw err(413, "too_large", "The app would be larger than 100 MB.", NOTHING_PUBLISHED);
  return { files, changed: [...changed].sort() };
}

/**
 * The files to publish for a publish request: a whole app (`html` or `zip_base64`), or changes
 * (`files`, `edits`, plus a partial zip and deletions from the deploy API) on top of the app's live
 * version. `expectedVersion` is set when changes were applied, so a publish in between is refused.
 */
export async function filesForPublish(
  ctx: Ctx,
  body: Record<string, unknown>,
  extra: Pick<Changes, "overlay" | "deletes"> = {},
): Promise<{ files: FileMap; expectedVersion?: string; changed?: string[] }> {
  const changes: Changes = { ...extra, files: body.files, edits: body.edits };
  const whole = body.html !== undefined || body.zip_base64 !== undefined;
  if (!hasChanges(changes)) {
    if (!whole) throw badRequest("Nothing to publish.", "Send the whole app as html or zip_base64, or changes to an existing app as edits or files.");
    return { files: filesFromJson(body) };
  }
  if (whole) throw badRequest("Send either a whole app (html or zip_base64) or changes (edits, files), not both.", "To change an existing app, send only the edits or the changed files.");

  const label = validateLabel(body.namespace);
  const mount = validateMountPath(body.mount_path ?? "");
  const existing = await getSiteByMount(ctx.env, label, mount);
  if (!existing) {
    // A new app can be made from files alone (index.html among them); anything else needs an app to change.
    if (changes.edits !== undefined || changes.deletes !== undefined || changes.overlay !== undefined) {
      throw err(404, "not_found", `There is no app at ${label}/${mount || "(root)"} to change.`, "Check namespace and mount_path, or publish the whole app first (html, zip_base64, or files including index.html).");
    }
    return applyChanges(new Map(), changes);
  }
  const ns = await getNamespace(ctx.env, label);
  if (!ns || !canManageSite(ctx.user, existing, ns)) {
    throw err(409, "not_yours", `A site at ${label}/${mount} already exists and you cannot replace it.`, "Ask its owner to add you as an editor, or publish to a different path.");
  }
  const expectedVersion = existing.current_version;
  return { ...applyChanges(await currentFiles(ctx.env, existing), changes), expectedVersion };
}
