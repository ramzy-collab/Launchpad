// The admin panel's Metrics page: growth, engagement, MCP use and hosted-app use, computed from
// the accounts, waitlist, apps, activity log, MCP calls and app visits. Admins only.
//
// Days are UTC. "Team accounts" (admins and OWNER_EMAIL) are left out unless asked for, so the
// numbers describe real customers. Everything is read fresh on each page load; at Formelab's size
// a handful of grouped queries is cheap, and there is nothing to keep in sync.
import type { Env } from "./env";
import { now } from "./env";
import { GUEST } from "./usage";
import { normEmail, parseJsonArray } from "./util";

export const DAY = 86_400_000;
export const RANGES = { "30d": "30 days", "90d": "90 days", "12m": "12 months", all: "All time" } as const;
export type Range = keyof typeof RANGES;

/** Activity-log actions that mean someone was building or running their apps. */
const BUILD_ACTIONS = new Set(["publish", "replace", "update_site", "ai_build", "ai_edit", "secret_set", "secret_delete", "namespace_create", "delete_site"]);
/** Actions that happen inside an app on behalf of the person using it. */
const USE_ACTIONS = new Set(["proxy", "gemini", "sheets"]);

export interface Bucket {
  start: number; // day number (days since 1970-01-01, UTC)
  end: number; // inclusive
  label: string;
}

export interface Series {
  name: string;
  values: number[];
}

export interface Tile {
  value: number;
  /** The same measure over the period before, for the change; null when there is none. */
  previous: number | null;
  /** Up to 12 points for a sparkline. */
  trend?: number[];
}

export interface AppRow {
  id: string;
  title: string;
  host: string;
  owner: string;
  createdAt: number;
  visitors: number; // people other than its builders, in the range
  builders: number; // owner and editors who opened it, in the range
  views: number;
  lastOpened: string | null; // YYYY-MM-DD, any time
  versions: number; // publishes, all time
  dataRows: number;
  features: string[];
}

export interface PersonRow {
  email: string;
  joined: number;
  apps: number;
  activeDays: number;
  publishes: number;
  mcpCalls: number;
  reach: number; // other people who opened their apps, in the range
  lastActive: string | null;
  client: string | null;
}

export interface Metrics {
  range: Range;
  includeTeam: boolean;
  unit: "day" | "week";
  buckets: Bucket[];
  generatedAt: number;
  team: number;
  /** When MCP calls and app visits started being recorded (null: nothing recorded yet). */
  trackingSince: { mcp: number | null; visits: string | null };
  tiles: {
    wau: Tile & { builders: number; appUsers: number };
    accounts: Tile & { total: number };
    apps: Tile & { total: number };
    publishes: Tile;
    mcpCalls: Tile;
    appViews: Tile & { visitors: number; guestViews: number };
    waitlist: Tile & { waiting: number };
    activation: { value: number; accounts: number; withApp: number };
    stickiness: { value: number; dau: number; mau: number };
    reach: Tile;
    timeToFirstApp: number | null; // median hours
  };
  growth: { accounts: Series; apps: Series; newAccounts: Series; waitlistJoins: Series };
  engagement: { dau: Series; wau: Series; mau: Series; newBuilders: Series; returningBuilders: Series };
  shipping: { newApps: Series; updates: Series; aiBuilds: Series };
  funnel: { label: string; count: number; note: string }[];
  retention: { cohorts: { label: string; size: number; weeks: (number | null)[] }[] };
  mcp: {
    byClient: Series[];
    tools: { name: string; calls: number; errors: number }[];
    clients: { name: string; people: number; calls: number }[];
    calls: number;
    errors: number;
    people: number;
    sessions: number;
    p50: number | null;
    p95: number | null;
    connectedPeople: number;
  };
  apps: {
    views: Series;
    visitors: Series;
    sharedVisitors: Series;
    builderVisitors: Series;
    guestViews: Series;
    top: AppRow[];
    adoption: { label: string; count: number; total: number }[];
  };
  people: PersonRow[];
}

// ---------------------------------------------------------------------------
// Days and buckets
// ---------------------------------------------------------------------------

export const dayOf = (ms: number) => Math.floor(ms / DAY);
const isoDay = (d: number) => new Date(d * DAY).toISOString().slice(0, 10);
const dayFromIso = (s: string) => Math.floor(Date.parse(s + "T00:00:00Z") / DAY);
/** The Monday on or before day d (day 0, 1970-01-01, was a Thursday). */
export const mondayOf = (d: number) => d - ((d + 3) % 7);
const shortDate = (d: number) => new Date(d * DAY).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** The chart buckets for a range ending today: days up to 90 days, else weeks starting Monday. */
export function bucketsFor(range: Range, today: number, firstDay: number): { unit: "day" | "week"; buckets: Bucket[] } {
  const days = range === "30d" ? 30 : range === "90d" ? 90 : range === "12m" ? 365 : Math.max(1, today - firstDay + 1);
  const start = today - days + 1;
  if (days <= 90) {
    return { unit: "day", buckets: Array.from({ length: days }, (_, i) => ({ start: start + i, end: start + i, label: shortDate(start + i) })) };
  }
  const buckets: Bucket[] = [];
  for (let m = mondayOf(start); m <= today; m += 7) buckets.push({ start: m, end: Math.min(m + 6, today), label: shortDate(m) });
  return { unit: "week", buckets };
}

/** Index of the bucket holding day d, or -1. Buckets are contiguous and sorted. */
function bucketIndex(buckets: Bucket[], d: number): number {
  if (!buckets.length || d < buckets[0]!.start || d > buckets[buckets.length - 1]!.end) return -1;
  const span = buckets[0]!.end - buckets[0]!.start + 1;
  return Math.min(buckets.length - 1, Math.floor((d - buckets[0]!.start) / span));
}

// ---------------------------------------------------------------------------
// AI app names
// ---------------------------------------------------------------------------

/** Groups the many names AI apps give themselves ("claude-code", "Claude-User", "claude-ai") into products. */
export function clientFamily(raw: string | null | undefined): string {
  const s = (raw ?? "").toLowerCase();
  if (!s) return "Unknown";
  if (s.includes("claude-code") || s.includes("claude code")) return "Claude Code";
  if (s.includes("claude") || s.includes("anthropic")) return "Claude";
  if (s.includes("codex")) return "Codex";
  if (s.includes("chatgpt") || s.includes("openai")) return "ChatGPT";
  if (s.includes("cursor")) return "Cursor";
  if (s.includes("windsurf") || s.includes("codeium")) return "Windsurf";
  if (s.includes("vscode") || s.includes("visual studio") || s.includes("copilot")) return "VS Code";
  if (s.includes("gemini")) return "Gemini";
  return raw!.trim().slice(0, 24);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const zeros = (n: number) => new Array<number>(n).fill(0);

/** Adds `email` to the set for `day`. */
function mark(map: Map<number, Set<string>>, day: number, email: string) {
  let s = map.get(day);
  if (!s) map.set(day, (s = new Set()));
  s.add(email);
}

/** Distinct people in `map` over days [from, to]. */
function peopleBetween(map: Map<number, Set<string>>, from: number, to: number): Set<string> {
  const out = new Set<string>();
  for (let d = from; d <= to; d++) for (const e of map.get(d) ?? []) out.add(e);
  return out;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

type AuditGroup = { actor: string; action: string; d: number; n: number };
type SiteRowLite = {
  id: string;
  title: string | null;
  namespace: string;
  mount_path: string;
  host_label: string | null;
  owner_email: string;
  editors: string;
  visibility: string;
  allowed_emails: string;
  sheets: string;
  public_link: string | null;
  created_at: number;
};

async function load(env: Env) {
  const q = <T>(sql: string, ...binds: unknown[]) =>
    env.DB.prepare(sql)
      .bind(...binds)
      .all<T>()
      .then((r) => r.results);
  const [users, waitlist, sites, audit, siteAudit, oauth, mcp, visits, kv, kvUser, secrets, tokens] = await Promise.all([
    q<{ email: string; created_at: number; is_admin: number; status: string }>("SELECT email, created_at, is_admin, status FROM users"),
    q<{ email: string; created_at: number; approved_at: number | null }>("SELECT email, created_at, approved_at FROM waitlist"),
    q<SiteRowLite>("SELECT id, title, namespace, mount_path, host_label, owner_email, editors, visibility, allowed_emails, sheets, public_link, created_at FROM sites"),
    q<AuditGroup>(`SELECT actor, action, CAST(at / ${DAY} AS INTEGER) AS d, COUNT(*) AS n FROM audit GROUP BY actor, action, d`),
    q<{ site_id: string; action: string; n: number }>("SELECT site_id, action, COUNT(*) AS n FROM audit WHERE site_id IS NOT NULL GROUP BY site_id, action"),
    q<{ actor: string; detail: string | null }>("SELECT actor, detail FROM audit WHERE action = 'oauth_connect'"),
    q<{ email: string; client: string | null; tool: string; d: number; n: number; errors: number; first: number }>(
      `SELECT email, client, tool, CAST(at / ${DAY} AS INTEGER) AS d, COUNT(*) AS n, SUM(1 - ok) AS errors, MIN(at) AS first FROM mcp_calls GROUP BY email, client, tool, d`,
    ),
    q<{ site_id: string; day: string; email: string; own: number; views: number }>("SELECT site_id, day, email, own, views FROM app_visits"),
    q<{ site_id: string; n: number }>("SELECT site_id, COUNT(*) AS n FROM kv GROUP BY site_id"),
    q<{ site_id: string; n: number }>("SELECT site_id, COUNT(*) AS n FROM kv_user GROUP BY site_id"),
    q<{ site_id: string; n: number }>("SELECT site_id, COUNT(*) AS n FROM secrets GROUP BY site_id"),
    q<{ owner_email: string; client_name: string | null; last_used: number | null }>("SELECT owner_email, client_name, last_used FROM tokens WHERE revoked = 0"),
  ]);
  return { users, waitlist, sites, audit, siteAudit, oauth, mcp, visits, kv, kvUser, secrets, tokens };
}

/** MCP tool-call latency percentiles over [from, to) ms, without loading every row. */
async function latency(env: Env, from: number, to: number, team: Set<string>, includeTeam: boolean): Promise<{ p50: number | null; p95: number | null }> {
  const excluded = includeTeam ? [] : [...team];
  const notTeam = excluded.length ? ` AND email NOT IN (${excluded.map(() => "?").join(",")})` : "";
  const where = `WHERE at >= ? AND at < ? AND tool <> 'initialize'${notTeam}`;
  const n = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM mcp_calls ${where}`).bind(from, to, ...excluded).first<{ n: number }>())?.n ?? 0;
  if (!n) return { p50: null, p95: null };
  const at = async (p: number) =>
    (await env.DB.prepare(`SELECT ms FROM mcp_calls ${where} ORDER BY ms LIMIT 1 OFFSET ?`).bind(from, to, ...excluded, Math.min(n - 1, Math.floor((p / 100) * n))).first<{ ms: number }>())?.ms ?? null;
  const [p50, p95] = await Promise.all([at(50), at(95)]);
  return { p50, p95 };
}

// ---------------------------------------------------------------------------
// Computing
// ---------------------------------------------------------------------------

export async function computeMetrics(env: Env, range: Range, includeTeam: boolean, at = now()): Promise<Metrics> {
  const raw = await load(env);
  const owner = normEmail(env.OWNER_EMAIL ?? "");
  const team = new Set(raw.users.filter((u) => u.is_admin === 1).map((u) => u.email));
  if (owner) team.add(owner);
  const counts = (email: string) => includeTeam || !team.has(email);

  const today = dayOf(at);
  const users = raw.users.filter((u) => counts(u.email));
  const waitlist = raw.waitlist.filter((w) => counts(w.email));
  const sites = raw.sites.filter((s) => counts(s.owner_email));
  const audit = raw.audit.filter((a) => counts(a.actor));
  const mcp = raw.mcp.filter((m) => counts(m.email));
  const allVisits = raw.visits.filter((v) => counts(v.email)).map((v) => ({ ...v, d: dayFromIso(v.day) }));
  // People who opened apps; guests let in by a public link are anonymous and count only as views.
  const visits = allVisits.filter((v) => v.email !== GUEST);
  const guestVisits = allVisits.filter((v) => v.email === GUEST);

  const firstDay = [...users, ...waitlist, ...sites].reduce((t, r) => Math.min(t, dayOf(r.created_at)), today);
  const { unit, buckets } = bucketsFor(range, today, firstDay);
  const start = buckets[0]!.start;
  const span = today - start + 1;
  const prevStart = start - span;
  const hasPrev = range !== "all";
  const inRange = (d: number) => d >= start && d <= today;
  const inPrev = (d: number) => hasPrev && d >= prevStart && d < start;
  const n = buckets.length;
  const series = (name: string, values = zeros(n)): Series => ({ name, values });

  // --- Who was active when -------------------------------------------------
  const active = new Map<number, Set<string>>(); // anyone
  const building = new Map<number, Set<string>>(); // building apps (activity log or MCP)
  const using = new Map<number, Set<string>>(); // using apps they don't build
  const firstBuild = new Map<string, number>();
  const built = (email: string, d: number) => {
    mark(active, d, email);
    mark(building, d, email);
    if (!firstBuild.has(email) || firstBuild.get(email)! > d) firstBuild.set(email, d);
  };
  for (const a of audit) {
    if (BUILD_ACTIONS.has(a.action)) {
      built(a.actor, a.d);
    } else if (USE_ACTIONS.has(a.action)) {
      mark(active, a.d, a.actor);
      mark(using, a.d, a.actor);
    }
  }
  for (const m of mcp) built(m.email, m.d);
  for (const v of visits) {
    mark(active, v.d, v.email);
    if (!v.own) mark(using, v.d, v.email);
  }

  // --- Growth --------------------------------------------------------------
  const createdDays = audit.filter((a) => a.action === "publish");
  const appsCreatedBefore = (d: number) => createdDays.reduce((t, a) => t + (a.d <= d ? a.n : 0), 0);
  const growth = {
    accounts: series("Accounts", buckets.map((b) => users.filter((u) => u.status === "active" && dayOf(u.created_at) <= b.end).length)),
    apps: series("Apps created", buckets.map((b) => appsCreatedBefore(b.end))),
    newAccounts: series("New accounts"),
    waitlistJoins: series("Waitlist sign-ups"),
  };
  for (const u of users) {
    const i = bucketIndex(buckets, dayOf(u.created_at));
    if (i >= 0 && u.status === "active") growth.newAccounts.values[i]!++;
  }
  for (const w of waitlist) {
    const i = bucketIndex(buckets, dayOf(w.created_at));
    if (i >= 0) growth.waitlistJoins.values[i]!++;
  }

  // --- Engagement ----------------------------------------------------------
  const engagement = {
    dau: series("Daily active", buckets.map((b) => (unit === "day" ? active.get(b.end)?.size ?? 0 : peopleBetween(active, b.start, b.end).size / 7))),
    wau: series("Weekly active", buckets.map((b) => peopleBetween(active, b.end - 6, b.end).size)),
    mau: series("Monthly active", buckets.map((b) => peopleBetween(active, b.end - 29, b.end).size)),
    newBuilders: series("New builders"),
    returningBuilders: series("Returning builders"),
  };
  // Weekly averages of daily actives read as fractions; round them to one place.
  engagement.dau.values = engagement.dau.values.map((v) => Math.round(v * 10) / 10);
  buckets.forEach((b, i) => {
    for (const e of peopleBetween(building, b.start, b.end)) {
      if (firstBuild.get(e)! >= b.start) engagement.newBuilders.values[i]!++;
      else engagement.returningBuilders.values[i]!++;
    }
  });

  // --- Shipping ------------------------------------------------------------
  const shipping = { newApps: series("New apps"), updates: series("Updates"), aiBuilds: series("Built in Formelab") };
  for (const a of audit) {
    const i = bucketIndex(buckets, a.d);
    if (i < 0) continue;
    if (a.action === "publish") shipping.newApps.values[i]! += a.n;
    else if (a.action === "replace") shipping.updates.values[i]! += a.n;
    else if (a.action === "ai_build" || a.action === "ai_edit") shipping.aiBuilds.values[i]! += a.n;
  }
  const sumWhere = (pred: (d: number) => boolean, actions: string[]) => audit.reduce((t, a) => t + (actions.includes(a.action) && pred(a.d) ? a.n : 0), 0);

  // --- MCP -----------------------------------------------------------------
  const toolCalls = mcp.filter((m) => m.tool !== "initialize");
  const familyCalls = new Map<string, number>();
  for (const m of toolCalls) if (inRange(m.d)) familyCalls.set(clientFamily(m.client), (familyCalls.get(clientFamily(m.client)) ?? 0) + m.n);
  const topFamilies = [...familyCalls.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
  const shown = topFamilies.length > 5 ? topFamilies.slice(0, 4) : topFamilies;
  const byClient = new Map<string, Series>(shown.map((f) => [f, series(f)]));
  if (topFamilies.length > shown.length) byClient.set("Other", series("Other"));
  const tools = new Map<string, { calls: number; errors: number }>();
  const clients = new Map<string, { people: Set<string>; calls: number }>();
  const mcpPeople = new Set<string>();
  let calls = 0;
  let errors = 0;
  let sessions = 0;
  for (const m of mcp) {
    if (!inRange(m.d)) continue;
    if (m.tool === "initialize") {
      sessions += m.n;
      continue;
    }
    calls += m.n;
    errors += m.errors;
    mcpPeople.add(m.email);
    const f = clientFamily(m.client);
    const s = byClient.get(f) ?? byClient.get("Other")!;
    s.values[bucketIndex(buckets, m.d)]! += m.n;
    const t = tools.get(m.tool) ?? { calls: 0, errors: 0 };
    t.calls += m.n;
    t.errors += m.errors;
    tools.set(m.tool, t);
    const c = clients.get(f) ?? { people: new Set(), calls: 0 };
    c.people.add(m.email);
    c.calls += m.n;
    clients.set(f, c);
  }
  // Everyone who has connected an AI app: OAuth approvals, used access keys, or MCP calls.
  const connected = new Set<string>([
    ...raw.oauth.map((o) => o.actor),
    ...raw.tokens.filter((t) => t.last_used).map((t) => t.owner_email),
    ...raw.mcp.map((m) => m.email),
  ].filter(counts));
  const lat = await latency(env, start * DAY, (today + 1) * DAY, team, includeTeam);

  // --- Apps ----------------------------------------------------------------
  const appSeries = {
    views: series("Page views"),
    visitors: series("Visitors"),
    sharedVisitors: series("People it was shared with"),
    builderVisitors: series("Its builders"),
    guestViews: series("Views through a public link"),
  };
  const visitorsPerBucket = buckets.map(() => new Set<string>());
  const sharedPerBucket = buckets.map(() => new Set<string>());
  const builderPerBucket = buckets.map(() => new Set<string>());
  type Agg = { visitors: Set<string>; builders: Set<string>; views: number; last: number; everShared: boolean };
  const perApp = new Map<string, Agg>();
  const aggOf = (id: string) => perApp.get(id) ?? perApp.set(id, { visitors: new Set(), builders: new Set(), views: 0, last: -1, everShared: false }).get(id)!;
  for (const v of visits) {
    const a = aggOf(v.site_id);
    a.last = Math.max(a.last, v.d);
    if (!v.own) a.everShared = true;
    if (!inRange(v.d)) continue;
    (v.own ? a.builders : a.visitors).add(v.email);
    a.views += v.views;
    const i = bucketIndex(buckets, v.d);
    appSeries.views.values[i]! += v.views;
    visitorsPerBucket[i]!.add(v.email);
    (v.own ? builderPerBucket : sharedPerBucket)[i]!.add(v.email);
  }
  for (const v of guestVisits) {
    const a = aggOf(v.site_id);
    a.last = Math.max(a.last, v.d);
    a.everShared = true;
    if (!inRange(v.d)) continue;
    a.views += v.views;
    const i = bucketIndex(buckets, v.d);
    appSeries.views.values[i]! += v.views;
    appSeries.guestViews.values[i]! += v.views;
  }
  appSeries.visitors.values = visitorsPerBucket.map((s) => s.size);
  appSeries.sharedVisitors.values = sharedPerBucket.map((s) => s.size);
  appSeries.builderVisitors.values = builderPerBucket.map((s) => s.size);

  const siteActions = new Map<string, Record<string, number>>();
  for (const r of raw.siteAudit) {
    const m = siteActions.get(r.site_id) ?? {};
    m[r.action] = r.n;
    siteActions.set(r.site_id, m);
  }
  const countMap = (rows: { site_id: string; n: number }[]) => new Map(rows.map((r) => [r.site_id, r.n]));
  const kvRows = countMap(raw.kv);
  const kvUserRows = countMap(raw.kvUser);
  const secretCount = countMap(raw.secrets);
  const featuresOf = (s: SiteRowLite) => {
    const acts = siteActions.get(s.id) ?? {};
    const f: string[] = [];
    if ((kvRows.get(s.id) ?? 0) + (kvUserRows.get(s.id) ?? 0) > 0) f.push("Data");
    if ((secretCount.get(s.id) ?? 0) > 0) f.push("APIs");
    if (acts.gemini) f.push("AI");
    if (acts.sheets || parseJsonArray(s.sheets).length) f.push("Sheets");
    return f;
  };
  const sharedOut = (s: SiteRowLite) => s.visibility === "all" || parseJsonArray(s.allowed_emails).length > 0 || parseJsonArray(s.editors).length > 0;
  const top: AppRow[] = sites
    .map((s) => {
      const a = perApp.get(s.id);
      const acts = siteActions.get(s.id) ?? {};
      return {
        id: s.id,
        title: s.title || `${s.namespace}/${s.mount_path || ""}`.replace(/\/$/, ""),
        host: s.host_label ?? "",
        owner: s.owner_email,
        createdAt: s.created_at,
        visitors: a?.visitors.size ?? 0,
        builders: a?.builders.size ?? 0,
        views: a?.views ?? 0,
        lastOpened: a && a.last >= 0 ? isoDay(a.last) : null,
        versions: (acts.publish ?? 0) + (acts.replace ?? 0),
        dataRows: (kvRows.get(s.id) ?? 0) + (kvUserRows.get(s.id) ?? 0),
        features: featuresOf(s),
      };
    })
    .sort((a, b) => b.visitors - a.visitors || b.views - a.views || b.versions - a.versions)
    .slice(0, 12);
  const live = sites.length;
  const adoption = [
    { label: "Updated after launch", count: sites.filter((s) => (siteActions.get(s.id)?.replace ?? 0) > 0).length },
    { label: "Shared with other people", count: sites.filter(sharedOut).length },
    { label: "Has a public link", count: sites.filter((s) => !!s.public_link).length },
    { label: "Opened by someone else", count: sites.filter((s) => perApp.get(s.id)?.everShared).length },
    { label: "Stores data", count: sites.filter((s) => featuresOf(s).includes("Data")).length },
    { label: "Calls outside APIs", count: sites.filter((s) => featuresOf(s).includes("APIs")).length },
    { label: "Uses AI (Gemini)", count: sites.filter((s) => featuresOf(s).includes("AI")).length },
    { label: "Uses Google Sheets", count: sites.filter((s) => featuresOf(s).includes("Sheets")).length },
  ].map((r) => ({ ...r, total: live }));

  // --- Funnel (people whose first contact falls in the range) ---------------
  const firstTouch = new Map<string, number>();
  for (const w of waitlist) firstTouch.set(w.email, dayOf(w.created_at));
  for (const u of users) firstTouch.set(u.email, Math.min(firstTouch.get(u.email) ?? Infinity, dayOf(u.created_at)));
  const cohort = [...firstTouch.entries()].filter(([, d]) => inRange(d)).map(([e]) => e);
  const approved = new Set(waitlist.filter((w) => w.approved_at).map((w) => w.email));
  const activeAccounts = new Set(users.filter((u) => u.status === "active").map((u) => u.email));
  const published = new Set(audit.filter((a) => a.action === "publish").map((a) => a.actor));
  const weeksActive = new Map<string, Set<number>>();
  for (const [d, people] of building) for (const e of people) (weeksActive.get(e) ?? weeksActive.set(e, new Set()).get(e)!).add(mondayOf(d));
  const stage = (pred: (e: string) => boolean) => cohort.filter(pred).length;
  const funnel = [
    { label: "Signed up", count: cohort.length, note: "Joined the waitlist or were invited" },
    { label: "Let in", count: stage((e) => approved.has(e) || activeAccounts.has(e)), note: "Approved off the waitlist" },
    { label: "Logged in", count: stage((e) => activeAccounts.has(e)), note: "Have an active account" },
    { label: "Connected an AI", count: stage((e) => connected.has(e)), note: "Claude, ChatGPT, Cursor… or an access key" },
    { label: "Published an app", count: stage((e) => published.has(e)), note: "Shipped at least one app" },
    { label: "Came back", count: stage((e) => (weeksActive.get(e)?.size ?? 0) >= 2), note: "Built in two or more different weeks" },
  ];

  // --- Retention: weekly cohorts of new accounts, the last 12 weeks ---------
  const thisWeek = mondayOf(today);
  const retention = { cohorts: [] as Metrics["retention"]["cohorts"] };
  for (let w = thisWeek - 11 * 7; w <= thisWeek; w += 7) {
    const members = users.filter((u) => u.status === "active" && mondayOf(dayOf(u.created_at)) === w).map((u) => u.email);
    const weeks: (number | null)[] = [];
    for (let k = 0; k < 12; k++) {
      const ws = w + k * 7;
      if (ws > today) weeks.push(null);
      else if (!members.length) weeks.push(null);
      else {
        const seen = peopleBetween(active, ws, Math.min(ws + 6, today));
        weeks.push(members.filter((e) => seen.has(e)).length / members.length);
      }
    }
    retention.cohorts.push({ label: shortDate(w), size: members.length, weeks });
  }

  // --- Tiles ---------------------------------------------------------------
  const wauNow = peopleBetween(active, today - 6, today);
  const trendOf = (values: number[], running = false) => sparkPoints(values, running);
  const accountsIn = (pred: (d: number) => boolean) => users.filter((u) => u.status === "active" && pred(dayOf(u.created_at))).length;
  const viewsIn = (pred: (d: number) => boolean, list = allVisits) => list.reduce((t, v) => t + (pred(v.d) ? v.views : 0), 0);
  const callsIn = (pred: (d: number) => boolean) => toolCalls.reduce((t, m) => t + (pred(m.d) ? m.n : 0), 0);
  const reachIn = (from: number, to: number) => peopleBetween(using, from, to).size;
  const withApp = new Set(sites.map((s) => s.owner_email));
  const accountsTotal = users.filter((u) => u.status === "active").length;
  const dauNow = active.get(today)?.size ?? 0;
  const mauNow = peopleBetween(active, today - 29, today).size;
  const firstPublishMs = new Map<string, number>();
  for (const s of raw.sites) if (!firstPublishMs.has(s.owner_email) || firstPublishMs.get(s.owner_email)! > s.created_at) firstPublishMs.set(s.owner_email, s.created_at);
  const ttfa = users
    .filter((u) => firstPublishMs.has(u.email) && firstPublishMs.get(u.email)! >= u.created_at)
    .map((u) => (firstPublishMs.get(u.email)! - u.created_at) / 3_600_000);

  const tiles: Metrics["tiles"] = {
    wau: {
      value: wauNow.size,
      previous: peopleBetween(active, today - 13, today - 7).size,
      // Weekly active people at the end of each of the last 12 weeks.
      trend: Array.from({ length: 12 }, (_, k) => peopleBetween(active, today - (11 - k) * 7 - 6, today - (11 - k) * 7).size),
      builders: peopleBetween(building, today - 6, today).size,
      appUsers: peopleBetween(using, today - 6, today).size,
    },
    accounts: { value: accountsIn(inRange), previous: hasPrev ? accountsIn(inPrev) : null, total: accountsTotal, trend: trendOf(growth.accounts.values, true) },
    apps: { value: sumWhere(inRange, ["publish"]), previous: hasPrev ? sumWhere(inPrev, ["publish"]) : null, total: live, trend: trendOf(growth.apps.values, true) },
    publishes: {
      value: sumWhere(inRange, ["publish", "replace"]),
      previous: hasPrev ? sumWhere(inPrev, ["publish", "replace"]) : null,
      trend: trendOf(shipping.newApps.values.map((v, i) => v + shipping.updates.values[i]!)),
    },
    mcpCalls: { value: callsIn(inRange), previous: hasPrev ? callsIn(inPrev) : null, trend: trendOf(byClientTotal([...byClient.values()], n)) },
    appViews: { value: viewsIn(inRange), previous: hasPrev ? viewsIn(inPrev) : null, trend: trendOf(appSeries.views.values), visitors: new Set(visits.filter((v) => inRange(v.d)).map((v) => v.email)).size, guestViews: viewsIn(inRange, guestVisits) },
    waitlist: {
      value: waitlist.filter((w) => inRange(dayOf(w.created_at))).length,
      previous: hasPrev ? waitlist.filter((w) => inPrev(dayOf(w.created_at))).length : null,
      waiting: waitlist.filter((w) => !w.approved_at && !activeAccounts.has(w.email)).length,
      trend: trendOf(growth.waitlistJoins.values),
    },
    activation: { value: accountsTotal ? users.filter((u) => u.status === "active" && withApp.has(u.email)).length / accountsTotal : 0, accounts: accountsTotal, withApp: users.filter((u) => u.status === "active" && withApp.has(u.email)).length },
    stickiness: { value: mauNow ? dauNow / mauNow : 0, dau: dauNow, mau: mauNow },
    reach: { value: reachIn(start, today), previous: hasPrev ? reachIn(prevStart, start - 1) : null, trend: trendOf(appSeries.sharedVisitors.values) },
    timeToFirstApp: median(ttfa),
  };

  // --- People --------------------------------------------------------------
  const appsOwned = new Map<string, number>();
  for (const s of sites) appsOwned.set(s.owner_email, (appsOwned.get(s.owner_email) ?? 0) + 1);
  const siteOwner = new Map(raw.sites.map((s) => [s.id, s.owner_email]));
  const reachOf = new Map<string, Set<string>>();
  for (const v of visits) {
    if (v.own || !inRange(v.d)) continue;
    const o = siteOwner.get(v.site_id);
    if (o) (reachOf.get(o) ?? reachOf.set(o, new Set()).get(o)!).add(v.email);
  }
  const lastActive = new Map<string, number>();
  for (const [d, people] of active) for (const e of people) if ((lastActive.get(e) ?? -1) < d) lastActive.set(e, d);
  const activeDays = new Map<string, number>();
  for (const [d, people] of active) if (inRange(d)) for (const e of people) activeDays.set(e, (activeDays.get(e) ?? 0) + 1);
  const pubs = new Map<string, number>();
  for (const a of audit) if ((a.action === "publish" || a.action === "replace") && inRange(a.d)) pubs.set(a.actor, (pubs.get(a.actor) ?? 0) + a.n);
  const personCalls = new Map<string, Map<string, number>>();
  for (const m of toolCalls) {
    if (!inRange(m.d)) continue;
    const c = personCalls.get(m.email) ?? personCalls.set(m.email, new Map()).get(m.email)!;
    c.set(clientFamily(m.client), (c.get(clientFamily(m.client)) ?? 0) + m.n);
  }
  const people: PersonRow[] = users
    .filter((u) => u.status === "active")
    .map((u) => {
      const c = personCalls.get(u.email);
      return {
        email: u.email,
        joined: u.created_at,
        apps: appsOwned.get(u.email) ?? 0,
        activeDays: activeDays.get(u.email) ?? 0,
        publishes: pubs.get(u.email) ?? 0,
        mcpCalls: c ? [...c.values()].reduce((a, b) => a + b, 0) : 0,
        reach: reachOf.get(u.email)?.size ?? 0,
        lastActive: lastActive.has(u.email) ? isoDay(lastActive.get(u.email)!) : null,
        client: c ? [...c.entries()].sort((a, b) => b[1] - a[1])[0]![0] : null,
      };
    })
    .filter((p) => p.activeDays || p.publishes || p.mcpCalls || p.reach)
    .sort((a, b) => b.activeDays - a.activeDays || b.publishes - a.publishes || b.mcpCalls - a.mcpCalls)
    .slice(0, 15);

  const mcpSince = raw.mcp.reduce<number | null>((t, m) => (t === null || m.first < t ? m.first : t), null);
  const visitsSince = raw.visits.reduce<string | null>((t, v) => (t === null || v.day < t ? v.day : t), null);
  return {
    range,
    includeTeam,
    unit,
    buckets,
    generatedAt: at,
    team: team.size,
    trackingSince: { mcp: mcpSince, visits: visitsSince },
    tiles,
    growth,
    engagement,
    shipping,
    funnel,
    retention,
    mcp: {
      byClient: [...byClient.values()],
      tools: [...tools.entries()].map(([name, t]) => ({ name, ...t })).sort((a, b) => b.calls - a.calls),
      clients: [...clients.entries()].map(([name, c]) => ({ name, people: c.people.size, calls: c.calls })).sort((a, b) => b.people - a.people || b.calls - a.calls),
      calls,
      errors,
      people: mcpPeople.size,
      sessions,
      p50: lat.p50,
      p95: lat.p95,
      connectedPeople: connected.size,
    },
    apps: { ...appSeries, top, adoption },
    people,
  };
}

/** A tile's sparkline over the period shown: at most 31 points, else one per 7 buckets (summed,
 * or the last value for running totals). Groups end at the latest bucket. */
function sparkPoints(values: number[], running: boolean): number[] {
  if (values.length <= 31) return values;
  const out: number[] = [];
  for (let end = values.length; end > 0; end -= 7) {
    const group = values.slice(Math.max(0, end - 7), end);
    out.unshift(running ? group[group.length - 1]! : group.reduce((a, b) => a + b, 0));
  }
  return out;
}

function byClientTotal(list: Series[], n: number): number[] {
  const out = zeros(n);
  for (const s of list) s.values.forEach((v, i) => (out[i]! += v));
  return out;
}
