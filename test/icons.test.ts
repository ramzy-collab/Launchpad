import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { findIcon } from "../src/icons";
import { call, OWNER, PAGE, publishHtml, publishZip, uniq } from "./helpers";

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5"/></svg>`;

describe("finding an app's icon", () => {
  it("prefers what index.html links, then well-known files", () => {
    const files = ["index.html", "img/icon.svg", "favicon.ico", "apple.png"];
    expect(findIcon(files, `<link rel="icon" href="img/icon.svg">`, "")).toBe("img/icon.svg");
    expect(findIcon(files, `<link rel="icon" href="./img/icon.svg?v=2"><link rel="apple-touch-icon" href="apple.png">`, "")).toBe("apple.png");
    expect(findIcon(files, `<link rel="icon" href="/tools/img/icon.svg">`, "tools")).toBe("img/icon.svg"); // absolute, under the app's path
    expect(findIcon(files, `<link rel="shortcut icon" href="https://cdn.example.com/i.png">`, "")).toBe("favicon.ico"); // external: ignored
    expect(findIcon(files, `<link rel="icon" href="../secret.png">`, "")).toBe("favicon.ico");
    expect(findIcon(files, `<link rel="stylesheet" href="img/icon.svg">`, "")).toBe("favicon.ico");
    expect(findIcon(["index.html", "app.js"], "<title>x</title>", "")).toBe("");
    const data = "data:image/svg+xml,%3Csvg%3E%3C/svg%3E";
    expect(findIcon(["index.html"], `<link rel=icon href="${data}">`, "")).toBe(data);
  });
});

describe("app icons on the web app", () => {
  it("shows the app's favicon on its tile, only to people who can open the app", async () => {
    const ns = uniq();
    const res = await publishZip(OWNER, ns, "iconic", { "index.html": `<!doctype html><link rel="icon" href="icon.svg"><p>hi`, "icon.svg": SVG }, { title: "Iconic" });
    expect(res.status).toBe(201);
    const { site } = await res.json<{ site: { id: string; iconUrl: string } }>();
    expect(site.iconUrl).toMatch(new RegExp(`^/apps/${site.id}/icon\\?v=`));
    const html = await (await call("/app", { as: OWNER })).text();
    expect(html).toContain(`<img src="${site.iconUrl}" alt=""`);

    const icon = await call(`/app${site.iconUrl}`, { as: OWNER });
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toBe("image/svg+xml");
    expect(icon.headers.get("content-security-policy")).toContain("sandbox"); // an SVG opened directly can't run script
    expect(await icon.text()).toBe(SVG);
    expect((await call(`/app${site.iconUrl}`, { as: `stranger-${uniq()}@example.com` })).status).toBe(404);
  });

  it("falls back to the letter when there's no icon, and finds icons of older apps on first use", async () => {
    const ns = uniq();
    const plain = await (await publishHtml(OWNER, ns, "plain", PAGE("x"), { title: "Plain" })).json<{ site: { id: string; iconUrl: string | null } }>();
    expect(plain.site.iconUrl).toBeNull();
    const html = await (await call("/app", { as: OWNER })).text();
    expect(html).not.toContain(`/apps/${plain.site.id}/icon`);

    // An app published before icons existed (icon_path NULL) gets looked at when its icon is asked for.
    const old = await (await publishZip(OWNER, ns, "old", { "index.html": "<p>old", "favicon.png": new Uint8Array([137, 80, 78, 71]) })).json<{ site: { id: string } }>();
    await env.DB.prepare("UPDATE sites SET icon_path = NULL WHERE id = ?").bind(old.site.id).run();
    // Until then its tile shows the letter, and listing the apps looks for its icon in the background.
    expect(await (await call("/app", { as: OWNER })).text()).not.toContain(`/apps/${old.site.id}/icon`);
    for (let i = 0; i < 40; i++) {
      const row = await env.DB.prepare("SELECT icon_path FROM sites WHERE id = ?").bind(old.site.id).first<{ icon_path: string | null }>();
      if (row?.icon_path !== null) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(await (await call("/app", { as: OWNER })).text()).toContain(`/apps/${old.site.id}/icon`);
    await env.DB.prepare("UPDATE sites SET icon_path = NULL WHERE id = ?").bind(old.site.id).run();
    const icon = await call(`/app/apps/${old.site.id}/icon`, { as: OWNER });
    expect(icon.headers.get("content-type")).toBe("image/png");
    expect((await env.DB.prepare("SELECT icon_path FROM sites WHERE id = ?").bind(old.site.id).first<{ icon_path: string }>())!.icon_path).toBe("favicon.png");

    // And one with nothing gets a letter tile.
    await env.DB.prepare("UPDATE sites SET icon_path = NULL WHERE id = ?").bind(plain.site.id).run();
    const letter = await call(`/app/apps/${plain.site.id}/icon`, { as: OWNER });
    expect(letter.headers.get("content-type")).toBe("image/svg+xml");
    expect(await letter.text()).toContain(">P</text>");
  });
});
