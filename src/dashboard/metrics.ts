// The admin panel's Metrics page: Formelab's growth, engagement, MCP use and hosted-app use, built
// to be read (and shown) as a business dashboard. Numbers come from src/metrics.ts.
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { computeMetrics, RANGES, type Metrics, type Range, type Series, type Tile } from "../metrics";
import { escapeHtml as e } from "../util";
import { barList, columnChart, fmt, lineChart, meter, sparkline, type ChartSeries } from "./charts";
import { fmtTime } from "./page";

/** Each series' color slot, fixed by what it is so it never changes between charts or filters. */
const SLOT: Record<string, number> = {
  "Weekly active": 1,
  "Monthly active": 2,
  "Daily active": 3,
  "New builders": 2,
  "Returning builders": 1,
  "New accounts": 1,
  "Waitlist sign-ups": 2,
  "New apps": 2,
  Updates: 1,
  "Page views": 1,
  Visitors: 2,
  "People it was shared with": 2,
  "Its builders": 1,
  "Views through a public link": 3,
  "Claude Code": 1,
  Claude: 2,
  ChatGPT: 3,
  Cursor: 4,
  Other: 6,
  Unknown: 6,
};
/** Gives each series its fixed slot; a name without one (or whose slot is taken in this chart) gets the first free slot. */
function withSlots(list: Series[]): ChartSeries[] {
  const used = new Set<number>();
  const fixed = list.map((s) => {
    const slot = SLOT[s.name];
    if (slot === undefined || used.has(slot)) return undefined;
    used.add(slot);
    return slot;
  });
  return list.map((s, i) => {
    let slot = fixed[i];
    if (slot === undefined) {
      slot = [1, 2, 3, 4, 5].find((k) => !used.has(k)) ?? 6;
      used.add(slot);
    }
    return { ...s, slot };
  });
}

export function parseRange(v: string | undefined): Range {
  return v && v in RANGES ? (v as Range) : "90d";
}

export async function metricsBody(c: Context<AppEnv>): Promise<string> {
  const range = parseRange(c.req.query("range"));
  const includeTeam = c.req.query("team") === "1";
  const m = await computeMetrics(c.env, range, includeTeam);
  return [filters(m), headline(m), growthSection(m), engagementSection(m), funnelSection(m), mcpSection(m), appsSection(m), peopleSection(m), notes(m)].join("\n");
}

// ---------------------------------------------------------------------------
// Filters and headline
// ---------------------------------------------------------------------------

const href = (range: Range, team: boolean) => `/metrics?range=${range}${team ? "&team=1" : ""}`;

function filters(m: Metrics): string {
  const ranges = (Object.keys(RANGES) as Range[])
    .map((r) => `<a href="${href(r, m.includeTeam)}"${r === m.range ? ' aria-current="page"' : ""}>${e(RANGES[r])}</a>`)
    .join("");
  return `<div class="viz-filters">
  <nav class="tabs" aria-label="Time range">${ranges}</nav>
  <a class="team-toggle" href="${href(m.range, !m.includeTeam)}" role="switch" aria-checked="${m.includeTeam}"><span class="switch" aria-hidden="true"></span>Include team accounts${m.team ? ` <span class="muted">(${e(m.team)})</span>` : ""}</a>
  <span class="muted viz-stamp">Updated ${e(fmtTime(m.generatedAt))} · days in UTC</span>
</div>`;
}

const periodName = (m: Metrics) => (m.range === "all" ? "all time" : `the last ${RANGES[m.range]}`);
const priorName = (m: Metrics) => `the ${RANGES[m.range]} before`;

/** "+12%" with an arrow, green when up, red when down; nothing when there is no earlier period. */
function delta(t: Tile, vs: string): string {
  if (t.previous === null) return "";
  if (!t.previous && !t.value) return `<span class="delta flat">No change <span class="muted">vs ${e(vs)}</span></span>`;
  if (!t.previous) return `<span class="delta up"><span aria-hidden="true">▲</span> New <span class="muted">vs ${e(vs)}</span></span>`;
  const pct = (t.value - t.previous) / t.previous;
  const dir = Math.abs(pct) < 0.005 ? "flat" : pct > 0 ? "up" : "down";
  const arrow = dir === "up" ? "▲" : dir === "down" ? "▼" : "■";
  const word = dir === "up" ? "Up" : dir === "down" ? "Down" : "Flat";
  return `<span class="delta ${dir}"><span aria-hidden="true">${arrow}</span><span class="sr">${word}</span> ${e(fmt(Math.abs(pct), "pct"))} <span class="muted">vs ${e(vs)}</span></span>`;
}

/** A stat tile. `sub` and `foot` are HTML (escape what goes in them). */
function tile(label: string, value: string, opts: { sub?: string; delta?: string; trend?: number[]; meter?: number; foot?: string } = {}): string {
  return `<div class="kpi">
  <span class="kpi-label">${e(label)}</span>
  <span class="kpi-value">${e(value)}</span>
  ${opts.delta ?? ""}
  ${opts.sub ? `<span class="kpi-sub">${opts.sub}</span>` : ""}
  ${opts.trend ? sparkline(opts.trend) : ""}
  ${opts.meter !== undefined ? meter(opts.meter) : ""}
  ${opts.foot ? `<span class="kpi-foot">${opts.foot}</span>` : ""}
</div>`;
}

function headline(m: Metrics): string {
  const t = m.tiles;
  const hours = t.timeToFirstApp;
  const ttfa = hours === null ? "—" : hours < 1 ? `${Math.max(1, Math.round(hours * 60))} min` : hours < 48 ? `${fmt(hours, "dec")} h` : `${fmt(hours / 24, "dec")} days`;
  return `<section class="viz-hero">
  <div class="hero-main">
    <span class="kpi-label">Weekly active people</span>
    <span class="hero-value">${e(fmt(t.wau.value))}</span>
    ${delta(t.wau, "the week before")}
    <p class="hero-sub"><strong>${e(fmt(t.wau.builders))}</strong> building apps · <strong>${e(fmt(t.wau.appUsers))}</strong> using apps someone else built</p>
    ${sparkline(t.wau.trend ?? [])}
    <span class="kpi-foot">The last 12 weeks</span>
  </div>
  <div class="hero-side">
    ${tile("Stickiness", fmt(t.stickiness.value, "pct"), { sub: `${e(fmt(t.stickiness.dau))} active today of ${e(fmt(t.stickiness.mau))} this month`, meter: t.stickiness.value, foot: "Daily ÷ monthly active. Above 20% is strong for a product people use at work." })}
    ${tile("Activation", fmt(t.activation.value, "pct"), { sub: `${e(fmt(t.activation.withApp))} of ${e(fmt(t.activation.accounts))} accounts have an app live`, meter: t.activation.value, foot: "Accounts that have shipped at least one app." })}
    ${tile("Time to first app", ttfa, { sub: "Median, from getting an account to an app live", foot: hours === null ? "" : `Half of new people ship faster than this.` })}
  </div>
</section>
<div class="kpis">
  ${tile("New accounts", fmt(t.accounts.value), { delta: delta(t.accounts, priorName(m)), sub: `${e(fmt(t.accounts.total))} in total`, trend: t.accounts.trend })}
  ${tile("Apps created", fmt(t.apps.value), { delta: delta(t.apps, priorName(m)), sub: `${e(fmt(t.apps.total))} live now`, trend: t.apps.trend })}
  ${tile("Publishes", fmt(t.publishes.value), { delta: delta(t.publishes, priorName(m)), sub: "New apps and new versions", trend: t.publishes.trend })}
  ${tile("MCP tool calls", fmt(t.mcpCalls.value), { delta: delta(t.mcpCalls, priorName(m)), sub: `By ${e(fmt(m.mcp.people))} ${m.mcp.people === 1 ? "person" : "people"}`, trend: t.mcpCalls.trend })}
  ${tile("App page views", fmt(t.appViews.value), { delta: delta(t.appViews, priorName(m)), sub: `${e(fmt(t.appViews.visitors))} people opened an app${t.appViews.guestViews ? ` · ${e(fmt(t.appViews.guestViews))} views through public links` : ""}`, trend: t.appViews.trend })}
  ${tile("Reach", fmt(t.reach.value), { delta: delta(t.reach, priorName(m)), sub: "People using apps they didn't build", trend: t.reach.trend })}
  ${tile("Waitlist sign-ups", fmt(t.waitlist.value), { delta: delta(t.waitlist, priorName(m)), sub: `${e(fmt(t.waitlist.waiting))} waiting to get in`, trend: t.waitlist.trend })}
  ${tile("AI connections", fmt(m.mcp.connectedPeople), { sub: "People who connected an AI app, all time" })}
</div>`;
}

function section(id: string, title: string, intro: string, body: string): string {
  return `<section class="viz-section" id="${e(id)}">
  <div class="viz-head"><h2>${e(title)}</h2><p>${intro}</p></div>
  ${body}
</section>`;
}

const labels = (m: Metrics) => m.buckets.map((b) => b.label);
const per = (m: Metrics) => (m.unit === "day" ? "per day" : "per week");
const firstCol = (m: Metrics) => (m.unit === "day" ? "Day" : "Week of");

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function growthSection(m: Metrics): string {
  return section(
    "growth",
    "Growth",
    `How fast Formelab is gaining people and apps over ${e(periodName(m))}.`,
    `<div class="viz-grid">
  ${lineChart({ id: "chart-accounts", title: "Accounts", sub: "Active accounts, running total", labels: labels(m), series: withSlots([m.growth.accounts]), area: true, firstCol: firstCol(m) })}
  ${lineChart({ id: "chart-apps", title: "Apps created", sub: "Apps ever published, running total", labels: labels(m), series: [{ ...m.growth.apps, slot: 2 }], area: true, firstCol: firstCol(m) })}
  ${columnChart({ id: "chart-signups", title: "New accounts", sub: `People who got an account, ${per(m)}`, labels: labels(m), series: withSlots([m.growth.newAccounts]), firstCol: firstCol(m) })}
  ${columnChart({ id: "chart-waitlist", title: "Waitlist sign-ups", sub: `Demand: people asking to get in, ${per(m)}`, labels: labels(m), series: [{ ...m.growth.waitlistJoins, slot: 2 }], firstCol: firstCol(m) })}
</div>`,
  );
}

function engagementSection(m: Metrics): string {
  const e1 = m.engagement;
  const dauName = m.unit === "day" ? "Daily active" : "Daily active (average)";
  return section(
    "engagement",
    "Engagement",
    "Active means building an app (publishing, changing it, or asking an AI to through MCP) or using one (opening it, or its data and AI calls).",
    `<div class="viz-grid">
  ${lineChart({ id: "chart-active", title: "Active people", sub: "Distinct people active in the day, week and 30 days up to each point", labels: labels(m), series: withSlots([e1.mau, e1.wau, { ...e1.dau, name: dauName }]).map((s) => (s.name === dauName ? { ...s, slot: 3 } : s)), kind: m.unit === "day" ? "int" : "dec", firstCol: firstCol(m) })}
  ${columnChart({ id: "chart-builders", title: "Builders", sub: `People building apps ${per(m)}: first time vs coming back`, labels: labels(m), series: withSlots([e1.returningBuilders, e1.newBuilders]), firstCol: firstCol(m) })}
</div>
${retention(m)}`,
  );
}

function retention(m: Metrics): string {
  const cohorts = m.retention.cohorts;
  const cls = (v: number | null) => (v === null ? "h-none" : `h${Math.min(5, Math.ceil(v * 5))}`);
  const head = `<tr><th scope="col">Signed up, week of</th><th scope="col" class="num">People</th>${Array.from({ length: 12 }, (_, k) => `<th scope="col" class="num">${k === 0 ? "Wk 0" : k}</th>`).join("")}</tr>`;
  const rows = cohorts
    .map(
      (c) =>
        `<tr><th scope="row">${e(c.label)}</th><td class="num">${e(c.size)}</td>${c.weeks
          .map((v) => `<td class="cell ${cls(v)}">${v === null ? "" : e(fmt(v, "pct"))}</td>`)
          .join("")}</tr>`,
    )
    .join("");
  return `<figure class="chart heat">
  <figcaption><h3>Retention by signup week</h3><p>Share of each week's new accounts active in each later week. Read across a row to see a cohort stay (or fade); read down a column to see if newer cohorts stick better.</p></figcaption>
  <div class="scroll"><table class="heatmap"><thead>${head}</thead><tbody>${rows}</tbody></table></div>
  <ul class="legend scale"><li><span class="swatch h0"></span>0%</li><li><span class="swatch h1"></span>1–20%</li><li><span class="swatch h2"></span>21–40%</li><li><span class="swatch h3"></span>41–60%</li><li><span class="swatch h4"></span>61–80%</li><li><span class="swatch h5"></span>81–100%</li></ul>
</figure>`;
}

function funnelSection(m: Metrics): string {
  const top = m.funnel[0]!.count;
  const rows = m.funnel
    .map((s, i) => {
      const prev = i ? m.funnel[i - 1]!.count : s.count;
      const step = i && prev ? s.count / prev : null;
      const pct = top ? (s.count / top) * 100 : 0;
      return `<li class="f${i + 1}">
  <span class="f-label"><strong>${e(s.label)}</strong><span class="muted">${e(s.note)}</span></span>
  <svg class="f-track" aria-hidden="true"><rect class="f-fill" width="${Math.max(s.count ? 0.8 : 0, pct).toFixed(1)}%" height="100%" rx="4"/></svg>
  <span class="f-value"><strong>${e(fmt(s.count))}</strong> <span class="muted">${e(top ? fmt(s.count / top, "pct") : "—")}</span></span>
  <span class="f-step">${step === null ? "" : `<span class="muted">${e(fmt(step, "pct"))} of the step before</span>`}</span>
</li>`;
    })
    .join("");
  return section(
    "funnel",
    "Activation funnel",
    `People whose first contact (waitlist sign-up or account) was in ${e(periodName(m))}, and how far each got.`,
    top ? `<ol class="funnel">${rows}</ol>` : `<p class="muted empty-note">Nobody new in this period.</p>`,
  );
}

function mcpSection(m: Metrics): string {
  const x = m.mcp;
  const errRate = x.calls ? x.errors / x.calls : 0;
  const ms = (v: number | null) => (v === null ? "—" : v < 1000 ? `${v} ms` : `${fmt(v / 1000, "dec")} s`);
  return section(
    "mcp",
    "MCP: building through AI apps",
    "Every tool call people's AI apps (Claude Code, Claude, ChatGPT, Cursor…) make to Formelab's MCP server.",
    `<div class="kpis compact">
  ${tile("Tool calls", fmt(x.calls))}
  ${tile("People", fmt(x.people), { sub: "Made at least one call" })}
  ${tile("Sessions", fmt(x.sessions), { sub: "AI apps connecting to start work" })}
  ${tile("Calls per person", x.people ? fmt(x.calls / x.people, "dec") : "—")}
  ${tile("Success rate", x.calls ? fmt(1 - errRate, "pct") : "—", { sub: `${e(fmt(x.errors))} answered with an error` })}
  ${tile("Speed", ms(x.p50), { sub: `Median · ${e(ms(x.p95))} for the slowest 5%` })}
</div>
<div class="viz-grid">
  ${columnChart({ id: "chart-mcp", title: "Tool calls by AI app", sub: `MCP tool calls ${per(m)}`, labels: labels(m), series: withSlots(x.byClient), firstCol: firstCol(m), empty: "No MCP calls in this period yet." })}
  <figure class="chart">
    <figcaption><h3>Which AI apps people use</h3><p>People who made calls from each AI app in ${e(periodName(m))}</p></figcaption>
    ${barList(x.clients.map((c) => ({ label: c.name, value: c.people, note: `${fmt(c.calls)} calls` })), { total: x.people, empty: "No MCP calls in this period yet." })}
  </figure>
</div>
<figure class="chart">
  <figcaption><h3>Tools</h3><p>Calls to each MCP tool in ${e(periodName(m))}, and how many failed</p></figcaption>
  ${barList(x.tools.slice(0, 14).map((t) => ({ label: t.name, value: t.calls, note: t.errors ? `${fmt(t.errors)} failed` : undefined })), { empty: "No MCP calls in this period yet." })}
</figure>`,
  );
}

function appsSection(m: Metrics): string {
  const a = m.apps;
  const top = a.top
    .map(
      (r) => `<tr>
  <td><strong>${e(r.title)}</strong><div class="muted">${e(r.host)}</div></td>
  <td>${e(r.owner)}</td>
  <td class="num">${e(fmt(r.visitors))}</td>
  <td class="num">${e(fmt(r.views))}</td>
  <td class="num">${e(fmt(r.versions))}</td>
  <td class="num">${e(fmt(r.dataRows))}</td>
  <td>${r.features.map((f) => `<span class="tag">${e(f)}</span>`).join(" ") || '<span class="muted">—</span>'}</td>
  <td class="nowrap">${e(r.lastOpened ?? "—")}</td>
</tr>`,
    )
    .join("");
  return section(
    "apps",
    "Hosted apps",
    "Apps people built and published on Formelab, and the people opening them. An app's builders are its owner and editors; everyone else opening it is someone it was shared with.",
    `<div class="viz-grid">
  ${lineChart({ id: "chart-views", title: "App traffic", sub: `Page views (including guests with a public link) and distinct signed-in people opening apps, ${per(m)}`, labels: labels(m), series: withSlots([a.views, a.visitors, a.guestViews]), firstCol: firstCol(m), empty: "No app visits in this period yet." })}
  ${columnChart({ id: "chart-visitors", title: "Who opens apps", sub: `Distinct people ${per(m)}: builders testing vs people it was shared with`, labels: labels(m), series: withSlots([a.builderVisitors, a.sharedVisitors]), firstCol: firstCol(m), empty: "No app visits in this period yet." })}
  ${columnChart({ id: "chart-shipping", title: "Shipping", sub: `Publishes ${per(m)}: brand-new apps vs new versions of existing ones`, labels: labels(m), series: withSlots([m.shipping.updates, m.shipping.newApps]), firstCol: firstCol(m) })}
  <figure class="chart">
    <figcaption><h3>What apps do</h3><p>Share of the ${e(fmt(a.adoption[0]?.total ?? 0))} live apps using each capability</p></figcaption>
    ${barList(a.adoption.map((r) => ({ label: r.label, value: r.count })), { total: a.adoption[0]?.total || undefined, empty: "No apps yet." })}
  </figure>
</div>
<figure class="chart">
  <figcaption><h3>Top apps</h3><p>Ranked by people who opened them in ${e(periodName(m))} other than their builders</p></figcaption>
  ${top ? `<div class="scroll"><table class="data"><thead><tr><th>App</th><th>Owner</th><th class="num">Visitors</th><th class="num">Views</th><th class="num">Versions</th><th class="num">Data rows</th><th>Uses</th><th>Last opened</th></tr></thead><tbody>${top}</tbody></table></div>` : '<p class="muted empty-note">No apps yet.</p>'}
</figure>`,
  );
}

function peopleSection(m: Metrics): string {
  const rows = m.people
    .map(
      (p) => `<tr>
  <td>${e(p.email)}<div class="muted">Joined ${e(fmtTime(p.joined).slice(0, 10))}</div></td>
  <td class="num">${e(fmt(p.activeDays))}</td>
  <td class="num">${e(fmt(p.apps))}</td>
  <td class="num">${e(fmt(p.publishes))}</td>
  <td class="num">${e(fmt(p.mcpCalls))}</td>
  <td class="num">${e(fmt(p.reach))}</td>
  <td>${e(p.client ?? "—")}</td>
  <td class="nowrap">${e(p.lastActive ?? "—")}</td>
</tr>`,
    )
    .join("");
  return section(
    "people",
    "Most engaged customers",
    `The people who were active on the most days in ${e(periodName(m))}. Reach is how many other people opened their apps.`,
    rows
      ? `<div class="scroll"><table class="data"><thead><tr><th>Person</th><th class="num">Active days</th><th class="num">Apps live</th><th class="num">Publishes</th><th class="num">MCP calls</th><th class="num">Reach</th><th>Main AI app</th><th>Last active</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : '<p class="muted empty-note">Nobody was active in this period.</p>',
  );
}

function notes(m: Metrics): string {
  const since = (s: string | null) => (s ? `since ${e(s)}` : "from the next one");
  return `<section class="viz-notes">
  <h2>About these numbers</h2>
  <ul>
    <li><strong>Team accounts</strong> (admins and the owner) are ${m.includeTeam ? "<strong>included</strong>" : "left out, so the numbers show real customers. Turn on <em>Include team accounts</em> to count them"}.</li>
    <li><strong>MCP calls</strong> are recorded ${since(m.trackingSince.mcp === null ? null : new Date(m.trackingSince.mcp).toISOString().slice(0, 10))} and <strong>app visits</strong> ${since(m.trackingSince.visits)}. Accounts, the waitlist, apps, publishes and changes go back to the start.</li>
    <li>Changes compare the period shown with the one just before it, the same length.</li>
    <li>A visit is one person opening an app's pages on one day (UTC); views count every page they loaded. Guests let in by an app's public link don't sign in, so they count as views but not as people.</li>
  </ul>
</section>`;
}

