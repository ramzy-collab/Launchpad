import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { GUIDE_MD } from "../src/generated/assets";
import { pngSize } from "../src/icons";
import { findShareImage, isPreviewBot, svgToPng, wrap } from "../src/share";
import { APP, appAt, call, OWNER, publishHtml, publishZip, uniq } from "./helpers";

const IMESSAGE = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/601.2.4 (KHTML, like Gecko) Version/9.0.1 Safari/601.2.4 facebookexternalhit/1.1 Facebot Twitterbot/1.0";
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const bot = (ua = IMESSAGE) => ({ headers: { "user-agent": ua } });
const ICON = `<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%23FF6B4A'/%3E%3C/svg%3E">`;
const SHARE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630"><rect width="1200" height="630" fill="#2BC48A"/><text x="80" y="330" font-family="system-ui" font-size="90">Hoops</text></svg>`;

const ogContent = (html: string, prop: string) =>
  new RegExp(`<meta (?:property|name)="${prop.replace(/[:.]/g, "\\$&")}" content="([^"]*)">`).exec(html)?.[1];
const png = async (res: Response) => pngSize(new Uint8Array(await res.arrayBuffer()));

/** A PNG 1200 wide (the renderer draws to that width) and `height` tall. */
const realPng = (height: number) =>
  svgToPng(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${height}"><rect width="1200" height="${height}" fill="#5B4CF5"/></svg>`);

describe("link previews for apps", () => {
  it("gives preview fetchers the app's title, description and image instead of the sign-in", async () => {
    const ns = uniq();
    await publishHtml(OWNER, ns, "wedding", `<!doctype html><html><head><title>Wedding &amp; party</title><meta name="description" content="RSVP and pick a meal."><meta property="og:image" content="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1200 630'%3E%3Crect width='1200' height='630' fill='red'/%3E%3C/svg%3E">${ICON}</head><body>SECRET GUEST LIST</body></html>`);
    const origin = await appAt(ns, "wedding");

    const res = await call(`${origin}/`, bot());
    expect(res.status).toBe(200);
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    const html = await res.text();
    expect(html).not.toContain("SECRET GUEST LIST");
    expect(ogContent(html, "og:title")).toBe("Wedding &amp; party");
    expect(ogContent(html, "og:description")).toBe("RSVP and pick a meal.");
    expect(ogContent(html, "og:url")).toBe(`${origin}/`);
    expect(ogContent(html, "og:site_name")).toBe("Formelab");
    expect(ogContent(html, "twitter:card")).toBe("summary_large_image");
    const image = ogContent(html, "og:image")!;
    expect(image).toMatch(new RegExp(`^${origin.replace(/\./g, "\\.")}/_platform/share\\.png\\?v=`));
    expect(html).toMatch(/<link rel="apple-touch-icon" href="https:\/\/[^"]+\/_platform\/app-icon\//);
    expect(html).toContain("/auth/app?return=");

    // The image is public, and the app's own illustration drawn as a PNG.
    const img = await call(image.replace(/&amp;/g, "&"));
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(img.headers.get("cache-control")).toContain("public");
    expect(await png(img)).toEqual({ width: 1200, height: 630 });

    // People without a sign-in still have to sign in, and the app's API stays closed to fetchers.
    const person = await call(`${origin}/`, bot(CHROME));
    expect(person.status).not.toBe(200);
    expect(await person.text()).not.toContain("og:title");
    expect((await call(`${origin}/_api/kv`, bot())).status).toBe(401);
    expect((await call(`${origin}/_platform/sdk.js`, bot())).status).not.toBe(200);
  });

  it("previews restricted apps and every page of an app, with Slack, WhatsApp and Signal too", async () => {
    const ns = uniq();
    await publishHtml(OWNER, ns, "poll", `<!doctype html><html><head><title>Lunch poll</title>${ICON}</head><body>x</body></html>`, { visibility: "restricted" });
    const origin = await appAt(ns, "poll");
    for (const ua of ["Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)", "WhatsApp/2.23.20.0 A", "WhatsApp", "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)", "TelegramBot (like TwitterBot)"]) {
      const res = await call(`${origin}/results?x=1`, bot(ua));
      expect(res.status, ua).toBe(200);
      const html = await res.text();
      expect(ogContent(html, "og:title")).toBe("Lunch poll");
      expect(ogContent(html, "og:description")).toBe("Made with Formelab.");
      expect(ogContent(html, "og:url")).toBe(`${origin}/results`);
    }
  });

  it("draws a card for apps without their own illustration", async () => {
    const ns = uniq();
    await publishHtml(OWNER, ns, "plain", `<!doctype html><html><head><title>Plain</title>${ICON}</head><body>x</body></html>`, { title: "Book club" });
    const origin = await appAt(ns, "plain");
    const html = await (await call(`${origin}/`, bot())).text();
    expect(ogContent(html, "og:title")).toBe("Book club"); // the app's own title setting wins
    expect(ogContent(html, "og:image:width")).toBe("1200");
    expect(ogContent(html, "og:image:height")).toBe("630");
    const img = await call(`${origin}/_platform/share.png`);
    expect(img.status).toBe(200);
    expect(await png(img)).toEqual({ width: 1200, height: 630 });
  });

  it("uses share.svg, share.png or an https og:image from a zip", async () => {
    const ns = uniq();
    await publishZip(OWNER, ns, "hoops", { "index.html": `<!doctype html><html><head><title>Hoops</title>${ICON}</head><body>x</body></html>`, "share.svg": SHARE_SVG });
    let row = await env.DB.prepare("SELECT share_path FROM sites WHERE namespace = ? AND mount_path = ?").bind(ns, "hoops").first<{ share_path: string }>();
    expect(row?.share_path).toBe("share.svg");
    expect(await png(await call(`${await appAt(ns, "hoops")}/_platform/share.png`))).toEqual({ width: 1200, height: 630 });

    await publishZip(OWNER, ns, "photo", {
      "index.html": `<!doctype html><html><head><title>Photo</title>${ICON}<meta property="og:image" content="img/cover.png"></head><body>x</body></html>`,
      "img/cover.png": await realPng(600),
    });
    const photo = await appAt(ns, "photo");
    const html = await (await call(`${photo}/`, bot())).text();
    expect(ogContent(html, "og:image:width")).toBe("1200");
    expect(ogContent(html, "og:image:height")).toBe("600");
    expect(await png(await call(`${photo}/_platform/share.png`))).toEqual({ width: 1200, height: 600 });

    await publishHtml(OWNER, ns, "cdn", `<!doctype html><html><head><title>CDN</title>${ICON}<meta property="og:image" content="https://cdn.example.net/cover.png?a=1&amp;b=2"></head><body>x</body></html>`);
    const cdn = await (await call(`${await appAt(ns, "cdn")}/`, bot())).text();
    expect(ogContent(cdn, "og:image")).toBe("https://cdn.example.net/cover.png?a=1&amp;b=2");

    // A new version without one goes back to the drawn card.
    await publishHtml(OWNER, ns, "hoops", `<!doctype html><html><head><title>Hoops</title>${ICON}</head><body>v2</body></html>`);
    row = await env.DB.prepare("SELECT share_path FROM sites WHERE namespace = ? AND mount_path = ?").bind(ns, "hoops").first<{ share_path: string }>();
    expect(row?.share_path).toBe("");
  });

  it("falls back to the card for an illustration that can't be drawn, and looks again for apps published before previews", async () => {
    const ns = uniq();
    await publishZip(OWNER, ns, "broken", { "index.html": `<!doctype html><html><head><title>Broken</title>${ICON}</head><body>x</body></html>`, "share.svg": "<svg not really" });
    expect(await png(await call(`${await appAt(ns, "broken")}/_platform/share.png`))).toEqual({ width: 1200, height: 630 });

    await publishZip(OWNER, ns, "old", { "index.html": `<!doctype html><html><head><title>Old</title>${ICON}</head><body>x</body></html>`, "share.svg": SHARE_SVG });
    await env.DB.prepare("UPDATE sites SET share_path = NULL WHERE namespace = ? AND mount_path = ?").bind(ns, "old").run();
    expect((await call(`${await appAt(ns, "old")}/`, bot())).status).toBe(200);
    const row = await env.DB.prepare("SELECT share_path FROM sites WHERE namespace = ? AND mount_path = ?").bind(ns, "old").first<{ share_path: string }>();
    expect(row?.share_path).toBe("share.svg");
  });
});

describe("link previews for Formelab", () => {
  it("puts the brand card on the home page and login page", async () => {
    const home = await (await call("/")).text();
    expect(ogContent(home, "og:title")).toBe("Formelab: SaaS is dead");
    const image = ogContent(home, "og:image")!;
    expect(image).toMatch(/^https:\/\/example\.com\/_assets\/share\.png\?v=[0-9a-f]{10}$/);
    expect(ogContent(home, "twitter:card")).toBe("summary_large_image");
    const img = await call(image);
    expect(img.status).toBe(200);
    expect(await png(img)).toEqual({ width: 1200, height: 630 });

    const login = await (await call("/login")).text();
    expect(ogContent(login, "og:title")).toBe("Log in to Formelab");
    expect(ogContent(login, "og:image")).toBe(image);
  });

  it("gives preview fetchers the brand card on the web app instead of the sign-in", async () => {
    const res = await call(`${APP}/shared`, bot());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(ogContent(html, "og:title")).toBe("Formelab");
    expect(ogContent(html, "og:url")).toBe(`${APP}/shared`);
    expect((await call(`${APP}/shared`, bot(CHROME))).status).toBe(302);
    expect((await call(`${APP}/_assets/share.png`)).status).toBe(200);
  });
});

describe("share helpers", () => {
  it("knows link preview fetchers from people", () => {
    const req = (ua: string) => new Request("https://x.test/", { headers: { "user-agent": ua } });
    for (const ua of [IMESSAGE, "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)", "LinkedInBot/1.0", "Twitterbot/1.0", "WhatsApp/2.2412.54 i", "Mozilla/5.0 (compatible; Discordbot/2.0)", "SkypeUriPreview Preview/0.5"]) {
      expect(isPreviewBot(req(ua)), ua).toBe(true);
    }
    for (const ua of [
      CHROME,
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/480.0]",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Teams/24.1 Chrome/120 Safari/537.36",
      "Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Mobile/15E148 Snapchat/13.0",
      "",
    ]) {
      expect(isPreviewBot(req(ua)), ua).toBe(false);
    }
  });

  it("finds the share image the app names, or a well-known file", () => {
    const files = ["index.html", "share.svg", "img/og.png", "og.png"];
    expect(findShareImage(files, `<meta property="og:image" content="img/og.png">`, "")).toBe("img/og.png");
    expect(findShareImage(files, `<meta name="twitter:image" content="./img/og.png">`, "")).toBe("img/og.png");
    expect(findShareImage(files, `<meta property="og:image" content="missing.png">`, "")).toBe("share.svg");
    expect(findShareImage(files, `<meta property="og:image" content="../../etc/passwd">`, "")).toBe("share.svg");
    expect(findShareImage(["index.html"], `<meta property="og:image" content="http://insecure.test/a.png">`, "")).toBe("");
    expect(findShareImage(["index.html", "og.png"], "", "")).toBe("og.png");
    expect(findShareImage(["index.html"], "", "")).toBe("");
  });

  it("draws the guide's starter illustration", async () => {
    const starter = GUIDE_MD.slice(GUIDE_MD.indexOf("## 5. Starter app"));
    const share = findShareImage(["index.html"], starter, "");
    expect(share).toMatch(/^data:image\/svg\+xml,/);
    expect(pngSize(await svgToPng(decodeURIComponent(share.slice(share.indexOf(",") + 1))))).toEqual({ width: 1200, height: 630 });
  });

  it("wraps long titles and cuts them off with an ellipsis", () => {
    expect(wrap("Wedding RSVPs", 76, 600, 2)).toEqual(["Wedding RSVPs"]);
    const lines = wrap("The Neighborhood Tool Library and Seed Swap Organizer for Maplewood", 60, 600, 3);
    expect(lines).toHaveLength(3);
    expect(lines[2]!.endsWith("…")).toBe(true);
    expect(wrap("Supercalifragilisticexpialidocious".repeat(3), 76, 600, 2)).toHaveLength(2);
  });
});
