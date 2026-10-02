import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("scaffold", () => {
  it("serves /healthz on apex and namespace hosts", async () => {
    for (const host of ["example.com", "anything.example.com"]) {
      const res = await exports.default.fetch(`https://${host}/healthz`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok");
    }
  });

  it("rejects unknown hosts", async () => {
    const res = await exports.default.fetch("https://other.test/healthz");
    expect(res.status).toBe(404);
  });
});
