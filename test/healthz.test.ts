import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { appAt, OWNER, PAGE, publishHtml, uniq } from "./helpers";

describe("scaffold", () => {
  it("serves /healthz on Formelab's hosts and app hosts", async () => {
    for (const host of ["example.com", "app.example.com", "admin.example.com", "anything-x2k4.example.app"]) {
      const res = await exports.default.fetch(`https://${host}/healthz`);
      expect(res.status, host).toBe(200);
      expect(await res.text()).toBe("ok");
    }
  });

  it("moves the web app from APP_DOMAIN to app.DOMAIN, keeping path and query", async () => {
    const res = await exports.default.fetch(new Request("https://example.app/apps/s_x?y=1", { redirect: "manual" }));
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://app.example.com/apps/s_x?y=1");
  });

  it("moves old app addresses on DOMAIN to the app's own host, keeping path and query", async () => {
    const ns = uniq();
    await publishHtml(OWNER, ns, "tools", PAGE("t"));
    const res = await exports.default.fetch(new Request(`https://${ns}.example.com/tools/x?y=1`, { redirect: "manual" }));
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(`${await appAt(ns, "tools")}/x?y=1`);
    expect((await exports.default.fetch(new Request("https://nobody-here.example.com/", { redirect: "manual" }))).status).toBe(404);
  });

  it("keeps the connector on DOMAIN", async () => {
    const meta = await exports.default.fetch("https://example.com/.well-known/oauth-protected-resource/mcp");
    expect(meta.status).toBe(200);
    expect(((await meta.json()) as { resource: string }).resource).toBe("https://example.com/mcp");
    expect((await exports.default.fetch("https://app.example.com/.well-known/oauth-protected-resource/mcp", { redirect: "manual" })).status).not.toBe(200);
  });

  it("rejects unknown hosts", async () => {
    const res = await exports.default.fetch("https://other.test/healthz");
    expect(res.status).toBe(404);
  });
});
