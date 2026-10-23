import { describe, expect, it } from "vitest";
import { listPlans, parsePlan } from "../src/testplans";
import { call, OWNER, uniq } from "./helpers";

const SLUG = "2026-10-23-settings-redesign-phase-1";
const results = (json: unknown, as = OWNER, url = `/_api/admin/test-plans/${SLUG}/results`) => call(url, { as, method: "PUT", json });
const clear = () => call(`/_api/admin/test-plans/${SLUG}/results`, { as: OWNER, method: "DELETE" });

describe("feature test plans", () => {
  it("reads every case from the plans in docs/test-plans", () => {
    const plan = listPlans().find((p) => p.slug === SLUG)!;
    expect(plan.title).toBe("Settings redesign, phase 1: test plan");
    expect(plan.date).toBe("2026-10-23");
    expect(plan.cases).toHaveLength(152);
    expect(plan.cases[0]).toMatchObject({ id: "MA-01", section: "3. My apps" });
    const parsed = parsePlan("2026-01-01-x", "# X\n\nAbout it.\n\n## Area\n\n| ID | Steps | Expected |\n|---|---|---|\n| `AB-01` | Click \\| tap | It works |\n");
    expect(parsed.summary).toBe("About it.");
    expect(parsed.cases).toEqual([{ id: "AB-01", section: "Area", steps: "Click | tap", expected: "It works" }]);
  });

  it("lists the plans and shows each one with a result control per case, for admins only", async () => {
    await clear();
    const list = await call("/admin/test-plans", { as: OWNER });
    expect(list.status).toBe(200);
    const html = await list.text();
    expect(html).toContain('<a href="/test-plans" aria-current="page">Test plans</a>');
    expect(html).toContain(`<a href="/test-plans/${SLUG}"><strong>Settings redesign, phase 1: test plan</strong></a>`);

    const page = await (await call(`/admin/test-plans/${SLUG}`, { as: OWNER })).text();
    expect(page).toContain("<h1>Settings redesign, phase 1: test plan</h1>");
    expect(page).toContain('<tr data-case="MA-01" data-status="todo">');
    expect(page).toContain('aria-label="Result for MA-01"');
    expect(page.match(/<tr data-case=/g)).toHaveLength(152);
    expect(page).toContain("Copy for Claude");
    expect(page).toContain('id="tp-markdown"');
    // The plan quotes markup (case PS-03); it's shown as text, never as HTML.
    expect(page).not.toContain("<img src=x");
    expect(page).toContain("&lt;img src=x onerror=alert(1)&gt;");

    const stranger = `tp-${uniq()}@example.com`;
    expect((await call("/admin/test-plans", { as: stranger })).status).toBe(404);
    expect((await call(`/admin/test-plans/${SLUG}`, { as: stranger })).status).toBe(404);
    expect((await call("/admin/test-plans/nope", { as: OWNER })).status).toBe(404);
  });

  it("records, updates, clears and imports results", async () => {
    await clear();
    const saved = await results({ cases: { "MA-01": { status: "pass" }, "MA-02": { status: "fail", notes: "Chip missing" } } });
    expect(saved.status).toBe(200);
    expect((await saved.json<{ results: Record<string, { status: string; notes: string }> }>()).results).toMatchObject({
      "MA-01": { status: "pass", notes: "" },
      "MA-02": { status: "fail", notes: "Chip missing" },
    });
    const page = await (await call(`/admin/test-plans/${SLUG}`, { as: OWNER })).text();
    expect(page).toContain('<tr data-case="MA-02" data-status="fail">');
    expect(page).toContain('<div class="tp-note">Chip missing</div>');
    const list = await (await call("/admin/test-plans", { as: OWNER })).text();
    expect(list).toMatch(/<span class="tp-dot pass" aria-hidden="true"><\/span>1<\/td>/);

    // An empty status clears that case; imports are marked as such.
    const cleared = await (await results({ cases: { "MA-01": { status: "" }, "UP-06": { status: "blocked", notes: "No key" } }, source: "import" })).json<{
      results: Record<string, { source: string }>;
    }>();
    expect(cleared.results["MA-01"]).toBeUndefined();
    expect(cleared.results["UP-06"]!.source).toBe("import");

    expect((await clear()).status).toBe(200);
    expect((await (await results({ cases: { "MA-03": { status: "pass" } } })).json<{ results: object }>()).results).toEqual({ "MA-03": expect.anything() });
  });

  it("refuses bad results, other people and the web app host", async () => {
    expect((await results({ cases: { "ZZ-99": { status: "pass" } } })).status).toBe(400);
    expect((await results({ cases: { "MA-01": { status: "maybe" } } })).status).toBe(400);
    expect((await results({ cases: { "MA-01": { status: "fail", notes: "x".repeat(2001) } } })).status).toBe(400);
    expect((await results({ cases: [] })).status).toBe(400);
    expect((await results({ cases: {} })).status).toBe(400);
    expect((await results({ cases: { "MA-01": { status: "pass" } } }, OWNER, `/_api/admin/test-plans/nope/results`)).status).toBe(404);
    const stranger = `tp-${uniq()}@example.com`;
    await call("/_api/admin/whoami", { as: stranger });
    expect((await results({ cases: { "MA-01": { status: "pass" } } }, stranger)).status).toBe(403);
    // Only on the admin host, like the panel's other admin actions.
    expect((await results({ cases: { "MA-01": { status: "pass" } } }, OWNER, `https://app.example.com/_api/admin/test-plans/${SLUG}/results`)).status).toBe(404);
  });
});
