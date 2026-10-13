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
let passwordsSet: { url: string; auth: string | null; body: unknown }[] = [];
/** An AuthKit-style access token; only its `sid` claim is read, so it needn't be signed. */
const accessToken = (sid: string) =>
  ["{\"alg\":\"none\"}", JSON.stringify({ sid, sub: "u" })].map((p) => btoa(p).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")).join(".") + ".x";
function mockWorkos(email: string, verified = true, passwordStatus = 200) {
  onOutbound(async (req) => {
    if (req.url === "https://api.workos.com/user_management/authenticate") {
      authenticated.push(await req.json());
      return Response.json({
        user: { id: "user_" + email, email, email_verified: verified, first_name: "Test", last_name: null },
        access_token: accessToken("session_" + email),
      });
    }
    if (req.method === "PUT" && req.url.startsWith("https://api.workos.com/user_management/users/")) {
      passwordsSet.push({ url: req.url, auth: req.headers.get("authorization"), body: await req.json() });
      return passwordStatus === 200
        ? Response.json({ id: "u" })
        : Response.json({ code: "password_strength_error", message: "Password does not meet strength requirements." }, { status: passwordStatus });
    }
    return new Response("unexpected", { status: 599 });
  });
}

/** Where a page that moves on by itself (logout) sends the browser. */
function refreshTarget(html: string): string {
  const m = /<meta http-equiv="refresh" content="0;url=([^"]+)">/.exec(html);
  return m ? m[1]!.replace(/&amp;/g, "&") : "";
}

/** Goes through /auth/login → (WorkOS) → /auth/callback and returns the session cookie. */
async function signIn(email: string, returnTo = "/app", origin = "https://example.com"): Promise<{ cookie: string; location: string }> {
  const back = await signInRaw(email, returnTo, origin);
  expect(back.status).toBe(302);
  return { cookie: cookieFrom(back, "__Host-fl_session")!, location: back.headers.get("location")! };
}

/** The WorkOS round trip on `origin`, returning the callback's response. */
async function signInRaw(email: string, returnTo: string, origin: string): Promise<Response> {
  mockWorkos(email);
  const start = await w(`${origin}/auth/login?provider=google&return=${encodeURIComponent(returnTo)}`);
  const authorize = new URL(start.headers.get("location")!);
  expect(authorize.searchParams.get("redirect_uri")).toBe(`${origin}/auth/callback`);
  const state = authorize.searchParams.get("state")!;
  return w(`${origin}/auth/callback?code=code123&state=${state}`, { headers: { cookie: cookieFrom(start, "__Host-fl_login")! } });
}

/** Trades a DOMAIN session for one on another Formelab host, the way a browser does on its first visit. */
async function hostCookie(cookie: string, origin: string): Promise<string> {
  const handoff = await w(`/auth/app?return=${encodeURIComponent(origin + "/")}`, { headers: { cookie } });
  expect(handoff.status).toBe(302);
  const cb = await w(handoff.headers.get("location")!);
  return cookieFrom(cb, "__Host-fl_session")!;
}

const APP = "https://example.app";
const ADMIN = "https://admin.example.com";
/** A page of the web app on APP_DOMAIN, signed in as the holder of a DOMAIN session. */
const onApp = async (path: string, cookie: string) => w(APP + path, { headers: { cookie: await hostCookie(cookie, APP) } });

afterEach(() => {
  onOutbound(undefined);
  authenticated = [];
  passwordsSet = [];
});

describe("login page and WorkOS redirect", () => {
  it("is a Formelab page asking for an email first, with Google below, keeping where to return", async () => {
    const res = await w("/login?return=%2Fapp%2Fshared");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/auth/login?provider=google&amp;return=%2Fapp%2Fshared"');
    expect(html).toContain('<form method="post" action="/login"');
    expect(html).toContain('name="return" value="/app/shared"');
    expect(html).toContain("Continue with email");
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain("Last used");
    expect(res.headers.get("content-security-policy")).toContain("form-action 'self' https://example.app https://*.example.app;".slice(0, -1));
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect((await (await w("/login?return=https%3A%2F%2Fevil.test%2F")).text())).toContain('name="return" value="/app"');
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

  it("restarts a sign-in begun on WorkOS's own pages (no state) instead of failing, without using its code", async () => {
    mockWorkos("x@example.com");
    const res = await w("/auth/callback?code=fromworkos");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/login?again=1&return=%2Fapp");
    expect(authenticated).toHaveLength(0);

    // The restarted sign-in completes normally...
    const start = await w(res.headers.get("location")!);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    expect(state.endsWith("-r")).toBe(true);
    const done = await w(`/auth/callback?code=c&state=${state}`, { headers: { cookie: cookieFrom(start, "__Host-fl_login")! } });
    expect(cookieFrom(done, "__Host-fl_session")).not.toBeNull();
    // ...and only restarts once: without the cookie (a browser dropping it) it stops with a message.
    expect((await w(`/auth/callback?code=c&state=${state}`)).status).toBe(400);
  });

  it("keeps where to return when the state cookie is there but WorkOS sent no state", async () => {
    const start = await w("/auth/login?return=%2Fapp%2Fshared");
    const res = await w("/auth/callback?code=c", { headers: { cookie: cookieFrom(start, "__Host-fl_login")! } });
    expect(res.headers.get("location")).toBe("/auth/login?again=1&return=%2Fapp%2Fshared");
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
    const res = await w(`${APP}/shared`);
    expect(res.status).toBe(302);
    const handoff = res.headers.get("location")!;
    expect(handoff).toBe(`https://example.com/auth/app?return=${encodeURIComponent(`${APP}/shared`)}`);
    const login = await w(handoff);
    expect(login.headers.get("location")).toBe(`/login?return=${encodeURIComponent(new URL(handoff).pathname + new URL(handoff).search)}`);
  });

  it("moves the old dashboard and admin addresses to their own hosts", async () => {
    for (const [from, to] of [
      ["/app", `${APP}/`],
      ["/app/shared?x=1", `${APP}/shared?x=1`],
      ["/app/connect", `${APP}/connect`],
      ["/admin", `${ADMIN}/`],
      ["/admin/waitlist", `${ADMIN}/waitlist`],
    ]) {
      const res = await w(from!);
      expect(res.status, from).toBe(301);
      expect(res.headers.get("location"), from).toBe(to);
    }
  });
});

describe("accounts and the waitlist", () => {
  it("new people land on the waitlist: they can sign in but not create", async () => {
    const email = `new-${uniq()}@example.com`;
    const { cookie } = await signIn(email);
    const html = await (await onApp("/", cookie)).text();
    expect(html).toContain("You're on the waitlist");
    // Their menu only has Shared with me and Connect your AI.
    expect(html).not.toContain('href="/new"');
    expect(html).not.toContain('href="/spaces"');
    expect(html).toContain('href="/shared"');
    expect(html).toContain('href="/connect"');
    expect((await onApp("/new", cookie)).status).toBe(200);
    expect(await (await onApp("/new", cookie)).text()).not.toContain('data-action="upload"');
    const create = await w(`${APP}/_api/admin/namespaces`, {
      method: "POST",
      headers: { cookie: await hostCookie(cookie, APP), "content-type": "application/json", "x-formelab-request": "1" },
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
    const html = await (await onApp("/", cookie)).text();
    expect(html).toContain('href="/new"');
  });

  it("invited people are active from their first sign-in, and only admins can invite", async () => {
    const email = `inv-${uniq()}@example.com`;
    expect((await call("/_api/admin/waitlist/approve", { as: "someone@example.com", method: "POST", json: { email } })).status).toBe(403);
    expect((await call("/_api/admin/waitlist/approve", { as: OWNER, method: "POST", json: { email } })).status).toBe(200);
    const { cookie } = await signIn(email);
    expect(await (await onApp("/", cookie)).text()).not.toContain("You're on the waitlist");
  });

  it("the owner is active on first sign-in", async () => {
    const { cookie } = await signIn(OWNER);
    expect(await (await onApp("/", cookie)).text()).toContain(`<a class="link" href="${ADMIN}/" target="_blank" rel="noopener">Admin panel ↗</a>`);
  });
});

describe("the admin panel's own sign-in", () => {
  const sessionLength = async (host: string) => {
    const row = await env.DB.prepare("SELECT expires_at - created_at AS len FROM sessions WHERE host = ? ORDER BY created_at DESC LIMIT 1").bind(host).first<{ len: number }>();
    return row!.len;
  };

  it("is separate from the web app's: a lab sign-in doesn't open the admin panel", async () => {
    const { cookie } = await signIn(OWNER);
    // The lab's session isn't valid on the admin host, and can't be handed over to it.
    const first = await w(`${ADMIN}/users`, { headers: { cookie } });
    expect(first.status).toBe(302);
    expect(first.headers.get("location")).toBe("/login?return=%2Fusers");
    expect((await w(`/auth/app?return=${encodeURIComponent(ADMIN + "/")}`, { headers: { cookie } })).status).toBe(400);
    expect((await w(`${ADMIN}/_auth/callback?code=abcdefghijklmnopqrstuvwxyz`)).status).toBe(302);
    // The admin login screen has no waitlist and no way into the lab.
    const login = await (await w(`${ADMIN}/login?return=%2Fusers`)).text();
    expect(login).toContain("Formelab admin");
    expect(login).toContain('href="/auth/login?provider=google&amp;return=%2Fusers"');
    expect(login).not.toContain("waitlist");
  });

  it("signs admins in on the admin host for 8 hours, apart from their lab", async () => {
    const admin = await signIn(OWNER, "/users", ADMIN);
    expect(admin.location).toBe("/users");
    expect(await sessionLength("admin.example.com")).toBeLessThanOrEqual(8 * 3600_000);
    const page = await w(`${ADMIN}/users`, { headers: { cookie: admin.cookie } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).not.toContain("My lab");
    expect(html).not.toContain("example.app");
    // The admin session doesn't sign anyone in to the lab, and logging out of one leaves the other.
    expect((await w(`${APP}/`, { headers: { cookie: admin.cookie } })).status).toBe(302);
    const lab = await signIn(OWNER);
    const out = await w(`${ADMIN}/auth/logout`, { method: "POST", headers: { cookie: admin.cookie, origin: ADMIN } });
    const to = new URL(refreshTarget(await out.text()));
    expect(to.origin + to.pathname).toBe("https://api.workos.com/user_management/sessions/logout");
    expect(to.searchParams.get("return_to")).toBe(`${ADMIN}/login`);
    expect((await w(`${ADMIN}/`, { headers: { cookie: admin.cookie } })).status).toBe(302);
    expect((await onApp("/", lab.cookie)).status).toBe(200);
  });

  it("turns away people who aren't admins, without adding them anywhere", async () => {
    const email = `notadmin-${uniq()}@example.com`;
    const res = await signInRaw(email, "/", ADMIN);
    expect(res.status).toBe(403);
    expect(cookieFrom(res, "__Host-fl_session")).toBeNull();
    expect(await env.DB.prepare("SELECT email FROM users WHERE email = ?").bind(email).first()).toBeNull();
    expect(await env.DB.prepare("SELECT email FROM waitlist WHERE email = ?").bind(email).first()).toBeNull();
  });
});

describe("accounts and the waitlist, continued", () => {

  it("logging out ends the session", async () => {
    const { cookie } = await signIn(`out-${uniq()}@example.com`);
    const res = await w("/auth/logout", { method: "POST", headers: { cookie, origin: "https://example.com" } });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().join("\n")).toContain("Max-Age=0");
    expect((await w("/auth/app?return=" + encodeURIComponent(APP + "/"), { headers: { cookie } })).status).toBe(302);
    expect((await w("/auth/app?return=" + encodeURIComponent(APP + "/"), { headers: { cookie } })).headers.get("location")).toMatch(/^\/login/);
  });

  it("logging out on the web app ends the sign-in everywhere, WorkOS included", async () => {
    const email = `out2-${uniq()}@example.com`;
    const { cookie } = await signIn(email);
    const appCookie = await hostCookie(cookie, APP);
    expect((await w(`${APP}/`, { headers: { cookie: appCookie } })).status).toBe(200);
    const res = await w(`${APP}/auth/logout`, { method: "POST", headers: { cookie: appCookie, origin: APP } });
    // Not a redirect: the web app's CSP (form-action 'self') would block one to another host.
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    const to = new URL(refreshTarget(await res.text()));
    expect(to.origin + to.pathname).toBe("https://api.workos.com/user_management/sessions/logout");
    expect(to.searchParams.get("session_id")).toBe(`session_${email}`);
    expect(to.searchParams.get("return_to")).toBe("https://example.com/");
    expect((await w(`${APP}/`, { headers: { cookie: appCookie } })).status).toBe(302);
    expect((await w("/auth/app?return=" + encodeURIComponent(APP + "/"), { headers: { cookie } })).headers.get("location")).toMatch(/^\/login/);
  });

  it("the web app logs out in the background, then goes where the answer says", async () => {
    const email = `bg-${uniq()}@example.com`;
    const { cookie } = await signIn(email);
    const res = await w(`${APP}/auth/logout`, { method: "POST", headers: { cookie: await hostCookie(cookie, APP), origin: APP, "x-formelab-request": "1" } });
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.getSetCookie().join("\n")).toContain("Max-Age=0");
    const { to } = (await res.json()) as { to: string };
    expect(new URL(to).searchParams.get("session_id")).toBe(`session_${email}`);
  });

  it("logging out a session from before WorkOS sessions were recorded still works", async () => {
    const { cookie } = await signIn(`old-${uniq()}@example.com`);
    await env.DB.prepare("UPDATE sessions SET workos_sid = NULL").run();
    const res = await w("/auth/logout", { method: "POST", headers: { cookie, origin: "https://example.com" } });
    expect(refreshTarget(await res.text())).toBe("https://example.com/");
  });

  it("refuses a logout posted from another site", async () => {
    const { cookie } = await signIn(`csrf-${uniq()}@example.com`);
    const res = await w(`${APP}/auth/logout`, { method: "POST", headers: { cookie: await hostCookie(cookie, APP), origin: "https://evil.test" } });
    expect(res.status).toBe(403);
  });

  it("a session cookie only works on the host it was made for", async () => {
    const { cookie } = await signIn(`host-${uniq()}@example.com`);
    const ns = uniq();
    const res = await w(`https://${ns}.example.app/`, { headers: { cookie } });
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
    const shared = await (await onApp("/shared", cookie)).text();
    expect(shared).toContain("Shared app");
    expect(shared).not.toContain("Private app");
    expect(shared).toContain("Can open");

    const stranger = await signIn(`stranger-${uniq()}@example.com`);
    expect(await (await onApp("/shared", stranger.cookie)).text()).not.toContain("Shared app");

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
    const first = await w(`https://${ns}.example.app/app/?x=1`);
    const handoffUrl = first.headers.get("location")!;
    expect(handoffUrl).toBe(`https://example.com/auth/app?return=${encodeURIComponent(`https://${ns}.example.app/app/?x=1`)}`);

    // 2. The apex, signed in, sends back a code.
    const handoff = await w(handoffUrl, { headers: { cookie } });
    const back = new URL(handoff.headers.get("location")!);
    expect(back.origin + back.pathname).toBe(`https://${ns}.example.app/_auth/callback`);
    expect(back.searchParams.get("return")).toBe("/app/?x=1");

    // 3. The app host trades the code for its own cookie.
    const cb = await w(back.toString());
    expect(cb.headers.get("location")).toBe("/app/?x=1");
    const appCookie = cookieFrom(cb, "__Host-fl_session")!;
    expect(appCookie).toBeTruthy();
    expect(appCookie).not.toBe(cookie);
    const page = await w(`https://${ns}.example.app/app/`, { headers: { cookie: appCookie } });
    expect(await page.text()).toContain("hello friend");

    // The code works once, and only on its own host.
    expect((await w(back.toString())).status).toBe(400);
    expect((await w(`https://other${ns}.example.app/_auth/callback?code=${back.searchParams.get("code")}`)).status).toBe(400);

    // The app-host cookie isn't a dashboard login, and logging out ends both.
    expect((await w(`${APP}/`, { headers: { cookie: appCookie } })).status).toBe(302);
    await w("/auth/logout", { method: "POST", headers: { cookie } });
    expect((await w(`https://${ns}.example.app/app/`, { headers: { cookie: appCookie } })).status).toBe(302);
  });

  it("people who weren't shared the app still can't open it", async () => {
    const ns = uniq();
    await publishHtml(OWNER, ns, "", PAGE("secret stuff"));
    const { cookie } = await signIn(`nope-${uniq()}@example.com`);
    const handoff = await w(`/auth/app?return=${encodeURIComponent(`https://${ns}.example.app/`)}`, { headers: { cookie } });
    const cb = await w(handoff.headers.get("location")!);
    const page = await w(`https://${ns}.example.app/`, { headers: { cookie: cookieFrom(cb, "__Host-fl_session")! } });
    expect(page.status).toBe(403);
    expect(await page.text()).not.toContain("secret stuff");
  });

  it("waitlisted people can't open apps open to all members, only ones shared with them", async () => {
    const ns = uniq();
    const email = `wl-${uniq()}@example.com`;
    await publishHtml(OWNER, ns, "open", PAGE("members only"), { visibility: "all" });
    await publishHtml(OWNER, ns, "mine", PAGE("shared by name"), { allowed_emails: email });
    const { cookie } = await signIn(email); // lands on the waitlist
    const nsCookie = await hostCookie(cookie, `https://${ns}.example.app`);
    const get = (path: string, headers: Record<string, string> = {}) =>
      w(`https://${ns}.example.app${path}`, { headers: { cookie: nsCookie, ...headers } });

    const open = await get("/open/");
    expect(open.status).toBe(403);
    const text = await open.text();
    expect(text).toContain("still on the waitlist");
    expect(text).not.toContain("members only");
    // Nor its data, through the app API.
    expect((await get("/_api/kv", { "x-formelab-mount": "/open/" })).status).toBe(403);
    // An app shared with them by name still works.
    expect(await (await get("/mine/")).text()).toContain("shared by name");
    expect((await get("/_api/kv", { "x-formelab-mount": "/mine/" })).status).toBe(200);
    // Listing the namespace doesn't show the members-only app either.
    const listed = await w(`${APP}/_api/admin/sites?namespace=${ns}`, { headers: { cookie: await hostCookie(cookie, APP) } });
    expect((await listed.json<{ mountPath: string }[]>()).map((s) => s.mountPath)).toEqual(["mine"]);

    // Once they're let in, the members-only app opens.
    expect((await call("/_api/admin/waitlist/approve", { as: OWNER, method: "POST", json: { email } })).status).toBe(200);
    expect(await (await get("/open/")).text()).toContain("members only");
  });

  it("only hands sessions to Formelab's own hosts", async () => {
    const { cookie } = await signIn(`evil-${uniq()}@example.com`);
    for (const target of ["https://evil.test/", "https://example.com/app", "http://x.example.app/", "https://x.example.com/", "not a url"]) {
      expect((await w(`/auth/app?return=${encodeURIComponent(target)}`, { headers: { cookie } })).status, target).toBe(400);
    }
  });
});

describe("passwords", () => {
  const put = (cookie: string, password: unknown) =>
    w(`${APP}/_api/admin/account/password`, {
      method: "PUT",
      headers: { cookie, origin: APP, "x-formelab-request": "1", "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });

  it("right after signing in, someone can set a password at WorkOS", async () => {
    const email = `pw-${uniq()}@example.com`;
    const { cookie } = await signIn(email);
    const appCookie = await hostCookie(cookie, APP);
    const page = await (await w(`${APP}/account`, { headers: { cookie: appCookie } })).text();
    expect(page).toContain('data-action="password-set"');
    expect(page).toContain('autocomplete="new-password"');

    const res = await put(appCookie, "correct horse battery");
    expect(res.status).toBe(200);
    expect(passwordsSet).toEqual([
      { url: `https://api.workos.com/user_management/users/${encodeURIComponent("user_" + email)}`, auth: "Bearer sk_test", body: { password: "correct horse battery" } },
    ]);
    const logged = await env.DB.prepare("SELECT action FROM audit WHERE actor = ? AND action = 'password_set'").bind(email).first();
    expect(logged).not.toBeNull();
  });

  it("the account menu links to it", async () => {
    const { cookie } = await signIn(`pwm-${uniq()}@example.com`);
    expect(await (await onApp("/", cookie)).text()).toContain('href="/account"');
  });

  it("asks for a fresh sign-in when the last one is old", async () => {
    const email = `pwold-${uniq()}@example.com`;
    const { cookie } = await signIn(email);
    const appCookie = await hostCookie(cookie, APP);
    await env.DB.prepare("UPDATE sessions SET created_at = created_at - ? WHERE email = ?").bind(60 * 60_000, email).run();

    const page = await (await w(`${APP}/account`, { headers: { cookie: appCookie } })).text();
    expect(page).not.toContain('data-action="password-set"');
    const relogin = /href="([^"]+)">Log in again/.exec(page)![1]!.replace(/&amp;/g, "&");
    const url = new URL(relogin);
    expect(url.origin + url.pathname).toBe("https://example.com/login");
    expect(url.searchParams.get("return")).toBe(`/auth/app?return=${encodeURIComponent(`${APP}/account`)}`);

    const res = await put(appCookie, "correct horse battery");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("reauth_required");
    expect(passwordsSet).toHaveLength(0);
  });

  it("turns down short passwords before asking WorkOS, and passes on WorkOS's reason", async () => {
    const email = `pwweak-${uniq()}@example.com`;
    const { cookie } = await signIn(email);
    const appCookie = await hostCookie(cookie, APP);
    expect((await put(appCookie, "short")).status).toBe(400);
    expect((await put(appCookie, 12345678901)).status).toBe(400);
    expect(passwordsSet).toHaveLength(0);

    mockWorkos(email, true, 422);
    const res = await put(appCookie, "aaaaaaaaaaaa");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe("Password does not meet strength requirements.");
  });

  it("needs the web app's own request header, like the rest of its API", async () => {
    const { cookie } = await signIn(`pwcsrf-${uniq()}@example.com`);
    const res = await w(`${APP}/_api/admin/account/password`, {
      method: "PUT",
      headers: { cookie: await hostCookie(cookie, APP), "content-type": "application/json" },
      body: JSON.stringify({ password: "correct horse battery" }),
    });
    expect(res.status).toBe(403);
    expect(passwordsSet).toHaveLength(0);
  });
});

describe("Formelab's own sign-in page", () => {
  let calls: { url: string; body: Record<string, unknown> }[] = [];
  /** WorkOS's API: `answer` decides each call's response; unknown calls fail loudly. */
  function mockApi(answer: (path: string, body: Record<string, unknown>) => Response | undefined) {
    calls = [];
    onOutbound(async (req) => {
      const body = (await req.json()) as Record<string, unknown>;
      calls.push({ url: req.url, body });
      return answer(new URL(req.url).pathname, body) ?? new Response("unexpected", { status: 599 });
    });
  }
  const signedIn = (email: string, method = "MagicAuth") =>
    Response.json({
      user: { id: "user_" + email, email, email_verified: true, first_name: "Pat", last_name: null },
      access_token: accessToken("session_" + email),
      authentication_method: method,
    });

  const post = (path: string, fields: Record<string, string>, opts: { origin?: string; cookie?: string; host?: string } = {}) => {
    const host = opts.host ?? "https://example.com";
    const headers: Record<string, string> = { origin: opts.origin ?? host, "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.9", "user-agent": "test-browser" };
    if (opts.cookie) headers.cookie = opts.cookie;
    return w(host + path, { method: "POST", headers, body: new URLSearchParams(fields).toString() });
  };

  it("asks people with a password for it, and logs them in", async () => {
    const email = `pass-${uniq()}@example.com`;
    await env.DB.prepare("INSERT INTO users (email, created_at, has_password) VALUES (?, 0, 1)").bind(email).run();
    mockApi((path, body) => (path === "/user_management/authenticate" && body.password === "right password!" ? signedIn(email, "Password") : undefined));
    const step = await post("/login", { email: email.toUpperCase(), action: "email", return: "/app/shared" });
    const stepHtml = await step.text();
    expect(stepHtml).toContain("Enter your password");
    expect(stepHtml).toContain('autocomplete="current-password"');
    expect(stepHtml).toContain(`value="${email}"`);
    expect(calls).toHaveLength(0);

    const res = await post("/login", { email, password: "right password!", action: "password", return: "/app/shared" });
    // Straight on, no page in between: the login page's CSP lets the form lead to the web app.
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/app/shared");
    const cookie = cookieFrom(res, "__Host-fl_session")!;
    expect(cookie).not.toBeNull();
    expect(calls[0]!.body).toMatchObject({ grant_type: "password", email, client_id: "client_test", client_secret: "sk_test", ip_address: "203.0.113.9", user_agent: "test-browser" });
    // A real session, recording the WorkOS session for logout.
    const row = await env.DB.prepare("SELECT workos_sid FROM sessions WHERE email = ?").bind(email).first<{ workos_sid: string }>();
    expect(row!.workos_sid).toBe(`session_${email}`);
    // The next visit labels email as the way they logged in last time.
    const last = cookieFrom(res, "__Host-fl_last")!;
    expect(last).toBe("__Host-fl_last=email");
    expect(await (await w("/login", { headers: { cookie: last } })).text()).toContain("Last used");
  });

  it("emails a code straight away to people without a password, who can switch to one", async () => {
    const email = `new-${uniq()}@example.com`;
    mockApi((path) => (path === "/user_management/magic_auth" ? Response.json({ id: "ma_1" }) : undefined));
    const res = await post("/login", { email, action: "email" });
    const html = await res.text();
    expect(html).toContain("We sent a code to <b>" + email);
    expect(calls[0]!.url).toBe("https://api.workos.com/user_management/magic_auth");
    expect(html).toContain('value="use-password"');
    const pw = await post("/login", { email, action: "use-password" });
    expect(await pw.text()).toContain("Enter your password");
  });

  it("remembers that someone has a password once they log in with one", async () => {
    const email = `remember-${uniq()}@example.com`;
    mockApi(() => signedIn(email, "Password"));
    await post("/login", { email, password: "a password here", action: "password" });
    const row = await env.DB.prepare("SELECT has_password FROM users WHERE email = ?").bind(email).first<{ has_password: number }>();
    expect(row!.has_password).toBe(1);
  });

  it("says so when the password is wrong, keeping the email", async () => {
    mockApi(() => Response.json({ error: "invalid_grant", error_description: "Invalid credentials." }, { status: 400 }));
    const res = await post("/login", { email: "who@example.com", password: "nope", action: "password" });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("That password isn&#39;t right");
    expect(html).toContain('value="who@example.com"');
    expect(cookieFrom(res, "__Host-fl_session")).toBeNull();
  });

  it("emails a code and logs in with it; new people land on the waitlist", async () => {
    const email = `code-${uniq()}@example.com`;
    mockApi((path, body) => {
      if (path === "/user_management/magic_auth") return Response.json({ id: "ma_1", email: body.email });
      if (path === "/user_management/authenticate" && body.code === "123456") return signedIn(email);
      if (path === "/user_management/authenticate") return Response.json({ error: "invalid_grant" }, { status: 400 });
      return undefined;
    });
    const sent = await post("/login", { email, action: "code", return: "/app" });
    expect(sent.status).toBe(200);
    expect(await sent.text()).toContain("We sent a code to <b>" + email);
    expect(calls[0]).toMatchObject({ url: "https://api.workos.com/user_management/magic_auth", body: { email } });
    const pending = cookieFrom(sent, "__Host-fl_signin")!;

    const wrong = await post("/login/code", { code: "000000", return: "/app" }, { cookie: pending });
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toContain("That code didn");

    const ok = await post("/login/code", { code: "123 456", return: "/app" }, { cookie: pending });
    expect(ok.status).toBe(303);
    expect(cookieFrom(ok, "__Host-fl_session")).not.toBeNull();
    expect(calls.at(-1)!.body).toMatchObject({ grant_type: "urn:workos:oauth:grant-type:magic-auth:code", email, code: "123456" });
    expect(await env.DB.prepare("SELECT email FROM waitlist WHERE email = ?").bind(email).first()).not.toBeNull();
  });

  it("asks for the emailed code when WorkOS wants the address confirmed first", async () => {
    const email = `verify-${uniq()}@example.com`;
    mockApi((path, body) => {
      if (body.grant_type === "password") return Response.json({ code: "email_verification_required", message: "Verify", pending_authentication_token: "pat_123" }, { status: 403 });
      if (body.grant_type === "urn:workos:oauth:grant-type:email-verification:code" && body.pending_authentication_token === "pat_123") return signedIn(email);
      return undefined;
    });
    const step = await post("/login", { email, password: "a password here", action: "password" });
    expect(await step.text()).toContain("To confirm it");
    const done = await post("/login/code", { code: "654321" }, { cookie: cookieFrom(step, "__Host-fl_signin")! });
    expect(cookieFrom(done, "__Host-fl_session")).not.toBeNull();
  });

  it("sends steps it doesn't handle (like two-factor) to WorkOS's own page", async () => {
    mockApi(() => Response.json({ code: "mfa_challenge", message: "MFA" }, { status: 403 }));
    const res = await post("/login", { email: "mfa@example.com", password: "a password here", action: "password" });
    expect(await res.text()).toContain('href="/auth/login">Continue on the secure sign-in page');
  });

  it("refuses forms posted from another site, and expired code steps", async () => {
    mockApi(() => undefined);
    expect((await post("/login", { email: "x@example.com", password: "p" }, { origin: "https://evil.test" })).status).toBe(403);
    expect(calls).toHaveLength(0);
    const res = await post("/login/code", { code: "123456" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("That took too long");
  });

  it("forgot password asks WorkOS to email a link, with the same answer either way", async () => {
    mockApi((path) => (path === "/user_management/password_reset" ? Response.json({ id: "pr_1" }) : undefined));
    expect(await (await w("/login/forgot")).text()).toContain('action="/login/forgot"');
    const res = await post("/login/forgot", { email: "forgot@example.com" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("If there's a Formelab account for <b>forgot@example.com</b>");
    expect(calls).toEqual([{ url: "https://api.workos.com/user_management/password_reset", body: { email: "forgot@example.com" } }]);
  });

  it("the reset link lets someone choose a new password", async () => {
    mockApi((path, body) =>
      path === "/user_management/password_reset/confirm" && body.token === "tok_1" ? Response.json({ user: { email: "reset@example.com" } }) : undefined,
    );
    const page = await (await w("/reset-password?token=tok_1")).text();
    expect(page).toContain('name="token" value="tok_1"');
    expect((await post("/reset-password", { token: "tok_1", password: "long enough pw", confirm: "different pw!!" })).status).toBe(400);
    expect(calls).toHaveLength(0);
    const res = await post("/reset-password", { token: "tok_1", password: "long enough pw", confirm: "long enough pw" });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Password saved");
    expect(html).toContain("Enter your password");
    expect(html).toContain('value="reset@example.com"');
    expect(calls[0]!.body).toEqual({ token: "tok_1", new_password: "long enough pw" });
  });

  it("on the admin host, only admins get in", async () => {
    const email = `nonadmin-${uniq()}@example.com`;
    mockApi(() => signedIn(email));
    const res = await post("/login", { email, password: "a password here", action: "password", return: "/" }, { host: ADMIN });
    expect(res.status).toBe(403);
    expect(cookieFrom(res, "__Host-fl_session")).toBeNull();
    mockApi(() => signedIn(OWNER));
    const ok = await post("/login", { email: OWNER, password: "a password here", action: "password", return: "/users" }, { host: ADMIN });
    expect(ok.headers.get("location")).toBe("/users");
    expect(cookieFrom(ok, "__Host-fl_session")).not.toBeNull();
  });
});
