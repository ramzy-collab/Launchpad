import { audit } from "./audit";
import { findIcon, iconPathFor } from "./icons";
import { findShareImage, linkPreviewOf } from "./share";
import { accountsAmong, canManageSite, canPublishTo, canShareSite, canViewSite, isAppOwner, isNamespaceEditor, isNamespaceOwner, ownerOnly } from "./auth";
import type { Env, User } from "./env";
import { now } from "./env";
import { badRequest, err, forbidden, notFound } from "./errors";
import { contentTypeFor } from "./mime";
import type { FileMap } from "./upload";
import { base32, isEmail, normEmail, parseJsonArray, randomBytes, randomId, sortableId } from "./util";
import { appSharedEmail, namespaceSharedEmail, sendEach, shareEmailAllowance } from "./email";
import { appOrigin, siteOrigin } from "./hosts";
import { flagOnForOwner } from "./flags";

/** Addresses in `next` that weren't in `prev` (both normalized). */
const added = (next: string[], prev: string[]) => {
  const before = new Set(prev.map(normEmail));
  return next.map(normEmail).filter((e) => !before.has(e));
};

/** Emails the people newly given access to an app. */
/**
 * Emails the people an app was just shared with, within the sharer's daily share email limits
 * (see shareEmailAllowance). Returns the ones who weren't emailed, so the sharer can be told.
 */
async function notifyShared(ctx: Ctx, site: SiteRow, viewers: string[], editors: string[]): Promise<string[]> {
  if (!viewers.length && !editors.length) return [];
  const { send, held } = await shareEmailAllowance(ctx.env, ctx.user.email, [...editors, ...viewers]);
  const origin = appOrigin(ctx.env, ctx.requestUrl);
  // The sender is named by their email address (verified), not their display name (which they choose).
  const by = ctx.user.email;
  const title = site.title || `${site.namespace}/${site.mount_path}`;
  const url = siteUrl(ctx.env, site, ctx.requestUrl);
  const editorSet = new Set(editors);
  ctx.waitUntil(sendEach(ctx.env, send, ctx.user.email, (to) => appSharedEmail(origin, to, { by, title, url, canEdit: editorSet.has(to) })));
  return held;
}

/** What to tell the sharer about people their share emails didn't reach today. */
export const heldNote = (held: string[]) =>
  held.length
    ? `Shared, but ${held.length === 1 ? held[0] : `${held.length} people`} didn't get an email: you've reached today's limit on share emails. Send them the link yourself.`
    : undefined;

/** Editors and Admins sign in to make changes, so each new one needs a Formelab account. */
export async function requireAccounts(env: Env, emails: string[]): Promise<void> {
  if (!emails.length) return;
  const have = await accountsAmong(env, emails);
  const missing = emails.filter((x) => !have.has(x));
  if (missing.length) {
    throw err(
      409,
      "needs_account",
      `${missing.join(", ")} ${missing.length === 1 ? "doesn't" : "don't"} have a Formelab account yet. Editors and Admins need one, since they sign in to make changes.`,
      "Send a sign-up invite from the app's People list (they become an Editor once they join), or share the app with them as a viewer.",
    );
  }
}

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
  /** See src/icons.ts: NULL = not looked for yet, "" = none. */
  icon_path?: string | null;
  /** See src/share.ts: NULL = not looked for yet, "" = none (a card is drawn). */
  share_path?: string | null;
  /** JSON array of the Google spreadsheet ids the app may use (see src/sheets.ts). */
  sheets?: string;
  /** The app's own host, <host_label>.APP_DOMAIN, e.g. "hoops-7kq2" (see src/hosts.ts). */
  host_label: string;
  /** Who may change the app's shared data (KV): "all" who can open it, or its owner and "editors". */
  kv_writes?: "all" | "editors";
  /** The secret in the app's "anyone with the link" address, or null when it has none (see publicLinkUrl). */
  public_link?: string | null;
  /** 1 when guests from the public link may send responses (formelab.responses.submit); see src/responses.ts. */
  guest_responses?: number;
  /** The most responses guests may send the app in a UTC day (see src/responses.ts). */
  guest_responses_per_day?: number;
  /** What link previews show: "full", "private", or NULL to decide from who can open it (see linkPreviewOf). */
  link_preview?: "full" | "private" | null;
  /** JSON array of the editors who may also change who can open the app (see canShareSite). */
  sharers?: string;
  /** 0 once the app was handed to someone else: its namespace's owner no longer owns it (isAppOwner). */
  space_owner_powers?: number;
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

export const RESERVED_LABELS = new Set(["www", "api", "admin", "app", "mcp", "static", "platform"]);
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
  throw badRequest(`visibility must be "all" or "restricted".`, "\"restricted\" (the default) limits the app to its owner, editors and allowed_emails; \"all\" lets every Formelab member open it.");
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

/** An app's address: its own host, e.g. https://hoops-7kq2.formelab.app/. */
export const siteUrl = (env: Env, site: Pick<SiteRow, "host_label">, requestUrl?: string) =>
  `${siteOrigin(env, site.host_label, requestUrl)}/`;

/** Where public links start (on the app's own host); see the route in index.ts. */
export const PUBLIC_LINK_PATH = "/_platform/link/";
const PUBLIC_LINK_RE = /^[a-z2-7]{32}$/;
export const isPublicLinkToken = (t: string) => PUBLIC_LINK_RE.test(t);
const newPublicLink = () => base32(randomBytes(20));

/** The app's "anyone with the link" address, or null when it has none. */
export const publicLinkUrl = (env: Env, site: Pick<SiteRow, "host_label" | "public_link">, requestUrl?: string) =>
  site.public_link ? `${siteOrigin(env, site.host_label, requestUrl)}${PUBLIC_LINK_PATH}${site.public_link}` : null;

const HOST_CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no 0/o, 1/l/i
const HOST_NAME_MAX = 40;

/** "tools/budget" -> "tools-budget": the readable part of an app's host label. */
export function hostName(namespace: string, mountPath: string): string {
  const raw = mountPath ? mountPath.replace(/\//g, "-") : namespace;
  const name = raw.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").slice(0, HOST_NAME_MAX).replace(/^-+|-+$/g, "");
  return name || "app";
}

/** A free host label for a new app: its name plus a 4-character code, e.g. "hoops-7kq2". */
async function newHostLabel(env: Env, namespace: string, mountPath: string): Promise<string> {
  const name = hostName(namespace, mountPath);
  for (let attempt = 0; attempt < 8; attempt++) {
    const bytes = crypto.getRandomValues(new Uint8Array(4));
    const code = [...bytes].map((b) => HOST_CODE_ALPHABET[b % HOST_CODE_ALPHABET.length]).join("");
    const label = `${name}-${code}`;
    const taken = await env.DB.prepare("SELECT 1 FROM sites WHERE host_label = ?1 UNION ALL SELECT 1 FROM namespaces WHERE label = ?1")
      .bind(label)
      .first();
    if (!taken) return label;
  }
  throw err(503, "busy", "Couldn't pick an address for the app.", "Publish again.");
}

export interface SiteView {
  id: string;
  namespace: string;
  mountPath: string;
  url: string;
  title: string | null;
  ownerEmail: string;
  editors: string[];
  /** Editors who may also change who can open the app. */
  sharers: string[];
  visibility: "all" | "restricted";
  allowedEmails: string[];
  hidden: boolean;
  spa: boolean;
  fileCount: number;
  totalBytes: number;
  createdAt: number;
  updatedAt: number;
  /** Where the web app shows the app's icon; null when the app has none (show its letter). */
  iconUrl: string | null;
  /** Google spreadsheet ids the app may use through its owner's Sheets connection. */
  sheets: string[];
  /** Who may change the app's shared data: "everyone" who can open it, or only its owner and "editors". */
  dataWrites: "everyone" | "editors";
  /**
   * The "anyone with the link" address: it opens the app without signing in. Null when the app has
   * none, and always null for people who can't manage the app (only they may hand it out).
   */
  publicUrl: string | null;
  /** Whether people who open the app through its public link may send it responses. */
  guestResponses: boolean;
  guestResponsesPerDay: number;
  /** What link previews of the app show now. */
  linkPreview: "full" | "private";
  /** "auto" when it follows who can open the app (see linkPreviewOf), else the owner's choice. */
  linkPreviewSetting: "auto" | "full" | "private";
}

export const siteView = (env: Env, s: SiteRow, requestUrl?: string): SiteView => ({
  id: s.id,
  namespace: s.namespace,
  mountPath: s.mount_path,
  url: siteUrl(env, s, requestUrl),
  title: s.title,
  ownerEmail: s.owner_email,
  editors: parseJsonArray(s.editors),
  sharers: parseJsonArray(s.sharers ?? "[]"),
  visibility: s.visibility,
  allowedEmails: parseJsonArray(s.allowed_emails),
  hidden: !!s.hidden,
  spa: !!s.spa,
  fileCount: s.file_count,
  totalBytes: s.total_bytes,
  createdAt: s.created_at,
  updatedAt: s.updated_at,
  iconUrl: s.icon_path ? `/apps/${encodeURIComponent(s.id)}/icon?v=${s.current_version}` : null,
  sheets: parseJsonArray(s.sheets),
  dataWrites: s.kv_writes === "editors" ? "editors" : "everyone",
  publicUrl: publicLinkUrl(env, s, requestUrl),
  guestResponses: !!s.guest_responses,
  guestResponsesPerDay: s.guest_responses_per_day ?? DEFAULT_GUEST_RESPONSES_PER_DAY,
  linkPreview: linkPreviewOf(s),
  linkPreviewSetting: s.link_preview ?? "auto",
});

/** "auto" | "full" | "private" → the stored link_preview value (null for "auto"). */
export function parseLinkPreview(raw: unknown): "full" | "private" | null | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (raw === null || raw === "auto") return null;
  if (raw === "full" || raw === "private") return raw;
  throw badRequest(`link_preview must be "auto", "full" or "private".`, "\"full\" shows the app's name, description and picture when its link is shared in a chat; \"private\" shows a plain Formelab card; \"auto\" picks from who can open it.");
}

export const DEFAULT_GUEST_RESPONSES_PER_DAY = 500;
export const MAX_GUEST_RESPONSES_PER_DAY = 5000;

/** A whole number of guest responses a day, 0 to MAX_GUEST_RESPONSES_PER_DAY. */
export function parseGuestResponsesPerDay(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = typeof raw === "number" ? raw : typeof raw === "string" && /^\s*\d+\s*$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > MAX_GUEST_RESPONSES_PER_DAY) {
    throw badRequest(`guest_responses_per_day must be a whole number from 0 to ${MAX_GUEST_RESPONSES_PER_DAY}.`, `The most responses people with the public link may send the app in a day (the default is ${DEFAULT_GUEST_RESPONSES_PER_DAY}).`);
  }
  return n;
}

/** siteView for a list that also holds apps the person can only open: the public link is for managers. */
/**
 * siteView for a list that also holds apps the person can only open: who else it's shared with,
 * its editors and its spreadsheets are for the people who manage it (audit A4), like the public link.
 */
const listedView = (env: Env, s: SiteRow, canManage: boolean, requestUrl?: string) => {
  const v = siteView(env, s, requestUrl);
  if (canManage) return { ...v, canManage };
  return { ...v, publicUrl: null, allowedEmails: [], editors: [], sharers: [], sheets: [], canManage };
};

/** true (turn the public link on, keeping one that exists), false (off) or "new" (replace it). */
export function parsePublicLink(raw: unknown): boolean | "new" | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (raw === "new") return "new";
  try {
    return parseBool(raw);
  } catch {
    throw badRequest(`public_link must be true, false or "new".`, "true turns on a link that opens the app without signing in, false turns it off, and \"new\" replaces it so the old link stops working.");
  }
}

/** "everyone" | "editors" (also "all") → the stored kv_writes value. */
export function parseDataWrites(raw: unknown): "all" | "editors" | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (raw === "editors") return "editors";
  if (raw === "everyone" || raw === "all") return "all";
  throw badRequest(`data_writes must be "editors" or "everyone".`, "\"editors\" lets only the owner and editors change the app's shared data; \"everyone\" lets everyone who can open it.");
}

export const MAX_SITE_SHEETS = 50;
const SHEET_ID = /^[A-Za-z0-9_-]{20,128}$/;

/**
 * Spreadsheet ids from a list (or a comma/space separated string) of ids or Google Sheets URLs
 * like https://docs.google.com/spreadsheets/d/<id>/edit.
 */
export function sheetIdList(raw: unknown): string[] {
  let list: unknown = raw;
  if (raw === null || raw === "") return [];
  if (typeof raw === "string") list = raw.split(/[\s,;]+/);
  if (!Array.isArray(list)) throw badRequest("sheets must be a list of spreadsheet ids or links.", "Send [\"<spreadsheet id>\"] or a Google Sheets link.");
  const out = new Set<string>();
  for (const item of list) {
    const v = String(item ?? "").trim();
    if (!v) continue;
    const id = /\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(v)?.[1] ?? v;
    if (!SHEET_ID.test(id)) {
      throw badRequest(`"${v.slice(0, 80)}" is not a Google spreadsheet id or link.`, "Copy the link from the spreadsheet's address bar (docs.google.com/spreadsheets/d/<id>/edit).");
    }
    out.add(id);
  }
  if (out.size > MAX_SITE_SHEETS) throw badRequest(`An app can use at most ${MAX_SITE_SHEETS} spreadsheets.`, "Remove spreadsheets the app no longer uses.");
  return [...out];
}

/** Adds a spreadsheet to an app's list (used when the owner creates one through the app). */
export async function addSiteSheet(env: Env, siteId: string, sheetId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE sites SET sheets = json_insert(sheets, '$[#]', ?1)
      WHERE id = ?2 AND NOT EXISTS (SELECT 1 FROM json_each(sites.sheets) WHERE value = ?1)
        AND json_array_length(sheets) < ?3`,
  )
    .bind(sheetId, siteId, MAX_SITE_SHEETS)
    .run();
}

export const namespaceView = (n: NamespaceRow, user: User, env: Env, requestUrl?: string) => ({
  label: n.label,
  /** Spaces have no address of their own: this is the web app's list of the apps in it. */
  url: `${appOrigin(env, requestUrl)}/?space=${encodeURIComponent(n.label)}`,
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
export const getSiteByHostLabel = (env: Env, label: string) =>
  env.DB.prepare("SELECT * FROM sites WHERE host_label = ?").bind(label).first<SiteRow>();

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

export async function requireManageableSite(ctx: Ctx, id: string) {
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
  if (!ctx.user.active) throw waitlisted();
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
  const newEditors = added(editors, parseJsonArray(ns.editors));
  let held: string[] = [];
  if (newEditors.length) {
    const allowance = await shareEmailAllowance(ctx.env, ctx.user.email, newEditors);
    held = allowance.held;
    const origin = appOrigin(ctx.env, ctx.requestUrl);
    const by = ctx.user.email;
    const url = `${origin}/shared`;
    ctx.waitUntil(sendEach(ctx.env, allowance.send, ctx.user.email, (to) => namespaceSharedEmail(origin, to, { by, namespace: ns.label, url })));
  }
  const note = heldNote(held);
  return { ...namespaceView({ ...ns, editors: JSON.stringify(editors) }, ctx.user, ctx.env, ctx.requestUrl), ...(note ? { note, notEmailed: held } : {}) };
}

export async function deleteNamespace(ctx: Ctx, rawLabel: string) {
  const ns = await requireNamespace(ctx.env, String(rawLabel).toLowerCase());
  if (!isNamespaceOwner(ctx.user, ns)) throw ownerOnly();
  const { results } = await ctx.env.DB.prepare("SELECT * FROM sites WHERE namespace = ?").bind(ns.label).all<SiteRow>();
  // Apps handed to someone else stay theirs: deleting the space would delete them too.
  const handedOver = results.filter((s) => s.space_owner_powers === 0 && s.owner_email !== ctx.user.email);
  if (handedOver.length) {
    throw err(
      409,
      "space_has_transferred_apps",
      `This space holds ${handedOver.length === 1 ? "an app" : `${handedOver.length} apps`} you gave to someone else, so it can't be deleted.`,
      `Ask ${[...new Set(handedOver.map((s) => s.owner_email))].join(", ")} to delete ${handedOver.length === 1 ? "it" : "them"} first.`,
    );
  }
  for (const s of results) await removeSite(ctx.env, s);
  await ctx.env.DB.prepare("DELETE FROM namespaces WHERE label = ?").bind(ns.label).run();
  await audit(ctx.env, ctx.user.email, "namespace_delete", ns.label, { sites: results.length });
  return { ok: true, deletedSites: results.length };
}

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

export const waitlisted = () =>
  err(403, "waitlisted", "Your account is still on the waitlist.", "You can open apps people share with you. We'll email you when you can create your own.");

const listed = (list: string, email: string) => parseJsonArray(list).map(normEmail).includes(email);

/** Is this the person's own app: they own it, or own its namespace. */
const ownsSite = (u: User, s: SiteRow, ns: NamespaceRow) => isAppOwner(u, s, ns);

/**
 * Apps someone else owns that were shared with this person by name: as a viewer (allowed_emails),
 * an editor of the app, or an editor of its namespace. Apps open to all members don't count.
 */
export async function listSharedSites(ctx: Ctx) {
  const { env, user } = ctx;
  const [namespaces, sites] = await Promise.all([
    env.DB.prepare("SELECT * FROM namespaces").all<NamespaceRow>(),
    env.DB.prepare("SELECT * FROM sites ORDER BY updated_at DESC").all<SiteRow>(),
  ]);
  const nsByLabel = new Map(namespaces.results.map((n) => [n.label, n]));
  const out = sites.results
    .filter((s) => {
      const ns = nsByLabel.get(s.namespace);
      if (!ns || ownsSite(user, s, ns)) return false;
      return listed(s.allowed_emails, user.email) || listed(s.editors, user.email) || listed(ns.editors, user.email);
    })
    .map((s) => listedView(env, s, canManageSite(user, s, nsByLabel.get(s.namespace)!), ctx.requestUrl));
  const shown = new Set(out.map((v) => v.id));
  findMissingIcons(ctx, sites.results.filter((r) => shown.has(r.id)));
  return out;
}

/** Apps published before icons existed haven't been looked at yet: do a few in the background,
 * so their icons show from the next visit on. */
function findMissingIcons(ctx: Ctx, sites: SiteRow[]) {
  const todo = sites.filter((s) => s.icon_path === null || s.icon_path === undefined).slice(0, 20);
  if (todo.length) ctx.waitUntil(Promise.all(todo.map((s) => iconPathFor(ctx.env, s).catch(() => ""))));
}

/** The person's own apps (see ownsSite), for the dashboard's "My apps". */
export async function listOwnSites(ctx: Ctx) {
  const { env, user } = ctx;
  const [namespaces, sites] = await Promise.all([
    env.DB.prepare("SELECT * FROM namespaces").all<NamespaceRow>(),
    env.DB.prepare("SELECT * FROM sites ORDER BY namespace, mount_path").all<SiteRow>(),
  ]);
  const nsByLabel = new Map(namespaces.results.map((n) => [n.label, n]));
  const out = sites.results
    .filter((s) => {
      const ns = nsByLabel.get(s.namespace);
      return !!ns && ownsSite(user, s, ns);
    })
    .map((s) => ({ ...siteView(env, s, ctx.requestUrl), canManage: true }));
  const shown = new Set(out.map((v) => v.id));
  findMissingIcons(ctx, sites.results.filter((r) => shown.has(r.id)));
  return out;
}

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
    .map((s) => listedView(env, s, canManageSite(user, s, namespaces.get(s.namespace)!), ctx.requestUrl));
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
  /** Who may change a new app's shared data (see parseDataWrites); new apps default to editors only. */
  dataWrites?: unknown;
  /** Refuse an app without an icon (the MCP publish tool, so AI-made apps always have one). */
  requireIcon?: boolean;
  /** The version the files were built on (edits, partial uploads): refuse if the app has changed since. */
  expectedVersion?: string;
}

/** Shown to AI apps whose publish was refused for lack of an icon. */
export const ICON_HINT =
  "Add a small SVG icon that fits the app: put <link rel=\"icon\" href=\"data:image/svg+xml,<url-encoded svg>\"> in index.html's <head>, " +
  "or include icon.svg in a zip and link it with <link rel=\"icon\" href=\"icon.svg\">. Then publish again.";

const R2_CONCURRENCY = 8;

/** Runs `fn` over `items`, at most R2_CONCURRENCY at a time. */
async function eachLimited<T>(items: T[], fn: (item: T) => Promise<void>) {
  let i = 0;
  const worker = async () => {
    while (i < items.length) await fn(items[i++]!);
  };
  await Promise.all(Array.from({ length: Math.min(R2_CONCURRENCY, items.length) }, worker));
}

async function sha256Bytes(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Writes each file with its SHA-256 in customMetadata, so siteManifest can tell clients what is unchanged. */
async function putFiles(bucket: R2Bucket, prefix: string, files: FileMap) {
  await eachLimited([...files.entries()], async ([path, data]) => {
    await bucket.put(prefix + path, data, {
      httpMetadata: { contentType: contentTypeFor(path) },
      customMetadata: { sha256: await sha256Bytes(data) },
    });
  });
}

/** Every file of the site's live version. */
export async function currentFiles(env: Env, site: SiteRow): Promise<FileMap> {
  const prefix = `sites/${site.id}/${site.current_version}/`;
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const list = await env.BUCKET.list({ prefix, cursor, limit: 1000 });
    for (const o of list.objects) keys.push(o.key);
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  const files: FileMap = new Map();
  await eachLimited(keys, async (key) => {
    const obj = await env.BUCKET.get(key);
    if (obj) files.set(key.slice(prefix.length), new Uint8Array(await obj.arrayBuffer()));
  });
  return files;
}

/** The live version's files with their sizes and SHA-256 (null for files written before hashes were kept). */
export async function siteManifest(env: Env, site: SiteRow) {
  const prefix = `sites/${site.id}/${site.current_version}/`;
  const files: { path: string; bytes: number; sha256: string | null }[] = [];
  let cursor: string | undefined;
  do {
    const list = await env.BUCKET.list({ prefix, cursor, limit: 1000, include: ["customMetadata"] });
    for (const o of list.objects) files.push({ path: o.key.slice(prefix.length), bytes: o.size, sha256: o.customMetadata?.sha256 ?? null });
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { version: site.current_version, files };
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
  // Waitlisted people can open what's shared with them, but not publish, even as someone's editor (audit A5).
  if (!user.active) throw waitlisted();
  const label = validateLabel(input.namespace);
  const mount = validateMountPath(input.mountPath);
  const title = parseTitle(input.title);
  const spa = parseBool(input.spa);
  const visibility = parseVisibility(input.visibility);
  const allowed = input.allowedEmails === undefined ? undefined : emailList(input.allowedEmails, "allowed_emails");
  const dataWrites = parseDataWrites(input.dataWrites);
  const editors = input.editors === undefined ? undefined : emailList(input.editors, "editors");
  if (!input.files.has("index.html")) throw badRequest("The upload has no index.html.", "Include an index.html at the root.");
  // The app's icon for the web app's tiles (see icons.ts).
  const icon = findIcon(input.files.keys(), new TextDecoder().decode(input.files.get("index.html")!.subarray(0, 64 * 1024)), mount);
  // Its link preview image (see share.ts).
  const share = findShareImage(input.files.keys(), new TextDecoder().decode(input.files.get("index.html")!.subarray(0, 192 * 1024)), mount);
  if (input.requireIcon && !icon) throw err(400, "icon_required", "This app has no icon (favicon). Formelab shows it on the app's tile.", ICON_HINT);

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
    if (input.expectedVersion !== undefined && existing.current_version !== input.expectedVersion) {
      throw err(409, "conflict", "This app changed while your changes were being applied.", "Publish your changes again.");
    }
  } else if (input.expectedVersion !== undefined) {
    throw err(409, "conflict", "This app was deleted while your changes were being applied.", "Publish the whole app again.");
  } else if (!canPublishTo(user, ns)) {
    throw err(409, "namespace_taken", `The namespace "${label}" belongs to someone else.`, `Publish to your own namespace instead, or ask ${ns.owner_email} to add you as an editor.`);
  }
  if (!existing && editors) await requireAccounts(env, editors);
  // Publishing a new version never changes who can open or edit the app; that only happens
  // through update_site / the app's settings. Say so when the caller asked for something else.
  const sharingNote = existing && sharingDiffers(existing, visibility, allowed, editors)
    ? "Kept this app's sharing settings (who can open and edit it). Publishing a new version doesn't change them; use update_site or the app's Settings to change who it's shared with."
    : undefined;

  const version = sortableId();
  const id = existing?.id ?? randomId("s_");
  const hostLabel = existing?.host_label ?? (await newHostLabel(env, label, mount));
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
      // A new version keeps the app's settings unless a new title or spa value is given; an empty
      // title (as a blank form field sends) keeps the current one.
      const res = await env.DB.prepare(
        `UPDATE sites SET current_version = ?, file_count = ?, total_bytes = ?, updated_at = ?,
           title = COALESCE(?, title), spa = COALESCE(?, spa)
         WHERE id = ? AND current_version = ?`,
      )
        .bind(
          version,
          input.files.size,
          totalBytes,
          t,
          title ?? null,
          spa === undefined ? null : spa ? 1 : 0,
          id,
          existing.current_version,
        )
        .run();
      if (!res.meta.changes) throw err(409, "conflict", "Someone else replaced this site at the same moment.", "Publish again.");
    } else {
      await env.DB.prepare(
        `INSERT INTO sites (id, namespace, mount_path, title, owner_email, editors, visibility, allowed_emails,
                            hidden, spa, current_version, file_count, total_bytes, created_at, updated_at, kv_writes, host_label)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          id,
          label,
          mount,
          title ?? null,
          user.email,
          JSON.stringify(editors ?? []),
          visibility ?? "restricted",
          JSON.stringify(allowed ?? []),
          spa ? 1 : 0,
          version,
          input.files.size,
          totalBytes,
          t,
          t,
          dataWrites ?? "editors",
          hostLabel,
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
  await env.DB.prepare("UPDATE sites SET icon_path = ?, share_path = ? WHERE id = ? AND current_version = ?").bind(icon, share, id, version).run();
  row.icon_path = icon;
  row.share_path = share;
  await audit(env, user.email, existing ? "replace" : "publish", `${label}/${mount}`, {
    siteId: id,
    version,
    files: input.files.size,
    bytes: totalBytes,
  });
  const held = existing ? [] : await notifyShared(ctx, row, allowed ?? [], editors ?? []);
  const site = siteView(env, row, ctx.requestUrl);
  const note = [sharingNote, heldNote(held)].filter(Boolean).join(" ");
  return { url: site.url, site, replaced: !!existing, ...(note ? { note } : {}), ...(held.length ? { notEmailed: held } : {}) };
}

/** Whether publish input asked for sharing different from what the app has. */
function sharingDiffers(s: SiteRow, visibility?: string, allowed?: string[], editors?: string[]): boolean {
  const sameList = (list: string[] | undefined, stored: string) =>
    list === undefined || [...list].sort().join(",") === parseJsonArray(stored).map(normEmail).sort().join(",");
  return (visibility !== undefined && visibility !== s.visibility) || !sameList(allowed, s.allowed_emails) || !sameList(editors, s.editors);
}

export interface SitePatch {
  title?: unknown;
  hidden?: unknown;
  spa?: unknown;
  visibility?: unknown;
  allowed_emails?: unknown;
  editors?: unknown;
  sheets?: unknown;
  data_writes?: unknown;
  public_link?: unknown;
  guest_responses?: unknown;
  guest_responses_per_day?: unknown;
  link_preview?: unknown;
  sharers?: unknown;
}

/** The columns that decide who can open an app: only canShareSite may change them. */
const SHARING_COLUMNS = ["visibility", "allowed_emails", "public_link", "guest_responses", "guest_responses_per_day", "link_preview"];

export async function updateSite(ctx: Ctx, id: string, patch: SitePatch) {
  const { site, ns } = await requireManageableSite(ctx, id);
  const sets: string[] = [];
  const binds: unknown[] = [];
  const changed: string[] = [];
  const detail: Record<string, unknown> = { siteId: id };
  // Only what actually changes is written and logged (the dashboard form sends every field).
  const set = (col: string, v: unknown) => {
    if (String((site as unknown as Record<string, unknown>)[col] ?? "") === String(v ?? "")) return;
    sets.push(`${col} = ?`);
    binds.push(v);
    changed.push(col);
  };
  const title = parseTitle(patch.title);
  if (title !== undefined) {
    set("title", title);
    if (changed.includes("title")) detail.title = title ?? "";
  }
  const hidden = parseBool(patch.hidden);
  if (hidden !== undefined) set("hidden", hidden ? 1 : 0);
  const spa = parseBool(patch.spa);
  if (spa !== undefined) set("spa", spa ? 1 : 0);
  const visibility = parseVisibility(patch.visibility);
  if (visibility) {
    set("visibility", visibility);
    if (changed.includes("visibility")) detail.visibility = visibility;
  }
  let newViewers: string[] = [];
  let newEditors: string[] = [];
  if (patch.allowed_emails !== undefined) {
    const list = emailList(patch.allowed_emails, "allowed_emails");
    const before = parseJsonArray(site.allowed_emails);
    newViewers = added(list, before);
    const gone = added(before, list);
    if (newViewers.length || gone.length) {
      set("allowed_emails", JSON.stringify(list));
      detail.sharedWith = newViewers;
      detail.unsharedWith = gone;
    }
  }
  const editorsAfter = patch.editors !== undefined ? emailList(patch.editors, "editors") : parseJsonArray(site.editors);
  if (patch.editors !== undefined) {
    if (!isAppOwner(ctx.user, site, ns)) throw ownerOnly();
    const before = parseJsonArray(site.editors);
    newEditors = added(editorsAfter, before);
    await requireAccounts(ctx.env, newEditors);
    const gone = added(before, editorsAfter);
    if (newEditors.length || gone.length) {
      set("editors", JSON.stringify(editorsAfter));
      detail.editorsAdded = newEditors;
      detail.editorsRemoved = gone;
    }
  }
  // Which editors may also share it: the owner's choice, and always among the editors.
  if (patch.sharers !== undefined || patch.editors !== undefined) {
    const before = parseJsonArray(site.sharers ?? "[]");
    let list = patch.sharers !== undefined ? emailList(patch.sharers, "sharers") : before;
    if (patch.sharers !== undefined) {
      if (!isAppOwner(ctx.user, site, ns)) throw ownerOnly();
      const notEditor = list.find((s) => !editorsAfter.includes(s));
      if (notEditor) throw badRequest(`${notEditor} isn't an editor of this app.`, "Make them an editor first; only editors can be allowed to share.");
    }
    list = list.filter((s) => editorsAfter.includes(s));
    if (added(list, before).length || added(before, list).length) {
      set("sharers", JSON.stringify(list));
      detail.sharers = list;
    }
  }
  const dataWrites = parseDataWrites(patch.data_writes);
  if (dataWrites) {
    set("kv_writes", dataWrites);
    if (changed.includes("kv_writes")) detail.dataWrites = dataWrites === "all" ? "everyone" : "editors";
  }
  const publicLink = parsePublicLink(patch.public_link);
  if (publicLink !== undefined) {
    const next = publicLink === false ? null : publicLink === "new" || !site.public_link ? newPublicLink() : site.public_link;
    set("public_link", next);
    if (changed.includes("public_link")) detail.publicLink = !next ? "off" : site.public_link ? "new" : "on";
  }
  const guestResponses = parseBool(patch.guest_responses);
  if (guestResponses !== undefined && !(await flagOnForOwner(ctx.env, "responses", site.owner_email))) {
    throw err(403, "not_available", "Responses aren't available on Formelab yet.", "Leave guest_responses out until they are.");
  }
  if (guestResponses !== undefined) {
    set("guest_responses", guestResponses ? 1 : 0);
    if (changed.includes("guest_responses")) detail.guestResponses = guestResponses;
  }
  const perDay = parseGuestResponsesPerDay(patch.guest_responses_per_day);
  if (perDay !== undefined) {
    set("guest_responses_per_day", perDay);
    if (changed.includes("guest_responses_per_day")) detail.guestResponsesPerDay = perDay;
  }
  const linkPreview = parseLinkPreview(patch.link_preview);
  if (linkPreview !== undefined) {
    set("link_preview", linkPreview);
    if (changed.includes("link_preview")) detail.linkPreview = linkPreview ?? "auto";
  }
  if (patch.sheets !== undefined) {
    // The spreadsheets are reached with the owner's own Google account, so only the owner chooses them.
    const list = sheetIdList(patch.sheets);
    const before = parseJsonArray(site.sheets);
    if (added(list, before).length || added(before, list).length) {
      if (site.owner_email !== ctx.user.email) {
        throw err(403, "owner_only", "Only the app's owner can choose which Google spreadsheets it uses.", "They're reached with the owner's Google account. Ask the owner to change this.");
      }
      set("sheets", JSON.stringify(list));
      detail.sheets = list.length;
    }
  }
  if (changed.some((col) => SHARING_COLUMNS.includes(col)) && !canShareSite(ctx.user, site, ns)) {
    throw err(
      403,
      "sharing_not_allowed",
      "Only the app's owner can change who can open it.",
      `Ask ${site.owner_email} to change it, or to let you share the app (Editors who can also share, in the app's settings).`,
    );
  }
  if (sets.length) {
    const fields = [...changed];
    set("updated_at", now());
    await ctx.env.DB.prepare(`UPDATE sites SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, id).run();
    await audit(ctx.env, ctx.user.email, "update_site", `${site.namespace}/${site.mount_path}`, { ...detail, fields });
  }
  const updated = (await getSiteById(ctx.env, id))!;
  // A sign-up invite ends once they're an editor anyway, or no longer have access at all.
  const nowEditors = parseJsonArray(updated.editors);
  const nowViewers = parseJsonArray(updated.allowed_emails);
  const { results: pending } = await ctx.env.DB.prepare("SELECT email FROM pending_role_invites WHERE site_id = ?").bind(id).all<{ email: string }>();
  const stale = pending.map((p) => p.email).filter((p) => nowEditors.includes(p) || !nowViewers.includes(p));
  if (stale.length) {
    await ctx.env.DB.batch(stale.map((p) => ctx.env.DB.prepare("DELETE FROM pending_role_invites WHERE site_id = ? AND email = ?").bind(id, p)));
  }
  const held = await notifyShared(ctx, updated, newViewers, newEditors);
  const note = heldNote(held);
  return { ...siteView(ctx.env, updated, ctx.requestUrl), ...(note ? { note, notEmailed: held } : {}) };
}

/** A site the signed-in person may manage (owner, editor or namespace owner); 404 for others. */
export async function getManageableSite(ctx: Ctx, id: string): Promise<SiteView & { canEditEditors: boolean; canShare: boolean }> {
  const { site, ns } = await requireManageableSite(ctx, id);
  return { ...siteView(ctx.env, site, ctx.requestUrl), canEditEditors: isAppOwner(ctx.user, site, ns), canShare: canShareSite(ctx.user, site, ns) };
}

/** Removes a site's files, KV rows, secret rows and the site row itself. */
export async function removeSite(env: Env, site: SiteRow) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM kv WHERE site_id = ?").bind(site.id),
    env.DB.prepare("DELETE FROM kv_user WHERE site_id = ?").bind(site.id),
    env.DB.prepare("DELETE FROM secrets WHERE site_id = ?").bind(site.id),
    env.DB.prepare("DELETE FROM responses WHERE site_id = ?").bind(site.id),
    env.DB.prepare("DELETE FROM app_stars WHERE site_id = ?").bind(site.id),
    env.DB.prepare("DELETE FROM pending_role_invites WHERE site_id = ?").bind(site.id),
    env.DB.prepare("DELETE FROM rate_counters WHERE bucket LIKE ?").bind(site.id + ":%"),
    env.DB.prepare("DELETE FROM sites WHERE id = ?").bind(site.id),
  ]);
  await deletePrefix(env.BUCKET, `sites/${site.id}/`);
}

export async function deleteSite(ctx: Ctx, id: string) {
  const { site, ns } = await requireManageableSite(ctx, id);
  // Editors can publish new versions, but only the owner can delete the app (audit finding #10).
  if (!isAppOwner(ctx.user, site, ns)) {
    throw err(403, "owner_only", "Only the app's owner can delete it.", `Ask ${site.owner_email} to delete it.`);
  }
  await removeSite(ctx.env, site);
  await audit(ctx.env, ctx.user.email, "delete_site", `${site.namespace}/${site.mount_path}`, { deletedSiteId: id });
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

/**
 * Make a copy: the app's files as a new app in the same space, named "<name> (copy)", open only to
 * the person who made it. Its data, keys, people and public link aren't copied.
 */
export async function copySite(ctx: Ctx, id: string) {
  const { site, ns } = await requireManageableSite(ctx, id);
  if (!canPublishTo(ctx.user, ns)) {
    throw err(403, "cannot_publish_here", `Only people who can publish in the space ${ns.label} can copy its apps.`, `Ask ${ns.owner_email} to add you as an editor of the space.`);
  }
  const base = (site.mount_path || "app").slice(0, 40);
  let mount = `${base}-copy`;
  for (let n = 2; await getSiteByMount(ctx.env, ns.label, mount); n++) {
    if (n > 50) throw err(409, "too_many_copies", "This app already has a lot of copies in this space.", "Delete some of them, then try again.");
    mount = `${base}-copy-${n}`;
  }
  const name = (site.title || site.mount_path || site.namespace).slice(0, 190);
  const result = await publishSite(ctx, {
    namespace: ns.label,
    mountPath: mount,
    files: await currentFiles(ctx.env, site),
    title: `${name} (copy)`,
    spa: !!site.spa,
    visibility: "restricted",
    allowedEmails: [],
    dataWrites: site.kv_writes === "editors" ? "editors" : "everyone",
  });
  await audit(ctx.env, ctx.user.email, "copy_site", `${ns.label}/${mount}`, { siteId: result.site.id, fromSiteId: id, from: `${site.namespace}/${site.mount_path}` });
  return result;
}
