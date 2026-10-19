import { beforeAll, describe, expect, it } from "vitest";
import { appAt, call, OWNER, PAGE, publishHtml, uniq } from "./helpers";

type View = { id: string; publicUrl: string | null; guestResponses: boolean };
type Listed = { total: number; responses: { id: string; at: number; email: string | null; data: unknown }[]; next: string | null };

const setFlag = (state: string) => call("/_api/admin/features/responses", { as: OWNER, method: "PUT", json: { state } });

async function newSite(extra: Record<string, string> = {}) {
  const ns = uniq();
  const res = await publishHtml(OWNER, ns, "form", PAGE("rsvp"), extra);
  const { site } = await res.json<{ site: View }>();
  const origin = await appAt(ns, "form");
  const patch = (json: unknown, as = OWNER) => call(`/_api/admin/sites/${site.id}`, { as, method: "PATCH", json });
  const api = (path: string, init: Parameters<typeof call>[1] = {}) => call(`${origin}/_api/${path}`, { mount: "/", ...init });
  return { ns, site, origin, patch, api };
}

/** A guest's cookie from the app's public link (turned on here). */
async function guestCookie(patch: (json: unknown) => Promise<Response>): Promise<string> {
  const { publicUrl } = await (await patch({ public_link: true })).json<View>();
  return (await call(publicUrl!)).headers.get("set-cookie")!.split(";")[0]!;
}

describe("responses", () => {
  beforeAll(async () => {
    expect((await setFlag("on")).status).toBe(200);
  });

  it("are sent by anyone who can open the app and read only by its owner and editors", async () => {
    const { api } = await newSite({ allowed_emails: "friend@example.com", editors: "ed@example.com" });
    const sent = await api("responses", { as: "friend@example.com", method: "POST", body: JSON.stringify({ name: "Ana", coming: true }) });
    expect(sent.status).toBe(201);
    expect((await sent.json<{ id: string }>()).id).toMatch(/^r_[a-z2-7]{20}$/);
    await api("responses", { as: OWNER, method: "POST", body: '"just a string"' });

    // The sender can't read them back.
    expect((await api("responses", { as: "friend@example.com" })).status).toBe(403);

    for (const who of [OWNER, "ed@example.com"]) {
      const list = await (await api("responses", { as: who })).json<Listed>();
      expect(list.total).toBe(2);
      expect(list.responses.map((r) => r.data)).toEqual(["just a string", { name: "Ana", coming: true }]);
      expect(list.responses[1]!.email).toBe("friend@example.com");
    }

    const [newest] = (await (await api("responses", { as: OWNER })).json<Listed>()).responses;
    expect((await api(`responses/${newest!.id}`, { as: "friend@example.com", method: "DELETE" })).status).toBe(403);
    expect((await api(`responses/${newest!.id}`, { as: OWNER, method: "DELETE" })).status).toBe(200);
    expect((await api(`responses/${newest!.id}`, { as: OWNER, method: "DELETE" })).status).toBe(404);
    expect((await (await api("responses", { as: OWNER })).json<Listed>()).total).toBe(1);
  });

  it("refuse bad or oversized bodies, and page with limit and before", async () => {
    const { api } = await newSite();
    expect((await api("responses", { as: OWNER, method: "POST", body: "{not json" })).status).toBe(400);
    expect((await api("responses", { as: OWNER, method: "POST", body: "null" })).status).toBe(400);
    const big = await api("responses", { as: OWNER, method: "POST", body: JSON.stringify({ a: "x".repeat(17 * 1024) }) });
    expect(big.status).toBe(413);

    for (let i = 0; i < 3; i++) await api("responses", { as: OWNER, method: "POST", body: JSON.stringify({ i }) });
    const first = await (await api("responses?limit=2", { as: OWNER })).json<Listed>();
    expect(first.responses.map((r) => r.data)).toEqual([{ i: 2 }, { i: 1 }]);
    expect(first.next).toBe(first.responses[1]!.id);
    const rest = await (await api(`responses?limit=2&before=${first.next}`, { as: OWNER })).json<Listed>();
    expect(rest.responses.map((r) => r.data)).toEqual([{ i: 0 }]);
    expect(rest.next).toBeNull();
    expect((await api("responses?before=nope", { as: OWNER })).status).toBe(400);
  });

  it("come from public-link guests only when the owner allows it, and stay unreadable to them", async () => {
    const { site, patch, api } = await newSite();
    expect(site.guestResponses).toBe(false);
    const cookie = await guestCookie(patch);
    const guest = (path: string, init: Parameters<typeof call>[1] = {}) => api(path, { ...init, headers: { cookie } });

    const refused = await guest("responses", { method: "POST", body: '{"name":"Bo"}' });
    expect(refused.status).toBe(401);
    expect((await refused.json<{ error: { code: string } }>()).error.code).toBe("sign_in_required");

    expect((await (await patch({ guest_responses: true })).json<View>()).guestResponses).toBe(true);
    expect((await guest("responses", { method: "POST", body: '{"name":"Bo"}', headers: { cookie, "cf-connecting-ip": "203.0.113.9" } })).status).toBe(201);
    // Still nothing else: not the list, not deleting, not shared KV.
    expect((await guest("responses")).status).toBe(401);
    expect((await guest("responses/r_aaaaaaaaaaaaaaaaaaaa", { method: "DELETE" })).status).toBe(401);
    expect((await guest("kv/x", { method: "PUT", body: '"x"' })).status).toBe(401);

    const list = await (await api("responses", { as: OWNER })).json<Listed>();
    expect(list.responses).toMatchObject([{ email: null, data: { name: "Bo" } }]);

    // Turning it off, or turning the link off, stops guests again.
    await patch({ guest_responses: false });
    expect((await guest("responses", { method: "POST", body: "{}" })).status).toBe(401);
    await patch({ guest_responses: true, public_link: false });
    expect((await guest("responses", { method: "POST", body: "{}" })).status).toBe(401);
  });

  it("limit how many one guest sends a minute", async () => {
    const { patch, api } = await newSite();
    const cookie = await guestCookie(patch);
    await patch({ guest_responses: true });
    const send = (ip: string) => api("responses", { method: "POST", body: "{}", headers: { cookie, "cf-connecting-ip": ip } });
    for (let i = 0; i < 5; i++) expect((await send("198.51.100.7")).status).toBe(201);
    const limited = await send("198.51.100.7");
    expect(limited.status).toBe(429);
    expect((await limited.json<{ error: { code: string } }>()).error.code).toBe("rate_limited");
    // Someone else still gets through.
    expect((await send("198.51.100.8")).status).toBe(201);
  });

  it("download as CSV for managers, and show on the app's page", async () => {
    const { site, patch, api } = await newSite({ allowed_emails: "viewer@example.com" });
    await api("responses", { as: OWNER, method: "POST", body: JSON.stringify({ name: "Ana", dish: "Pie, apple" }) });
    await api("responses", { as: OWNER, method: "POST", body: JSON.stringify({ name: "=HYPERLINK(\"x\")", guests: 3 }) });

    const csv = await call(`/app/apps/${site.id}/responses.csv`, { as: OWNER });
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(csv.headers.get("content-disposition")).toContain("attachment");
    const lines = (await csv.text()).replace(/^\uFEFF/, "").trim().split("\r\n");
    expect(lines[0]).toBe("Submitted (UTC),Email,name,dish,guests");
    expect(lines[1]).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d,owner@example\.com,Ana,"Pie, apple",$/);
    // Formulas are kept as text.
    expect(lines[2]).toMatch(/,"'=HYPERLINK\(""x""\)",,3$/);
    expect((await call(`/app/apps/${site.id}/responses.csv`, { as: "viewer@example.com" })).status).toBe(404);

    const page = await (await call(`/app/apps/${site.id}`, { as: OWNER })).text();
    expect(page).toContain("2 responses");
    expect(page).toContain("responses.csv");

    await patch({ public_link: true });
    expect(await (await call(`/app/apps/${site.id}`, { as: OWNER })).text()).toContain('data-action="guest-responses"');
    await patch({ guest_responses: true });
    const activity = await (await call(`/app/apps/${site.id}/activity`, { as: OWNER })).text();
    expect(activity).toContain("Let people with the public link send responses");
  });

  it("are read by the owner's AI with get_responses", async () => {
    const { ns, api } = await newSite();
    await api("responses", { as: OWNER, method: "POST", body: '{"q":"yes"}' });
    const { token } = await (await call("/_api/admin/tokens", { as: OWNER, method: "POST", json: { name: "t" } })).json<{ token: string }>();
    const rpc = async (method: string, params: unknown) =>
      (await call("/mcp", { token, method: "POST", headers: { accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" }, json: { jsonrpc: "2.0", id: 1, method, params } })).json<{
        result: { tools?: { name: string }[]; content?: { text: string }[] };
      }>();
    expect((await rpc("tools/list", {})).result.tools!.map((t) => t.name)).toContain("get_responses");
    const res = await rpc("tools/call", { name: "get_responses", arguments: { namespace: ns, mount_path: "form" } });
    expect(JSON.parse(res.result.content![0]!.text)).toMatchObject({ total: 1, responses: [{ data: { q: "yes" } }] });
  });

  it("are gone when the app is deleted", async () => {
    const { site, api } = await newSite();
    await api("responses", { as: OWNER, method: "POST", body: "{}" });
    expect((await call(`/_api/admin/sites/${site.id}`, { as: OWNER, method: "DELETE" })).status).toBe(200);
    const { env } = await import("cloudflare:workers");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM responses WHERE site_id = ?").bind(site.id).first("n")).toBe(0);
  });
});

describe("the responses feature flag", () => {
  it("hides responses and their settings while it's off", async () => {
    const { site, patch, api } = await newSite();
    expect((await setFlag("off")).status).toBe(200);
    try {
      const sent = await api("responses", { as: OWNER, method: "POST", body: "{}" });
      expect(sent.status).toBe(403);
      expect((await sent.json<{ error: { code: string } }>()).error.code).toBe("not_available");
      expect((await api("responses", { as: OWNER })).status).toBe(403);
      expect((await patch({ guest_responses: true })).status).toBe(403);

      await patch({ public_link: true });
      const page = await (await call(`/app/apps/${site.id}`, { as: OWNER })).text();
      expect(page).not.toContain("<h2>Responses</h2>");
      expect(page).not.toContain('data-action="guest-responses"');
      expect((await call(`/app/apps/${site.id}/responses.csv`, { as: OWNER })).status).toBe(404);

      const guide = await (await call("/_platform/guide.md", { as: OWNER })).text();
      expect(guide).not.toContain("formelab.responses");
    } finally {
      await setFlag("on");
    }
  });
});
