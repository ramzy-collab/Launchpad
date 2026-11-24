import { describe, expect, it } from "vitest";
import { ApiError } from "../src/errors";
import { GUIDE_MD } from "../src/generated/assets";
import { parseRules, scanAccess, sourceLevel } from "../src/rules";

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

  it("accepts the guide's examples", () => {
    const section = GUIDE_MD.slice(GUIDE_MD.indexOf("## 4. Access rules"), GUIDE_MD.indexOf("## 5. Patterns"));
    const examples = [...section.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]!);
    expect(examples).toHaveLength(3);
    for (const json of examples) expect(() => rules(json)).not.toThrow();
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

  it("checks the connected services it names", () => {
    const ID = "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms";
    const withSources = (sources: unknown) => ({ ...CRM, sources });
    const ok = withSources({ sheets: { [ID]: { owner_column: "Assigned to", read: { salesperson: "own" }, write: { salesperson: "own" } } }, connectors: { quo: { manager: "all" }, gemini: { salesperson: "none" } } });
    expect(rules(ok)).toEqual(ok);
    // A role used only by a service still counts for default_role.
    expect(() => rules({ default_role: "temp", records: {}, sources: { connectors: { quo: { temp: "all" } } } })).not.toThrow();
    expect(refusal({ everyone: "all", sources: {} })).toMatch(/sources isn't a known setting/);
    expect(refusal(withSources([]))).toMatch(/sources must be an object/);
    expect(refusal(withSources({ airtable: {} }))).toMatch(/sources\.airtable isn't a known setting/);
    expect(refusal(withSources({ sheets: { "my-sheet": { read: {} } } }))).toMatch(/"my-sheet" isn't a spreadsheet id/);
    expect(refusal(withSources({ sheets: { [ID]: { read: { salesperson: "own" } } } }))).toMatch(/gives "own" access but has no owner_column/);
    expect(refusal(withSources({ sheets: { [ID]: { owner_column: " ", read: {} } } }))).toMatch(/owner_column must be the text in row 1/);
    expect(refusal(withSources({ sheets: { [ID]: { owner_col: "x" } } }))).toMatch(/owner_col isn't a known setting/);
    expect(refusal(withSources({ sheets: { [ID]: { read: { guest: "all" } } } }))).toMatch(/guest: people who open the app through its public link/);
    expect(refusal(withSources({ connectors: { Quo: { manager: "all" } } }))).toMatch(/"Quo" isn't a connector name/);
    expect(refusal(withSources({ connectors: { quo: { salesperson: "own" } } }))).toMatch(/can't tell whose data a connected service returns/);
    expect(refusal(withSources({ connectors: { quo: { salesperson: "some" } } }))).toMatch(/Use "all", "own" or "none"/);
  });

  it("gives each role its level for a service", () => {
    const ID = "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms";
    const r = rules({ ...CRM, sources: { sheets: { [ID]: { read: { salesperson: "all" } } }, connectors: { quo: { salesperson: "all" } } } });
    const rep = { manages: false, guest: false, email: "a@x.test", role: "salesperson" };
    expect(sourceLevel(r, rep, true, "sheets", ID, "read")).toBe("all");
    expect(sourceLevel(r, rep, true, "sheets", ID, "write")).toBe("none"); // no "write" at all
    expect(sourceLevel(r, rep, true, "connectors", "other", "read")).toBe("none");
    expect(sourceLevel(r, { ...rep, manages: true }, true, "connectors", "other", "read")).toBe("all");
    expect(sourceLevel(r, { ...rep, guest: true, email: null }, true, "connectors", "quo", "read")).toBe("none");
    // Rules without "sources": today's behavior for older apps, owner and editors only for new ones.
    expect(sourceLevel(CRM as never, rep, false, "sheets", ID, "write")).toBe("all");
    expect(sourceLevel(CRM as never, rep, true, "sheets", ID, "read")).toBe("none");
    expect(sourceLevel(null, rep, true, "sheets", ID, "read")).toBe("all");
    expect(sourceLevel({ everyone: "all" }, rep, true, "connectors", "quo", "read")).toBe("all");
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
