// Charts for the admin panel's Metrics page, drawn on the server as SVG so the page keeps its strict
// CSP. Colors come from CSS (--viz-1…6 in formelab.css, light and dark); viz.js adds the
// crosshair and tooltips from each chart's data-chart attribute. Every chart also has a table view.
import { escapeHtml as e } from "../util";

export type Fmt = "int" | "dec" | "pct";

export interface ChartSeries {
  name: string;
  values: number[];
  /** Categorical color slot, 1–6, fixed per entity so a series keeps its color everywhere. */
  slot: number;
}

// Drawn about as wide as a half-width card shows it, so 13px text stays close to 13px.
const W = 560;
const PAD = { left: 44, right: 46, top: 16, bottom: 30 };

/** 1,284 → "1.3K"; 0.42 → "42%". */
export function fmt(v: number, kind: Fmt = "int"): string {
  if (kind === "pct") return `${Math.round(v * 100)}%`;
  const a = Math.abs(v);
  if (a >= 1e6) return `${trim(v / 1e6)}M`;
  if (a >= 1e4) return `${trim(v / 1e3)}K`;
  if (a >= 1e3) return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  return kind === "dec" ? trim(v) : String(Math.round(v));
}
const trim = (v: number) => (Math.round(v * 10) / 10).toString();

/** Tick values from 0 to a rounded maximum just above `max`, at most five steps. */
function ticks(max: number, kind: Fmt): number[] {
  if (kind === "pct") return [0, 0.25, 0.5, 0.75, 1];
  if (max <= 0) return [0, 1, 2, 3, 4];
  const mag = 10 ** Math.floor(Math.log10(max / 5));
  const step = [1, 2, 2.5, 5, 10, 20, 25, 50].map((m) => m * mag).find((s) => (kind !== "int" || Number.isInteger(s)) && Math.ceil(max / s) <= 5) ?? mag * 100;
  return Array.from({ length: Math.max(1, Math.ceil(max / step)) + 1 }, (_, i) => i * step);
}

/** Which x positions get a date label: about six, always the first and last. */
function labelIndexes(n: number): Set<number> {
  const out = new Set<number>([0, n - 1]);
  const every = Math.max(1, Math.ceil(n / 6));
  for (let i = 0; i < n - every / 2; i += every) out.add(i);
  return out;
}

function frame(opts: { height: number; labels: string[]; yTicks: number[]; kind: Fmt; x: (i: number) => number }) {
  const { height, labels, yTicks, kind, x } = opts;
  const bottom = height - PAD.bottom;
  const top = PAD.top;
  const max = yTicks[yTicks.length - 1]!;
  const y = (v: number) => bottom - (Math.max(0, v) / max) * (bottom - top);
  const grid = yTicks
    .map((t) => `<line class="grid${t === 0 ? " base" : ""}" x1="${PAD.left}" x2="${W - PAD.right}" y1="${y(t)}" y2="${y(t)}"/><text class="tick" x="${PAD.left - 8}" y="${y(t) + 4}" text-anchor="end">${e(fmt(t, kind))}</text>`)
    .join("");
  const shown = labelIndexes(labels.length);
  const xLabels = labels
    .map((l, i) => {
      if (!shown.has(i)) return "";
      // Keep the first and last labels inside the plot.
      const anchor = labels.length > 1 && i === 0 ? "start" : labels.length > 1 && i === labels.length - 1 ? "end" : "middle";
      return `<text class="tick" x="${x(i)}" y="${height - 8}" text-anchor="${anchor}">${e(l)}</text>`;
    })
    .join("");
  return { y, grid, xLabels, bottom, top };
}

function legend(series: ChartSeries[], mark: "line" | "box"): string {
  if (series.length < 2) return "";
  return `<ul class="legend">${series.map((s) => `<li><span class="key ${mark} s${s.slot}" aria-hidden="true"></span>${e(s.name)}</li>`).join("")}</ul>`;
}

function tableView(labels: string[], series: ChartSeries[], kind: Fmt, firstCol: string): string {
  const head = `<tr><th scope="col">${e(firstCol)}</th>${series.map((s) => `<th scope="col" class="num">${e(s.name)}</th>`).join("")}</tr>`;
  const rows = labels.map((l, i) => `<tr><th scope="row">${e(l)}</th>${series.map((s) => `<td class="num">${e(fmt(s.values[i] ?? 0, kind))}</td>`).join("")}</tr>`).join("");
  return `<details class="table-view"><summary>Show the numbers</summary><div class="scroll"><table><thead>${head}</thead><tbody>${rows}</tbody></table></div></details>`;
}

function figure(opts: { id: string; title: string; sub: string; labels: string[]; series: ChartSeries[]; kind: Fmt; geometry: { x0: number; step: number; top: number; bottom: number }; svg: string; mark: "line" | "box"; empty?: string; firstCol: string; stacked?: boolean }) {
  const data = { labels: opts.labels, series: opts.series.map((s) => ({ name: s.name, slot: s.slot, values: s.values })), kind: opts.kind, stacked: !!opts.stacked, ...opts.geometry, w: W };
  const empty = opts.series.every((s) => s.values.every((v) => !v));
  return `<figure class="chart" id="${e(opts.id)}">
  <figcaption><h3>${e(opts.title)}</h3><p>${e(opts.sub)}</p></figcaption>
  ${legend(opts.series, opts.mark)}
  <div class="plot${empty ? " is-empty" : ""}" tabindex="0" role="img" aria-label="${e(opts.title)}. Use the arrow keys to read each point." data-chart="${e(JSON.stringify(data))}">
    ${opts.svg}
    ${empty ? `<p class="empty-note">${e(opts.empty ?? "Nothing yet in this period.")}</p>` : ""}
    <div class="tip" hidden></div>
  </div>
  ${tableView(opts.labels, opts.series, opts.kind, opts.firstCol)}
</figure>`;
}

/** Lines over time on one axis. `area` washes the first series. End values are labeled. */
export function lineChart(opts: { id: string; title: string; sub: string; labels: string[]; series: ChartSeries[]; kind?: Fmt; height?: number; area?: boolean; empty?: string; firstCol?: string }): string {
  const { labels, series, kind = "int", height = 220 } = opts;
  const n = labels.length;
  const step = n > 1 ? (W - PAD.left - PAD.right) / (n - 1) : 0;
  const x = (i: number) => (n > 1 ? PAD.left + i * step : (PAD.left + W - PAD.right) / 2);
  const max = Math.max(0, ...series.flatMap((s) => s.values));
  const f = frame({ height, labels, yTicks: ticks(max, kind), kind, x });
  const lines = series
    .map((s, si) => {
      const pts = s.values.map((v, i) => `${x(i).toFixed(1)},${f.y(v).toFixed(1)}`);
      const path = `M${pts.join("L")}`;
      const area = opts.area && si === 0 && n > 1 ? `<path class="area s${s.slot}" d="${path}L${x(n - 1)},${f.bottom}L${x(0)},${f.bottom}Z"/>` : "";
      const last = s.values[n - 1] ?? 0;
      return `${area}<path class="ln s${s.slot}" d="${path}"/><circle class="dot s${s.slot}" cx="${x(n - 1)}" cy="${f.y(last)}" r="4"/>`;
    })
    .join("");
  // End labels, nudged apart only when two would overlap.
  const ends = series.map((s) => ({ v: s.values[n - 1] ?? 0, y: f.y(s.values[n - 1] ?? 0) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i]!.y - ends[i - 1]!.y < 15) ends[i]!.y = ends[i - 1]!.y + 15;
  const endLabels = ends.map((l) => `<text class="end" x="${x(n - 1) + 9}" y="${l.y + 4}">${e(fmt(l.v, kind))}</text>`).join("");
  const svg = `<svg viewBox="0 0 ${W} ${height}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">${f.grid}${lines}${endLabels}${f.xLabels}<line class="xhair" x1="0" x2="0" y1="${f.top}" y2="${f.bottom}" visibility="hidden"/></svg>`;
  return figure({ ...opts, kind, mark: "line", svg, firstCol: opts.firstCol ?? "Date", geometry: { x0: x(0), step, top: f.top, bottom: f.bottom } });
}

/** Columns over time; several series stack, with a 2px gap between segments. The total is labeled on the last column. */
export function columnChart(opts: { id: string; title: string; sub: string; labels: string[]; series: ChartSeries[]; kind?: Fmt; height?: number; empty?: string; firstCol?: string }): string {
  const { labels, series, kind = "int", height = 220 } = opts;
  const n = labels.length;
  const band = (W - PAD.left - PAD.right) / Math.max(1, n);
  const bw = Math.max(2, Math.min(24, band * 0.68));
  const x = (i: number) => PAD.left + band * (i + 0.5);
  const totals = labels.map((_, i) => series.reduce((t, s) => t + (s.values[i] ?? 0), 0));
  const f = frame({ height, labels, yTicks: ticks(Math.max(0, ...totals), kind), kind, x });
  let bars = "";
  for (let i = 0; i < n; i++) {
    const segs = series.map((s) => ({ slot: s.slot, v: s.values[i] ?? 0 })).filter((p) => p.v > 0);
    let sum = 0;
    segs.forEach((p, k) => {
      const base = f.y(sum) - (k > 0 ? 2 : 0); // a 2px surface gap between stacked segments
      sum += p.v;
      const top = f.y(sum);
      const h = Math.max(1, base - top);
      const left = (x(i) - bw / 2).toFixed(1);
      bars +=
        k === segs.length - 1
          ? `<path class="bar s${p.slot}" d="${roundTop(x(i) - bw / 2, base - h, bw, h)}"/>`
          : `<rect class="bar s${p.slot}" x="${left}" y="${(base - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}"/>`;
    });
  }
  const lastTotal = totals[n - 1] ?? 0;
  const endLabel = n && lastTotal ? `<text class="end" x="${x(n - 1)}" y="${f.y(lastTotal) - 6}" text-anchor="middle">${e(fmt(lastTotal, kind))}</text>` : "";
  const svg = `<svg viewBox="0 0 ${W} ${height}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">${f.grid}<rect class="hover-band" x="0" y="${f.top}" width="${band.toFixed(1)}" height="${f.bottom - f.top}" visibility="hidden"/>${bars}${endLabel}${f.xLabels}</svg>`;
  return figure({ ...opts, kind, mark: "box", svg, stacked: series.length > 1, firstCol: opts.firstCol ?? "Date", geometry: { x0: x(0), step: band, top: f.top, bottom: f.bottom } });
}

/** A rect with 4px rounded top corners and a square base. */
function roundTop(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  return `M${x.toFixed(1)},${(y + h).toFixed(1)}V${(y + r).toFixed(1)}Q${x.toFixed(1)},${y.toFixed(1)} ${(x + r).toFixed(1)},${y.toFixed(1)}H${(x + w - r).toFixed(1)}Q${(x + w).toFixed(1)},${y.toFixed(1)} ${(x + w).toFixed(1)},${(y + r).toFixed(1)}V${(y + h).toFixed(1)}Z`;
}

/** Horizontal bars, one color, values at the tips; with `total`, each also shows its share of it. Widths are
 * SVG attributes, not inline styles, which the page's CSP would block. */
export function barList(rows: { label: string; value: number; note?: string }[], opts: { kind?: Fmt; total?: number; empty?: string } = {}): string {
  if (!rows.length || rows.every((r) => !r.value)) return `<p class="muted empty-note">${e(opts.empty ?? "Nothing yet in this period.")}</p>`;
  const max = Math.max(...rows.map((r) => r.value), 1);
  return `<ul class="barlist">${rows
    .map((r) => {
      const share = opts.total ? ` <span class="muted">${e(fmt(opts.total ? r.value / opts.total : 0, "pct"))}</span>` : "";
      return `<li><span class="bl-label">${e(r.label)}${r.note ? `<span class="muted"> · ${e(r.note)}</span>` : ""}</span><svg class="bl-track" aria-hidden="true"><rect class="bl-fill" width="${Math.max(r.value ? 0.6 : 0, (r.value / max) * 100).toFixed(1)}%" height="100%" rx="4"/></svg><span class="bl-value">${e(fmt(r.value, opts.kind ?? "int"))}${share}</span></li>`;
    })
    .join("")}</ul>`;
}

/** A tiny trend line for a stat tile: the earlier points muted, the latest dotted in the accent.
 * It stretches to its box, so the dot is a round-capped zero-length stroke rather than a circle. */
export function sparkline(values: number[]): string {
  if (values.length < 2) return "";
  const w = 120;
  const h = 32;
  const max = Math.max(...values, 1);
  const x = (i: number) => 3 + (i / (values.length - 1)) * (w - 6);
  const y = (v: number) => h - 4 - (v / max) * (h - 8);
  const d = `M${values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("L")}`;
  const last = values.length - 1;
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path d="${d}"/><path class="spark-dot" d="M${x(last).toFixed(1)},${y(values[last]!).toFixed(1)}h0"/></svg>`;
}

/** A 0–100% meter: the fill on a lighter track of the same hue. */
export function meter(value: number): string {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return `<svg class="meter" aria-hidden="true"><rect class="meter-track" width="100%" height="100%" rx="4"/><rect class="meter-fill" width="${pct.toFixed(1)}%" height="100%" rx="4"/></svg>`;
}
