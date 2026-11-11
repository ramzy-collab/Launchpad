// Fills index.tpl.html into the composition's index.html. Usage: [FORMAT=vertical] node gen.mjs "$(cat targets-<format>.json)"
import fs from "fs";
const S = process.argv[1].replace(/\/gen\.mjs$/, ""), VERT = process.env.FORMAT === "vertical";
const OUT = `${S}/../${VERT ? "composition-vertical" : "composition"}/index.html`;
// cursor targets and offsets for this format, measured from the layout: {"SLOTX":..,"SLOTY":..,"CTAX":..,...}
const P = JSON.parse(process.argv[2]);
const figs = JSON.parse(fs.readFileSync(`${S}/figs.json`, "utf8"));
const rms = fs.readFileSync(`${S}/rms.json`, "utf8").trim();
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const words = (s) => s.split(" ").map((w) => `<span class="w">${esc(w)}</span>`).join(" ");
const chars = (s) => [...s].map((c) => `<span class="c">${c === " " ? " " : esc(c)}</span>`).join("");
// [file, time, volume]; peak lands about a frame after its picture
const sfx = [
  ["impactSoft_medium_001.ogg", 1.6, 0.9],
  ["drop_002.ogg", 13.92, 0.6], ["drop_003.ogg", 14.19, 0.4], ["drop_001.ogg", 14.45, 0.4], ["drop_003.ogg", 14.71, 0.4], ["drop_001.ogg", 14.97, 0.4], ["drop_003.ogg", 15.23, 0.4], ["impactSoft_medium_001.ogg", 15.75, 0.6],
  ...Array.from({ length: 5 }, (_, i) => [`keypress-00${(i % 6) + 1}.wav`, +(9.5 + i * 0.09).toFixed(2), 0.3]),
  ...Array.from({ length: 5 }, (_, i) => [`keypress-00${((i + 3) % 6) + 1}.wav`, +(11.6 + i * 0.08).toFixed(2), 0.3]),
  ["click_003.ogg", 9.96, 0.8], ["card-slide-1.ogg", 10.0, 0.45], ["drop_002.ogg", 10.52, 0.6],
  ["click_002.ogg", 12.05, 0.8], ["card-slide-1.ogg", 12.09, 0.45], ["drop_001.ogg", 12.52, 0.6], ["drop_002.ogg", 12.62, 0.6], 
  ...Array.from({ length: 10 }, (_, i) => [`keypress-00${(i % 6) + 1}.wav`, +(3.98 + i * 0.12).toFixed(2), 0.35]),
  ["click_003.ogg", 5.24, 0.8], ["card-slide-1.ogg", 5.32, 0.5], ["click_002.ogg", 7.40, 0.8], ["drop_001.ogg", 7.96, 0.7],
  ["card-slide-1.ogg", 17.91, 0.4], ["drop_003.ogg", 18.43, 0.45], ["card-slide-1.ogg", 18.98, 0.4], ["drop_003.ogg", 19.50, 0.45], ["card-slide-1.ogg", 20.02, 0.4],
  ["card-slide-1.ogg", 22.91, 0.4], ["click_002.ogg", 24.20, 0.8], ["click_003.ogg", 25.25, 0.8], ["drop_001.ogg", 25.54, 0.7],
  ["impactBell_heavy_000.ogg", 27.36, 0.55], ["click_003.ogg", 28.40, 0.8],
];
const len = (f) => (f.startsWith("key") ? 0.25 : { "card-slide-1.ogg": 0.6, "drop_001.ogg": 0.11, "drop_002.ogg": 0.2, "drop_003.ogg": 0.2, "impactBell_heavy_000.ogg": 1.48, "impactSoft_medium_001.ogg": 0.19 }[f] ?? 0.05);
const sfxTags = sfx.map(([f, t, v], i) => `      <audio id="sfx${i}" class="clip" data-start="${t}" data-duration="${len(f)}" data-track-index="${11 + i}" data-volume="${v}" src="assets/sfx/${f}"></audio>`).join("\n");
let html = fs.readFileSync(`${S}/index.tpl.html`, "utf8")
  .replace("https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/gsap.min.js", "assets/js/gsap.min.js")
  .replace("__H1A__", words("Software that fits you,"))
  .replace("__PROMPT__", chars("Make a class booking page for my studio")).replace("__PROMPT2__", chars("Make a budget that matches how I spend")).replace("__PROMPT3__", chars("Make a spelling game for my kids"))
  .replace("__SFX__", sfxTags).replace("__RMS__", rms)
  .replace(/__([A-Z0-9]+)__/g, (m, k) => (k in P ? String(P[k]) : m));
// the AI apps' marks, the same ones the product shows on Connect your AI
const logosSrc = fs.readFileSync(`${S}/../../src/dashboard/logos.ts`, "utf8");
const AI_LOGOS = JSON.parse(logosSrc.slice(logosSrc.indexOf("{", logosSrc.indexOf("AI_LOGOS")), logosSrc.lastIndexOf("}") + 1).replace(/,\s*}$/, "}"));
html = html.replace(/__LOGO_([A-Z]+)__/g, (m, k) => { const svg = AI_LOGOS[k.toLowerCase()]; if (!svg) throw new Error("no logo for " + k); return svg; });
// the cards' floating toasts cover the app on purpose, as on formelab.ai
figs.forEach((f, i) => { html = html.replace(`__FIG${i}__`, f.replace(/<div class="float/g, '<div data-layout-allow-occlusion data-layout-allow-overlap class="float').replace(/<div class="shot">/g, '<div class="shot" data-layout-allow-overlap>')); });
if (VERT) html = html.replace(/width=1920, height=1080/, "width=1080, height=1920").replace("html, body { margin: 0; width: 1920px; height: 1080px;", "html, body { margin: 0; width: 1080px; height: 1920px;").replace(/data-width="1920" data-height="1080"/g, 'data-width="1080" data-height="1920"').replace("    </style>", fs.readFileSync(`${S}/vertical.css`, "utf8") + "    </style>");
if (/__[A-Z0-9]+__/.test(html)) throw new Error("unfilled placeholder: " + html.match(/__[A-Z0-9]+__/)[0]);
fs.writeFileSync(OUT, html);
console.log("wrote", OUT, html.length);
