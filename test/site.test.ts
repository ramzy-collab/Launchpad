import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { call, OWNER } from "./helpers";

const join = (email: unknown, headers: Record<string, string> = {}) =>
  call("/_api/waitlist", { method: "POST", json: { email }, headers: { "cf-connecting-ip": "203.0.113.7", ...headers } });

describe("home page and login", () => {
  it("serves the home page publicly, with a strict CSP and no inline script", async () => {
    const res = await call("/");
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
    const html = await res.text();
    expect(html).toContain("is <span class=\"dead\">dead.</span>");
    expect(html).toContain('id="wait-form"');
    expect(html).toContain('href="/login"');
    expect(html).toContain("Built with Formelab");
    expect(html).toContain('href="/_assets/home.css"');
    expect(html).not.toMatch(/<script>(?!<\/script>)/);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toMatch(/\sstyle=/i);
  });

  it("sends someone already signed in to their dashboard", async () => {
    const res = await call("/", { as: OWNER });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/app");
  });

  it("serves the login screen publicly, pointing at the dashboard", async () => {
    const res = await call("/login");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Welcome back");
    expect(html).toContain('href="/app"');
  });

  it("serves the shared assets without sign-in", async () => {
    for (const [path, type] of [
      ["/_assets/formelab.css", "text/css"],
      ["/_assets/home.css", "text/css"],
      ["/_assets/theme.js", "javascript"],
      ["/_assets/site.js", "javascript"],
    ]) {
      const res = await call(path!);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type"), path).toContain(type);
    }
  });
});

describe("waitlist", () => {
  it("stores a normalized email once, answering the same both times", async () => {
    const email = `Wait-${Date.now()}@Example.com`;
    const first = await join(email);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true });
    expect((await join(email.toLowerCase())).status).toBe(200);
    const rows = await env.DB.prepare("SELECT email FROM waitlist WHERE email = ?").bind(email.toLowerCase()).all();
    expect(rows.results).toHaveLength(1);
  });

  it("rejects invalid emails and non-JSON bodies", async () => {
    for (const bad of ["", "nope", "a@b", 42, null, "x".repeat(250) + "@example.com"]) {
      const res = await join(bad);
      expect(res.status, String(bad)).toBe(400);
      expect((await res.json<{ error: { hint: string } }>()).error.hint).toBeTruthy();
    }
    const form = await call("/_api/waitlist", { method: "POST", body: "email=a@example.com", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(form.status).toBe(400);
  });

  it("rejects cross-origin posts", async () => {
    expect((await join("x@example.com", { origin: "https://evil.test" })).status).toBe(403);
    expect((await join("y@example.com", { origin: "https://example.com" })).status).toBe(200);
  });

  it("rate limits sign-ups per address", async () => {
    const ip = `198.51.100.${Math.floor(Math.random() * 250)}`;
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await join(`rl${i}-${Date.now()}@example.com`, { "cf-connecting-ip": ip })).status);
    expect(statuses).toContain(429);
  });

  it("shows sign-ups to admins only", async () => {
    const email = `seen-${Date.now()}@example.com`;
    await join(email);
    const admin = await (await call("/app", { as: OWNER })).text();
    expect(admin).toContain("Waitlist");
    expect(admin).toContain(email);
    const other = await (await call("/app", { as: "someone-else@example.com" })).text();
    expect(other).not.toContain(email);
  });
});
