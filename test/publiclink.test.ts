import { describe, expect, it } from "vitest";
import { appAt, call, OWNER, PAGE, publishHtml, uniq } from "./helpers";

type View = { id: string; publicUrl: string | null };

async function newSite(extra: Record<string, string> = {}) {
  const ns = uniq();
  const res = await publishHtml(OWNER, ns, "app", PAGE("hello public"), extra);
  const { site } = await res.json<{ site: View }>();
  const origin = await appAt(ns, "app");
  const patch = (json: unknown, as = OWNER) => call(`/_api/admin/sites/${site.id}`, { as, method: "PATCH", json });
  return { ns, site, origin, patch };
}

/** Follows the public link like a browser with no Formelab sign-in: returns the cookie it sets. */
async function openLink(url: string): Promise<{ status: number; cookie: string | null; location: string | null }> {
  const res = await call(url);
  const set = res.headers.get("set-cookie");
  return { status: res.status, cookie: set ? set.split(";")[0]! : null, location: res.headers.get("location") };
}

describe("public links: anyone with the link", () => {
  it("is off for new apps, and turned on, replaced and off by the owner", async () => {
    const { site, origin, patch } = await newSite();
    expect(site.publicUrl).toBeNull();

    const on = await (await patch({ public_link: true })).json<View>();
    expect(on.publicUrl).toMatch(new RegExp(`^${origin}/_platform/link/[a-z2-7]{32}$`));
    // Turning it on again keeps the same link.
    expect((await (await patch({ public_link: true })).json<View>()).publicUrl).toBe(on.publicUrl);

    const renewed = await (await patch({ public_link: "new" })).json<View>();
    expect(renewed.publicUrl).not.toBe(on.publicUrl);
    expect((await openLink(on.publicUrl!)).status).toBe(404);

    expect((await (await patch({ public_link: false })).json<View>()).publicUrl).toBeNull();
    expect((await openLink(renewed.publicUrl!)).status).toBe(404);
    expect((await patch({ public_link: "maybe" })).status).toBe(400);
  });

  it("opens the app without signing in, and stops the moment the link changes", async () => {
    const { origin, patch } = await newSite();
    // Without the link, someone who isn't signed in can't see it.
    expect((await call(`${origin}/`)).status).not.toBe(200);

    const { publicUrl } = await (await patch({ public_link: true })).json<View>();
    const link = await openLink(publicUrl!);
    expect(link.status).toBe(302);
    expect(link.location).toBe("/");
    expect(link.cookie).toMatch(/^__Host-fl_link=[a-z2-7]{32}$/);

    const page = await call(`${origin}/`, { headers: { cookie: link.cookie! } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("hello public");

    // A wrong or old cookie doesn't open it.
    expect((await call(`${origin}/`, { headers: { cookie: "__Host-fl_link=" + "a".repeat(32) } })).status).not.toBe(200);
    await patch({ public_link: "new" });
    expect((await call(`${origin}/`, { headers: { cookie: link.cookie! } })).status).not.toBe(200);
  });

  it("lets guests read the app's shared data and nothing else", async () => {
    const { origin, patch } = await newSite({ data_writes: "everyone" });
    await call(`${origin}/_api/kv/greeting`, { as: OWNER, mount: "/", method: "PUT", body: '"hi"' });
    const { publicUrl } = await (await patch({ public_link: true })).json<View>();
    const { cookie } = await openLink(publicUrl!);
    const guest = (path: string, init: Parameters<typeof call>[1] = {}) =>
      call(`${origin}/_api/${path}`, { mount: "/", ...init, headers: { cookie: cookie! } });

    expect(await (await guest("me")).json()).toBeNull();
    expect(await (await guest("kv/greeting")).json()).toEqual({ value: "hi" });
    expect((await (await guest("kv")).json<unknown[]>()).length).toBe(1);

    // Even with data_writes "everyone", guests can't write, and can't touch private data or secrets.
    for (const [path, method] of [
      ["kv/greeting", "PUT"],
      ["kv/greeting", "DELETE"],
      ["me/kv", "GET"],
      ["me/kv/x", "PUT"],
      ["secrets", "GET"],
      ["secrets/key/proxy", "POST"],
      ["ai/gemini", "GET"],
      ["sheets", "GET"],
    ] as const) {
      const res = await guest(path, { method, body: method === "GET" ? undefined : '"x"' });
      expect(res.status, `${method} ${path}`).toBe(401);
      expect((await res.json<{ error: { code: string } }>()).error.code).toBe("sign_in_required");
    }
    expect(await (await call(`${origin}/_api/kv/greeting`, { as: OWNER, mount: "/" })).json()).toEqual({ value: "hi" });
  });

  it("keeps people the app is shared with signed in as themselves", async () => {
    const { origin, patch } = await newSite({ allowed_emails: "friend@example.com" });
    const { publicUrl } = await (await patch({ public_link: true })).json<View>();
    const { cookie } = await openLink(publicUrl!);
    const me = await call(`${origin}/_api/me`, { as: "friend@example.com", mount: "/", headers: { cookie: cookie! } });
    expect(await me.json()).toEqual({ email: "friend@example.com", name: null });
    // Someone the app isn't shared with is a guest, rather than being turned away.
    const stranger = await call(`${origin}/_api/me`, { as: "stranger@example.com", mount: "/", headers: { cookie: cookie! } });
    expect(stranger.status).toBe(200);
    expect(await stranger.json()).toBeNull();
  });

  it("is shown only to people who can manage the app, and logged in its activity", async () => {
    const { ns, site, patch } = await newSite({ allowed_emails: "viewer@example.com" });
    await patch({ public_link: true });
    expect((await patch({ public_link: true }, "viewer@example.com")).status).toBe(403);

    const shared = await (await call("/app/shared", { as: "viewer@example.com" })).text();
    expect(shared).toContain(ns);
    expect(shared).not.toContain("/_platform/link/");

    const settings = await (await call(`/app/apps/${site.id}`, { as: OWNER })).text();
    expect(settings).toContain("Public link");
    expect(settings).toContain("/_platform/link/");

    const activity = await (await call(`/app/apps/${site.id}/activity`, { as: OWNER })).text();
    expect(activity).toContain("Turned on a public link");
  });

  it("shows link previews (iMessage, Slack) the app's card for a public link, without a cookie", async () => {
    const { patch } = await newSite();
    const { publicUrl } = await (await patch({ public_link: true })).json<View>();
    const res = await call(publicUrl!, { headers: { "user-agent": "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.text()).toContain("og:image");
  });

  it("sends guests to sign in and back with formelab.signIn()", async () => {
    const { origin } = await newSite();
    const res = await call(`${origin}/_platform/sign-in?return=${encodeURIComponent("/board?x=1")}`);
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location")!);
    expect(to.origin).toBe("https://example.com");
    expect(to.pathname).toBe("/auth/app");
    expect(to.searchParams.get("return")).toBe(`${origin}/board?x=1`);
    // Only paths on the app's own host.
    const evil = await call(`${origin}/_platform/sign-in?return=${encodeURIComponent("//evil.test/")}`);
    expect(new URL(evil.headers.get("location")!).searchParams.get("return")).toBe(`${origin}/`);
  });
});
