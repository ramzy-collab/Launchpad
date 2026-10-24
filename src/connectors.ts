// Custom connectors: a person saves a service's API key once (Connected apps → + Custom connector),
// says which hosts it may be sent to and how the service expects it, and the apps built to use it
// call the service through Formelab without ever seeing the key. Behind the connected_apps flag.
//
// - A connector belongs to one person. Only they can make, change or delete it, and only they can
//   add it to (or remove it from) their apps.
// - An app uses a connector when it was built to: its `connectors` list (sites.connectors) names it,
//   set with update_site by the app's owner. Names resolve against the app's current owner.
// - Apps reach it with formelab.connectors.fetch(name, url) or, like a saved key,
//   formelab.secrets.proxy(name, { url }) with {{value}} placeholders.
// - Saved keys (an app's own secrets) can be moved into connectors: see planKeyMove / moveSavedKeys.
import { audit } from "./audit";
import type { Env, User } from "./env";
import { now } from "./env";
import { ApiError, badRequest, err, forbidden, notFound } from "./errors";
import { flagOnForOwner } from "./flags";
import {
  checkRate,
  decryptSecret,
  encryptSecret,
  parseProxyRequest,
  parseSecretHosts,
  SECRET_MAX_BYTES,
  SECRET_NAME_RE,
  sendProxied,
  type ProxyKey,
  type ProxyRequest,
  type ProxyResult,
  type SecretValue,
} from "./secrets";
import type { Ctx, SiteRow } from "./sites";
import { parseJsonArray, randomId } from "./util";

export type ConnectorAuth = "bearer" | "header" | "query" | "placeholder";
export const CONNECTOR_AUTHS: ConnectorAuth[] = ["bearer", "header", "query", "placeholder"];
export const MAX_CONNECTORS = 50;
export const MAX_SITE_CONNECTORS = 20;
/** Built-in connectors an app lists by name. */
export const BUILTIN_CONNECTORS = ["gemini"] as const;
/** Names a custom connector can't take: the built-in ones and the pages under /connected. */
const RESERVED = new Set(["gemini", "google-gemini", "sheets", "google-sheets", "new", "custom"]);
const HEADER_RE = /^[A-Za-z0-9-]{1,64}$/;
const QUERY_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const BLOCKED_HEADERS = new Set(["cookie", "host", "content-length"]);

interface ConnectorRow {
  id: string;
  owner_email: string;
  name: string;
  label: string;
  description: string;
  iv: string;
  ciphertext: string;
  hint: string;
  hosts: string;
  auth: ConnectorAuth;
  auth_name: string;
  created_at: number;
  updated_at: number;
}

export interface ConnectorView {
  id: string;
  name: string;
  label: string;
  description: string;
  /** The key's last 4 characters ("" for a key saved as an object). */
  hint: string;
  hosts: string[];
  auth: ConnectorAuth;
  authName: string;
  createdAt: number;
  updatedAt: number;
}

const view = (r: ConnectorRow): ConnectorView => ({
  id: r.id,
  name: r.name,
  label: r.label,
  description: r.description,
  hint: r.hint,
  hosts: parseJsonArray(r.hosts),
  auth: r.auth,
  authName: r.auth_name,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

// The key is encrypted like app secrets, bound to the connector: AAD "connector:<id>:key".
const scope = (id: string) => `connector:${id}`;

/** How a connector's key is sent, in words, like "the Authorization header, as Bearer <key>". */
export function authSentence(c: Pick<ConnectorView, "auth" | "authName">): string {
  switch (c.auth) {
    case "bearer":
      return "the Authorization header, as Bearer <key>";
    case "header":
      return `the ${c.authName} header`;
    case "query":
      return `the ${c.authName} query parameter`;
    default:
      return "wherever the app puts {{value}}";
  }
}

export async function listConnectors(env: Env, email: string): Promise<ConnectorView[]> {
  const { results } = await env.DB.prepare("SELECT * FROM connectors WHERE owner_email = ? ORDER BY label COLLATE NOCASE, name").bind(email).all<ConnectorRow>();
  return results.map(view);
}

const loadRow = (env: Env, email: string, name: string) =>
  env.DB.prepare("SELECT * FROM connectors WHERE owner_email = ? AND name = ?").bind(email, name).first<ConnectorRow>();

export async function getConnector(env: Env, email: string, name: string): Promise<ConnectorView | null> {
  const row = await loadRow(env, email, name);
  return row ? view(row) : null;
}

// ---------------------------------------------------------------------------
// Making and changing connectors (their owner only)
// ---------------------------------------------------------------------------

/** "Quo SMS" → "quo-sms": what apps ask for when no name is given. */
export const slugOf = (label: string) =>
  label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

function parseLabel(raw: unknown): string {
  const label = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  if (!label) throw badRequest("Give the connector a name.", "The service's name works, like \"Quo\" or \"Stripe\".");
  if (label.length > 60) throw badRequest("Names can be at most 60 characters.", "Use the service's name, like \"Quo\".");
  return label;
}

function parseName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!SECRET_NAME_RE.test(name)) {
    throw badRequest("Connector names use 1–64 lowercase letters, digits, \"_\" or \"-\".", "For example \"quo\" or \"stripe-live\".");
  }
  if (RESERVED.has(name)) throw badRequest(`"${name}" is taken by Formelab.`, "Pick another name, like \"my-" + name + "\".");
  return name;
}

function parseDescription(raw: unknown): string {
  const d = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  if (d.length > 200) throw badRequest("Keep what it's for under 200 characters.", "A few words is enough, like \"Texts from the business number\".");
  return d;
}

function parseKey(raw: unknown): string {
  const key = typeof raw === "string" ? raw.trim() : "";
  if (!key) throw badRequest("Paste the API key.", "Copy it from the service's settings or developer page.");
  if (new TextEncoder().encode(JSON.stringify(key)).length > SECRET_MAX_BYTES) {
    throw err(413, "secret_too_large", "Keys can be at most 8 KB.", "Paste only the key itself.");
  }
  return key;
}

function parseAuth(rawAuth: unknown, rawName: unknown): { auth: ConnectorAuth; authName: string } {
  const auth = (typeof rawAuth === "string" ? rawAuth : "bearer") as ConnectorAuth;
  if (!CONNECTOR_AUTHS.includes(auth)) throw badRequest("Choose how the key is sent.", "One of: bearer, header, query or placeholder.");
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (auth === "header") {
    if (!HEADER_RE.test(name) || BLOCKED_HEADERS.has(name.toLowerCase())) {
      throw badRequest("Say which header the key goes in.", "The service's API docs name it, like \"X-API-Key\".");
    }
    return { auth, authName: name };
  }
  if (auth === "query") {
    if (!QUERY_RE.test(name)) throw badRequest("Say which query parameter the key goes in.", "The service's API docs name it, like \"api_key\".");
    return { auth, authName: name };
  }
  return { auth, authName: "" };
}

const hostsOf = (raw: unknown, env: Env) =>
  parseSecretHosts(typeof raw === "string" ? raw.split(/[\s,]+/).filter(Boolean) : raw, env);

export interface ConnectorInput {
  label?: unknown;
  name?: unknown;
  description?: unknown;
  key?: unknown;
  hosts?: unknown;
  auth?: unknown;
  authName?: unknown;
}

export async function createConnector(ctx: Ctx, input: ConnectorInput): Promise<ConnectorView> {
  const { env, user } = ctx;
  const label = parseLabel(input.label);
  const name = parseName(input.name === undefined || input.name === "" ? slugOf(label) : input.name);
  const description = parseDescription(input.description);
  const key = parseKey(input.key);
  const hosts = hostsOf(input.hosts, env);
  const { auth, authName } = parseAuth(input.auth, input.authName);
  return insertConnector(env, user, { name, label, description, secret: key, hosts, auth, authName }, "connector_create");
}

async function insertConnector(
  env: Env,
  user: Pick<User, "email">,
  c: { name: string; label: string; description: string; secret: SecretValue; hosts: string[]; auth: ConnectorAuth; authName: string },
  action: string,
  extra: Record<string, unknown> = {},
): Promise<ConnectorView> {
  if (await loadRow(env, user.email, c.name)) {
    throw err(409, "connector_exists", `You already have a connector called ${c.name}.`, "Pick another name, or open that connector to replace its key.");
  }
  const id = randomId("con_");
  const { iv, ciphertext } = await encryptSecret(env, scope(id), "key", JSON.stringify(c.secret));
  const t = now();
  const res = await env.DB.prepare(
    `INSERT INTO connectors (id, owner_email, name, label, description, iv, ciphertext, hint, hosts, auth, auth_name, created_at, updated_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12
      WHERE (SELECT COUNT(*) FROM connectors WHERE owner_email = ?2) < ?13`,
  )
    .bind(id, user.email, c.name, c.label, c.description, iv, ciphertext, typeof c.secret === "string" ? c.secret.slice(-4) : "", JSON.stringify(c.hosts), c.auth, c.authName, t, MAX_CONNECTORS)
    .run();
  if (!res.meta.changes) throw err(409, "too_many_connectors", `You already have ${MAX_CONNECTORS} connectors.`, "Delete ones you no longer use.");
  await audit(env, user.email, action, null, { connector: c.name, hosts: c.hosts, ...extra });
  return view((await loadRow(env, user.email, c.name))!);
}

async function ownConnector(ctx: Ctx, name: string): Promise<ConnectorRow> {
  if (!SECRET_NAME_RE.test(name)) throw notFound(`The connector ${name.slice(0, 64)}`);
  const row = await loadRow(ctx.env, ctx.user.email, name);
  if (!row) throw notFound(`The connector ${name}`);
  return row;
}

/** Changes what it's called, what it's for, where and how it's sent, or the key. Not its name. */
export async function updateConnector(ctx: Ctx, name: string, input: ConnectorInput): Promise<ConnectorView> {
  const row = await ownConnector(ctx, name);
  const sets: string[] = [];
  const binds: unknown[] = [];
  const changed: string[] = [];
  const set = (col: string, v: unknown, field: string) => {
    sets.push(`${col} = ?`);
    binds.push(v);
    changed.push(field);
  };
  if (input.label !== undefined) set("label", parseLabel(input.label), "label");
  if (input.description !== undefined) set("description", parseDescription(input.description), "description");
  if (input.hosts !== undefined) set("hosts", JSON.stringify(hostsOf(input.hosts, ctx.env)), "hosts");
  if (input.auth !== undefined || input.authName !== undefined) {
    const { auth, authName } = parseAuth(input.auth ?? row.auth, input.authName ?? row.auth_name);
    set("auth", auth, "auth");
    set("auth_name", authName, "auth");
  }
  if (input.key !== undefined) {
    const key = parseKey(input.key);
    const { iv, ciphertext } = await encryptSecret(ctx.env, scope(row.id), "key", JSON.stringify(key));
    set("iv", iv, "key");
    set("ciphertext", ciphertext, "key");
    set("hint", key.slice(-4), "key");
  }
  if (!sets.length) return view(row);
  set("updated_at", now(), "updated_at");
  await ctx.env.DB.prepare(`UPDATE connectors SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, row.id).run();
  const fields = [...new Set(changed)].filter((f) => f !== "updated_at");
  await audit(ctx.env, ctx.user.email, fields.length === 1 && fields[0] === "key" ? "connector_key" : "connector_update", null, { connector: name, fields });
  return view((await loadRow(ctx.env, ctx.user.email, name))!);
}

/** Deletes the connector and its key. The apps that used it can't reach the service any more. */
export async function deleteConnector(ctx: Ctx, name: string): Promise<{ ok: true; apps: number }> {
  const row = await ownConnector(ctx, name);
  const using = await appsUsing(ctx.env, ctx.user.email, name);
  await ctx.env.DB.batch([
    ctx.env.DB.prepare("DELETE FROM connectors WHERE id = ?").bind(row.id),
    ...using.map((a) =>
      ctx.env.DB.prepare("UPDATE sites SET connectors = (SELECT json_group_array(value) FROM json_each(sites.connectors) WHERE value != ?) WHERE id = ?").bind(name, a.id),
    ),
  ]);
  await audit(ctx.env, ctx.user.email, "connector_delete", null, { connector: name, apps: using.length });
  return { ok: true, apps: using.length };
}

/** Removes a connector (custom, or "gemini") from one of the person's own apps. */
export async function detachConnector(ctx: Ctx, siteId: string, name: string) {
  const site = await ctx.env.DB.prepare("SELECT id, owner_email, namespace, mount_path, connectors FROM sites WHERE id = ?").bind(siteId).first<SiteRow>();
  if (!site) throw notFound("App");
  if (site.owner_email !== ctx.user.email) {
    throw forbidden(`Only the app's owner can remove ${name} from it.`);
  }
  const list = parseJsonArray(site.connectors ?? "[]");
  if (!list.includes(name)) throw notFound(`${name} on this app`);
  await ctx.env.DB.prepare("UPDATE sites SET connectors = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(list.filter((n) => n !== name)), now(), site.id).run();
  await audit(ctx.env, ctx.user.email, "update_site", `${site.namespace}/${site.mount_path}`, { siteId: site.id, connectorsAdded: [], connectorsRemoved: [name], fields: ["connectors"] });
  return { ok: true };
}

/**
 * Checks an app's connectors list (update_site's `connectors`): "gemini", or the names of the
 * owner's own custom connectors.
 */
export async function connectorNameList(env: Env, ownerEmail: string, raw: unknown): Promise<string[]> {
  const hint = "Send names like [\"gemini\", \"quo\"]: \"gemini\" for Google Gemini, or the owner's custom connectors (whoami lists them).";
  if (!Array.isArray(raw)) throw badRequest("connectors must be a list of connector names.", hint);
  if (!(await flagOnForOwner(env, "connected_apps", ownerEmail))) {
    throw err(403, "not_available", "Connected apps aren't available on Formelab yet.", "Leave connectors out until they are.");
  }
  const out: string[] = [];
  for (const v of raw) {
    const name = typeof v === "string" ? v.trim().toLowerCase() : "";
    if (out.includes(name)) continue;
    if (!(BUILTIN_CONNECTORS as readonly string[]).includes(name) && !(SECRET_NAME_RE.test(name) && (await loadRow(env, ownerEmail, name)))) {
      throw badRequest(
        `"${String(v).slice(0, 64)}" isn't one of the app owner's connectors.`,
        "The owner makes custom connectors in Formelab under Connected apps → + Custom connector. " + hint,
      );
    }
    out.push(name);
  }
  if (out.length > MAX_SITE_CONNECTORS) throw badRequest(`An app can use at most ${MAX_SITE_CONNECTORS} connectors.`, "Remove ones the app no longer uses.");
  return out;
}

// ---------------------------------------------------------------------------
// Apps using a connector
// ---------------------------------------------------------------------------

/** Whether the app was built to use the connector (or "gemini"). */
export const siteUses = (site: Pick<SiteRow, "connectors">, name: string) => parseJsonArray(site.connectors ?? "[]").includes(name);

const notDeclared = (label: string, name: string) =>
  err(
    403,
    "connector_not_in_app",
    `This app wasn't built to use ${label}.`,
    `Its owner can ask their AI to add it: update_site with connectors including "${name}".`,
  );

/** The key for a connector the app was built to use, ready for the proxy. */
export async function connectorKey(env: Env, site: SiteRow, name: string): Promise<ProxyKey> {
  if (!(await flagOnForOwner(env, "connected_apps", site.owner_email))) {
    throw err(403, "not_available", "Connected apps aren't available on Formelab yet.", "Check back soon; the app can't use connectors until then.");
  }
  if (!siteUses(site, name)) throw notDeclared(name, name);
  const row = await loadRow(env, site.owner_email, name);
  if (!row) {
    throw err(409, "connector_missing", `The app's owner doesn't have a connector called ${name} any more.`, "The owner can make it again in Formelab under Connected apps → + Custom connector.");
  }
  let secret: SecretValue;
  try {
    secret = JSON.parse(await decryptSecret(env, scope(row.id), "key", row.iv, row.ciphertext)) as SecretValue;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw err(500, "secret_unreadable", `The key for ${name} could not be decrypted.`, "The owner can replace it in Formelab under Connected apps.");
  }
  const authName = row.auth_name;
  const inject: ProxyKey["inject"] =
    row.auth === "bearer"
      ? (_u, h, v) => h.set("Authorization", `Bearer ${v}`)
      : row.auth === "header"
        ? (_u, h, v) => h.set(authName, v)
        : row.auth === "query"
          ? (u, _h, v) => u.searchParams.set(authName, v)
          : undefined;
  return {
    what: `The connector ${name}`,
    secret,
    hosts: parseJsonArray(row.hosts),
    audit: { connector: name },
    inject,
    hostsHint: `Call one of those hosts, or have the owner add this one in Formelab under Connected apps → ${row.label}.`,
  };
}

/**
 * formelab.connectors.fetch(name, url, options): the app calls the service and Formelab adds the
 * key the way the connector says. `url` may be a path, sent to the connector's first host.
 */
export async function connectorFetch(env: Env, site: SiteRow, viewer: User, name: string, req: ProxyRequest): Promise<ProxyResult> {
  if (!SECRET_NAME_RE.test(name)) throw notDeclared(name.slice(0, 64), name.slice(0, 64));
  const parsed = parseProxyRequest(req, `formelab.connectors.fetch("${name}", url)`);
  await checkRate(env, site, viewer);
  const key = await connectorKey(env, site, name);
  if (parsed.url.startsWith("/")) {
    const host = key.hosts.find((h) => !h.startsWith("*."));
    if (!host) throw badRequest("Use a full https:// address for this connector.", `${name} may be sent to ${key.hosts.join(", ")}, so a path alone doesn't say which.`);
    parsed.url = `https://${host}${parsed.url}`;
  }
  return sendProxied(env, site, viewer, parsed, key);
}

export interface AppUse {
  id: string;
  name: string;
  /** In the last 30 days. */
  calls: number;
  lastUsedAt: number | null;
}

const nameOf = (s: Pick<SiteRow, "title" | "mount_path" | "namespace">) => s.title || s.mount_path || s.namespace;
export const USE_WINDOW_MS = 30 * 86_400_000;

/** The person's own apps built to use `name` ("gemini" or a custom connector), with their use. */
export async function appsUsing(env: Env, email: string, name: string): Promise<AppUse[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, title, mount_path, namespace FROM sites WHERE owner_email = ? AND EXISTS (SELECT 1 FROM json_each(sites.connectors) WHERE value = ?) ORDER BY title, mount_path",
  )
    .bind(email, name)
    .all<SiteRow>();
  const since = now() - USE_WINDOW_MS;
  return Promise.all(
    results.map(async (s) => {
      const use =
        name === "gemini"
          ? await env.DB.prepare("SELECT COUNT(*) AS n, MAX(at) AS at FROM audit WHERE site_id = ? AND action = 'gemini' AND at > ?").bind(s.id, since).first<{ n: number; at: number | null }>()
          : await env.DB.prepare("SELECT COUNT(*) AS n, MAX(at) AS at FROM audit WHERE site_id = ? AND action = 'proxy' AND json_extract(detail, '$.connector') = ? AND at > ?")
              .bind(s.id, name, since)
              .first<{ n: number; at: number | null }>();
      return { id: s.id, name: nameOf(s), calls: use?.n ?? 0, lastUsedAt: use?.at ?? null };
    }),
  );
}

/** How many of the person's apps use each connector, for the Connected apps tiles. */
export async function useCounts(env: Env, email: string): Promise<Map<string, number>> {
  const { results } = await env.DB.prepare(
    "SELECT j.value AS name, COUNT(*) AS n FROM sites s, json_each(s.connectors) j WHERE s.owner_email = ? GROUP BY j.value",
  )
    .bind(email)
    .all<{ name: string; n: number }>();
  return new Map(results.map((r) => [r.name, r.n]));
}

/** What happened to a connector: made, changed, moved in. Newest first. */
export async function connectorActivity(env: Env, email: string, name: string, limit = 8): Promise<{ at: number; action: string; detail: Record<string, unknown> }[]> {
  const { results } = await env.DB.prepare(
    `SELECT at, action, detail FROM audit
      WHERE actor = ? AND action IN ('connector_create', 'connector_update', 'connector_key', 'connector_move') AND json_extract(detail, '$.connector') = ?
      ORDER BY id DESC LIMIT ?`,
  )
    .bind(email, name, limit)
    .all<{ at: number; action: string; detail: string | null }>();
  return results.map((r) => ({ at: r.at, action: r.action, detail: r.detail ? (JSON.parse(r.detail) as Record<string, unknown>) : {} }));
}

// ---------------------------------------------------------------------------
// Moving saved keys into connectors
// ---------------------------------------------------------------------------

export interface KeyMove {
  /** The connector the keys become (or join, when the person already has a matching one). */
  name: string;
  hosts: string[];
  apps: { id: string; name: string }[];
  joins: boolean;
}

export interface KeyMovePlan {
  moves: KeyMove[];
  /** Saved keys that stay in their app, and why. */
  kept: { name: string; app: string; why: string }[];
}

interface Candidate {
  siteId: string;
  app: string;
  name: string;
  hosts: string[];
  plaintext: string;
}

async function savedKeysOf(env: Env, email: string): Promise<{ candidates: Candidate[]; kept: KeyMovePlan["kept"] }> {
  const { results } = await env.DB.prepare(
    `SELECT k.site_id, k.name, k.iv, k.ciphertext, k.hosts, s.title, s.mount_path, s.namespace
       FROM secrets k JOIN sites s ON s.id = k.site_id WHERE s.owner_email = ? ORDER BY k.name, s.title`,
  )
    .bind(email)
    .all<{ site_id: string; name: string; iv: string; ciphertext: string; hosts: string | null; title: string | null; mount_path: string; namespace: string }>();
  const candidates: Candidate[] = [];
  const kept: KeyMovePlan["kept"] = [];
  for (const r of results) {
    const app = nameOf(r);
    const hosts = r.hosts ? parseJsonArray(r.hosts) : [];
    if (!hosts.length) {
      kept.push({ name: r.name, app, why: "It was saved before keys listed where they may be sent, so the app can't use it anyway." });
      continue;
    }
    if (RESERVED.has(r.name)) {
      kept.push({ name: r.name, app, why: "Its name is taken by a built-in connector." });
      continue;
    }
    try {
      candidates.push({ siteId: r.site_id, app, name: r.name, hosts: [...hosts].sort(), plaintext: await decryptSecret(env, r.site_id, r.name, r.iv, r.ciphertext) });
    } catch {
      kept.push({ name: r.name, app, why: "It couldn't be read. Set it again in the app." });
    }
  }
  return { candidates, kept };
}

/**
 * What moving the person's saved keys would do. Keys with the same name, hosts and value become
 * one connector the apps share. An app's code asks for a key by name, so only one key per name can
 * move: the one most apps share (or the one matching an existing connector of that name). The
 * others stay in their apps.
 */
async function plan(env: Env, email: string) {
  const { candidates, kept } = await savedKeysOf(env, email);
  const byName = new Map<string, Candidate[]>();
  for (const c of candidates) byName.set(c.name, [...(byName.get(c.name) ?? []), c]);
  const moves: (KeyMove & { members: Candidate[]; secret: string })[] = [];
  for (const [name, list] of byName) {
    const groups = new Map<string, Candidate[]>();
    for (const c of list) {
      const k = JSON.stringify([c.hosts, c.plaintext]);
      groups.set(k, [...(groups.get(k) ?? []), c]);
    }
    const existing = await loadRow(env, email, name);
    let chosen: Candidate[] | undefined;
    if (existing) {
      const ex = JSON.stringify([parseJsonArray(existing.hosts).sort(), await decryptSecret(env, scope(existing.id), "key", existing.iv, existing.ciphertext).catch(() => "")]);
      chosen = groups.get(ex);
    } else {
      chosen = [...groups.values()].sort((a, b) => b.length - a.length)[0];
    }
    for (const g of groups.values()) {
      if (g === chosen) continue;
      for (const c of g) {
        kept.push({
          name,
          app: c.app,
          why: existing && !chosen ? `You already have a connector called ${name} with a different key or hosts.` : `Another app has a different ${name} key, and apps ask for keys by name.`,
        });
      }
    }
    if (chosen) {
      moves.push({ name, hosts: chosen[0]!.hosts, apps: chosen.map((c) => ({ id: c.siteId, name: c.app })), joins: !!existing, members: chosen, secret: chosen[0]!.plaintext });
    }
  }
  return { moves, kept };
}

export async function planKeyMove(ctx: Ctx): Promise<KeyMovePlan> {
  const { moves, kept } = await plan(ctx.env, ctx.user.email);
  return { moves: moves.map(({ members: _m, secret: _s, ...m }) => m), kept };
}

/** Moves the saved keys planKeyMove lists into connectors. The apps keep working as they are. */
export async function moveSavedKeys(ctx: Ctx): Promise<KeyMovePlan> {
  const { env, user } = ctx;
  const { moves, kept } = await plan(env, user.email);
  for (const m of moves) {
    if (!m.joins) {
      await insertConnector(
        env,
        user,
        // Their apps already put the key in with {{value}} placeholders, so Formelab doesn't add it again.
        { name: m.name, label: m.name, description: "", secret: JSON.parse(m.secret) as SecretValue, hosts: m.hosts, auth: "placeholder", authName: "" },
        "connector_move",
        { apps: m.apps.length },
      );
    }
    await env.DB.batch(
      m.members.flatMap((c) => [
        env.DB.prepare(
          "UPDATE sites SET connectors = json_insert(connectors, '$[#]', ?1) WHERE id = ?2 AND NOT EXISTS (SELECT 1 FROM json_each(sites.connectors) WHERE value = ?1)",
        ).bind(m.name, c.siteId),
        env.DB.prepare("DELETE FROM secrets WHERE site_id = ? AND name = ?").bind(c.siteId, m.name),
      ]),
    );
  }
  return { moves: moves.map(({ members: _m, secret: _s, ...m }) => m), kept };
}
