import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("scaffold", () => {
  it("serves /healthz on apex and namespace hosts", async () => {
    for (const host of ["example.com", "anything.example.app", "example.app", "admin.example.com"]) {
      const res = await exports.default.fetch(`https://${host}/healthz`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok");
    }
  });

  it("moves old app addresses on DOMAIN to APP_DOMAIN, keeping path and query", async () => {
    const res = await exports.default.fetch(new Request("https://planner.example.com/tools/x?y=1", { redirect: "manual" }));
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://planner.example.app/tools/x?y=1");
  });

  it("keeps the connector on DOMAIN", async () => {
    const meta = await exports.default.fetch("https://example.com/.well-known/oauth-protected-resource/mcp");
    expect(meta.status).toBe(200);
    expect(((await meta.json()) as { resource: string }).resource).toBe("https://example.com/mcp");
    expect((await exports.default.fetch("https://example.app/.well-known/oauth-protected-resource/mcp", { redirect: "manual" })).status).not.toBe(200);
  });

  it("rejects unknown hosts", async () => {
    const res = await exports.default.fetch("https://other.test/healthz");
    expect(res.status).toBe(404);
  });
});
