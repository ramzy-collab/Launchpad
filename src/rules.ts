// An app's access rules (formelab.json) and the fixed scan publish uses to tell whether an app
// needs them: does its code save shared data, use Google Sheets or call connectors. No AI is
// involved. See docs/specs/2026-11-22-agent-access.md, step 2.
import { err } from "./errors";
import { KV_MAX_KEY } from "./kv";
import type { FileMap } from "./upload";

export const RULES_FILE = "formelab.json";
const RULES_MAX_BYTES = 64 * 1024;
const NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const LEVELS = ["all", "own", "none"] as const;
export type Level = (typeof LEVELS)[number];

export interface RecordRule {
  prefix: string;
  fields?: string[];
  owner_field?: string;
  read: Record<string, Level>;
  write: Record<string, Level>;
}

/** Either the one-line open rule (everyone may read and write everything) or rules per record type. */
export type Rules =
  | { everyone: "all" }
  | { default_role?: string; manage_roles?: string[]; records: Record<string, RecordRule> };

const HINT = "Fix formelab.json and publish again. The guide's Access rules section shows the format.";
const bad = (message: string) => err(400, "rules_invalid", `formelab.json: ${message}`, HINT);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const show = (v: unknown) => JSON.stringify(v)?.slice(0, 60) ?? String(v);

function onlyKeys(o: Record<string, unknown>, where: string, allowed: string[]) {
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) throw bad(`${where}${where ? "." : ""}${k} isn't a known setting. Use ${allowed.map((a) => `"${a}"`).join(", ")}.`);
  }
}

function name(v: unknown, where: string): string {
  if (typeof v !== "string" || !NAME_RE.test(v)) {
    throw bad(`${where} is ${show(v)}. Names use lowercase letters, digits, "_" or "-", start with a letter and are at most 32 characters.`);
  }
  return v;
}

function levels(v: unknown, where: string): Record<string, Level> {
  if (v === undefined) return {};
  if (!isObject(v)) throw bad(`${where} must be an object of roles, like {"manager": "all"}.`);
  for (const [role, level] of Object.entries(v)) {
    name(role, `${where} role ${show(role)}`);
    if (!LEVELS.includes(level as Level)) throw bad(`${where}.${role} is ${show(level)}. Use "all", "own" or "none".`);
  }
  return v as Record<string, Level>;
}

/** Parses and checks formelab.json. Throws rules_invalid with the exact problem. */
export function parseRules(bytes: Uint8Array): Rules {
  if (bytes.length > RULES_MAX_BYTES) throw bad(`the file is larger than ${RULES_MAX_BYTES / 1024} KB.`);
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch (e) {
    throw bad(`it isn't valid JSON (${e instanceof Error ? e.message : "parse error"}).`);
  }
  if (!isObject(raw)) throw bad("it must be a JSON object.");

  if ("everyone" in raw) {
    onlyKeys(raw, "", ["everyone"]);
    if (raw.everyone !== "all") throw bad(`everyone is ${show(raw.everyone)}. The only value is "all" (everyone may read and write everything).`);
    return { everyone: "all" };
  }

  onlyKeys(raw, "", ["default_role", "manage_roles", "records"]);
  if (!isObject(raw.records)) throw bad(`it needs "records" (each kind of record and who may see and change it), or {"everyone": "all"}.`);
  const used = new Set<string>();
  const prefixes: [string, string][] = [];
  for (const [type, r] of Object.entries(raw.records)) {
    const where = `records.${type}`;
    name(type, `the record type ${show(type)}`);
    if (!isObject(r)) throw bad(`${where} must be an object.`);
    onlyKeys(r, where, ["prefix", "fields", "owner_field", "read", "write"]);
    if (typeof r.prefix !== "string" || !r.prefix) throw bad(`${where}.prefix is missing. Give the start of its keys, like "lead:".`);
    if (r.prefix.length > KV_MAX_KEY) throw bad(`${where}.prefix is longer than ${KV_MAX_KEY} characters.`);
    for (const [other, p] of prefixes) {
      // The keys of one would match both rules, so which one applies would be unclear.
      if (p.startsWith(r.prefix) || r.prefix.startsWith(p)) throw bad(`the prefixes of ${other} (${show(p)}) and ${type} (${show(r.prefix)}) overlap. Use prefixes where neither starts the other.`);
    }
    prefixes.push([type, r.prefix]);
    if (r.fields !== undefined && !(Array.isArray(r.fields) && r.fields.every((f) => typeof f === "string" && f))) {
      throw bad(`${where}.fields must be a list of field names.`);
    }
    if (r.owner_field !== undefined && (typeof r.owner_field !== "string" || !r.owner_field)) throw bad(`${where}.owner_field must be a field name.`);
    const read = levels(r.read, `${where}.read`);
    const write = levels(r.write, `${where}.write`);
    const ownUsed = [...Object.values(read), ...Object.values(write)].includes("own");
    if (ownUsed && !r.owner_field) throw bad(`${where} gives "own" access but has no owner_field (the field holding the email of the person a record belongs to).`);
    if (r.owner_field && r.fields && !r.fields.includes(r.owner_field)) throw bad(`${where}.owner_field ${show(r.owner_field)} isn't one of its fields.`);
    for (const role of [...Object.keys(read), ...Object.keys(write)]) used.add(role);
  }

  if (raw.default_role !== undefined) {
    const role = name(raw.default_role, "default_role");
    if (!used.has(role)) throw bad(`default_role ${show(role)} isn't given access to any record.`);
  }
  if (raw.manage_roles !== undefined) {
    if (!Array.isArray(raw.manage_roles)) throw bad(`manage_roles must be a list of roles, like ["manager"].`);
    for (const role of raw.manage_roles) {
      name(role, "manage_roles");
      if (role === "guest") throw bad(`manage_roles can't include "guest" (signed-out visitors can't manage people).`);
      if (!used.has(role)) throw bad(`manage_roles ${show(role)} isn't given access to any record.`);
    }
  }
  return raw as Rules;
}

export interface AccessScan {
  /** Uses shared data (formelab.kv; formelab.kv.mine is each person's own and doesn't count). */
  kv: boolean;
  /** Key prefixes found in formelab.kv calls, like "lead:" or "settings". */
  prefixes: string[];
  /** Some formelab.kv call's key isn't written out in the code. */
  dynamic: boolean;
  sheets: boolean;
  /** Custom connectors, saved keys (secrets.proxy) or Google Gemini. */
  connectors: boolean;
  /** The app's valid rules, or null when it has no formelab.json. */
  rules: Rules | null;
  /** The rules let people in the app invite others (manage_roles), so treat it as public. */
  invites: boolean;
}

const SCANNED = /\.(?:html?|m?js)$/i;
const SDK = String.raw`\b(?:formelab|archie)\s*\.\s*`; // the SDK's global and its old name
const KV_RE = new RegExp(String.raw`${SDK}kv\b(?!\s*\.\s*mine\b)|/_api/kv\b`);
const SHEETS_RE = new RegExp(String.raw`${SDK}sheets\b|/_api/sheets\b`);
const CONNECTORS_RE = new RegExp(String.raw`${SDK}(?:connectors\s*\.\s*fetch|secrets\s*\.\s*proxy|gemini)\b|/_api/(?:connectors|secrets|ai)/`);
const KV_CALL_RE = /\bkv\s*\.\s*(?:get|set|delete|list)\s*\(/g;
// The written-out start of a call's key: up to the closing quote, or a template's first ${.
const KV_KEY_RE = /\bkv\s*\.\s*(get|set|delete|list)\s*\(\s*(?:"([^"\\]*)|'([^'\\]*)|`([^`\\$]*))/g;

/**
 * What the app's code uses, and its rules. Throws rules_invalid when formelab.json is broken.
 * shortcut: a text search, so aliases like formelab["kv"] slip past; step 3's runtime backstop catches those.
 */
export function scanAccess(files: FileMap): AccessScan {
  const rulesFile = files.get(RULES_FILE);
  const rules = rulesFile ? parseRules(rulesFile) : null;
  const scan: AccessScan = { kv: false, prefixes: [], dynamic: false, sheets: false, connectors: false, rules, invites: !!(rules && "records" in rules && rules.manage_roles?.length) };
  const prefixes = new Set<string>();
  const text = new TextDecoder();
  for (const [path, bytes] of files) {
    if (!SCANNED.test(path)) continue;
    const code = text.decode(bytes);
    scan.kv ||= KV_RE.test(code);
    scan.sheets ||= SHEETS_RE.test(code);
    scan.connectors ||= CONNECTORS_RE.test(code);
    let literal = 0;
    for (const m of code.matchAll(KV_KEY_RE)) {
      literal++;
      const key = m[2] ?? m[3] ?? m[4] ?? "";
      // "dish:1" and `dish:${id}` are both dish: records.
      const colon = key.indexOf(":");
      const prefix = colon >= 0 ? key.slice(0, colon + 1) : key;
      if (prefix) prefixes.add(prefix);
      else if (m[1] !== "list") scan.dynamic = true; // list("") reads everything; any other empty start is a key built at runtime
    }
    if ((code.match(KV_CALL_RE)?.length ?? 0) > literal) scan.dynamic = true;
  }
  scan.prefixes = [...prefixes].sort();
  return scan;
}

/** What the app's settings page needs from a scan, stored in sites.access as JSON. */
export const storedAccess = (s: AccessScan) =>
  JSON.stringify({ kv: s.kv, prefixes: s.prefixes, dynamic: s.dynamic, sheets: s.sheets, connectors: s.connectors, rules: !!s.rules, invites: s.invites });

/** Whether the app needs rules it doesn't have: it saves shared data or uses connected services. */
export const needsRules = (s: AccessScan) => !s.rules && (s.kv || s.sheets || s.connectors);

const LISTED = 10;
const listOf = (items: string[]) => (items.length < 3 ? items.join(" and ") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

/** The refusal for a new app that needs rules: the reason, the remedy and a prompt to paste into an AI tool. */
export function rulesRequired(s: AccessScan, guideUrl: string) {
  const shown = s.prefixes.slice(0, LISTED);
  const more = s.prefixes.length > LISTED ? ` and ${s.prefixes.length - LISTED} more` : "";
  const services = [s.sheets && "Google Sheets", s.connectors && "connected services"].filter((x): x is string => !!x);
  const uses = services.length ? `uses ${listOf(services)}` : "";
  let what: string;
  let promptStart: string;
  if (s.kv) {
    what = `saves data${shown.length ? ` (we found ${listOf(shown)}${more} records)` : ""}${uses ? ` and ${uses}` : ""}`;
    promptStart = shown.length ? `My Formelab app saves data under these keys: ${shown.join(", ")}${more ? ", and others" : ""}.` : "My Formelab app saves data with formelab.kv.";
    if (uses) promptStart += ` It also ${uses}.`;
  } else {
    what = uses;
    promptStart = `My Formelab app ${uses}.`;
  }
  const ask = s.kv ? "Ask me who should see and change each kind of record before you write it." : "Ask me who should use them before you write it.";
  const prompt = `${promptStart} Write a formelab.json access rules file for it, following ${guideUrl}. ${ask}`;
  const fix = s.kv ? "add a formelab.json that says who can see and change each kind of record." : "add a formelab.json that says who can use the app.";
  return err(400, "rules_required", `This app can't be published yet. It ${what} but has no access rules, so we can't tell who should see what.`,
    `To fix it, ${fix} Or paste this into Claude, ChatGPT or your AI tool: ${prompt}`,
    { title: "This app can't be published yet", reason: `It ${what} but has no access rules, so we can't tell who should see what.`, fix, prompt, prefixes: s.prefixes });
}

/** Asked before publishing rules that let people in the app invite others (manage_roles). */
export const confirmPublic = () =>
  err(409, "confirm_public", "People using this app can invite anyone. Treat it as public: anyone they invite can open it.",
    "Ask the person whether to publish anyway. Only if they say yes, publish again with confirm_public set to true.",
    { title: "People using this app can invite anyone", reason: "Treat it as public: anyone they invite can open it." });
