import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { call, onOutbound, OWNER, PAGE, publishHtml, uniq, appAt } from "./helpers";

type Seen = { url: string; method: string; auth: string | null; body: string };
const seen: Seen[] = [];
const idToken = (email: string) => `x.${btoa(JSON.stringify({ email })).replace(/=+$/, "")}.y`;

/** A stand-in for Google's token, revoke and Sheets endpoints. */
function mockGoogle(opts: { expiresIn?: number } = {}) {
  seen.length = 0;
  let issued = 0;
  onOutbound(async (req) => {
    const body = req.method === "GET" ? "" : await req.text();
    seen.push({ url: req.url, method: req.method, auth: req.headers.get("authorization"), body });
    const url = new URL(req.url);
    if (url.href === "https://oauth2.googleapis.com/token") {
      const p = new URLSearchParams(body);
      issued++;
      if (p.get("grant_type") === "authorization_code") {
        if (p.get("code") !== "good-code" || p.get("client_secret") !== "gsecret" || !p.get("code_verifier")) return Response.json({ error: "invalid_grant" }, { status: 400 });
        return Response.json({ access_token: `at-${issued}`, expires_in: opts.expiresIn ?? 3600, refresh_token: "rt-1", scope: "openid https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/userinfo.email", id_token: idToken("me@gmail.com") });
      }
      if (p.get("grant_type") === "refresh_token" && p.get("refresh_token") === "rt-1") return Response.json({ access_token: `at-${issued}`, expires_in: 3600 });
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    if (url.href === "https://oauth2.googleapis.com/revoke") return new Response("");
    if (url.hostname === "sheets.googleapis.com") {
      if (url.pathname.endsWith("/values/Sheet1!A1:B2")) return Response.json({ values: [["Name", "Email"], ["Ada", "ada@example.com"]] });
      if (url.pathname.endsWith(":append")) return Response.json({ updates: { updatedRows: 1 } });
      return Response.json({ error: { message: "Requested entity was not found." } }, { status: 404 });
    }
    return new Response("unexpected", { status: 599 });
  });
}

const setFlag = (state: string) => call("/_api/admin/features/connected_apps", { as: OWNER, method: "PUT", json: { state } });
const cookieFrom = (res: Response, name: string) => res.headers.getSetCookie().map((c) => c.split(";")[0]!).find((c) => c.startsWith(name + "=") && c.length > name.length + 1) ?? null;

/** Connect with Google as `as`, the way a browser goes through it. */
async function connectSheets(as: string, code = "good-code") {
  const start = await call("/app/services/google-sheets/connect", { as });
  expect(start.status).toBe(302);
  const google = new URL(start.headers.get("location")!);
  const cb = await call(`/app/services/google-sheets/callback?code=${code}&state=${google.searchParams.get("state")}`, {
    as,
    headers: { cookie: cookieFrom(start, "__Host-fl_sheets")! },
  });
  return { google, cb };
}
const SHEET = "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms";
/** Lists spreadsheets for the app at <ns>/s, as its owner. */
async function allowSheets(as: string, ns: string, list: unknown) {
  const site = await env.DB.prepare("SELECT id FROM sites WHERE namespace = ? AND mount_path = 's'").bind(ns).first<{ id: string }>();
  return call(`/_api/admin/sites/${site!.id}`, { as, method: "PATCH", json: { sheets: list } });
}
const sheets = async (as: string, ns: string, json: unknown) => call(`${await appAt(ns, "s")}/_api/sheets`, { as, mount: "/", method: "POST", json });

afterEach(() => onOutbound(undefined));

describe("Google Sheets as a connected app (OAuth)", () => {
  beforeEach(async () => {
    expect((await setFlag("on")).status).toBe(200);
  });

  it("signs in with Google (state + PKCE) and stores the connection encrypted", async () => {
    mockGoogle();
    const me = `s-${uniq()}@example.com`;
    await call("/_api/admin/whoami", { as: me });
    const { google, cb } = await connectSheets(me);
    expect(google.origin + google.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(google.searchParams.get("client_id")).toBe("gclient.apps.googleusercontent.com");
    expect(google.searchParams.get("redirect_uri")).toBe("https://app.example.com/services/google-sheets/callback");
    expect(google.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/spreadsheets");
    expect(google.searchParams.get("access_type")).toBe("offline");
    expect(google.searchParams.get("code_challenge_method")).toBe("S256");
    expect(cb.headers.get("location")).toBe("/connected/google-sheets?sheets=connected");

    const row = await env.DB.prepare("SELECT * FROM service_keys WHERE owner_email = ? AND service = 'google_sheets'").bind(me).first<{ hint: string }>();
    expect(row!.hint).toBe("me@gmail.com");
    expect(JSON.stringify(row)).not.toContain("rt-1");
    const page = await (await call("/app/connected/google-sheets?sheets=connected", { as: me })).text();
    expect(page).toContain("Connected</span> as me@gmail.com.");
    expect(page).toContain("Connected. Your apps can use your Google Sheets now.");

    // A bad code or a missing cookie connects nothing.
    const other = `s2-${uniq()}@example.com`;
    expect((await connectSheets(other, "bad-code")).cb.headers.get("location")).toBe("/connected/google-sheets?sheets=failed");
    expect((await call(`/app/services/google-sheets/callback?code=good-code&state=x`, { as: other })).headers.get("location")).toBe("/connected/google-sheets?sheets=expired");
    expect(await env.DB.prepare("SELECT 1 FROM service_keys WHERE owner_email = ?").bind(other).first()).toBeNull();
  });

  it("lets the owner's apps read and add rows, refreshing the sign-in when it expires", async () => {
    mockGoogle({ expiresIn: 30 }); // expires within a minute: the first call refreshes it
    const ns = uniq();
    const friend = `sf-${uniq()}@example.com`;
    await publishHtml(OWNER, ns, "s", PAGE("x"), { allowed_emails: friend });
    await connectSheets(OWNER);
    expect((await allowSheets(OWNER, ns, [SHEET])).status).toBe(200);

    expect(await (await call(`${await appAt(ns, "s")}/_api/sheets`, { as: OWNER, mount: "/" })).json()).toEqual({ connected: true, available: true });
    const read = await sheets(OWNER, ns, { method: "GET", path: "spreadsheets/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/values/Sheet1!A1:B2" });
    expect(read.status).toBe(200);
    const text = await read.text();
    expect(JSON.parse(text).data.values[1]).toEqual(["Ada", "ada@example.com"]);
    expect(text).not.toContain("at-");
    expect(seen.some((s) => s.body.includes("grant_type=refresh_token"))).toBe(true);
    const call1 = seen.find((s) => s.url.startsWith("https://sheets.googleapis.com/"))!;
    expect(call1.url).toBe("https://sheets.googleapis.com/v4/spreadsheets/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/values/Sheet1!A1:B2");
    expect(call1.auth).toMatch(/^Bearer at-\d+$/);

    // Someone the app is shared with uses the owner's connection.
    const add = await sheets(friend, ns, { method: "POST", path: "spreadsheets/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/values/Sheet1!A:B:append", query: { valueInputOption: "USER_ENTERED" }, body: { values: [["Bo", "bo@example.com"]] } });
    expect(add.status).toBe(200);
    const sent = seen.at(-1)!;
    expect(sent.url).toBe("https://sheets.googleapis.com/v4/spreadsheets/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/values/Sheet1!A:B:append?valueInputOption=USER_ENTERED");
    expect(JSON.parse(sent.body)).toEqual({ values: [["Bo", "bo@example.com"]] });

    // Only Sheets API paths.
    for (const path of ["../v1/files", "spreadsheets/%2e%2e/%2e%2e/oauth", "drive/v3/files", "https://evil.test/x"]) {
      expect((await sheets(OWNER, ns, { method: "GET", path })).status, path).toBe(400);
    }
    expect((await sheets(OWNER, ns, { method: "GET", path: "spreadsheets/nope/values/A1" })).status).toBe(403);

    const site = await env.DB.prepare("SELECT id FROM sites WHERE namespace = ?").bind(ns).first<{ id: string }>();
    const log = await (await call(`/app/apps/${site!.id}/activity`, { as: OWNER })).text();
    expect(log).toContain("Read from Google Sheets");
    expect(log).toContain("Wrote to Google Sheets");
  });

  it("disconnects (revoking at Google), and apps are told to ask the owner to connect", async () => {
    mockGoogle();
    const owner = `sd-${uniq()}@example.com`;
    const ns = uniq();
    await publishHtml(owner, ns, "s", PAGE("x"));
    await allowSheets(owner, ns, [SHEET]);
    const r = await sheets(owner, ns, { method: "GET", path: "spreadsheets/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/values/Sheet1!A1:B2" });
    expect(r.status).toBe(409);
    expect((await r.json<{ error: { code: string } }>()).error.code).toBe("sheets_not_connected");
    await connectSheets(owner);
    expect((await sheets(owner, ns, { method: "GET", path: "spreadsheets/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/values/Sheet1!A1:B2" })).status).toBe(200);
    expect((await call("/_api/admin/services/google-sheets", { as: owner, method: "DELETE" })).status).toBe(200);
    expect(seen.some((s) => s.url === "https://oauth2.googleapis.com/revoke" && s.body.includes("token=rt-1"))).toBe(true);
    expect((await sheets(owner, ns, { method: "GET", path: "spreadsheets/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/values/Sheet1!A1:B2" })).status).toBe(409);
  });

  it("limits each person using the owner's apps to 20 calls a minute", async () => {
    mockGoogle();
    const ns = uniq();
    const friend = `sl-${uniq()}@example.com`;
    await publishHtml(OWNER, ns, "s", PAGE("x"), { allowed_emails: friend });
    await connectSheets(OWNER);
    expect((await allowSheets(OWNER, ns, [SHEET])).status).toBe(200);
    const read = (as: string) => sheets(as, ns, { method: "GET", path: `spreadsheets/${SHEET}/values/Sheet1!A1:B2` });
    for (let i = 0; i < 20; i++) expect((await read(friend)).status).toBe(200);
    const limited = await read(friend);
    expect(limited.status).toBe(429);
    expect((await limited.json<{ error: { message: string } }>()).error.message).toContain("Google Sheets through this person's apps");
    expect((await read(OWNER)).status).toBe(200);
  });

  it("treats spreadsheet ids that differ only in case as different spreadsheets", async () => {
    const ns = uniq();
    await publishHtml(OWNER, ns, "s", PAGE("x"));
    expect((await allowSheets(OWNER, ns, [SHEET])).status).toBe(200);
    const other = SHEET.toUpperCase();
    const res = await allowSheets(OWNER, ns, [other]);
    expect(res.status).toBe(200);
    expect((await res.json<{ sheets: string[] }>()).sheets).toEqual([other]);
  });

  it("only lets an app use the spreadsheets its owner listed for it", async () => {
    mockGoogle();
    const ns = uniq();
    const friend = `sl-${uniq()}@example.com`;
    const editor = `se-${uniq()}@example.com`;
    await publishHtml(OWNER, ns, "s", PAGE("x"), { allowed_emails: friend, editors: editor });
    await connectSheets(OWNER);
    const read = (as: string, id: string) => sheets(as, ns, { method: "GET", path: `spreadsheets/${id}/values/Sheet1!A1:B2` });
    const other = "1OtherSpreadsheetIdOfTheOwner_0123456789ab";

    // Nothing is listed yet: every spreadsheet is refused, before anything reaches Google.
    seen.length = 0;
    const refused = await read(friend, SHEET);
    expect(refused.status).toBe(403);
    expect((await refused.json<{ error: { code: string } }>()).error.code).toBe("sheet_not_allowed");
    expect(seen.some((s) => s.url.startsWith("https://sheets.googleapis.com/"))).toBe(false);

    // A link works as well as an id; listed spreadsheets work for viewers, others still don't.
    expect((await allowSheets(OWNER, ns, `https://docs.google.com/spreadsheets/d/${SHEET}/edit#gid=0`)).status).toBe(200);
    expect((await read(friend, SHEET)).status).toBe(200);
    expect((await read(friend, other)).status).toBe(403);
    expect((await sheets(friend, ns, { method: "POST", path: `spreadsheets/${other}:batchUpdate`, body: { requests: [] } })).status).toBe(403);
    // A path has to name a spreadsheet (apart from creating one).
    expect((await sheets(OWNER, ns, { method: "GET", path: "spreadsheets" })).status).toBe(400);

    // Only the owner chooses the list: not editors, and not with bad ids.
    const byEditor = await allowSheets(editor, ns, [SHEET, other]);
    expect(byEditor.status).toBe(403);
    expect((await byEditor.json<{ error: { code: string } }>()).error.code).toBe("owner_only");
    expect((await allowSheets(OWNER, ns, ["not a sheet"])).status).toBe(400);
    expect((await read(friend, other)).status).toBe(403);
    // An editor saving the settings form without touching the list is fine.
    expect((await allowSheets(editor, ns, [SHEET])).status).toBe(200);
  });

  it("lets only the owner create a spreadsheet, and adds it to the app's list", async () => {
    mockGoogle();
    const created = "1NewlyCreatedSpreadsheetId_abcdefghijklmn";
    const base = (globalThis as unknown as { __lpOutbound?: (r: Request) => Promise<Response> }).__lpOutbound!;
    onOutbound(async (req) => {
      if (req.url === "https://sheets.googleapis.com/v4/spreadsheets" && req.method === "POST") {
        return Response.json({ spreadsheetId: created, spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${created}/edit` });
      }
      return base(req);
    });
    const ns = uniq();
    const friend = `sc-${uniq()}@example.com`;
    await publishHtml(OWNER, ns, "s", PAGE("x"), { allowed_emails: friend });
    await connectSheets(OWNER);
    const create = (as: string) => sheets(as, ns, { method: "POST", path: "spreadsheets", body: { properties: { title: "t" } } });

    const byFriend = await create(friend);
    expect(byFriend.status).toBe(403);
    expect((await byFriend.json<{ error: { code: string } }>()).error.code).toBe("sheets_owner_only");
    expect((await create(OWNER)).status).toBe(200);
    const row = await env.DB.prepare("SELECT sheets FROM sites WHERE namespace = ?").bind(ns).first<{ sheets: string }>();
    expect(JSON.parse(row!.sheets)).toEqual([created]);
  });

  it("is off with the connected_apps flag", async () => {
    mockGoogle();
    expect((await setFlag("off")).status).toBe(200);
    expect((await call("/app/services/google-sheets/connect", { as: OWNER })).status).toBe(404);
    expect(await (await call("/app/connected", { as: OWNER })).text()).not.toContain('href="/connected/google-sheets"');
    const ns = uniq();
    await publishHtml(OWNER, ns, "s", PAGE("x"));
    expect((await sheets(OWNER, ns, { method: "GET", path: "spreadsheets/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/values/Sheet1!A1:B2" })).status).toBe(403);
  });
});
