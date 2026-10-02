import { describe, expect, it } from "vitest";
import { call, OWNER, PAGE, publishHtml, uniq } from "./helpers";

describe("dashboard", () => {
  it("renders with a strict CSP and no inline script", async () => {
    const res = await call("/", { as: OWNER });
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
    const html = await res.text();
    expect(html).toContain(`Signed in as <strong>${OWNER}</strong>`);
    expect(html).toContain('<script src="/_platform/dashboard.js" defer></script>');
    expect(html).not.toMatch(/<script>(?!<\/script>)/);
    expect(html).not.toMatch(/\son[a-z]+=/i); // no inline event handlers
    expect(html).toContain("claude mcp add --transport http launchpad https://example.com/mcp");
    expect((await call("/_platform/dashboard.js", { as: OWNER })).headers.get("content-type")).toContain("javascript");
    expect((await call("/_platform/dashboard.css", { as: OWNER })).headers.get("content-type")).toContain("text/css");
  });

  it("security 11: escapes user-supplied strings", async () => {
    const ns = uniq();
    const evil = `<script>alert("x")</script><img src=x onerror=alert(1)>`;
    const res = await publishHtml(OWNER, ns, "xss", PAGE("x"), { title: evil });
    expect(res.status).toBe(201);
    await call("/_api/admin/tokens", { as: OWNER, method: "POST", json: { name: `<script>tok()</script>` } });
    const html = await (await call("/", { as: OWNER })).text();
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<script>tok()");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;script&gt;tok()&lt;/script&gt;");
  });

  it("shows sites, namespaces, tokens and recent activity", async () => {
    const ns = uniq();
    await publishHtml(OWNER, ns, "listed", PAGE("x"), { title: "Listed app" });
    await call("/_api/admin/tokens", { as: OWNER, method: "POST", json: { name: "laptop-token" } });
    const html = await (await call("/", { as: OWNER })).text();
    expect(html).toContain(`https://${ns}.example.com/listed/`);
    expect(html).toContain("Listed app");
    expect(html).toContain(`>${ns}</a>`);
    expect(html).toContain("laptop-token");
    expect(html).toContain(`${ns}/listed`); // audit row target
  });

  it("does not show other people's sites or activity", async () => {
    const ns = uniq();
    await publishHtml(OWNER, ns, "mine", PAGE("x"), { title: "Owner only title" });
    const html = await (await call("/", { as: "someone-else@example.com" })).text();
    expect(html).not.toContain("Owner only title");
    expect(html).not.toContain(ns);
  });

  it("serves the guide on the apex and namespace hosts", async () => {
    for (const url of ["https://example.com/_platform/guide.md", `https://${uniq()}.example.com/_platform/guide.md`]) {
      const res = await call(url, { as: OWNER });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/markdown");
      expect(await res.text()).toContain("## 7. Agent checklist");
    }
  });

  it("serves the SDK under 5 KB, defining launchpad and archie", async () => {
    const res = await call(`https://${uniq()}.example.com/_platform/sdk.js`, { as: OWNER });
    const js = await res.text();
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(new TextEncoder().encode(js).length).toBeLessThan(5 * 1024);
    expect(js).toContain("window.launchpad = launchpad");
    expect(js).toContain("window.archie = launchpad");
  });
});
