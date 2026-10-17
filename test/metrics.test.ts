import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { clientFamily, computeMetrics, bucketsFor, mondayOf, dayOf } from "../src/metrics";
import { call, ICON_PAGE, OWNER, PAGE, publishHtml, uniq, appAt } from "./helpers";

async function token(as: string) {
  const res = await call("/_api/admin/tokens", { as, method: "POST", json: { name: "mcp", ttlHours: 1 } });
  return (await res.json<{ token: string }>()).token;
}

let id = 0;
const rpc = (t: string, method: string, params?: unknown, headers: Record<string, string> = {}) =>
  call("/mcp", {
    method: "POST",
    token: t,
    headers: { accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", ...headers },
    json: { jsonrpc: "2.0", id: ++id, method, params },
  });

/** Background writes (waitUntil) land shortly after the response; wait for them. */
async function eventually<T>(read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  let v = await read();
  for (let i = 0; i < 40 && !ok(v); i++) {
    await new Promise((r) => setTimeout(r, 25));
    v = await read();
  }
  return v;
}

describe("usage tracking", () => {
  it("records MCP tool calls with the AI app, outcome and timing, and new connections", async () => {
    const email = `mcp-${uniq()}@example.com`;
    const t = await token(email);
    await rpc(t, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2.1.0" } });
    // The key now remembers its app, so later calls (which don't name it) are credited to it.
    await eventually(() => env.DB.prepare("SELECT client_name FROM tokens WHERE owner_email = ?").bind(email).first<{ client_name: string | null }>(), (r) => !!r?.client_name);
    await rpc(t, "tools/call", { name: "whoami", arguments: {} });
    await rpc(t, "tools/call", { name: "list_sites", arguments: { namespace: "nope-not-there" } });
    const rows = await eventually(
      () => env.DB.prepare("SELECT tool, client, ok, ms FROM mcp_calls WHERE email = ? ORDER BY id").bind(email).all<{ tool: string; client: string; ok: number; ms: number }>().then((r) => r.results),
      (r) => r.length >= 3,
    );
    expect(rows.map((r) => r.tool)).toEqual(["initialize", "whoami", "list_sites"]);
    expect(rows.every((r) => r.client === "claude-code")).toBe(true);
    expect(rows[1]!.ok).toBe(1);
    expect(rows[2]!.ok).toBe(0); // unknown namespace: the tool answered with an error
    expect(rows.every((r) => r.ms >= 0)).toBe(true);
  });

  it("names the AI app from the User-Agent when the connection doesn't", async () => {
    const email = `ua-${uniq()}@example.com`;
    const t = await token(email);
    await rpc(t, "tools/call", { name: "whoami", arguments: {} }, { "user-agent": "Claude-User/1.0" });
    const row = await eventually(() => env.DB.prepare("SELECT client FROM mcp_calls WHERE email = ?").bind(email).first<{ client: string }>(), (r) => !!r);
    expect(row!.client).toBe("Claude-User");
    expect(clientFamily(row!.client)).toBe("Claude");
  });

  it("counts people opening an app's pages, once per person per day, apart from its builders", async () => {
    const ns = uniq();
    const friend = `friend-${uniq()}@example.com`;
    await publishHtml(OWNER, ns, "visits", PAGE("hi"), { allowed_emails: friend });
    const site = (await env.DB.prepare("SELECT id FROM sites WHERE namespace = ?").bind(ns).first<{ id: string }>())!;
    const origin = await appAt(ns, "visits");
    const page = { "sec-fetch-dest": "document" };
    await call(`${origin}/`, { as: friend, headers: page });
    await call(`${origin}/`, { as: friend, headers: page });
    await call(`${origin}/`, { as: OWNER, headers: page });
    // Scripts, images, the SDK and API calls are not page views.
    await call(`${origin}/app.js`, { as: friend, headers: { "sec-fetch-dest": "script" } });
    await call(`${origin}/_platform/sdk.js`, { as: friend });
    const rows = await eventually(
      () => env.DB.prepare("SELECT email, own, views FROM app_visits WHERE site_id = ? ORDER BY email").bind(site.id).all<{ email: string; own: number; views: number }>().then((r) => r.results),
      (r) => r.length === 2 && r.some((x) => x.views === 2),
    );
    expect(rows).toEqual([
      { email: friend, own: 0, views: 2 },
      { email: OWNER, own: 1, views: 1 },
    ]);
  });
});

describe("metrics", () => {
  it("buckets by day up to 90 days and by week (from Monday) beyond", () => {
    const today = dayOf(Date.parse("2026-10-17T12:00:00Z")); // a Saturday
    expect(bucketsFor("30d", today, today - 500).buckets).toHaveLength(30);
    const year = bucketsFor("12m", today, today - 500);
    expect(year.unit).toBe("week");
    expect(year.buckets.every((b) => b.start === mondayOf(b.start))).toBe(true);
    expect(year.buckets.at(-1)!.end).toBe(today);
    expect(bucketsFor("all", today, today - 10)).toMatchObject({ unit: "day" });
  });

  it("groups AI app names into products", () => {
    expect(clientFamily("claude-code")).toBe("Claude Code");
    expect(clientFamily("claude-ai")).toBe("Claude");
    expect(clientFamily("openai-mcp")).toBe("ChatGPT");
    expect(clientFamily("Codex")).toBe("Codex");
    expect(clientFamily("cursor-vscode")).toBe("Cursor");
    expect(clientFamily(null)).toBe("Unknown");
  });

  it("counts customers' building, MCP use and app reach, leaving team accounts out unless asked", async () => {
    const builder = `builder-${uniq()}@example.com`;
    const fan = `fan-${uniq()}@example.com`;
    const ns = uniq();
    await call("/_api/admin/whoami", { as: builder });
    await publishHtml(builder, ns, "hit", ICON_PAGE("hit"), { allowed_emails: fan });
    await publishHtml(builder, ns, "hit", ICON_PAGE("hit v2"));
    const t = await token(builder);
    await rpc(t, "tools/call", { name: "whoami", arguments: {} }, { "user-agent": "openai-mcp/1.0.0" });
    await call(`${await appAt(ns, "hit")}/`, { as: fan, headers: { "sec-fetch-dest": "document" } });
    await eventually(() => env.DB.prepare("SELECT COUNT(*) AS n FROM mcp_calls WHERE email = ?").bind(builder).first<{ n: number }>(), (r) => r!.n > 0);
    await eventually(() => env.DB.prepare("SELECT COUNT(*) AS n FROM app_visits WHERE email = ?").bind(fan).first<{ n: number }>(), (r) => r!.n > 0);
    // The owner (a team account) is busy too.
    await publishHtml(OWNER, uniq(), "mine", PAGE("team"));

    const m = await computeMetrics(env, "30d", false);
    const me = m.people.find((p) => p.email === builder)!;
    expect(me).toMatchObject({ apps: 1, publishes: 2, mcpCalls: 1, reach: 1, client: "ChatGPT", activeDays: 1 });
    expect(m.people.some((p) => p.email === OWNER)).toBe(false);
    const app = m.apps.top.find((a) => a.owner === builder)!;
    expect(app).toMatchObject({ title: `${ns}/hit`, visitors: 1, versions: 2 });
    expect(m.mcp.clients.find((c) => c.name === "ChatGPT")!.people).toBeGreaterThanOrEqual(1);
    expect(m.tiles.reach.value).toBeGreaterThanOrEqual(1);
    expect(m.funnel[0]!.label).toBe("Signed up");
    for (let i = 1; i < m.funnel.length - 1; i++) expect(m.funnel[i]!.count).toBeLessThanOrEqual(m.funnel[i - 1]!.count);
    expect(m.buckets).toHaveLength(30);
    expect(m.engagement.wau.values).toHaveLength(30);

    const withTeam = await computeMetrics(env, "30d", true);
    expect(withTeam.tiles.apps.total).toBeGreaterThan(m.tiles.apps.total);
  });

  it("is a page in the admin panel, for admins only, with a strict CSP", async () => {
    const someone = `nosy-${uniq()}@example.com`;
    expect((await call("/admin/metrics", { as: someone })).status).toBe(404);
    for (const q of ["", "?range=30d", "?range=12m&team=1", "?range=all", "?range=bogus"]) {
      const res = await call(`/admin/metrics${q}`, { as: OWNER });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
      const html = await res.text();
      expect(html).toContain("<h1>Metrics</h1>");
      expect(html).toContain("Weekly active people");
      for (const s of ["growth", "engagement", "funnel", "mcp", "apps", "people"]) expect(html).toContain(`id="${s}"`);
      expect(html).toContain('src="/_assets/viz.js?v=');
      expect(html).not.toMatch(/<script>(?!<\/script>)/);
      expect(html).not.toMatch(/\sstyle="/); // the CSP blocks inline styles
      expect(html).not.toMatch(/\son[a-z]+=/i);
    }
    expect(await (await call("/admin/metrics?range=12m&team=1", { as: OWNER })).text()).toContain('aria-checked="true"');
    expect(await (await call("/admin", { as: OWNER })).text()).toContain('href="/metrics"');
    expect((await call("https://admin.example.com/_assets/viz.js")).headers.get("content-type")).toContain("javascript");
  });
});
