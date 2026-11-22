import { describe, expect, it } from "vitest";
import { ApiError } from "../src/errors";
import { parseRules, scanAccess } from "../src/rules";

const enc = (s: string) => new TextEncoder().encode(s);
const rules = (v: unknown) => parseRules(enc(typeof v === "string" ? v : JSON.stringify(v)));
const files = (m: Record<string, string>) => new Map(Object.entries(m).map(([k, v]) => [k, enc(v)]));

function refusal(v: unknown): string {
  try {
    rules(v);
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).code).toBe("rules_invalid");
    return (e as ApiError).message;
  }
  throw new Error("expected a refusal");
}

const CRM = {
  default_role: "salesperson",
  manage_roles: ["manager"],
  records: {
    lead: {
      prefix: "lead:",
      fields: ["name", "stage", "assignedTo"],
      owner_field: "assignedTo",
      read: { manager: "all", salesperson: "own" },
      write: { manager: "all", salesperson: "own" },
    },
  },
};

describe("formelab.json", () => {
  it("accepts the spec's example and the one-line open rule", () => {
    expect(rules(CRM)).toEqual(CRM);
    expect(rules({ everyone: "all" })).toEqual({ everyone: "all" });
    expect(rules({ records: {} })).toEqual({ records: {} });
  });

  it("refuses broken files with the exact problem", () => {
    expect(refusal("{ nope")).toMatch(/^formelab\.json: it isn't valid JSON/);
    expect(refusal([])).toBe("formelab.json: it must be a JSON object.");
    expect(refusal({ everyone: "read" })).toMatch(/everyone is "read"/);
    expect(refusal({ everyone: "all", records: {} })).toMatch(/records isn't a known setting/);
    expect(refusal({})).toMatch(/needs "records"/);
    expect(refusal({ records: {}, roles: [] })).toMatch(/roles isn't a known setting/);
    expect(refusal({ records: { Lead: { prefix: "l:" } } })).toMatch(/record type "Lead"/);
    expect(refusal({ records: { lead: { prefix: "" } } })).toMatch(/records\.lead\.prefix is missing/);
    expect(refusal({ records: { lead: { prefix: "x".repeat(257) } } })).toMatch(/longer than 256/);
    expect(refusal({ records: { lead: { prefix: "l:", owner_feild: "a" } } })).toMatch(/records\.lead\.owner_feild isn't a known setting/);
    expect(refusal({ records: { lead: { prefix: "l:", read: { manager: "mine" } } } })).toBe(
      'formelab.json: records.lead.read.manager is "mine". Use "all", "own" or "none".',
    );
    expect(refusal({ records: { lead: { prefix: "l:", read: ["manager"] } } })).toMatch(/must be an object of roles/);
    expect(refusal({ records: { lead: { prefix: "l:", read: { salesperson: "own" } } } })).toMatch(/gives "own" access but has no owner_field/);
    expect(refusal({ records: { lead: { prefix: "l:", fields: ["name"], owner_field: "by", read: { s: "own" } } } })).toMatch(/owner_field "by" isn't one of its fields/);
    expect(refusal({ records: { lead: { prefix: "l:", fields: "name" } } })).toMatch(/fields must be a list/);
    expect(refusal({ records: { a: { prefix: "lead:" }, b: { prefix: "lead:old:" } } })).toMatch(/prefixes of a \("lead:"\) and b \("lead:old:"\) overlap/);
    expect(refusal({ ...CRM, default_role: "intern" })).toMatch(/default_role "intern" isn't given access/);
    expect(refusal({ ...CRM, manage_roles: "manager" })).toMatch(/manage_roles must be a list/);
    expect(refusal({ ...CRM, manage_roles: ["guest"] })).toMatch(/can't include "guest"/);
    expect(refusal({ ...CRM, manage_roles: ["boss"] })).toMatch(/manage_roles "boss" isn't given access/);
    expect(() => parseRules(new Uint8Array(64 * 1024 + 1))).toThrow(/larger than 64 KB/);
  });
});

describe("scanning an app's code", () => {
  it("finds shared data and its key prefixes", () => {
    const s = scanAccess(
      files({
        "index.html": `<script>formelab.kv.get("settings"); formelab.kv.set(\`lead:\${id}\`, v); kv.get('dish:1'); kv.delete("lead:" + id); formelab.kv.list("")</script>`,
        "style.css": `formelab.sheets`, // not code
      }),
    );
    expect(s).toEqual({ kv: true, prefixes: ["dish:", "lead:", "settings"], dynamic: false, sheets: false, connectors: false, rules: null, invites: false });
  });

  it("notes keys built at runtime", () => {
    expect(scanAccess(files({ "app.js": "formelab.kv.get(key)" })).dynamic).toBe(true);
    expect(scanAccess(files({ "app.js": "formelab.kv.set(`${a}:b`, 1)" })).dynamic).toBe(true);
    expect(scanAccess(files({ "app.js": "formelab.kv.list()" })).dynamic).toBe(true);
  });

  it("leaves out each person's own data", () => {
    const s = scanAccess(files({ "index.html": `<script>formelab.kv.mine.set("draft", 1); fetch("/_api/me/kv/x")</script>` }));
    expect(s.kv).toBe(false);
    expect(s.prefixes).toEqual([]);
    expect(s.dynamic).toBe(false);
  });

  it("finds raw API calls, Sheets and connectors", () => {
    expect(scanAccess(files({ "a.mjs": `fetch("/_api/kv/x")` })).kv).toBe(true);
    expect(scanAccess(files({ "a.js": "archie.kv.get('a')" })).kv).toBe(true);
    expect(scanAccess(files({ "a.js": "formelab.sheets.read(id, 'A1')" })).sheets).toBe(true);
    expect(scanAccess(files({ "a.js": "fetch('/_api/sheets', o)" })).sheets).toBe(true);
    for (const code of ["formelab.connectors.fetch('quo', '/v1')", "formelab.secrets.proxy('k', r)", "formelab.gemini.generate('hi')", "fetch('/_api/ai/gemini')"]) {
      expect(scanAccess(files({ "a.js": code })).connectors).toBe(true);
    }
    expect(scanAccess(files({ "a.js": "formelab.connectors.list()" })).connectors).toBe(false);
  });

  it("reads the rules and whether they allow invites", () => {
    const s = scanAccess(files({ "index.html": "", "formelab.json": JSON.stringify(CRM) }));
    expect(s.rules).toEqual(CRM);
    expect(s.invites).toBe(true);
    expect(scanAccess(files({ "index.html": "", "formelab.json": '{"everyone":"all"}' })).invites).toBe(false);
    expect(() => scanAccess(files({ "index.html": "", "formelab.json": "{" }))).toThrow(/isn't valid JSON/);
  });
});
