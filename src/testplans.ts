// Feature test plans: the hands-on browser test plans in docs/test-plans (one per feature PR, see
// CLAUDE.md), shown in the admin panel with a result per case. The plans are bundled at build
// time like CHANGELOG.md; the results live in D1 (test_results), latest result per case.
import type { Env, User } from "./env";
import { now } from "./env";
import { badRequest, err } from "./errors";
import { TEST_PLANS } from "./generated/assets";
import { escapeHtml as e } from "./util";

export const RESULT_STATUSES = ["pass", "fail", "blocked"] as const;
export type ResultStatus = (typeof RESULT_STATUSES)[number];
export const CASE_ID = /^[A-Z]{2}-\d{2}$/;
const MAX_NOTES = 2000;

export interface TestCase {
  id: string;
  section: string;
  steps: string;
  expected: string;
}

export interface TestPlan {
  /** The file name without .md, e.g. 2026-10-23-settings-redesign-phase-1. */
  slug: string;
  /** YYYY-MM-DD from the file name. */
  date: string;
  title: string;
  /** The first paragraph under the title. */
  summary: string;
  markdown: string;
  cases: TestCase[];
}

export interface TestResult {
  status: ResultStatus;
  notes: string;
  source: string;
  updatedAt: number;
  updatedBy: string;
}

/** A Markdown table row's cells; "\|" is a literal pipe. */
export function splitRow(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "\\" && inner[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (inner[i] === "|") {
      cells.push(cur.trim());
      cur = "";
    } else cur += inner[i];
  }
  cells.push(cur.trim());
  return cells;
}

const plainText = (s: string) => s.replace(/`([^`]+)`/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

export function parsePlan(slug: string, markdown: string): TestPlan {
  const lines = markdown.split("\n");
  const title = plainText(lines.find((l) => l.startsWith("# "))?.slice(2).trim() ?? slug);
  const titleAt = lines.findIndex((l) => l.startsWith("# "));
  const summary = lines.slice(titleAt + 1).find((l) => l.trim() && !l.startsWith("#")) ?? "";
  const cases: TestCase[] = [];
  let section = "";
  for (const line of lines) {
    if (line.startsWith("## ")) section = plainText(line.slice(3).trim());
    if (!line.startsWith("|")) continue;
    const cells = splitRow(line);
    const id = cells[0]!.replace(/`/g, "");
    if (CASE_ID.test(id) && cells.length >= 3) cases.push({ id, section, steps: plainText(cells[1]!), expected: plainText(cells[2]!) });
  }
  return { slug, date: /^\d{4}-\d{2}-\d{2}/.exec(slug)?.[0] ?? "", title, summary, markdown, cases };
}

/** Every plan, newest first. */
export function listPlans(): TestPlan[] {
  return Object.entries(TEST_PLANS)
    .map(([slug, md]) => parsePlan(slug, md))
    .sort((a, b) => b.slug.localeCompare(a.slug));
}

export const getPlan = (slug: string): TestPlan | null => (Object.hasOwn(TEST_PLANS, slug) ? parsePlan(slug, TEST_PLANS[slug]!) : null);

function requirePlan(slug: string): TestPlan {
  const plan = getPlan(slug);
  if (!plan) throw err(404, "not_found", "There's no test plan with that name.", "Pick one from Test plans in the admin panel.");
  return plan;
}

function requireAdmin(user: User) {
  if (!user.isAdmin) throw err(403, "admin_only", "Only an admin can record test results.", "Ask the Formelab owner.");
}

export async function planResults(env: Env, slug: string): Promise<Record<string, TestResult>> {
  const { results } = await env.DB.prepare("SELECT case_id, status, notes, source, updated_at, updated_by FROM test_results WHERE plan = ?")
    .bind(slug)
    .all<{ case_id: string; status: ResultStatus; notes: string; source: string; updated_at: number; updated_by: string }>();
  return Object.fromEntries(results.map((r) => [r.case_id, { status: r.status, notes: r.notes, source: r.source, updatedAt: r.updated_at, updatedBy: r.updated_by }]));
}

/** Each plan's result counts, for the list of plans. */
export async function resultCounts(env: Env): Promise<Record<string, Record<ResultStatus, number>>> {
  const { results } = await env.DB.prepare("SELECT plan, status, COUNT(*) AS n FROM test_results GROUP BY plan, status").all<{ plan: string; status: ResultStatus; n: number }>();
  const out: Record<string, Record<ResultStatus, number>> = {};
  for (const r of results) (out[r.plan] ??= { pass: 0, fail: 0, blocked: 0 })[r.status] = r.n;
  return out;
}

/**
 * Records results: `cases` maps case ids to { status, notes }. An empty status clears that case
 * (back to not run). `source` says where they came from: "page" (clicked), "import" (pasted).
 */
export async function saveResults(env: Env, user: User, slug: string, rawCases: unknown, rawSource?: unknown) {
  requireAdmin(user);
  const plan = requirePlan(slug);
  if (!rawCases || typeof rawCases !== "object" || Array.isArray(rawCases)) {
    throw badRequest("cases must be an object of case ids to results.", 'Send { "cases": { "MA-01": { "status": "pass", "notes": "" } } }.');
  }
  const source = rawSource === "import" ? "import" : "page";
  const known = new Set(plan.cases.map((c) => c.id));
  const at = now();
  const statements = Object.entries(rawCases as Record<string, unknown>).map(([id, raw]) => {
    if (!known.has(id)) throw badRequest(`${id} isn't a case in this plan.`, "Use the case ids shown in the plan, like MA-01.");
    const r = (raw ?? {}) as { status?: unknown; notes?: unknown };
    const status = String(r.status ?? "");
    const notes = String(r.notes ?? "").trim();
    if (notes.length > MAX_NOTES) throw badRequest(`The note on ${id} is longer than ${MAX_NOTES} characters.`, "Shorten it.");
    if (!status) return env.DB.prepare("DELETE FROM test_results WHERE plan = ? AND case_id = ?").bind(slug, id);
    if (!(RESULT_STATUSES as readonly string[]).includes(status)) throw badRequest(`The result for ${id} must be pass, fail or blocked.`, "Leave status empty to clear it.");
    return env.DB.prepare(
      `INSERT INTO test_results (plan, case_id, status, notes, source, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(plan, case_id) DO UPDATE SET status = excluded.status, notes = excluded.notes, source = excluded.source,
         updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    ).bind(slug, id, status, notes, source, at, user.email);
  });
  if (!statements.length) throw badRequest("No results to save.", "Send at least one case.");
  await env.DB.batch(statements);
  return { plan: slug, results: await planResults(env, slug) };
}

/** Clears every result of a plan, for a fresh test run. */
export async function clearResults(env: Env, user: User, slug: string) {
  requireAdmin(user);
  requirePlan(slug);
  await env.DB.prepare("DELETE FROM test_results WHERE plan = ?").bind(slug).run();
  return { plan: slug, results: {} };
}

// ---------------------------------------------------------------------------
// The plan as HTML (our own files, in the small Markdown subset the plans use)
// ---------------------------------------------------------------------------

/** **bold**, `code` and [links](https://... or /path). */
export function inlineMarkdown(s: string): string {
  return e(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\((https:\/\/[^)\s"]+|\/[A-Za-z0-9\-/#._~]*)\)/g, (_m, text: string, href: string) =>
      href.startsWith("/") ? `<a href="${href}">${text}</a>` : `<a href="${href}" target="_blank" rel="noopener">${text}</a>`,
    );
}

const STATUS_LABEL: Record<ResultStatus, string> = { pass: "Pass", fail: "Fail", blocked: "Blocked" };

/** The result controls in a case's row: Pass, Fail, Blocked, and its note. */
function resultCell(id: string, r: TestResult | undefined): string {
  const buttons = RESULT_STATUSES.map(
    (s) => `<button type="button" data-result="${s}" aria-pressed="${r?.status === s}">${STATUS_LABEL[s]}</button>`,
  ).join("");
  return `<td class="res"><div class="seg" role="group" aria-label="Result for ${e(id)}">${buttons}</div>${
    r?.notes ? `<div class="tp-note">${e(r.notes)}</div>` : ""
  }<button type="button" class="tp-note-btn" data-note>${r?.notes ? "Edit note" : "Add note"}</button></td>`;
}

/** Headings, paragraphs, lists, quotes, code blocks and tables; case tables get a Result column. */
export function renderPlan(plan: TestPlan, results: Record<string, TestResult>): string {
  const lines = plan.markdown.split("\n");
  const out: string[] = [];
  let i = 0;
  const slug = (t: string) => plainText(t).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
    } else if (line.startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) code.push(lines[i++]!);
      i++;
      out.push(`<pre>${e(code.join("\n"))}</pre>`);
    } else if (/^#{1,3} /.test(line)) {
      const level = line.match(/^#+/)![0].length;
      const text = line.slice(level + 1);
      i++;
      if (level === 1) continue; // the title is the page's heading
      out.push(level === 2 ? `<h2 id="${slug(text)}">${inlineMarkdown(text)}</h2>` : `<h3>${inlineMarkdown(text)}</h3>`);
    } else if (line.startsWith("> ")) {
      const quote: string[] = [];
      while (i < lines.length && lines[i]!.startsWith("> ")) quote.push(lines[i++]!.slice(2));
      out.push(`<blockquote>${inlineMarkdown(quote.join(" "))}</blockquote>`);
    } else if (line.startsWith("- ")) {
      const items: string[] = [];
      while (i < lines.length && lines[i]!.startsWith("- ")) items.push(`<li>${inlineMarkdown(lines[i++]!.slice(2))}</li>`);
      out.push(`<ul>${items.join("")}</ul>`);
    } else if (line.startsWith("|")) {
      const head = splitRow(line);
      i += 2; // the header and its separator
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.startsWith("|")) rows.push(splitRow(lines[i++]!));
      const isCases = head[0] === "ID";
      const body = rows
        .map((cells) => {
          const id = cells[0]!.replace(/`/g, "");
          if (isCases && CASE_ID.test(id)) {
            const r = results[id];
            return `<tr data-case="${e(id)}" data-status="${r?.status ?? "todo"}"><td class="cid"><code>${e(id)}</code></td>${cells
              .slice(1)
              .map((c) => `<td>${inlineMarkdown(c)}</td>`)
              .join("")}${resultCell(id, r)}</tr>`;
          }
          return `<tr>${cells.map((c) => `<td>${inlineMarkdown(c)}</td>`).join("")}</tr>`;
        })
        .join("");
      out.push(
        `<div class="scroll tp-table${isCases ? " has-cases" : ""}"><table${isCases ? ' class="tp-cases"' : ""}><thead><tr>${head
          .map((h) => `<th>${inlineMarkdown(h)}</th>`)
          .join("")}${isCases ? "<th>Result</th>" : ""}</tr></thead><tbody>${body}</tbody></table></div>`,
      );
    } else {
      const para: string[] = [];
      while (i < lines.length && lines[i]!.trim() && !/^(#|> |- |\||```)/.test(lines[i]!)) para.push(lines[i++]!);
      out.push(`<p>${inlineMarkdown(para.join(" "))}</p>`);
    }
  }
  return out.join("\n");
}
