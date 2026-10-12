import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { call, onOutbound, OWNER, PAGE, publishHtml, uniq } from "./helpers";

// The Worker with Formelab's own login (WorkOS) turned on. WorkOS itself is mocked via onOutbound.
const WENV = { ...(env as unknown as Env), WORKOS_CLIENT_ID: "client_test", WORKOS_API_KEY: "sk_test" } as Env;

async function w(url: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const req = new Request(url.startsWith("http") ? url : `https://example.com${url}`, { redirect: "manual", ...init });
  const res = await worker.fetch(req, WENV, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/** "name=value" for the named cookie in a response's Set-Cookie headers. */
function cookieFrom(res: Response, name: string): string | null {
  for (const c of res.headers.getSetCookie()) {
    const pair = c.split(";")[0]!;
    if (pair.startsWith(name + "=") && pair.length > name.length + 1) return pair;
  }
  return null;
}

let authenticated: unknown[] = [];
function mockWorkos(email: string, verified = true) {
  onOutbound(async (req) => {
    if (req.url === "https://api.workos.com/user_management/authenticate") {
      authenticated.push(await req.json());
      return Response.json({ user: { id: "user_" + email, email, email_verified: verified, first_name: "Test", last_name: null } });
    }
    return new Response("unexpected", { status: 599 });
  });
}

/** Goes through /auth/login → (WorkOS) → /auth/callback and returns the session cookie. */
async function signIn(email: string, returnTo = "/app"): Promise<{ cookie: string; location: string }> {
  mockWorkos(email);
  const start = await w(`/auth/login?provider=google&return=${encodeURIComponent(returnTo)}`);
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const back = await w(`/auth/callback?code=code123&state=${state}`, { headers: { cookie: cookieFrom(start, "__Host-fl_login")! } });
  expect(back.status).toBe(302);
  return { cookie: cookieFrom(back, "__Host-fl_session")!, location: back.headers.get("location")! };
}

afterEach(() => {
  onOutbound(undefined);
  authenticated = [];
});

describe("login page and WorkOS redirect", () => {
  it("offers Google and email, keeping where to return", async () => {
    const html = await (await w("/login?return=%2Fapp%2Fshared")).text();
    expect(html).toContain('href="/auth/login?provider=google&amp;return=%2Fapp%2Fshared"');
    expect(html).toContain('href="/auth/login?provider=email&amp;return=%2Fapp%2Fshared"');
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });

  it("without WorkOS keys, keeps the Cloudflare Access button", async () => {
    const html = await (await call("/login")).text();
    expect(html).toContain('href="/app"');
    expect(html).not.toContain("/auth/login");
  });

  it("redirects to WorkOS with a state cookie, and picks the provider", async () => {
    const res = await w("/auth/login?provider=google");
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get("location")!);
    expect(url.origin + url.pathname).toBe("https://api.workos.com/user_management/authorize");
    expect(url.searchParams.get("client_id")).toBe("client_test");
    expect(url.searchParams.get("provider")).toBe("GoogleOAuth");
    expect(url.searchParams.get("redirect_uri")).toBe("https://example.com/auth/callback");
    const cookie = res.headers.getSetCookie().join("\n");
    expect(cookie).toContain("__Host-fl_login=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(new URL((await w("/auth/login?provider=email")).headers.get("location")!).searchParams.get("provider")).toBe("authkit");
  });

  it("rejects a callback whose state doesn't match the cookie", async () => {
    mockWorkos("x@example.com");
    const start = await w("/auth/login");
    const res = await w("/auth/callback?code=c&state=wrong", { headers: { cookie: cookieFrom(start, "__Host-fl_login")! } });
    expect(res.status).toBe(400);
    expect(authenticated).toHaveLength(0);
  });

  it("only returns to paths on Formelab itself", async () => {
    expect((await signIn(`r-${uniq()}@example.com`, "https://evil.test/")).location).toBe("/app");
    expect((await signIn(`r-${uniq()}@example.com`, "//evil.test/")).location).toBe("/app");
    expect((await signIn(`r-${uniq()}@example.com`, "/app/shared")).location).toBe("/app/shared");
  });

  it("refuses unverified emails", async () => {
    mockWorkos("unverified@example.com", false);
    const start = await w("/auth/login");
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const res = await w(`/auth/callback?code=c&state=${state}`, { headers: { cookie: cookieFrom(start, "__Host-fl_login")! } });
    expect(res.status).toBe(403);
    expect(cookieFrom(res, "__Host-fl_session")).toBeNull();
  });

  it("sends people without a session to the login screen, then back", async () => {
    const res = await w("/app/shared");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login?return=%2Fapp%2Fshared");
  });
});

describe("accounts and the waitlist", () => {
  it("new people land on the waitlist: they can sign in but not create", async () => {
    const email = `new-${uniq()}@example.com`;
    const { cookie } = await signIn(email);
    const html = await (await w("/app", { headers: { cookie } })).text();
    expect(html).toContain("You're on the waitlist");
    expect(html).not.toContain('data-action="upload"');
    const create = await w("/_api/admin/namespaces", {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-formelab-request": "1" },
      body: JSON.stringify({ label: uniq() }),
    });
    expect(create.status).toBe(403);
    expect((await create.json<{ error: { code: string } }>()).error.code).toBe("waitlisted");
    const row = await env.DB.prepare("SELECT email FROM waitlist WHERE email = ?").bind(email).first();
    expect(row).toBeTruthy();
  });

  it("an admin can let them in; the next request is active", async () => {
    const email = `wait-${uniq()}@example.com`;
    const { cookie } = await signIn(email);
    const approve = await call("/_api/admin/waitlist/approve", { as: OWNER, method: "POST", json: { email } });
    expect(approve.status).toBe(200);
    const html = await (await w("/app", { headers: { cookie } })).text();
    expect(html).toContain('data-action="upload"');
  });

  it("invited people are active from their first sign-in, and only admins can invite", async () => {
    const email = `inv-${uniq()}@example.com`;
    expect((await call("/_api/admin/waitlist/approve", { as: "someone@example.com", method: "POST", json: { email } })).status).toBe(403);
    expect((await call("/_api/admin/waitlist/approve", { as: OWNER, method: "POST", json: { email } })).status).toBe(200);
    const { cookie } = await signIn(email);
    expect(await (await w("/app", { headers: { cookie } })).text()).not.toContain("You're on the waitlist");
  });

  it("the owner is active on first sign-in", async () => {
    const { cookie } = await signIn(OWNER);
    expect(await (await w("/app", { headers: { cookie } })).text()).toContain('<span class="tag admin">admin</span>');
  });

  it("logging out ends the session", async () => {
    const { cookie } = await signIn(`out-${uniq()}@example.com`);
    const res = await w("/auth/logout", { method: "POST", headers: { cookie, origin: "https://example.com" } });
    expect(res.status).toBe(302);
    expect(res.headers.getSetCookie().join("\n")).toContain("Max-Age=0");
    expect((await w("/app", { headers: { cookie } })).status).toBe(302);
  });

  it("a session cookie only works on the host it was made for", async () => {
    const { cookie } = await signIn(`host-${uniq()}@example.com`);
    const ns = uniq();
    const res = await w(`https://${ns}.example.com/`, { headers: { cookie } });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("https://example.com/auth/app?return=");
  });
});

describe("my apps and shared with me", () => {
  it("apps are private by default and appear under Shared with me only for people named", async () => {
    const ns = uniq();
    const friend = `friend-${uniq()}@example.com`;
    await publishHtml(OWNER, ns, "private", PAGE("p"), { title: "Private app" });
    await publishHtml(OWNER, ns, "shared", PAGE("s"), { title: "Shared app", allowed_emails: friend });

    const { cookie } = await signIn(friend);
    const shared = await (await w("/app/shared", { headers: { cookie } })).text();
    expect(shared).toContain("Shared app");
    expect(shared).not.toContain("Private app");
    expect(shared).toContain("Can open");

    const stranger = await signIn(`stranger-${uniq()}@example.com`);
    expect(await (await w("/app/shared", { headers: { cookie: stranger.cookie } })).text()).not.toContain("Shared app");

    // The owner sees both under My apps, not under Shared with me.
    const mine = await (await call("/app", { as: OWNER })).text();
    expect(mine).toContain("Private app");
    expect(mine).toContain("Shared app");
    expect(await (await call("/app/shared", { as: OWNER })).text()).not.toContain("Private app");
  });
});

describe("namespace hosts get their own session", () => {
  it("hands the session over with a single-use code", async () => {
    const ns = uniq();
    const friend = `ns-${uniq()}@example.com`;
    await publishHtml(OWNER, ns, "app", PAGE("hello friend"), { allowed_emails: friend });
    const { cookie } = await signIn(friend);

    // 1. The app host sends the visitor to the apex.
    const first = await w(`https://${ns}.example.com/app/?x=1`);
    const handoffUrl = first.headers.get("location")!;
    expect(handoffUrl).toBe(`https://example.com/auth/app?return=${encodeURIComponent(`https://${ns}.example.com/app/?x=1`)}`);

    // 2. The apex, signed in, sends back a code.
    const handoff = await w(handoffUrl, { headers: { cookie } });
    const back = new URL(handoff.headers.get("location")!);
    expect(back.origin + back.pathname).toBe(`https://${ns}.example.com/_auth/callback`);
    expect(back.searchParams.get("return")).toBe("/app/?x=1");

    // 3. The app host trades the code for its own cookie.
    const cb = await w(back.toString());
    expect(cb.headers.get("location")).toBe("/app/?x=1");
    const appCookie = cookieFrom(cb, "__Host-fl_session")!;
    expect(appCookie).toBeTruthy();
    expect(appCookie).not.toBe(cookie);
    const page = await w(`https://${ns}.example.com/app/`, { headers: { cookie: appCookie } });
    expect(await page.text()).toContain("hello friend");

    // The code works once, and only on its own host.
    expect((await w(back.toString())).status).toBe(400);
    expect((await w(`https://other${ns}.example.com/_auth/callback?code=${back.searchParams.get("code")}`)).status).toBe(400);

    // The app-host cookie isn't a dashboard login, and logging out ends both.
    expect((await w("/app", { headers: { cookie: appCookie } })).status).toBe(302);
    await w("/auth/logout", { method: "POST", headers: { cookie } });
    expect((await w(`https://${ns}.example.com/app/`, { headers: { cookie: appCookie } })).status).toBe(302);
  });

  it("people who weren't shared the app still can't open it", async () => {
    const ns = uniq();
    await publishHtml(OWNER, ns, "", PAGE("secret stuff"));
    const { cookie } = await signIn(`nope-${uniq()}@example.com`);
    const handoff = await w(`/auth/app?return=${encodeURIComponent(`https://${ns}.example.com/`)}`, { headers: { cookie } });
    const cb = await w(handoff.headers.get("location")!);
    const page = await w(`https://${ns}.example.com/`, { headers: { cookie: cookieFrom(cb, "__Host-fl_session")! } });
    expect(page.status).toBe(403);
    expect(await page.text()).not.toContain("secret stuff");
  });

  it("only hands sessions to Formelab's own namespace hosts", async () => {
    const { cookie } = await signIn(`evil-${uniq()}@example.com`);
    for (const target of ["https://evil.test/", "https://example.com/app", "http://x.example.com/", "not a url"]) {
      expect((await w(`/auth/app?return=${encodeURIComponent(target)}`, { headers: { cookie } })).status, target).toBe(400);
    }
  });
});
