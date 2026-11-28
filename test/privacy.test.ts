import { describe, expect, it } from "vitest";
import { call } from "./helpers";

describe("the privacy page", () => {
  it("is public, on Formelab's own domain, and linked from the home page", async () => {
    const res = await call("/privacy");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<title>Privacy · Formelab</title>");
    expect(html).toContain("<h1>Privacy</h1>");
    for (const part of ["What we keep about you", "People who use apps built on Formelab", "Who else handles it", "Google user data", "Cookies", "Keeping and deleting", "Contact"]) {
      expect(html, part).toContain(`<h2>${part}</h2>`);
    }
    expect(html).toContain("Limited Use requirements");
    expect(html).not.toContain("—"); // no em dashes in UI copy
    expect(await (await call("/")).text()).toContain('<a href="/privacy">Privacy</a>');
  });
});
