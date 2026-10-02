import { audit } from "./audit";
import { canManageSite, canPublishTo, canViewSite, isNamespaceEditor, isNamespaceOwner, ownerOnly } from "./auth";
import type { Env, User } from "./env";
import { isDev, now } from "./env";
import { badRequest, err, forbidden, notFound } from "./errors";
import { contentTypeFor } from "./mime";
import type { FileMap } from "./upload";
import { isEmail, normEmail, parseJsonArray, randomId, sortableId } from "./util";

export interface NamespaceRow {
  label: string;
  owner_email: string;
  editors: string;
  created_at: number;
}

export interface SiteRow {
  id: string;
  namespace: string;
  mount_path: string;
  title: string | null;
  owner_email: string;
  editors: string;
  visibility: "all" | "restricted";
  allowed_emails: string;
  hidden: number;
  spa: number;
  current_version: string;
  file_count: number;
  total_bytes: number;
  created_at: number;
  updated_at: number;
}

/** Everything a service call needs: bindings, the acting user, and a way to defer work. */
export interface Ctx {
  env: Env;
  user: User;
  waitUntil: (p: Promise<unknown>) => void;
  /** The incoming request URL; in dev it decides the scheme and port of returned URLs. */
  requestUrl?: string;
}

// ---------------------------------------------------------------------------
// Names and paths
// ---------------------------------------------------------------------------

export const RESERVED_LABELS = new Set(["www", "api", "admin", "mcp", "static", "platform"]);
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SEGMENT_RE = /^[a-z0-9-]{1,63}$/;

export function validateLabel(raw: unknown): string {
  const label = String(raw ?? "").trim().toLowerCase();
  if (!LABEL_RE.test(label)) {
    throw badRequest(
      `"${String(raw ?? "").slice(0, 70)}" is not a valid namespace name.`,
      "Use 1–63 lowercase letters, digits or hyphens, not starting or ending with a hyphen. Example: \"ramzy\".",
    );
  }
  if (RESERVED_LABELS.has(label)) {
    throw badRequest(`"${label}" is a reserved name.`, "Pick another namespace name; www, api, admin, mcp, static and platform are reserved.");
  }
  return label;
}

/** Normalizes "", "/", "/a/b/", "a/b" to "" or "a/b" and validates each segment. */
export function validateMountPath(raw: unknown): string {
  const s = String(raw ?? "").trim().toLowerCase().replace(/^\/+|\/+$/g, "");
  if (s === "") return "";
  const segs = s.split("/");
  if (segs.length > 8 || !segs.every((x) => SEGMENT_RE.test(x))) {
    throw badRequest(
      `"${String(raw).slice(0, 100)}" is not a valid mount path.`,
      "Use lowercase letters, digits and hyphens, with \"/\" between parts. Example: \"tools/budget\". Use \"\" for the namespace root.",
    );
  }
  if (segs[0] === "healthz") throw badRequest(`"healthz" is reserved.`, "Pick another mount path.");
  return segs.join("/");
}

export function emailList(raw: unknown, field: string): string[] {
  let list: unknown = raw;
  if (raw === undefined || raw === null || raw === "") return [];
  if (typeof raw === "string") {
    const t = raw.trim();
    list = t.startsWith("[") ? safeJson(t) : t.split(/[\s,;]+/);
  }
  if (!Array.isArray(list)) throw badRequest(`${field} must be a list of email addresses.`, "Send an array like [\"a@example.com\"] or a comma-separated string.");
  const out = [...new Set(list.map((x) => normEmail(String(x))).filter(Boolean))];
  const bad = out.find((e) => !isEmail(e));
  if (bad) throw badRequest(`"${bad.slice(0, 80)}" in ${field} is not an email address.`, "Fix the address and try again.");
  if (out.length > 200) throw badRequest(`${field} can hold at most 200 addresses.`, "Trim the list.");
  return out;
}

const safeJson = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

export function parseVisibility(raw: unknown): "all" | "restricted" | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (raw === "all" || raw === "restricted") return raw;
  throw badRequest(`visibility must be "all" or "restricted".`, "\"all\" lets anyone signed in see the app; \"restricted\" limits it to the allow-list.");
}

export function parseBool(raw: unknown): boolean | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw === "boolean") return raw;
  if (raw === 1 || raw === "1" || raw === "true" || raw === "on" || raw === "yes") return true;
  if (raw === 0 || raw === "0" || raw === "false" || raw === "off" || raw === "no") return false;
  throw badRequest(`Expected true or false, got "${String(raw).slice(0, 20)}".`, "Use true or false.");
}

export function parseTitle(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  const t = String(raw).trim();
  if (t.length > 200) throw badRequest("Title must be at most 200 characters.", "Shorten the title.");
  return t || null;
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

export function nsOrigin(env: Env, ns: string, requestUrl?: string): string {
  if (isDev(env) && requestUrl) {
    const u = new URL(requestUrl);
    return `${u.protocol}//${ns}.${env.DOMAIN}${u.port ? ":" + u.port : ""}`;
  }
  return `https://${ns}.${env.DOMAIN}`;
}

export const siteUrl = (env: Env, ns: string, mount: string, requestUrl?: string) =>
  `${nsOrigin(env, ns, requestUrl)}/${mount ? mount + "/" : ""}`;

export interface SiteView {
  id: string;
  namespace: string;
  mountPath: string;
  url: string;
  title: string | null;
  ownerEmail: string;
  editors: string[];
  visibility: "all" | "restricted";
  allowedEmails: string[];
  hidden: boolean;
  spa: boolean;
  fileCount: number;
  totalBytes: number;
  createdAt: number;
  updatedAt: number;
}

export const siteView = (env: Env, s: SiteRow, requestUrl?: string): SiteView => ({
  id: s.id,
  namespace: s.namespace,
  mountPath: s.mount_path,
  url: siteUrl(env, s.namespace, s.mount_path, requestUrl),
  title: s.title,
  ownerEmail: s.owner_email,
  editors: parseJsonArray(s.editors),
  visibility: s.visibility,
  allowedEmails: parseJsonArray(s.allowed_emails),
  hidden: !!s.hidden,
  spa: !!s.spa,
  fileCount: s.file_count,
  totalBytes: s.total_bytes,
  createdAt: s.created_at,
  updatedAt: s.updated_at,
});

export const namespaceView = (n: NamespaceRow, user: User, env: Env, requestUrl?: string) => ({
  label: n.label,
  url: nsOrigin(env, n.label, requestUrl) + "/",
  ownerEmail: n.owner_email,
  editors: parseJsonArray(n.editors),
  isOwner: n.owner_email === user.email,
  createdAt: n.created_at,
});

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export const getNamespace = (env: Env, label: string) =>
  env.DB.prepare("SELECT * FROM namespaces WHERE label = ?").bind(label).first<NamespaceRow>();

export const getSiteById = (env: Env, id: string) => env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(id).first<SiteRow>();

export const getSiteByMount = (env: Env, ns: string, mount: string) =>
  env.DB.prepare("SELECT * FROM sites WHERE namespace = ? AND mount_path = ?").bind(ns, mount).first<SiteRow>();

/** Finds the site whose mount path is the longest prefix of `path` (which starts with "/"). */
export async function resolveSiteForPath(env: Env, ns: string, path: string): Promise<SiteRow | null> {
  const { results } = await env.DB.prepare("SELECT * FROM sites WHERE namespace = ?").bind(ns).all<SiteRow>();
  let best: SiteRow | null = null;
  for (const s of results) {
    const m = s.mount_path;
    const matches = m === "" || path === "/" + m || path.startsWith("/" + m + "/");
    if (matches && (!best || m.length > best.mount_path.length)) best = s;
  }
  return best;
}

async function requireNamespace(env: Env, label: string) {
  const ns = await getNamespace(env, label);
  if (!ns) throw notFound(`Namespace "${label}"`);
  return ns;
}

async function requireManageableSite(ctx: Ctx, id: string) {
  const site = await getSiteById(ctx.env, id);
  if (!site) throw notFound("Site");
  const ns = await requireNamespace(ctx.env, site.namespace);
  if (!canManageSite(ctx.user, site, ns)) {
    // Do not reveal restricted sites to people who cannot see them.
    if (!canViewSite(ctx.user, site, ns)) throw notFound("Site");
    throw forbidden("You cannot change this site.");
  }
  return { site, ns };
}

// ---------------------------------------------------------------------------
// Namespaces
// ---------------------------------------------------------------------------

export async function listNamespaces(ctx: Ctx) {
  const { results } = await ctx.env.DB.prepare("SELECT * FROM namespaces ORDER BY label").all<NamespaceRow>();
  return results.filter((n) => isNamespaceEditor(ctx.user, n)).map((n) => namespaceView(n, ctx.user, ctx.env, ctx.requestUrl));
}

export async function createNamespace(ctx: Ctx, rawLabel: unknown) {
  const label = validateLabel(rawLabel);
  const existing = await getNamespace(ctx.env, label);
  if (existing) {
    throw err(409, "namespace_taken", `The namespace "${label}" already exists.`, existing.owner_email === ctx.user.email ? "You already own it; publish into it." : "Pick a different name.");
  }
  const row: NamespaceRow = { label, owner_email: ctx.user.email, editors: "[]", created_at: now() };
  try {
    await ctx.env.DB.prepare("INSERT INTO namespaces (label, owner_email, editors, created_at) VALUES (?, ?, ?, ?)")
      .bind(row.label, row.owner_email, row.editors, row.created_at)
      .run();
  } catch {
    throw err(409, "namespace_taken", `The namespace "${label}" already exists.`, "Pick a different name.");
  }
  await audit(ctx.env, ctx.user.email, "namespace_create", label);
  return namespaceView(row, ctx.user, ctx.env, ctx.requestUrl);
}

export async function updateNamespaceEditors(ctx: Ctx, rawLabel: string, rawEditors: unknown) {
  const ns = await requireNamespace(ctx.env, String(rawLabel).toLowerCase());
  if (!isNamespaceOwner(ctx.user, ns)) throw ownerOnly();
  const editors = emailList(rawEditors, "editors");
  await ctx.env.DB.prepare("UPDATE namespaces SET editors = ? WHERE label = ?").bind(JSON.stringify(editors), ns.label).run();
  await audit(ctx.env, ctx.user.email, "namespace_editors", ns.label, { editors });
  return namespaceView({ ...ns, editors: JSON.stringify(editors) }, ctx.user, ctx.env, ctx.requestUrl);
}

export async function deleteNamespace(ctx: Ctx, rawLabel: string) {
  const ns = await requireNamespace(ctx.env, String(rawLabel).toLowerCase());
  if (!isNamespaceOwner(ctx.user, ns)) throw ownerOnly();
  const { results } = await ctx.env.DB.prepare("SELECT * FROM sites WHERE namespace = ?").bind(ns.label).all<SiteRow>();
  for (const s of results) await removeSite(ctx.env, s);
  await ctx.env.DB.prepare("DELETE FROM namespaces WHERE label = ?").bind(ns.label).run();
  await audit(ctx.env, ctx.user.email, "namespace_delete", ns.label, { sites: results.length });
  return { ok: true, deletedSites: results.length };
}

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

export async function listSites(ctx: Ctx, rawNamespace?: string | null) {
  const { env, user } = ctx;
  const namespaces = new Map(
    (await env.DB.prepare("SELECT * FROM namespaces").all<NamespaceRow>()).results.map((n) => [n.label, n]),
  );
  let sites: SiteRow[];
  if (rawNamespace) {
    const label = String(rawNamespace).toLowerCase();
    if (!namespaces.has(label)) throw notFound(`Namespace "${label}"`);
    sites = (await env.DB.prepare("SELECT * FROM sites WHERE namespace = ? ORDER BY mount_path").bind(label).all<SiteRow>()).results;
  } else {
    sites = (await env.DB.prepare("SELECT * FROM sites ORDER BY namespace, mount_path").all<SiteRow>()).results;
  }
  return sites
    .filter((s) => {
      const ns = namespaces.get(s.namespace);
      if (!ns) return false;
      const manage = canManageSite(user, s, ns);
      if (!rawNamespace) return manage; // "my sites"
      if (s.hidden && !manage) return false;
      return canViewSite(user, s, ns);
    })
    .map((s) => ({ ...siteView(env, s, ctx.requestUrl), canManage: canManageSite(user, s, namespaces.get(s.namespace)!) }));
}

export interface PublishInput {
  namespace: unknown;
  mountPath: unknown;
  files: FileMap;
  title?: unknown;
  spa?: unknown;
  visibility?: unknown;
  allowedEmails?: unknown;
  editors?: unknown;
}

const R2_CONCURRENCY = 8;

async function putFiles(bucket: R2Bucket, prefix: string, files: FileMap) {
  const entries = [...files.entries()];
  let i = 0;
  const worker = async () => {
    while (i < entries.length) {
      const [path, data] = entries[i++]!;
      await bucket.put(prefix + path, data, { httpMetadata: { contentType: contentTypeFor(path) } });
    }
  };
  await Promise.all(Array.from({ length: Math.min(R2_CONCURRENCY, entries.length) }, worker));
}

export async function deletePrefix(bucket: R2Bucket, prefix: string) {
  let cursor: string | undefined;
  do {
    const list = await bucket.list({ prefix, cursor, limit: 1000 });
    if (list.objects.length) await bucket.delete(list.objects.map((o) => o.key));
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
}

/** Creates or atomically replaces the site at namespace/mountPath. */
export async function publishSite(ctx: Ctx, input: PublishInput) {
  const { env, user } = ctx;
  const label = validateLabel(input.namespace);
  const mount = validateMountPath(input.mountPath);
  const title = parseTitle(input.title);
  const spa = parseBool(input.spa);
  const visibility = parseVisibility(input.visibility);
  const allowed = input.allowedEmails === undefined ? undefined : emailList(input.allowedEmails, "allowed_emails");
  const editors = input.editors === undefined ? undefined : emailList(input.editors, "editors");
  if (!input.files.has("index.html")) throw badRequest("The upload has no index.html.", "Include an index.html at the root.");

  let ns = await getNamespace(env, label);
  if (!ns) {
    await createNamespace(ctx, label);
    ns = (await getNamespace(env, label))!;
  }
  const existing = await getSiteByMount(env, label, mount);
  if (existing) {
    if (!canManageSite(user, existing, ns)) {
      throw err(409, "not_yours", `A site at ${label}/${mount} already exists and you cannot replace it.`, "Ask its owner to add you as an editor, or publish to a different path.");
    }
  } else if (!canPublishTo(user, ns)) {
    throw err(409, "namespace_taken", `The namespace "${label}" belongs to someone else.`, `Publish to your own namespace instead, or ask ${ns.owner_email} to add you as an editor.`);
  }
  if (editors !== undefined && existing && existing.owner_email !== user.email && !isNamespaceOwner(user, ns)) {
    throw ownerOnly();
  }

  const version = sortableId();
  const id = existing?.id ?? randomId("s_");
  const prefix = `sites/${id}/${version}/`;
  let totalBytes = 0;
  for (const d of input.files.values()) totalBytes += d.length;
  const t = now();

  try {
    await putFiles(env.BUCKET, prefix, input.files);
  } catch (e) {
    ctx.waitUntil(deletePrefix(env.BUCKET, prefix).catch(() => {}));
    throw e;
  }

  let row: SiteRow;
  try {
    if (existing) {
      const res = await env.DB.prepare(
        `UPDATE sites SET current_version = ?, file_count = ?, total_bytes = ?, updated_at = ?,
           title = COALESCE(?, title), spa = COALESCE(?, spa), visibility = COALESCE(?, visibility),
           allowed_emails = COALESCE(?, allowed_emails), editors = COALESCE(?, editors)
         WHERE id = ? AND current_version = ?`,
      )
        .bind(
          version,
          input.files.size,
          totalBytes,
          t,
          title === undefined ? null : title,
          spa === undefined ? null : spa ? 1 : 0,
          visibility ?? null,
          allowed ? JSON.stringify(allowed) : null,
          editors ? JSON.stringify(editors) : null,
          id,
          existing.current_version,
        )
        .run();
      if (!res.meta.changes) throw err(409, "conflict", "Someone else replaced this site at the same moment.", "Publish again.");
      // A title explicitly cleared to "" should clear it.
      if (title === null && input.title !== undefined) await env.DB.prepare("UPDATE sites SET title = NULL WHERE id = ?").bind(id).run();
    } else {
      await env.DB.prepare(
        `INSERT INTO sites (id, namespace, mount_path, title, owner_email, editors, visibility, allowed_emails,
                            hidden, spa, current_version, file_count, total_bytes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          id,
          label,
          mount,
          title ?? null,
          user.email,
          JSON.stringify(editors ?? []),
          visibility ?? "all",
          JSON.stringify(allowed ?? []),
          spa ? 1 : 0,
          version,
          input.files.size,
          totalBytes,
          t,
          t,
        )
        .run();
    }
    row = (await getSiteById(env, id))!;
  } catch (e) {
    // The old version (if any) is still live; drop the files we just wrote.
    ctx.waitUntil(deletePrefix(env.BUCKET, prefix).catch(() => {}));
    if (e instanceof Error && /UNIQUE/i.test(e.message)) {
      throw err(409, "conflict", "Someone else published to this path at the same moment.", "Publish again.");
    }
    throw e;
  }
  if (existing) ctx.waitUntil(deletePrefix(env.BUCKET, `sites/${id}/${existing.current_version}/`).catch(() => {}));
  await audit(env, user.email, existing ? "replace" : "publish", `${label}/${mount}`, {
    siteId: id,
    version,
    files: input.files.size,
    bytes: totalBytes,
  });
  const site = siteView(env, row, ctx.requestUrl);
  return { url: site.url, site, replaced: !!existing };
}

export interface SitePatch {
  title?: unknown;
  hidden?: unknown;
  spa?: unknown;
  visibility?: unknown;
  allowed_emails?: unknown;
  editors?: unknown;
}

export async function updateSite(ctx: Ctx, id: string, patch: SitePatch) {
  const { site, ns } = await requireManageableSite(ctx, id);
  const sets: string[] = [];
  const binds: unknown[] = [];
  const changed: string[] = [];
  const set = (col: string, v: unknown) => {
    sets.push(`${col} = ?`);
    binds.push(v);
    changed.push(col);
  };
  const title = parseTitle(patch.title);
  if (title !== undefined) set("title", title);
  const hidden = parseBool(patch.hidden);
  if (hidden !== undefined) set("hidden", hidden ? 1 : 0);
  const spa = parseBool(patch.spa);
  if (spa !== undefined) set("spa", spa ? 1 : 0);
  const visibility = parseVisibility(patch.visibility);
  if (visibility) set("visibility", visibility);
  if (patch.allowed_emails !== undefined) set("allowed_emails", JSON.stringify(emailList(patch.allowed_emails, "allowed_emails")));
  if (patch.editors !== undefined) {
    if (site.owner_email !== ctx.user.email && !isNamespaceOwner(ctx.user, ns)) throw ownerOnly();
    set("editors", JSON.stringify(emailList(patch.editors, "editors")));
  }
  if (sets.length) {
    set("updated_at", now());
    await ctx.env.DB.prepare(`UPDATE sites SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, id).run();
    await audit(ctx.env, ctx.user.email, "update_site", `${site.namespace}/${site.mount_path}`, { siteId: id, fields: changed.slice(0, -1) });
  }
  return siteView(ctx.env, (await getSiteById(ctx.env, id))!, ctx.requestUrl);
}

/** Removes a site's files, KV rows, secret rows and the site row itself. */
async function removeSite(env: Env, site: SiteRow) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM kv WHERE site_id = ?").bind(site.id),
    env.DB.prepare("DELETE FROM secrets WHERE site_id = ?").bind(site.id),
    env.DB.prepare("DELETE FROM rate_counters WHERE bucket LIKE ?").bind(site.id + ":%"),
    env.DB.prepare("DELETE FROM sites WHERE id = ?").bind(site.id),
  ]);
  await deletePrefix(env.BUCKET, `sites/${site.id}/`);
}

export async function deleteSite(ctx: Ctx, id: string) {
  const { site } = await requireManageableSite(ctx, id);
  await removeSite(ctx.env, site);
  await audit(ctx.env, ctx.user.email, "delete_site", `${site.namespace}/${site.mount_path}`, { siteId: id });
  return { ok: true };
}

/** For MCP tools, which address sites by namespace + mount path. */
export async function siteIdByMount(ctx: Ctx, rawNs: unknown, rawMount: unknown): Promise<string> {
  const label = String(rawNs ?? "").toLowerCase();
  const mount = validateMountPath(rawMount);
  const site = await getSiteByMount(ctx.env, label, mount);
  if (!site) throw notFound(`Site ${label}/${mount}`);
  return site.id;
}
