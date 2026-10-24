// The Answers page: /answers on an app's own address, made by Formelab for apps that collect
// answers with formelab.responses. Only the app's owner and editors can open it. It shows every
// answer in a table (one column per field), with a spreadsheet download at /answers.csv. Apps
// can't serve their own page at /answers while the responses feature is on for their owner.
import type { Context } from "hono";
import type { AppEnv, Env } from "./env";
import { flagOnForOwner } from "./flags";
import { countResponses, csvDownload, listResponses, responsesCsv } from "./responses";
import { plainPage } from "./serve";
import { siteName, siteUrl, type SiteRow } from "./sites";
import { ago, escapeHtml as e, parseJsonArray } from "./util";

export const ANSWERS_PATH = "/answers";

/** The page has no scripts, and its styles are its own. */
const ANSWERS_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Whether this app's owner has the responses feature: the page only exists when they do. */
export const answersOn = (env: Env, site: SiteRow) => flagOnForOwner(env, "responses", site.owner_email);

/**
 * Whether to add the small Answers link to one of the app's pages, for someone who manages the app
 * (the caller checks that): the app collects answers (its page uses formelab.responses, or it
 * already has some).
 */
export async function showAnswersLink(env: Env, site: SiteRow, html: string): Promise<boolean> {
  if (!(await answersOn(env, site))) return false;
  return html.includes("formelab.responses") || (await countResponses(env, site.id)) > 0;
}

const notForYou = () => plainPage(403, "Only for the app's team", "Only the app's owner and editors can see what people sent it.");

const cell = (v: unknown) => (v === undefined || v === null || v === "" ? `<span class="none">-</span>` : e(typeof v === "string" ? v : JSON.stringify(v)));

/**
 * GET /answers (and /answers.csv) on the app's host. Falls through to the app's own files when the
 * feature is off for its owner, so nothing changes for those apps.
 */
export async function answersRoute(c: Context<AppEnv>, next: () => Promise<void>, csv = false): Promise<Response | void> {
  const site = c.get("site");
  if (!(await answersOn(c.env, site))) return next();
  // Only the app's owner and editors (and its space's editors); never guests from the public link.
  if (!c.get("manages")) return notForYou();
  const name = siteName(site);
  if (csv) return csvDownload(name, "answers", await responsesCsv(c.env, site.id));
  const { total, responses } = await listResponses(c.env, site.id);
  // One column per field, in the order fields first appear (oldest answers first), then who sent it.
  const rows = responses.map((r) => ({
    ...r,
    fields: r.data && typeof r.data === "object" && !Array.isArray(r.data) ? (r.data as Record<string, unknown>) : { Answer: r.data },
  }));
  const columns: string[] = [];
  for (const r of [...rows].reverse()) for (const k of Object.keys(r.fields)) if (!columns.includes(k)) columns.push(k);
  const editors = parseJsonArray(site.editors).length;
  const who = editors ? `You and ${editors} editor${editors === 1 ? "" : "s"}` : "Just you";
  const table = rows.length
    ? `<div class="scroll"><table><thead><tr>${columns.map((k) => `<th>${e(k)}</th>`).join("")}<th>From</th><th>Sent</th></tr></thead><tbody>${rows
        .map(
          (r) =>
            `<tr>${columns.map((k) => `<td>${cell(r.fields[k])}</td>`).join("")}<td>${r.email ? e(r.email) : `<span class="none">Public link</span>`}</td><td class="when" title="${e(new Date(r.at).toISOString())}">${e(ago(r.at))}</td></tr>`,
        )
        .join("")}</tbody></table></div>${total > rows.length ? `<p class="more">Showing the newest ${rows.length} of ${total}. The spreadsheet has them all.</p>` : ""}`
    : `<div class="empty"><strong>No answers yet.</strong><br>When people send answers through the app, they show up here.</div>`;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>Answers · ${e(name)}</title>
<style>
:root { --bg: #FBFAF7; --surface: #fff; --ink: #1C1B19; --soft: #6B6862; --line: #E8E5DE; --accent: #5B4CF5; --accent-soft: rgba(91,76,245,.1); color-scheme: light; }
@media (prefers-color-scheme: dark) { :root { --bg: #161514; --surface: #1F1E1C; --ink: #F3F1EC; --soft: #A39F97; --line: #2E2C29; --accent: #8A7EFF; --accent-soft: rgba(138,126,255,.14); color-scheme: dark; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 Inter, system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 72rem; margin: 0 auto; padding: 28px max(16px, env(safe-area-inset-right)) 64px max(16px, env(safe-area-inset-left)); }
.banner { display: flex; gap: 10px; align-items: center; background: var(--accent-soft); color: var(--accent); border-radius: 14px; padding: 10px 14px; font-size: 14px; font-weight: 500; margin-bottom: 18px; }
.head { display: flex; flex-wrap: wrap; gap: 12px 18px; align-items: center; justify-content: space-between; margin-bottom: 16px; }
h1 { font: 800 clamp(1.6rem, 4vw, 2.1rem)/1.15 "Bricolage Grotesque", system-ui, sans-serif; margin: 0; letter-spacing: -.01em; }
.addr { color: var(--soft); font-size: 14px; margin-top: 2px; word-break: break-all; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.btn { display: inline-flex; align-items: center; min-height: 42px; padding: 0 18px; border-radius: 999px; font-weight: 600; text-decoration: none; border: 1px solid var(--line); color: var(--ink); background: var(--surface); }
.btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin: 0 0 16px; }
.stat { background: var(--surface); border: 1px solid var(--line); border-radius: 16px; padding: 14px 16px; }
.stat span { display: block; font-size: 13px; color: var(--soft); }
.stat b { font: 800 1.5rem "Bricolage Grotesque", system-ui, sans-serif; font-variant-numeric: tabular-nums; }
.scroll { overflow-x: auto; background: var(--surface); border: 1px solid var(--line); border-radius: 16px; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th { text-align: left; font-weight: 600; color: var(--soft); font-size: 12px; text-transform: uppercase; letter-spacing: .05em; padding: 12px 14px; border-bottom: 1px solid var(--line); white-space: nowrap; }
td { padding: 11px 14px; border-bottom: 1px solid var(--line); vertical-align: top; max-width: 28rem; overflow-wrap: anywhere; }
tbody tr:last-child td { border-bottom: 0; }
td.when { color: var(--soft); white-space: nowrap; }
.none { color: var(--soft); }
.empty { background: var(--surface); border: 1.5px dashed var(--line); border-radius: 16px; padding: 28px; text-align: center; color: var(--soft); }
.empty strong { color: var(--ink); }
.more { color: var(--soft); font-size: 13px; }
@media (max-width: 640px) { .stats { grid-template-columns: 1fr; } .actions { width: 100%; } .actions .btn { flex: 1; justify-content: center; } }
</style>
</head>
<body>
<main>
  <div class="banner">Only you and the app's editors can open this page.</div>
  <div class="head">
    <div><h1>${e(name)} answers</h1><div class="addr">${e(siteUrl(c.env, site, c.req.url).replace(/^https?:\/\//, ""))}answers</div></div>
    <div class="actions"><a class="btn" href="${ANSWERS_PATH}.csv" download>Download as spreadsheet</a><a class="btn primary" href="/">Open app</a></div>
  </div>
  <div class="stats">
    <div class="stat"><span>Answers</span><b>${total}</b></div>
    <div class="stat"><span>Newest</span><b>${rows[0] ? e(ago(rows[0].at)) : "-"}</b></div>
    <div class="stat"><span>Can see this page</span><b>${e(who)}</b></div>
  </div>
  ${table}
</main>
</body>
</html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": ANSWERS_CSP, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" },
  });
}
