import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "../src/secrets";
import type { Env } from "../src/env";
import { call, onOutbound, OWNER, PAGE, publishHtml, uniq } from "./helpers";

const E = env as unknown as Env;
const SECRET = "sk-live-0123456789abcdef";

async function newSite(opts: Record<string, string> = {}, mount = "app") {
  const ns = uniq();
  const res = await publishHtml(OWNER, ns, mount, PAGE("app"), opts);
  const { site } = await res.json<{ site: { id: string } }>();
  const origin = `https://${ns}.example.com`;
  const api = (path: string, init: Parameters<typeof call>[1] = {}) =>
    call(`${origin}/_api/${path}`, { as: OWNER, mount: `/${mount}/`, ...init });
  return { ns, id: site.id, origin, api };
}

afterEach(() => onOutbound(undefined));

describe("runtime API: me and kv", () => {
  it("me returns the viewer", async () => {
    const { api } = await newSite();
    expect(await (await api("me", { as: "Viewer@Example.com" })).json()).toEqual({ email: "viewer@example.com", name: null });
  });

  it("kv round-trips JSON, lists by prefix, and deletes", async () => {
    const { api } = await newSite();
    expect(await (await api("kv/settings", { method: "PUT", body: JSON.stringify({ theme: "dark" }) })).json()).toEqual({ ok: true });
    await api("kv/vote%3Aalice", { method: "PUT", body: "1" });
    await api("kv/vote%3Abob", { method: "PUT", body: "2" });
    await api("kv/a%2Fb%20c", { method: "PUT", body: '"slash"' });
    expect(await (await api("kv/settings")).json()).toEqual({ value: { theme: "dark" } });
    expect(await (await api("kv/a%2Fb%20c")).json()).toEqual({ value: "slash" });
    const list = await (await api("kv?prefix=vote%3A")).json<{ key: string; value: unknown; updatedAt: number }[]>();
    expect(list.map((x) => [x.key, x.value])).toEqual([["vote:alice", 1], ["vote:bob", 2]]);
    expect(list[0]!.updatedAt).toBeGreaterThan(0);
    expect((await (await api("kv")).json<unknown[]>()).length).toBe(4);
    await api("kv/settings", { method: "DELETE" });
    const missing = await api("kv/settings");
    expect(missing.status).toBe(404);
    expect((await missing.json<{ error: { hint: string } }>()).error.hint).toBeTruthy();
  });

  it("enforces kv limits", async () => {
    const { api, id } = await newSite();
    expect((await api("kv/" + "k".repeat(257), { method: "PUT", body: "1" })).status).toBe(400);
    expect((await api("kv/x", { method: "PUT", body: "{not json" })).status).toBe(400);
    expect((await api("kv/x", { method: "PUT", body: JSON.stringify("x".repeat(64 * 1024)) })).status).toBe(413);
    // Fill to the 1,000 key cap directly, then try one more through the API.
    const stmts = [];
    for (let i = 0; i < 1000; i++) stmts.push(E.DB.prepare("INSERT INTO kv (site_id, key, value, updated_at) VALUES (?, ?, '1', 0)").bind(id, `k${i}`));
    await E.DB.batch(stmts);
    const over = await api("kv/one-more", { method: "PUT", body: "1" });
    expect(over.status).toBe(409);
    // Overwriting an existing key is still allowed at the cap.
    expect((await api("kv/k1", { method: "PUT", body: "2" })).status).toBe(200);
  });
});

describe("security 4: namespace isolation", () => {
  it("an app can't reach another namespace's KV or secrets, even with a forged mount", async () => {
    const a = await newSite({}, "shared");
    const b = await newSite({}, "shared");
    await b.api("kv/private", { method: "PUT", body: '"b-data"' });
    await b.api("secrets/key", { method: "PUT", json: { value: SECRET } });

    // From A's origin, asking for the same mount path only ever finds A's site.
    expect((await a.api("kv/private")).status).toBe(404);
    expect(await (await a.api("secrets")).json()).toEqual([]);
    await a.api("kv/private", { method: "PUT", body: '"a-data"' });
    expect(await (await b.api("kv/private")).json()).toEqual({ value: "b-data" });

    // Forged mounts: another namespace's label, absolute URLs, traversal.
    for (const forged of [`/${b.ns}/shared/`, `https://${b.ns}.example.com/shared/`, "/../shared/", "/shared/../x/", "/SHARED/"]) {
      const res = await call(`${a.origin}/_api/kv/private`, { as: OWNER, mount: forged });
      expect([400, 404], forged).toContain(res.status);
    }
    // Mount pointing at a path with no site.
    expect((await call(`${a.origin}/_api/kv`, { as: OWNER, mount: "/nothing-here/" })).status).toBe(404);
  });

  it("requires the x-formelab-mount header", async () => {
    const { origin } = await newSite();
    expect((await call(`${origin}/_api/me`, { as: OWNER })).status).toBe(400);
  });
});

describe("security 10: cross-origin requests", () => {
  it("rejects cross-origin and preflight requests to /_api/*", async () => {
    const { origin, ns } = await newSite();
    for (const bad of ["https://evil.test", `https://other.example.com`, "null", `http://${ns}.example.com`]) {
      const res = await call(`${origin}/_api/kv/x`, { as: OWNER, mount: "/app/", method: "PUT", body: "1", headers: { origin: bad } });
      expect(res.status, bad).toBe(403);
    }
    const pre = await call(`${origin}/_api/kv/x`, { method: "OPTIONS", headers: { origin: "https://evil.test", "access-control-request-method": "PUT" }, as: OWNER });
    expect(pre.status).toBe(403);
    expect(pre.headers.get("access-control-allow-origin")).toBeNull();
    // Same-origin requests are fine.
    const ok = await call(`${origin}/_api/kv/x`, { as: OWNER, mount: "/app/", method: "PUT", body: "1", headers: { origin } });
    expect(ok.status).toBe(200);
  });
});

describe("secrets", () => {
  it("only owners and editors can set or delete; anyone allowed can list names", async () => {
    const { api } = await newSite({ editors: "ed@example.com" });
    expect((await api("secrets/key", { method: "PUT", json: { value: SECRET }, as: "viewer@example.com" })).status).toBe(403);
    expect((await api("secrets/key", { method: "PUT", json: { value: SECRET }, as: "ed@example.com" })).status).toBe(200);
    expect(await (await api("secrets", { as: "viewer@example.com" })).json()).toEqual(["key"]);
    expect((await api("secrets/key", { method: "DELETE", as: "viewer@example.com" })).status).toBe(403);
    expect((await api("secrets/key", { method: "DELETE" })).status).toBe(200);
    expect(await (await api("secrets")).json()).toEqual([]);
  });

  it("validates names, sizes and count", async () => {
    const { api, id } = await newSite();
    for (const name of ["UPPER", "has.dot", "x".repeat(65)]) {
      expect((await api(`secrets/${name}`, { method: "PUT", json: { value: "v" } })).status, name).toBe(400);
    }
    expect((await api("secrets/ok", { method: "PUT", json: { value: 42 } })).status).toBe(400);
    expect((await api("secrets/ok", { method: "PUT", json: { value: "x".repeat(8 * 1024) } })).status).toBe(413);
    const stmts = [];
    for (let i = 0; i < 50; i++) stmts.push(E.DB.prepare("INSERT INTO secrets (site_id, name, iv, ciphertext, updated_at) VALUES (?, ?, 'x', 'x', 0)").bind(id, `s${i}`));
    await E.DB.batch(stmts);
    expect((await api("secrets/fifty-one", { method: "PUT", json: { value: "v" } })).status).toBe(409);
  });
});

describe("security 5: secret values never leak", () => {
  it("stays out of responses, the database in plaintext, the audit log, and logs", async () => {
    const logs: string[] = [];
    const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
    for (const k of Object.keys(orig) as (keyof typeof orig)[]) console[k] = (...a: unknown[]) => logs.push(a.map(String).join(" "));
    try {
      const { api, id } = await newSite();
      const obj = { username: "svc-user", password: "pw-very-secret-123" };
      const r1 = await api("secrets/key", { method: "PUT", json: { value: SECRET } });
      const r2 = await api("secrets/basic", { method: "PUT", json: { value: obj } });
      const r3 = await api("secrets");
      // An echoing upstream (like httpbin) must not hand the key to the browser.
      let seen = "";
      onOutbound(async (req) => {
        seen = req.headers.get("authorization") ?? "";
        return Response.json({ headers: Object.fromEntries(req.headers), url: req.url });
      });
      const r4 = await api("secrets/key/proxy", { method: "POST", json: { url: "https://api.test/echo?k={{value}}", headers: { Authorization: "Bearer {{value}}" } } });
      expect(r4.status).toBe(200);
      expect(seen).toBe(`Bearer ${SECRET}`);
      const r5 = await api("secrets/basic/proxy", { method: "POST", json: { url: "https://api.test/echo", headers: { Authorization: "Basic {{basic}}", "X-Pw": "{{password}}" } } });
      // Errors don't echo the secret either.
      const r6 = await api("secrets/key/proxy", { method: "POST", json: { url: "https://127.0.0.1/?k={{value}}" } });
      expect(r6.status).toBe(400);
      const r7 = await api("secrets/key/proxy", { method: "POST", json: { url: "https://api.test/{{nope}}" } });
      expect(r7.status).toBe(400);

      const bodies = await Promise.all([r1, r2, r3, r4, r5, r6, r7].map((r) => r.text()));
      const basic = btoa("svc-user:pw-very-secret-123");
      for (const b of bodies) {
        expect(b).not.toContain(SECRET);
        expect(b).not.toContain("pw-very-secret-123");
        expect(b).not.toContain(basic);
      }
      expect(bodies[3]).toContain("[redacted]");

      const rows = await E.DB.prepare("SELECT * FROM secrets WHERE site_id = ?").bind(id).all();
      const audit = await E.DB.prepare("SELECT * FROM audit").all();
      for (const dump of [JSON.stringify(rows.results), JSON.stringify(audit.results), logs.join("\n")]) {
        expect(dump).not.toContain(SECRET);
        expect(dump).not.toContain("pw-very-secret-123");
        expect(dump).not.toContain(basic);
      }
    } finally {
      Object.assign(console, orig);
    }
  });
});

describe("security 6: ciphertext is bound to site and name", () => {
  it("decrypts only under the original site id and name", async () => {
    const { iv, ciphertext } = await encryptSecret(E, "s_one", "api_key", '"hello"');
    expect(await decryptSecret(E, "s_one", "api_key", iv, ciphertext)).toBe('"hello"');
    await expect(decryptSecret(E, "s_two", "api_key", iv, ciphertext)).rejects.toThrow();
    await expect(decryptSecret(E, "s_one", "other", iv, ciphertext)).rejects.toThrow();
  });

  it("a ciphertext copied to another site or name row is unusable", async () => {
    const a = await newSite();
    const b = await newSite();
    await a.api("secrets/key", { method: "PUT", json: { value: SECRET } });
    await b.api("secrets/key", { method: "PUT", json: { value: "b-secret-value" } });
    const rowA = (await E.DB.prepare("SELECT iv, ciphertext FROM secrets WHERE site_id = ? AND name = 'key'").bind(a.id).first<{ iv: string; ciphertext: string }>())!;
    // Swap A's ciphertext into B's row, and into a differently named row on A.
    await E.DB.prepare("UPDATE secrets SET iv = ?, ciphertext = ? WHERE site_id = ? AND name = 'key'").bind(rowA.iv, rowA.ciphertext, b.id).run();
    await E.DB.prepare("INSERT INTO secrets (site_id, name, iv, ciphertext, updated_at) VALUES (?, 'renamed', ?, ?, 0)").bind(a.id, rowA.iv, rowA.ciphertext).run();
    let called = false;
    onOutbound(() => {
      called = true;
      return new Response("ok");
    });
    const r1 = await b.api("secrets/key/proxy", { method: "POST", json: { url: "https://api.test/{{value}}" } });
    const r2 = await a.api("secrets/renamed/proxy", { method: "POST", json: { url: "https://api.test/{{value}}" } });
    for (const r of [r1, r2]) {
      expect(r.status).toBe(500);
      expect((await r.json<{ error: { code: string } }>()).error.code).toBe("secret_unreadable");
    }
    expect(called).toBe(false);
  });

  it("uses a fresh IV for every write", async () => {
    const ivs = new Set<string>();
    for (let i = 0; i < 5; i++) ivs.add((await encryptSecret(E, "s", "n", "x")).iv);
    expect(ivs.size).toBe(5);
  });
});

describe("secret proxy", () => {
  let site: Awaited<ReturnType<typeof newSite>>;
  beforeAll(async () => {
    site = await newSite();
    await site.api("secrets/str", { method: "PUT", json: { value: "plainkey" } });
    await site.api("secrets/obj", { method: "PUT", json: { value: { public: "pk_123", secret: "sk_456", region: "eu" } } });
  });

  it("fills placeholders in url, headers and body", async () => {
    let got: { url: string; method: string; headers: Record<string, string>; body: string } | null = null;
    onOutbound(async (req) => {
      got = { url: req.url, method: req.method, headers: Object.fromEntries(req.headers), body: await req.text() };
      return new Response("created", { status: 201, headers: { "content-type": "text/plain", "set-cookie": "a=b" } });
    });
    const res = await site.api("secrets/obj/proxy", {
      method: "POST",
      json: {
        url: "https://api.test/{{region}}/items",
        method: "post",
        headers: { Authorization: "Basic {{basic}}", "X-Key": "{{ secret }}", Cookie: "steal=1" },
        body: JSON.stringify({ pk: "{{public}}" }),
      },
    });
    expect(res.status).toBe(200);
    const out = await res.json<Record<string, unknown>>();
    expect(out).toEqual({ status: 201, contentType: "text/plain", text: "created", truncated: false });
    expect(got!.url).toBe("https://api.test/eu/items");
    expect(got!.method).toBe("POST");
    expect(got!.headers.authorization).toBe("Basic " + btoa("pk_123:sk_456"));
    expect(got!.headers["x-key"]).toBe("sk_456");
    expect(got!.headers.cookie).toBeUndefined();
    expect(got!.body).toBe('{"pk":"pk_123"}');
  });

  it("rejects unknown placeholders instead of leaving them empty", async () => {
    let called = false;
    onOutbound(() => ((called = true), new Response("")));
    const res = await site.api("secrets/str/proxy", { method: "POST", json: { url: "https://api.test/?k={{key}}" } });
    expect(res.status).toBe(400);
    const { error } = await res.json<{ error: { message: string; hint: string } }>();
    expect(error.message).toContain("{{key}}");
    expect(error.hint).toContain("{{value}}");
    expect(called).toBe(false);
  });

  it("does not follow redirects", async () => {
    onOutbound(() => new Response(null, { status: 302, headers: { location: "https://169.254.169.254/" } }));
    const out = await (await site.api("secrets/str/proxy", { method: "POST", json: { url: "https://api.test/r" } })).json<{ status: number; location: string }>();
    expect(out.status).toBe(302);
    expect(out.location).toBe("https://169.254.169.254/");
  });

  it("blocks SSRF targets after substitution", async () => {
    await site.api("secrets/host", { method: "PUT", json: { value: "127.0.0.1" } });
    const res = await site.api("secrets/host/proxy", { method: "POST", json: { url: "https://{{value}}/admin" } });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe("url_blocked");
  });

  it("validates method and body", async () => {
    onOutbound(() => new Response("x"));
    const p = (json: unknown) => site.api("secrets/str/proxy", { method: "POST", json });
    expect((await p({ url: "https://api.test/", method: "TRACE" })).status).toBe(400);
    expect((await p({ url: "https://api.test/", method: "GET", body: "x" })).status).toBe(400);
    expect((await p({ url: "https://api.test/", method: "POST", body: { obj: 1 } })).status).toBe(400);
    expect((await p({ url: "https://api.test/", method: "POST", body: "x".repeat(1024 * 1024 + 1) })).status).toBe(413);
    expect((await p({})).status).toBe(400);
    expect((await p({ url: "https://api.test/", headers: ["x"] })).status).toBe(400);
  });

  it("truncates responses over 5 MB", async () => {
    onOutbound(() => new Response("a".repeat(5 * 1024 * 1024 + 10)));
    const out = await (await site.api("secrets/str/proxy", { method: "POST", json: { url: "https://api.test/big" } })).json<{ text: string; truncated: boolean }>();
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBe(5 * 1024 * 1024);
  });

  it("writes an audit row with site, secret, host, status and viewer, but not the URL", async () => {
    onOutbound(() => new Response(null, { status: 204 }));
    await site.api("secrets/str/proxy", { method: "POST", json: { url: "https://api.test/path?k={{value}}" }, as: "viewer@example.com" });
    const row = await E.DB.prepare("SELECT * FROM audit WHERE action = 'proxy' AND actor = 'viewer@example.com' ORDER BY id DESC").first<{ detail: string; target: string }>();
    expect(JSON.parse(row!.detail)).toEqual({ siteId: site.id, secret: "str", host: "api.test", status: 204 });
    expect(row!.target).toBe(`${site.ns}/app`);
    expect(row!.detail).not.toContain("path");
  });

  it("rate-limits to 60 calls per minute per site", async () => {
    const s = await newSite();
    await s.api("secrets/k", { method: "PUT", json: { value: "v" } });
    onOutbound(() => new Response("ok"));
    const statuses: number[] = [];
    for (let i = 0; i < 62; i++) statuses.push((await s.api("secrets/k/proxy", { method: "POST", json: { url: "https://api.test/" } })).status);
    expect(statuses.slice(0, 60).every((x) => x === 200)).toBe(true);
    expect(statuses.slice(60)).toEqual([429, 429]);
    // Another site has its own budget.
    const other = await newSite();
    await other.api("secrets/k", { method: "PUT", json: { value: "v" } });
    expect((await other.api("secrets/k/proxy", { method: "POST", json: { url: "https://api.test/" } })).status).toBe(200);
  });
});
