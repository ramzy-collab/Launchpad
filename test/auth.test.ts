import { env } from "cloudflare:workers";
import { generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { identifyHuman, mintToken, upsertUser } from "../src/auth";
import type { Env } from "../src/env";
import { accessJwt, call, OWNER, publishHtml, PAGE, uniq } from "./helpers";

const NOW = () => Date.now();

describe("security 1: Access JWT required", () => {
  it("rejects requests with no JWT on every protected surface", async () => {
    const ns = uniq();
    expect((await publishHtml(OWNER, ns, "", PAGE("hi"))).status).toBe(201);
    const urls = [
      "https://example.com/_api/admin/whoami",
      "https://example.com/_platform/guide.md",
      "https://example.com/_api/admin/sites",
      `https://${ns}.example.com/`,
      `https://${ns}.example.com/index.html`,
      `https://${ns}.example.com/_api/me`,
      `https://${ns}.example.com/_api/kv`,
      `https://${ns}.example.com/_platform/sdk.js`,
    ];
    for (const u of urls) {
      const res = await call(u, { mount: "/" });
      expect(res.status, u).toBe(401);
      expect(await res.text(), u).not.toContain("hi</body>");
    }
    // The dashboard sends visitors without a JWT to the public login screen.
    const dash = await call("/app");
    expect(dash.status).toBe(302);
    expect(dash.headers.get("location")).toBe("/login");
  });

  it("never trusts Cf-Access-Authenticated-User-Email on its own", async () => {
    const res = await call("/_api/admin/whoami", { headers: { "cf-access-authenticated-user-email": OWNER } });
    expect(res.status).toBe(401);
  });

  it("rejects JWTs with the wrong audience, issuer, signature or expiry", async () => {
    const other = await generateKeyPair("RS256");
    const bad = [
      await accessJwt(OWNER, { aud: "someone-else" }),
      await accessJwt(OWNER, { iss: "https://evil.cloudflareaccess.com" }),
      await accessJwt(OWNER, { expSecondsFromNow: -60 }),
      await accessJwt(OWNER, { key: other.privateKey }),
      "not-a-jwt",
    ];
    for (const jwt of bad) {
      const res = await call("/_api/admin/whoami", { headers: { "cf-access-jwt-assertion": jwt } });
      expect(res.status).toBe(401);
      const body = await res.json<{ error: { code: string; hint: string } }>();
      expect(body.error.code).toBe("unauthorized");
      expect(body.error.hint).toBeTruthy();
    }
  });

  it("accepts a valid JWT and creates the user, with is_admin only for OWNER_EMAIL", async () => {
    const res = await call("/_api/admin/whoami", { as: "Someone@Example.com" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: "someone@example.com", name: null, isAdmin: false });
    const owner = await (await call("/_api/admin/whoami", { as: OWNER })).json<{ isAdmin: boolean }>();
    expect(owner.isAdmin).toBe(true);
    const row = await env.DB.prepare("SELECT is_admin FROM users WHERE email = ?").bind("someone@example.com").first();
    expect(row).toEqual({ is_admin: 0 });
  });

  it("bypassed paths need a bearer token, not a JWT", async () => {
    expect((await call("/_api/deploy/whoami", { as: OWNER })).status).toBe(401);
    expect((await call("/mcp", { as: OWNER, method: "POST", json: {} })).status).toBe(401);
  });
});

describe("security 2: dev auth bypass", () => {
  const base = env as unknown as Env;
  const req = () => new Request("https://example.com/");

  it("uses DEV_USER only when ENVIRONMENT is exactly 'dev'", async () => {
    const dev = { ...base, ENVIRONMENT: "dev", DEV_USER: "dev@example.com" };
    expect((await identifyHuman(req(), dev))?.email).toBe("dev@example.com");
    for (const environment of ["production", "test", "Dev", "DEV", "development", "", "dev "]) {
      const e = { ...base, ENVIRONMENT: environment, DEV_USER: "dev@example.com" };
      expect(await identifyHuman(req(), e), environment).toBeNull();
    }
  });

  it("the deployed worker (ENVIRONMENT=test here) ignores DEV_USER entirely", async () => {
    expect(base.ENVIRONMENT).not.toBe("dev");
    expect((await call("/_api/admin/whoami")).status).toBe(401);
  });
});

describe("security 9: deploy tokens", () => {
  it("stores only a sha256 hash and authenticates with the plaintext", async () => {
    const res = await call("/_api/admin/tokens", { as: OWNER, method: "POST", json: { name: "ci", ttlHours: 2 } });
    expect(res.status).toBe(201);
    const { token, id } = await res.json<{ token: string; id: string }>();
    expect(token).toMatch(/^fl_[a-z2-7]{52}$/);
    const row = await env.DB.prepare("SELECT * FROM tokens WHERE id = ?").bind(id).first<Record<string, unknown>>();
    expect(JSON.stringify(row)).not.toContain(token);
    expect(JSON.stringify(row)).not.toContain(token.slice(3));
    expect(row!.hash).toMatch(/^[0-9a-f]{64}$/);

    const who = await call("/_api/deploy/whoami", { token });
    expect(who.status).toBe(200);
    expect((await who.json<{ email: string }>()).email).toBe(OWNER);
    const used = await env.DB.prepare("SELECT last_used FROM tokens WHERE id = ?").bind(id).first<{ last_used: number }>();
    expect(used!.last_used).toBeGreaterThan(0);

    // Listing never returns the token or its hash.
    const list = await (await call("/_api/admin/tokens", { as: OWNER })).text();
    expect(list).not.toContain(token);
    expect(list).not.toContain(row!.hash as string);
  });

  it("returns 401 for revoked tokens", async () => {
    const { token, id } = await (await call("/_api/admin/tokens", { as: OWNER, method: "POST", json: { name: "x" } })).json<{ token: string; id: string }>();
    expect((await call("/_api/deploy/whoami", { token })).status).toBe(200);
    expect((await call(`/_api/admin/tokens/${id}`, { as: OWNER, method: "DELETE" })).status).toBe(200);
    expect((await call("/_api/deploy/whoami", { token })).status).toBe(401);
  });

  it("returns 401 for expired tokens", async () => {
    const user = await upsertUser(env as unknown as Env, "exp@example.com", null);
    const { token, info } = await mintToken(env as unknown as Env, user, "short", 1);
    await env.DB.prepare("UPDATE tokens SET expires_at = ? WHERE id = ?").bind(NOW() - 1, info.id).run();
    expect((await call("/_api/deploy/whoami", { token })).status).toBe(401);
  });

  it("returns 401 for unknown or malformed tokens", async () => {
    for (const t of ["fl_" + "a".repeat(52), "nope", "fl_UPPERCASE"]) {
      expect((await call("/_api/deploy/whoami", { token: t })).status).toBe(401);
    }
  });

  it("enforces the 1 hour – 30 day lifetime", async () => {
    for (const ttlHours of [0, 0.5, 721, -1, "abc"]) {
      const res = await call("/_api/admin/tokens", { as: OWNER, method: "POST", json: { name: "x", ttlHours } });
      expect(res.status).toBe(400);
    }
    const ok = await (await call("/_api/admin/tokens", { as: OWNER, method: "POST", json: { name: "x" } })).json<{ expiresAt: number; createdAt: number }>();
    expect(ok.expiresAt - ok.createdAt).toBe(24 * 3600_000);
  });

  it("tokens cannot mint more tokens", async () => {
    const { token } = await (await call("/_api/admin/tokens", { as: OWNER, method: "POST", json: { name: "x" } })).json<{ token: string }>();
    const res = await call("/_api/deploy/tokens", { token, method: "POST", json: { name: "y", ttlHours: 720 } });
    expect(res.status).toBe(403);
  });

  it("a token can only revoke its owner's tokens", async () => {
    const { id } = await (await call("/_api/admin/tokens", { as: OWNER, method: "POST", json: { name: "x" } })).json<{ id: string }>();
    expect((await call(`/_api/admin/tokens/${id}`, { as: "mallory@example.com", method: "DELETE" })).status).toBe(404);
  });
});

describe("admin API CSRF", () => {
  it("rejects cross-origin and header-less writes", async () => {
    const jwt = await accessJwt(OWNER);
    const res1 = await call("https://example.com/_api/admin/namespaces", {
      method: "POST",
      headers: { "cf-access-jwt-assertion": jwt, origin: "https://evil.test", "x-formelab-request": "1", "content-type": "application/json" },
      body: JSON.stringify({ label: uniq() }),
    });
    expect(res1.status).toBe(403);
    const res2 = await call("https://example.com/_api/admin/namespaces", {
      method: "POST",
      headers: { "cf-access-jwt-assertion": jwt, "content-type": "application/json" },
      body: JSON.stringify({ label: uniq() }),
      csrf: false,
    });
    expect(res2.status).toBe(403);
  });
});
