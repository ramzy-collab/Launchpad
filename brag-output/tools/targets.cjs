// Measures cursor targets for one format and prints the JSON gen.mjs takes. Usage: node targets.cjs <w> <h> <index.html>
const { chromium } = require("playwright");
const [W, H, file] = [+process.argv[2], +process.argv[3], process.argv[4]];
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: W, height: H } });
  await p.addInitScript(() => { window.__timelines = {}; });
  await p.goto("file://" + file); await p.evaluate(() => document.fonts.ready);
  const r = await p.evaluate(([W, H]) => {
    const tl = window.__timelines.main, rect = (s) => document.querySelector(s).getBoundingClientRect();
    const mid = (s) => { const e = rect(s); return [e.x + e.width / 2, e.y + e.height / 2]; };
    const tip = ([x, y]) => [Math.round(x - 13), Math.round(y - 8)]; // the arrow's tip sits 13,8 px into its 64px box
    tl.seek(7.0);
    const a = rect("#s3-label"), c = rect("#s3-prompt"), cx = (a.left + c.right) / 2, cy = (a.top + c.bottom) / 2;
    const DX = Math.round(W / 2 - cx), DY = Math.round(H / 2 - cy);
    const [sx, sy] = mid("#s3-send"), [SENDX, SENDY] = tip([sx + DX, sy + DY]); // clicked before the prompt slides into place
    const [SLOTX, SLOTY] = tip(mid("#s3-app .slots span:nth-child(2)"));
    tl.seek(26.07); const [R2X, R2Y] = tip(mid("#s6-r2 .radio")), [R3X, R3Y] = tip(mid("#s6-r3 .radio"));
    tl.seek(28.31); const [CTAX, CTAY] = tip(mid("#s5-cta"));
    return { DX, DY, SENDX, SENDY, SLOTX, SLOTY, R0X: W - 200, R0Y: H - 80, R2X, R2Y, R3X, R3Y, CTAX, CTAY };
  }, [W, H]);
  console.log(JSON.stringify(r)); await b.close();
})();
