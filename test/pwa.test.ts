import { describe, expect, it } from "vitest";
import { pngSize } from "../src/icons";
import { APP, APP_DOMAIN, call, OWNER, publishHtml, publishZip, uniq } from "./helpers";

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5"/></svg>`;

/** A PNG header (signature + IHDR) claiming the given size; enough for the size check. */
function pngHeader(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const v = new DataView(b.buffer);
  v.setUint32(16, width);
  v.setUint32(20, height);
  return b;
}

describe("installing Formelab", () => {
  it("serves its manifest, icons and service worker without sign-in", async () => {
    const res = await call(`${APP}/manifest.webmanifest`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/manifest+json");
    const m = await res.json<{ name: string; start_url: string; scope: string; display: string; icons: { src: string; sizes: string; purpose: string }[] }>();
    expect(m).toMatchObject({ name: "Formelab", start_url: "/", scope: "/", display: "standalone" });
    expect(m.icons.map((i) => i.sizes)).toEqual(["192x192", "512x512", "512x512"]);
    expect(m.icons.some((i) => i.purpose === "maskable")).toBe(true);
    for (const icon of m.icons) {
      const img = await call(`${APP}${icon.src}`);
      expect(img.status, icon.src).toBe(200);
      expect(img.headers.get("content-type")).toBe("image/png");
      const size = pngSize(new Uint8Array(await img.arrayBuffer()));
      expect(`${size?.width}x${size?.height}`).toBe(icon.sizes);
    }
    expect(pngSize(new Uint8Array(await (await call(`${APP}/_assets/apple-touch-icon.png`)).arrayBuffer()))).toEqual({ width: 180, height: 180 });

    const sw = await call(`${APP}/sw.js`);
    expect(sw.status).toBe(200);
    expect(sw.headers.get("content-type")).toContain("javascript");
    expect(await sw.text()).toContain('addEventListener("fetch"');
  });

  it("links the manifest and install script from web app pages, with a Get the app page", async () => {
    const html = await (await call("/app", { as: OWNER })).text();
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest">');
    expect(html).toContain('<link rel="apple-touch-icon" href="/_assets/apple-touch-icon.png">');
    expect(html).toMatch(/<script src="\/_assets\/install\.js\?v=[0-9a-f]{10}" defer><\/script>/);
    expect(html).toContain('href="/install"');
    expect((await call(`${APP}/_assets/install.js`)).status).toBe(200);

    const ns = uniq();
    await publishHtml(OWNER, ns, "notes", `<!doctype html><html><head><title>n</title></head><body>hi</body></html>`, { title: "Notes" });
    const page = await call("/app/install", { as: OWNER });
    expect(page.status).toBe(200);
    const body = await page.text();
    expect(body).toContain("Get the app");
    expect(body).toContain('data-install hidden');
    for (const p of ["ios", "android", "desktop", "mac"]) expect(body).toContain(`data-steps="${p}"`);
    expect(body).toContain(`https://${ns}.${APP_DOMAIN}/notes/`);
    expect(body).not.toMatch(/\son[a-z]+=/i); // strict CSP: no inline handlers
  });
});

describe("installing a published app", () => {
  it("adds a manifest link to the app's pages, unless it has its own", async () => {
    const ns = uniq();
    await publishHtml(OWNER, ns, "tools/budget", `<!doctype html><html><head><title>b</title></head><body>hi</body></html>`, { title: "Budget" });
    const html = await (await call(`https://${ns}.${APP_DOMAIN}/tools/budget/`, { as: OWNER })).text();
    expect(html).toContain('<base href="/tools/budget/"><link rel="manifest" href="/_platform/manifest.webmanifest?mount=tools%2Fbudget" crossorigin="use-credentials">');
    expect(html).toContain('<meta name="apple-mobile-web-app-title" content="Budget">');

    await publishHtml(OWNER, ns, "own", `<!doctype html><html><head><link rel="manifest" href="app.webmanifest"></head><body>hi</body></html>`);
    const own = await (await call(`https://${ns}.${APP_DOMAIN}/own/`, { as: OWNER })).text();
    expect(own.match(/rel="manifest"/g)).toHaveLength(1);
  });

  it("writes a manifest scoped to the app, for people who can open it", async () => {
    const ns = uniq();
    await publishZip(OWNER, ns, "kit", { "index.html": `<!doctype html><head><link rel="icon" href="icon.svg"></head><p>hi`, "icon.svg": SVG }, { title: "Kit" });
    const url = `https://${ns}.${APP_DOMAIN}/_platform/manifest.webmanifest?mount=kit`;
    expect((await call(url)).status).toBe(401); // needs a sign-in, like the app
    expect((await call(url, { as: `stranger-${uniq()}@example.com` })).status).toBe(404);
    expect((await call(`https://${ns}.${APP_DOMAIN}/_platform/manifest.webmanifest?mount=nope`, { as: OWNER })).status).toBe(404);

    const res = await call(url, { as: OWNER });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/manifest+json");
    const m = await res.json<{ id: string; name: string; start_url: string; scope: string; display: string; icons: { src: string; type: string; sizes: string }[] }>();
    expect(m).toMatchObject({ id: "/kit/", name: "Kit", start_url: "/kit/", scope: "/kit/", display: "standalone" });
    expect(m.icons).toHaveLength(1);
    expect(m.icons[0]).toMatchObject({ type: "image/svg+xml", sizes: "any" });

    // The icon's address is signed, so it loads without cookies; a changed signature doesn't.
    const icon = await call(`https://${ns}.${APP_DOMAIN}${m.icons[0]!.src}`);
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toBe("image/svg+xml");
    expect(icon.headers.get("content-security-policy")).toContain("sandbox");
    expect(await icon.text()).toBe(SVG);
    const forged = m.icons[0]!.src.replace(/[0-9a-f]$/, (d) => (d === "0" ? "1" : "0"));
    expect((await call(`https://${ns}.${APP_DOMAIN}${forged}`)).status).toBe(404);
    // ...and only on the app's own host.
    expect((await call(`https://other${ns}.${APP_DOMAIN}${m.icons[0]!.src}`)).status).toBe(404);
  });

  it("uses a big PNG icon as is, and adds it as the iPhone home screen icon; small ones get the letter tile", async () => {
    const ns = uniq();
    await publishZip(OWNER, ns, "big", { "index.html": `<!doctype html><head><link rel="icon" href="logo.png"></head><p>hi`, "logo.png": pngHeader(512, 512) }, { title: "Big" });
    const html = await (await call(`https://${ns}.${APP_DOMAIN}/big/`, { as: OWNER })).text();
    expect(html).toMatch(/<link rel="apple-touch-icon" href="\/_platform\/app-icon\/[^/]+\/[^/]+\/icon\/[0-9a-f]{32}">/);
    const big = await (await call(`https://${ns}.${APP_DOMAIN}/_platform/manifest.webmanifest?mount=big`, { as: OWNER })).json<{ icons: { src: string; type: string; sizes: string }[] }>();
    expect(big.icons[0]).toMatchObject({ type: "image/png", sizes: "512x512" });
    expect(big.icons[0]!.src).toContain("/icon/");

    await publishZip(OWNER, ns, "small", { "index.html": `<!doctype html><head><link rel="icon" href="fav.png"></head><p>hi`, "fav.png": pngHeader(32, 32) }, { title: "Small" });
    const small = await (await call(`https://${ns}.${APP_DOMAIN}/_platform/manifest.webmanifest?mount=small`, { as: OWNER })).json<{ icons: { src: string; type: string }[] }>();
    expect(small.icons[0]).toMatchObject({ type: "image/svg+xml" });
    expect(small.icons[0]!.src).toContain("/letter/");
    const letter = await call(`https://${ns}.${APP_DOMAIN}${small.icons[0]!.src}`);
    expect(await letter.text()).toContain(">S</text>");
  });

  it("shows how to install it on the app's page", async () => {
    const ns = uniq();
    const res = await publishHtml(OWNER, ns, "x", `<!doctype html><html><head></head><body>hi</body></html>`);
    const { site } = await res.json<{ site: { id: string } }>();
    const html = await (await call(`/app/apps/${site.id}`, { as: OWNER })).text();
    expect(html).toContain("Install on your devices");
    expect(html).toContain('href="/install"');
  });
});
