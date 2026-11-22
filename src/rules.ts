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
