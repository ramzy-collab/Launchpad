// Fixes from the second security audit pass (A4–A9, A11, A12).
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { shareEmailAllowance } from "../src/email";
import { createSession, endOtherSessions } from "../src/session";
import { publishSite } from "../src/sites";
import { appAt, call, onOutbound, OWNER, PAGE, publishHtml, uniq } from "./helpers";

const E = env as unknown as Env;
const count = async (sql: string, ...binds: unknown[]) => (await E.DB.prepare(sql).bind(...binds).first<{ n: number }>())!.n;
afterEach(() => onOutbound(undefined));

describe("second audit pass", () => {
  it("A4: lists show who else an app is shared with, its editors and spreadsheets only to its managers", async () => {
    const ns = uniq();
    const viewer = `v4-${uniq()}@example.com`;
    await publishHtml(OWNER, ns, "a", PAGE("x"), { visibility: "all", allowed_emails: `${viewer}, other@example.com`, editors: "ed4@example.com" });
    type Listed = { mountPath: string; allowedEmails: string[]; editors: string[]; sharers: string[]; sheets: string[]; publicUrl: string | null };
    const asViewer = (await (await call(`/_api/admin/sites?namespace=${ns}`, { as: viewer })).json<Listed[]>()).find((s) => s.mountPath === "a")!;
    expect(asViewer).toMatchObject({ allowedEmails: [], editors: [], sharers: [], sheets: [], publicUrl: null });
    const asOwner = (await (await call(`/_api/admin/sites?namespace=${ns}`, { as: OWNER })).json<Listed[]>()).find((s) => s.mountPath === "a")!;
    expect(asOwner.allowedEmails).toContain("other@example.com");
    expect(asOwner.editors).toEqual(["ed4@example.com"]);
  });

  it("A5: waitlisted people can't publish, even as an editor of someone's space", async () => {
    const ns = uniq();
    const helper = `w5-${uniq()}@example.com`;
    await publishHtml(OWNER, ns, "a", PAGE("x"), { editors: helper });
    await call(`/_api/admin/namespaces/${ns}`, { as: OWNER, method: "PATCH", json: { editors: helper } });
    // (In tests, signing in through Access lets people in, so call the service as a waitlisted user.)
    const ctx = { env: E, user: { email: helper, name: null, isAdmin: false, active: false }, waitUntil: () => {} };
    for (const mount of ["a", "new-one"]) {
      const files = new Map([["index.html", new TextEncoder().encode(PAGE("mine"))]]);
      await expect(publishSite(ctx, { namespace: ns, mountPath: mount, files }), mount).rejects.toMatchObject({ code: "waitlisted" });
    }
  });

  it("A6: requests at the same moment can't each take the whole share email allowance", async () => {
    const sharer = `s6-${uniq()}@example.com`;
    const batch = () => Array.from({ length: 15 }, () => `n-${uniq()}@example.com`);
    const results = await Promise.all([1, 2, 3].map(() => shareEmailAllowance(E, sharer, batch())));
    expect(results.reduce((n, r) => n + r.send.length, 0)).toBe(20);
    expect(results.reduce((n, r) => n + r.held.length, 0)).toBe(25);
  });

  it("A7: a password change ends the person's other sessions, keeping the one that made it", async () => {
    const email = `p7-${uniq()}@example.com`;
    await call("/_api/admin/whoami", { as: email });
    const id = async (cookie: string) => {
      const token = /=([^;]+)/.exec(cookie)![1]!;
      const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))].map((b) => b.toString(16).padStart(2, "0")).join("");
      return hash;
    };
    const mine = await id(await createSession(E, email, "example.com"));
    const mineChild = await id(await createSession(E, email, "app.example.com", { parentId: mine }));
    const stolen = await id(await createSession(E, email, "example.com"));
    await createSession(E, email, "hoops-1234.example.app", { parentId: stolen });
    await endOtherSessions(E, email, mineChild);
    const left = (await E.DB.prepare("SELECT id FROM sessions WHERE email = ?").bind(email).all<{ id: string }>()).results.map((r) => r.id).sort();
    expect(left).toEqual([mine, mineChild].sort());
    await endOtherSessions(E, email);
    expect(await count("SELECT COUNT(*) AS n FROM sessions WHERE email = ?", email)).toBe(0);
  });

  it("A8: Gemini answers are always capped", async () => {
    const ns = uniq();
    await publishHtml(OWNER, ns, "g", PAGE("x"));
    await call("/_api/admin/features/connected_apps", { as: OWNER, method: "PUT", json: { state: "on" } });
    const id = (await E.DB.prepare("SELECT id FROM sites WHERE namespace = ?").bind(ns).first<{ id: string }>())!.id;
    await call(`/_api/admin/sites/${id}`, { as: OWNER, method: "PATCH", json: { connectors: ["gemini"] } });
    let sent: { generationConfig?: { maxOutputTokens?: number } } | null = null;
    onOutbound(async (req) => {
      if (req.method === "GET") return Response.json({ name: "models/x" });
      sent = await req.json();
      return Response.json({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }], usageMetadata: {} });
    });
    expect((await call("/_api/admin/services/gemini", { as: OWNER, method: "PUT", json: { apiKey: "AIzaSyTESTKEY0123456789abcdefCAP8" } })).status).toBe(200);
    expect((await call(`${await appAt(ns, "g")}/_api/ai/gemini`, { as: OWNER, mount: "/", method: "POST", json: { prompt: "hi" } })).status).toBe(200);
    expect(sent!.generationConfig?.maxOutputTokens).toBe(8192);
  });

  it("A9: deleting a user takes them off other apps' sharers too", async () => {
    const ns = uniq();
    const gone = `d9-${uniq()}@example.com`;
    await call("/_api/admin/whoami", { as: gone });
    const { site } = await (await publishHtml(OWNER, ns, "a", PAGE("x"), { editors: gone })).json<{ site: { id: string } }>();
    await call(`/_api/admin/sites/${site.id}`, { as: OWNER, method: "PATCH", json: { sharers: gone } });
    expect((await call(`/_api/admin/users/${encodeURIComponent(gone)}`, { as: OWNER, method: "DELETE" })).status).toBe(200);
    const row = await E.DB.prepare("SELECT editors, sharers FROM sites WHERE id = ?").bind(site.id).first<{ editors: string; sharers: string }>();
    expect(JSON.parse(row!.sharers)).toEqual([]);
    expect(JSON.parse(row!.editors)).toEqual([]);
  });
});
