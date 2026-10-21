import { describe, expect, it } from "vitest";
import { safeReturn } from "../src/login";

describe("return paths after signing in (open redirects)", () => {
  it("keeps paths on this site", () => {
    expect(safeReturn("/app/shared?x=1#top")).toBe("/app/shared?x=1#top");
    expect(safeReturn("/a/../b", "/")).toBe("/b");
    expect(safeReturn("/%2F%2Fevil.test", "/")).toBe("/%2F%2Fevil.test"); // encoded: still a path here
  });

  it("refuses anything a browser would read as another site", () => {
    for (const bad of [
      "//evil.test",
      "/\\evil.test",
      "/\\\\evil.test",
      "/\t/evil.test",
      "/\n/evil.test",
      "/\r\n/evil.test",
      "https://evil.test/",
      "javascript:alert(1)",
      "evil.test",
      "",
      null,
      undefined,
    ]) {
      expect(safeReturn(bad, "/fallback"), JSON.stringify(bad)).toBe("/fallback");
    }
  });
});
