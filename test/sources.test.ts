import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { colName, parseA1 } from "../src/sheets";
import { appAt, call, onOutbound, OWNER, PAGE, publishZip, uniq } from "./helpers";

// Access rules over Google Sheets and connectors (spec step 6).
const SHEET = "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms";
const EDITOR = "ed@example.com";
type Err = { error: { code: string; message: string } };

/** The spreadsheet Google holds in this test: one tab, "Leads", with a heading row. */
let grid: string[][] = [];
let appendAt: string | null = null; // set to make Google append in other columns than asked
const sent: { method: string; url: string }[] = [];

function slice(range: string) {
  const a = parseA1(range)!;
  const rows = grid.slice(a.r1 - 1, a.r2 === Infinity ? undefined : a.r2).map((r) => r.slice(a.c1, a.c2 === Infinity ? undefined : a.c2 + 1));
  while (rows.length && !rows.at(-1)!.some((c) => c)) rows.pop();
  return { range, majorDimension: "ROWS", ...(rows.length ? { values: rows } : {}) };
}

function mockGoogle() {
  sent.length = 0;
  appendAt = null;
  grid = [
    ["Name", "Stage", "Assigned to"],
    ["Ada", "new", ""],
    ["Bo", "won", ""],
    ["Cy", "new", ""],
    ["Dee", "lost", ""],
  ];
  onOutbound(async (req) => {
    const url = new URL(req.url);
    if (url.href === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "at", expires_in: 3600, refresh_token: "rt-1", scope: "openid https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/userinfo.email", id_token: `x.${btoa('{"email":"me@gmail.com"}').replace(/=+$/, "")}.y` });
    sent.push({ method: req.method, url: req.url });
    const p = decodeURIComponent(url.pathname.replace(`/v4/spreadsheets/${SHEET}`, ""));
    if (p === "") return Response.json({ spreadsheetId: SHEET, sheets: [{ properties: { title: "Leads" } }] });
    if (p === "/values:batchGet") return Response.json({ valueRanges: url.searchParams.getAll("ranges").map(slice) });
    const range = p.replace(/^\/values\//, "").replace(/:(append|clear)$/, "");
    if (req.method === "GET") return Response.json(slice(range));
    const body = (await req.json()) as { values?: string[][] };
    if (p.endsWith(":append")) {
      grid.push(body.values![0]!);
      return Response.json({ spreadsheetId: SHEET, tableRange: `Leads!A1:C${grid.length - 1}`, updates: { updatedRange: appendAt ?? `Leads!A${grid.length}:C${grid.length}`, updatedRows: 1 } });
    }
    if (p.endsWith(":clear")) {
      const a = parseA1(range)!;
      for (let r = a.r1; r <= a.r2; r++) grid[r - 1] = grid[r - 1]!.map(() => "");
      return Response.json({});
    }
    const a = parseA1(range)!;
    body.values!.forEach((row, i) => row.forEach((v, j) => (grid[a.r1 - 1 + i]![a.c1 + j] = v)));
    return Response.json({ updatedRange: range });
  });
}

const RULES = (sheet: unknown, connectors?: unknown) => ({
  default_role: "rep",
  records: { note: { prefix: "note:", read: { rep: "all" } } },
  sources: { sheets: { [SHEET]: sheet }, ...(connectors ? { connectors } : {}) },
});
const OWN = { owner_column: "Assigned to", read: { rep: "own" }, write: { rep: "own" } };
const CODE = PAGE(`<script>formelab.kv.get("note:1"); formelab.sheets.read(id, "Leads!A:C")</script>`);

/** A new app with `rules`, shared with two people, its sheet listed, and a way to call Sheets as anyone. */
async function app(rules: unknown, opts: { code?: string; older?: boolean } = {}) {
  const ns = uniq();
  const rep = `rep-${ns}@x.test`;
  const rep2 = `rep2-${ns}@x.test`;
  const files: Record<string, string> = { "index.html": opts.code ?? CODE, ...(rules ? { "formelab.json": JSON.stringify(rules) } : {}) };
  const extra = { allowed_emails: `${rep}, ${rep2}`, editors: EDITOR };
  // An app made before access rules: published once without services, then as it is now.
  if (opts.older) expect((await publishZip(OWNER, ns, "s", { "index.html": PAGE("x") }, extra)).status).toBe(201);
  const res = await publishZip(OWNER, ns, "s", files, extra, { newApp: !opts.older });
  expect([200, 201], await res.clone().text()).toContain(res.status);
  const { site } = await res.json<{ site: { id: string } }>();
  expect((await call(`/_api/admin/sites/${site.id}`, { as: OWNER, method: "PATCH", json: { sheets: [SHEET] } })).status).toBe(200);
  grid[1]![2] = rep;
  grid[2]![2] = rep2;
  grid[3]![2] = ` ${rep.toUpperCase()} `;
  const origin = await appAt(ns, "s");
  const sheets = (as: string, json: unknown) => call(`${origin}/_api/sheets`, { as, mount: "/", method: "POST", json });
  const read = async (as: string, range: string) => (await sheets(as, { method: "GET", path: `spreadsheets/${SHEET}/values/${encodeURIComponent(range)}` }));
  const write = (as: string, range: string, values: unknown[][], append = false) =>
    sheets(as, { method: append ? "POST" : "PUT", path: `spreadsheets/${SHEET}/values/${encodeURIComponent(range)}${append ? ":append" : ""}`, query: { valueInputOption: "USER_ENTERED" }, body: { values } });
  return { ns, id: site.id, origin, rep, rep2, sheets, read, write };
}
const code = async (res: Response) => (await res.json<Err>()).error.code;

beforeEach(async () => {
  expect((await call("/_api/admin/features/connected_apps", { as: OWNER, method: "PUT", json: { state: "on" } })).status).toBe(200);
  mockGoogle();
  // Connect the owner's Google account the way a browser does.
  const start = await call("/app/services/google-sheets/connect", { as: OWNER });
  const state = new URL(start.headers.get("location")!).searchParams.get("state");
  const cookie = start.headers.getSetCookie().map((c) => c.split(";")[0]!).find((c) => c.startsWith("__Host-fl_sheets="))!;
  await call(`/app/services/google-sheets/callback?code=good-code&state=${state}`, { as: OWNER, headers: { cookie } });
});
afterEach(() => onOutbound(undefined));

describe("A1 ranges", () => {
  it("reads tab, rows and columns, and refuses ranges without a tab", () => {
    expect(parseA1("Leads!A2:C10")).toEqual({ tab: "Leads", c1: 0, r1: 2, c2: 2, r2: 10 });
    expect(parseA1("'It''s mine'!B:D")).toEqual({ tab: "It's mine", c1: 1, r1: 1, c2: 3, r2: Infinity });
    expect(parseA1("Leads!2:5")).toEqual({ tab: "Leads", c1: 0, r1: 2, c2: Infinity, r2: 5 });
    expect(parseA1("Leads!AA3")).toEqual({ tab: "Leads", c1: 26, r1: 3, c2: 26, r2: 3 });
    for (const r of ["A1:C10", "Leads", "Leads!A", "Leads!C1:A1", "Leads!A0:B2", "Leads!A:C10", "Named"]) expect(parseA1(r), r).toBeNull();
    expect([0, 25, 26, 701, 702].map(colName)).toEqual(["A", "Z", "AA", "ZZ", "AAA"]);
  });
});

describe("Sheets rows by owner column", () => {
  it("returns only the person's rows, keeping row positions, and everything to owners and editors", async () => {
    const { rep, rep2, read } = await app(RULES(OWN));
    const mine = await (await read(rep, "Leads!A1:C10")).json<{ data: { values: string[][] } }>();
    expect(mine.data.values).toEqual([["Name", "Stage", "Assigned to"], ["Ada", "new", rep], [], ["Cy", "new", ` ${rep.toUpperCase()} `]]);
    // A range without the owner column is still filtered by it; trailing rows that aren't theirs are left off.
    expect((await (await read(rep2, "Leads!A2:A")).json<{ data: { values: string[][] } }>()).data.values).toEqual([[], ["Bo"]]);
    for (const who of [OWNER, EDITOR]) expect((await (await read(who, "Leads!A1:C10")).json<{ data: { values: string[][] } }>()).data.values).toHaveLength(5);
    // Formelab asks for rows and formatted values itself.
    const batch = new URL([...sent].reverse().find((s) => s.url.includes("batchGet"))!.url);
    expect(batch.searchParams.get("majorDimension")).toBe("ROWS");
    expect(batch.searchParams.get("valueRenderOption")).toBe("FORMATTED_VALUE");
  });

  it("refuses the calls the filter doesn't understand", async () => {
    const { rep, read, sheets } = await app(RULES(OWN));
    expect(await code(await read(rep, "A1:C10"))).toBe("not_allowed"); // no tab
    for (const req of [
      { method: "GET", path: `spreadsheets/${SHEET}/values:batchGet`, query: { ranges: ["Leads!A:C"] } },
      { method: "POST", path: `spreadsheets/${SHEET}/values:batchUpdate`, body: { data: [] } },
      { method: "POST", path: `spreadsheets/${SHEET}/values/Leads!A:C:clear`, body: {} },
      { method: "POST", path: `spreadsheets/${SHEET}:batchUpdate`, body: { requests: [] } },
    ]) {
      const res = await sheets(rep, req);
      expect(res.status, req.path).toBe(403);
    }
    // Tab names are still fine, with Formelab's own field mask whatever the caller asks for.
    for (const fields of ["sheets.properties.title", "*", "sheets/*"]) {
      expect((await sheets(rep, { method: "GET", path: `spreadsheets/${SHEET}`, query: { fields, ranges: "Leads!A:C" } })).status, fields).not.toBe(403);
      const meta = new URL(sent.at(-1)!.url);
      expect(meta.pathname).toBe(`/v4/spreadsheets/${SHEET}`);
      expect([...meta.searchParams]).toEqual([["fields", "spreadsheetId,properties.title,sheets.properties"]]);
    }
  });

  it("adds rows only with the person's email in the owner column", async () => {
    const { rep, rep2, write } = await app(RULES(OWN));
    expect((await write(rep, "Leads!A:C", [["Eve", "new", rep]], true)).status).toBe(200);
    expect(grid.at(-1)).toEqual(["Eve", "new", rep]);
    const append = new URL([...sent].reverse().find((s) => s.url.includes(":append"))!.url);
    expect(append.searchParams.get("insertDataOption")).toBe("INSERT_ROWS");
    const before = grid.length;
    expect(await code(await write(rep, "Leads!A:C", [["Fay", "new", rep2]], true))).toBe("not_allowed");
    expect(await code(await write(rep, "Leads!A:C", [["Fay", "new", rep], ["Gus", "new", ""]], true))).toBe("not_allowed");
    expect(await code(await write(rep, "Leads!A:B", [["Fay", "new"]], true))).toBe("not_allowed"); // no owner column
    expect(await code(await write(rep, "Leads!A:C", [["=C3", "new", rep]], true))).toBe("not_allowed"); // would show Bo's email
    expect(grid.length).toBe(before);
  });

  it("takes a row out again when Google appends it in other columns", async () => {
    const { rep, write } = await app(RULES(OWN));
    appendAt = "Leads!B6:D6";
    const res = await write(rep, "Leads!A:C", [["Eve", "new", rep]], true);
    expect(res.status).toBe(409);
    expect(await code(res)).toBe("sheets_append_moved");
    expect(sent.at(-1)!.url).toContain(":clear");
  });

  it("changes only the person's own rows, and keeps them theirs", async () => {
    const { rep, rep2, write } = await app(RULES(OWN));
    expect((await write(rep, "Leads!B2", [["won"]])).status).toBe(200);
    expect(grid[1]![1]).toBe("won");
    expect(await code(await write(rep, "Leads!B3", [["lost"]]))).toBe("not_allowed"); // Bo's
    expect(await code(await write(rep, "Leads!B2:B3", [["x"], ["x"]]))).toBe("not_allowed"); // spans Bo's
    expect(await code(await write(rep, "Leads!B5", [["x"]]))).toBe("not_allowed"); // nobody's
    expect(await code(await write(rep, "Leads!A1:C1", [["x", "y", rep]]))).toBe("not_allowed"); // the heading row
    expect(await code(await write(rep, "Leads!A2:C2", [["Ada", "won", rep2]]))).toBe("not_allowed"); // giving it away
    expect(grid[2]).toEqual(["Bo", "won", rep2]);
  });

  it("says plainly when the tab has no owner column", async () => {
    const { rep, read } = await app(RULES({ ...OWN, owner_column: "Owner" }));
    const res = await read(rep, "Leads!A:C");
    expect(res.status).toBe(409);
    expect(await code(res)).toBe("sheets_owner_column_missing");
  });

  it("follows read and write levels separately", async () => {
    const { rep, read, write } = await app(RULES({ owner_column: "Assigned to", read: { rep: "all" }, write: { rep: "none" } }));
    expect((await (await read(rep, "Leads!A1:C10")).json<{ data: { values: string[][] } }>()).data.values).toHaveLength(5);
    expect(await code(await write(rep, "Leads!A:C", [["Eve", "new", rep]], true))).toBe("not_allowed");
  });

  it("keeps a spreadsheet the rules don't name for owners and editors, in new apps", async () => {
    // The code doesn't mention Sheets, so publish lets the missing "sources" through; the runtime doesn't.
    const { rep, read } = await app({ default_role: "rep", records: { note: { prefix: "note:", read: { rep: "all" } } } }, { code: PAGE(`<script>formelab.kv.get("note:1")</script>`) });
    expect(await code(await read(rep, "Leads!A:C"))).toBe("not_allowed");
    expect((await read(OWNER, "Leads!A:C")).status).toBe(200);
  });

  it("keeps today's behavior for apps made before access rules whose rules don't name services", async () => {
    const { rep, read } = await app({ default_role: "rep", records: { note: { prefix: "note:", read: { rep: "all" } } } }, { older: true });
    expect((await (await read(rep, "Leads!A1:C10")).json<{ data: { values: string[][] } }>()).data.values).toHaveLength(5);
  });
});

describe("connectors, saved keys and Gemini by role", () => {
  it("lets each role use only the services the rules give it", async () => {
    const { rep, origin } = await app(RULES(OWN, { quo: { rep: "all" }, gemini: { rep: "none" } }));
    const post = (as: string, path: string) => call(`${origin}/_api/${path}`, { as, mount: "/", method: "POST", json: { url: "/v1/x", prompt: "hi" } });
    for (const path of ["connectors/other/fetch", "secrets/other/proxy", "secrets/gemini/proxy", "ai/gemini"]) {
      const res = await post(rep, path);
      expect(res.status, path).toBe(403);
      expect(await code(res), path).toBe("not_allowed");
    }
    // quo is allowed, so the call gets past the rules (and fails later: the app wasn't built to use it).
    expect(await code(await post(rep, "connectors/quo/fetch"))).not.toBe("not_allowed");
    expect(await code(await post(OWNER, "connectors/other/fetch"))).not.toBe("not_allowed");
  });
});

describe("publishing", () => {
  it("refuses a new app whose rules don't say who uses the services its code calls", async () => {
    const ns = uniq();
    const bare = { default_role: "rep", records: { note: { prefix: "note:", read: { rep: "all" } } } };
    const res = await publishZip(OWNER, ns, "s", { "index.html": CODE, "formelab.json": JSON.stringify(bare) }, {}, { newApp: true });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string; message: string; details: { prompt: string } } }>();
    expect(body.error.code).toBe("rules_required");
    expect(body.error.message).toContain("uses Google Sheets, but its access rules don't say who can use them");
    expect(body.error.details.prompt).toContain('Add a "sources" section');
    // Apps made before access rules publish as before.
    const old = uniq();
    await publishZip(OWNER, old, "s", { "index.html": PAGE("x") });
    expect((await publishZip(OWNER, old, "s", { "index.html": CODE, "formelab.json": JSON.stringify(bare) })).status).toBe(200);
    expect(await env.DB.prepare("SELECT 1 FROM sites WHERE namespace = ?").bind(ns).first()).toBeNull();
  });
});
