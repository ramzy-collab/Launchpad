// Formelab's own sign-in page (formelab.ai/login, and admin.DOMAIN/login for the admin panel).
//
// People sign in on Formelab itself rather than on WorkOS's hosted page. Formelab collects the
// email, password or emailed code and checks it with WorkOS's API from the server; WorkOS still
// owns the accounts, sends the codes and reset emails, and enforces its password rules.
// Google goes through /auth/login (WorkOS hands straight over to Google).
//
// Every form posts back to Formelab, and a signed-in person moves on through a page rather than a
// redirect: these pages' CSP says form-action 'self', which also covers redirects after a POST,
// and the way back to the web app leads to another host.
import type { Context } from "hono";
import type { AppEnv, Env } from "./env";
import {
  completeSignIn,
  homePath,
  LAST_USED_COOKIE,
  markHasPassword,
  onAdminHost,
  safeReturn,
  WORKOS_API,
  workosEnabled,
  type LastUsed,
  type WorkosAuthentication,
} from "./login";
import { homeHead, loginPage, topNav } from "./dashboard/home";
import { htmlResponse } from "./dashboard/layout";
import { identifyBrowser } from "./auth";
import { cookieHeader, readCookie, SESSION_COOKIE } from "./session";
import { escapeHtml as e, isEmail, normEmail } from "./util";

/** A sign-in waiting for an emailed code: "m" (code to log in) or "v" (confirm the email address). */
const PENDING_COOKIE = "__Host-fl_signin";
const PENDING_TTL_S = 15 * 60;

const hasSignIn = (req: Request) => !!(readCookie(req, SESSION_COOKIE) || req.headers.get("cf-access-jwt-assertion"));

const GOOGLE_G = `<svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>`;

// ---------------------------------------------------------------------------
// WorkOS
// ---------------------------------------------------------------------------

type WorkosResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string; message: string; data: Record<string, unknown> };

async function workos<T>(env: Env, path: string, body: Record<string, unknown>): Promise<WorkosResult<T>> {
  let res: Response;
  try {
    res = await fetch(`${WORKOS_API}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.WORKOS_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    console.error("workos unreachable", path);
    return { ok: false, status: 503, code: "", message: "", data: {} };
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok) return { ok: true, data: data as T };
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const code = str(data.code) || str(data.error);
  const firstError = Array.isArray(data.errors) ? str((data.errors[0] as { message?: unknown } | undefined)?.message) : "";
  const message = firstError || str(data.message) || str(data.error_description);
  if (res.status >= 500) console.error("workos", path, res.status);
  return { ok: false, status: res.status, code, message, data };
}

/** POST /user_management/authenticate with this app's credentials and the visitor's IP and browser. */
const authenticate = (c: Context<AppEnv>, grant: Record<string, unknown>) =>
  workos<WorkosAuthentication>(c.env, "/user_management/authenticate", {
    client_id: c.env.WORKOS_CLIENT_ID,
    client_secret: c.env.WORKOS_API_KEY,
    ...visitor(c),
    ...grant,
  });

const visitor = (c: Context<AppEnv>) => ({
  ip_address: c.req.header("cf-connecting-ip") ?? undefined,
  user_agent: c.req.header("user-agent")?.slice(0, 500) ?? undefined,
});

/** Steps WorkOS can ask for that this page doesn't handle; WorkOS's own page does. */
const OTHER_STEPS = new Set(["mfa_enrollment", "mfa_challenge", "mfa_verification", "sso_required", "organization_selection_required", "radar_email_challenge", "radar_sms_challenge"]);

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

interface View {
  admin: boolean;
  returnTo: string;
  /** The sign-in method this browser used last, labelled "Last used". */
  last?: LastUsed | null;
  email?: string;
  error?: string;
  info?: string;
  /** HTML (already escaped) shown under the error, e.g. a link to another way in. */
  extra?: string;
}

function view(c: Context<AppEnv>, returnTo: string): View {
  const last = readCookie(c.req.raw, LAST_USED_COOKIE);
  return { admin: onAdminHost(c), returnTo, last: last === "email" || last === "google" ? last : null };
}

function frame(v: View, title: string, intro: string, body: string, status = 200): Response {
  const alert = v.error
    ? `<p class="alert err" role="alert">${e(v.error)}${v.extra ? " " + v.extra : ""}</p>`
    : v.info
      ? `<p class="alert ok" role="status">${e(v.info)}</p>`
      : "";
  return htmlResponse(
    `<!doctype html>
<html lang="en">
<head>
${homeHead(v.admin ? "Formelab admin" : "Log in to Formelab")}
</head>
<body>
${topNav(v.admin)}

<main>
  <div class="container center">
    <div class="card">
      <h2>${e(title)}</h2>
      <p>${intro}</p>
      ${alert}
      ${body}
    </div>
  </div>
</main>
</body>
</html>`,
    undefined,
    status,
  );
}

const returnField = (v: View) => `<input type="hidden" name="return" value="${e(v.returnTo)}">`;
const withReturn = (path: string, v: View) => (v.returnTo === (v.admin ? "/" : "/app") ? path : `${path}?return=${encodeURIComponent(v.returnTo)}`);

const lastUsed = (v: View, method: LastUsed) => (v.last === method ? `<span class="last-used">Last used</span>` : "");

/** Step one: an email address (then a password or a code), or Google. */
function signInForm(v: View, status = 200): Response {
  const google = withReturn("/auth/login", v).replace("/auth/login?", "/auth/login?provider=google&").replace(/^\/auth\/login$/, "/auth/login?provider=google");
  const body = `<form method="post" action="/login" class="signin">
        ${returnField(v)}
        <label class="field">Email
          <input type="email" name="email" autocomplete="username" placeholder="Your email address" required autofocus value="${e(v.email ?? "")}">
        </label>
        <div class="badged">
          <button class="btn w100" name="action" value="email">Continue with email</button>
          ${lastUsed(v, "email")}
        </div>
      </form>
      <div class="or">or</div>
      <div class="badged">
        <a class="ghost provider" href="${e(google)}">${GOOGLE_G}Continue with Google</a>
        ${lastUsed(v, "google")}
      </div>
      ${
        v.admin
          ? `<p class="hint center-text">For Formelab admins only. This sign-in is separate from your lab and lasts 8 hours.</p>`
          : `<div class="foot-row center-row"><span>Don't have an account?</span><a class="tlink" href="/#signup">Join the waitlist</a></div>`
      }`;
  return frame(v, v.admin ? "Formelab admin" : "Log in", v.admin ? "Log in to manage Formelab." : "Welcome back to your Formelab workspace.", body, status);
}

/** Step two for people with a password. */
function passwordForm(v: View, email: string, status = 200): Response {
  const body = `<form method="post" action="/login" class="signin">
        ${returnField(v)}
        <input type="email" name="email" autocomplete="username" value="${e(email)}" hidden readonly>
        <label class="field"><span class="field-row"><span>Password</span><a class="tlink" href="${e(withReturn("/login/forgot", v))}">Forgot password?</a></span>
          <input type="password" name="password" autocomplete="current-password" required autofocus>
        </label>
        <button class="btn w100" name="action" value="password">Log in</button>
        <button class="ghost" name="action" value="code" formnovalidate>Email me a code instead</button>
      </form>`;
  return frame(v, "Enter your password", `${changeEmail(v, email)}`, body, status);
}

/** "<email> · Change", under a step's title. */
const changeEmail = (v: View, email: string) => `<b>${e(email)}</b> · <a class="tlink" href="${e(withReturn("/login", v))}">Change</a>`;

/** Enter the code WorkOS emailed: to log in, or to confirm the email address. */
function codeForm(v: View, email: string, verifying: boolean, status = 200): Response {
  const body = `<form method="post" action="/login/code" class="signin">
        ${returnField(v)}
        <label class="field">Code
          <input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,8}" maxlength="8" required autofocus>
        </label>
        <button class="btn w100">${verifying ? "Confirm and log in" : "Log in"}</button>
      </form>
      <form method="post" action="/login" class="signin">
        ${returnField(v)}
        <input type="hidden" name="email" value="${e(email)}">
        <button class="ghost" name="action" value="code">Send a new code</button>
        ${verifying ? "" : `<button class="link-button" name="action" value="use-password">Use a password instead</button>`}
      </form>
      <div class="foot-row"><span>Wrong address?</span><a class="tlink" href="${e(withReturn("/login", v))}">Change it</a></div>`;
  const intro = verifying
    ? `To confirm it's your email address, enter the code we sent to <b>${e(email)}</b>.`
    : `We sent a code to <b>${e(email)}</b>. It works once and expires in 10 minutes.`;
  return frame(v, "Check your email", intro, body, status);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** A sign-in page that only makes sense with WorkOS; without it, the Cloudflare Access login. */
async function gate(c: Context<AppEnv>): Promise<{ v: View } | Response> {
  const returnTo = safeReturn(c.req.method === "GET" ? c.req.query("return") : String((await form(c)).get("return") ?? ""), homePath(c));
  if (!workosEnabled(c.env)) return loginPage({ returnTo, admin: onAdminHost(c) });
  if (c.req.method === "GET" && hasSignIn(c.req.raw) && (await identifyBrowser(c.req.raw, c.env))) return c.redirect(returnTo, 302);
  if (c.req.method === "POST") {
    const origin = c.req.header("origin");
    if (origin !== new URL(c.req.url).origin) return htmlResponse("Log in from Formelab itself.", undefined, 403);
    if (c.env.LOGIN_LIMITER && !(await c.env.LOGIN_LIMITER.limit({ key: c.req.header("cf-connecting-ip") ?? "unknown" })).success) {
      return signInForm({ ...view(c, returnTo), error: "Too many tries. Wait a minute, then try again." }, 429);
    }
  }
  return { v: view(c, returnTo) };
}

async function form(c: Context<AppEnv>): Promise<FormData> {
  const cached = (c as unknown as { _form?: FormData })._form;
  if (cached) return cached;
  let f: FormData;
  try {
    f = await c.req.raw.clone().formData();
  } catch {
    f = new FormData();
  }
  (c as unknown as { _form?: FormData })._form = f;
  return f;
}

/** Sends the browser on to `to` once signed in (see the note at the top on why not a redirect). */
const moveOn = (to: string) => (headers: Headers) => {
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("x-content-type-options", "nosniff");
  headers.append("set-cookie", cookieHeader(PENDING_COOKIE, "", 0));
  const href = e(to);
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="0;url=${href}"><title>Logging in</title></head><body style="font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#222"><p>Logging you in… <a href="${href}">Continue</a></p></body></html>`,
    { headers },
  );
};

/** GET /login */
export async function signInGet(c: Context<AppEnv>): Promise<Response> {
  const g = await gate(c);
  return g instanceof Response ? g : signInForm(g.v);
}

/** POST /login: email and password, or "Email me a code". */
export async function signInPost(c: Context<AppEnv>): Promise<Response> {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const f = await form(c);
  const email = normEmail(String(f.get("email") ?? ""));
  const v = { ...g.v, email };
  if (!isEmail(email)) return signInForm({ ...v, error: "Enter your email address." }, 400);

  const action = String(f.get("action") ?? "email");
  if (action === "use-password") return passwordForm(v, email);
  // Step one: people Formelab knows have a password are asked for it; everyone else, new people
  // included, gets an emailed code (and can switch to a password from there).
  if (action === "email") {
    const row = await c.env.DB.prepare("SELECT has_password FROM users WHERE email = ?").bind(email).first<{ has_password: number }>();
    if (row?.has_password === 1) return passwordForm(v, email);
  }

  if (action === "email" || action === "code") {
    const sent = await workos(c.env, "/user_management/magic_auth", { email, ...visitor(c) });
    if (!sent.ok) return signInForm({ ...v, error: (sent.status < 500 && sent.message) || "Couldn't send a code. Try again in a minute." }, sent.status >= 500 ? 502 : 400);
    const page = codeForm(v, email, false);
    page.headers.append("set-cookie", pendingCookie({ kind: "m", email }));
    return page;
  }

  const password = String(f.get("password") ?? "");
  if (!password) return passwordForm({ ...v, error: "Enter your password, or choose Email me a code." }, email, 400);
  const res = await authenticate(c, { grant_type: "password", email, password });
  if (res.ok) return completeSignIn(c, res.data, moveOn(v.returnTo));
  return authProblem(c, v, email, res);
}

/** POST /login/code: the code from the email, to log in or to confirm the address. */
export async function signInCode(c: Context<AppEnv>): Promise<Response> {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const v = g.v;
  const pending = readPending(c.req.raw);
  if (!pending) return signInForm({ ...v, error: "That took too long. Enter your email to start again." }, 400);
  const code = String((await form(c)).get("code") ?? "").replace(/\s+/g, "");
  const verifying = pending.kind === "v";
  if (!/^\d{6,8}$/.test(code)) return codeForm({ ...v, error: "Enter the code from the email." }, pending.email, verifying, 400);
  const res = verifying
    ? await authenticate(c, { grant_type: "urn:workos:oauth:grant-type:email-verification:code", pending_authentication_token: pending.token, code })
    : await authenticate(c, { grant_type: "urn:workos:oauth:grant-type:magic-auth:code", email: pending.email, code });
  if (res.ok) return completeSignIn(c, res.data, moveOn(v.returnTo));
  if (OTHER_STEPS.has(res.code) || res.code === "email_verification_required") return authProblem(c, { ...v, email: pending.email }, pending.email, res);
  return codeForm({ ...v, error: "That code didn't work. Check it, or send a new one." }, pending.email, verifying, 400);
}

/** WorkOS turned the sign-in down, or wants another step first. */
function authProblem(c: Context<AppEnv>, v: View, email: string, res: Extract<WorkosResult<unknown>, { ok: false }>): Response {
  if (res.code === "email_verification_required" && typeof res.data.pending_authentication_token === "string") {
    const page = codeForm(v, email, true);
    page.headers.append("set-cookie", pendingCookie({ kind: "v", email, token: res.data.pending_authentication_token }));
    return page;
  }
  if (OTHER_STEPS.has(res.code)) {
    const link = `<a class="tlink" href="${e(withReturn("/auth/login", v))}">Continue on the secure sign-in page</a>`;
    return signInForm({ ...v, error: "Your account needs another sign-in step.", extra: link }, 400);
  }
  if (res.status >= 500 || res.status === 0) return passwordForm({ ...v, error: "The sign-in service isn't answering. Try again in a minute." }, email, 502);
  if (res.status === 429) return passwordForm({ ...v, error: "Too many tries. Wait a minute, then try again." }, email, 429);
  return passwordForm({ ...v, error: "That password isn't right. Try again, or choose Email me a code." }, email, 400);
}

/** GET /login/forgot */
export async function forgotGet(c: Context<AppEnv>): Promise<Response> {
  const g = await gate(c);
  return g instanceof Response ? g : forgotForm(g.v);
}

function forgotForm(v: View, status = 200): Response {
  const body = `<form method="post" action="/login/forgot" class="signin">
        ${returnField(v)}
        <label class="field">Email
          <input type="email" name="email" autocomplete="username" required autofocus value="${e(v.email ?? "")}">
        </label>
        <button class="btn w100">Email me a reset link</button>
      </form>
      <div class="foot-row"><span>Remembered it?</span><a class="tlink" href="${e(withReturn("/login", v))}">Back to log in</a></div>`;
  return frame(v, "Reset your password", "We'll email you a link to choose a new password. You can also log in with an emailed code.", body, status);
}

/** POST /login/forgot: always the same answer, so it doesn't reveal who has an account. */
export async function forgotPost(c: Context<AppEnv>): Promise<Response> {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const email = normEmail(String((await form(c)).get("email") ?? ""));
  const v = { ...g.v, email };
  if (!isEmail(email)) return forgotForm({ ...v, error: "Enter your email address." }, 400);
  const res = await workos(c.env, "/user_management/password_reset", { email });
  if (!res.ok && res.status >= 500) return forgotForm({ ...v, error: "Couldn't send the email. Try again in a minute." }, 502);
  return frame(v, "Check your email", `If there's a Formelab account for <b>${e(email)}</b>, we've sent it a link to choose a new password.`, `<a class="btn w100" href="${e(withReturn("/login", v))}">Back to log in</a>`);
}

/** GET /reset-password?token=…: where the reset email's link leads (WorkOS's Password reset URL). */
export async function resetGet(c: Context<AppEnv>): Promise<Response> {
  const g = await gate(c);
  return g instanceof Response ? g : resetForm(g.v, c.req.query("token") ?? "");
}

function resetForm(v: View, token: string, status = 200): Response {
  if (!token) return frame({ ...v, error: "This reset link is missing its code. Ask for a new one." }, "Reset your password", "", `<a class="btn w100" href="/login/forgot">Get a new link</a>`, 400);
  const body = `<form method="post" action="/reset-password" class="signin">
        <input type="hidden" name="token" value="${e(token)}">
        <label class="field">New password
          <input type="password" name="password" autocomplete="new-password" minlength="10" maxlength="256" required autofocus>
        </label>
        <label class="field">Confirm new password
          <input type="password" name="confirm" autocomplete="new-password" minlength="10" maxlength="256" required>
        </label>
        <button class="btn w100">Save password</button>
      </form>`;
  return frame(v, "Choose a new password", "Use at least 10 characters that are hard to guess: a few unrelated words works well.", body, status);
}

/** POST /reset-password */
export async function resetPost(c: Context<AppEnv>): Promise<Response> {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const f = await form(c);
  const token = String(f.get("token") ?? "");
  const password = String(f.get("password") ?? "");
  const v = g.v;
  if (password.length < 10 || password.length > 256) return resetForm({ ...v, error: "Use 10 to 256 characters." }, token, 400);
  if (password !== String(f.get("confirm") ?? "")) return resetForm({ ...v, error: "The two passwords don't match." }, token, 400);
  const res = await workos<{ user?: { email?: string } }>(c.env, "/user_management/password_reset/confirm", { token, new_password: password });
  if (!res.ok) {
    if (res.status >= 500) return resetForm({ ...v, error: "Couldn't save your password. Try again in a minute." }, token, 502);
    const expired = /token|expired|invalid/i.test(`${res.code} ${res.message}`) && !/password/i.test(res.code);
    if (expired) return frame({ ...v, error: "This reset link has expired or was already used." }, "Reset your password", "", `<a class="btn w100" href="/login/forgot">Get a new link</a>`, 400);
    return resetForm({ ...v, error: res.message || "That password wasn't accepted. Try a longer one that's hard to guess." }, token, 400);
  }
  const email = normEmail(res.data.user?.email ?? "");
  if (!isEmail(email)) return signInForm({ ...v, info: "Password saved. Log in with it now." });
  await markHasPassword(c.env, email);
  return passwordForm({ ...v, info: "Password saved. Log in with it now." }, email);
}

// ---------------------------------------------------------------------------
// The pending-code cookie
// ---------------------------------------------------------------------------

type Pending = { kind: "m"; email: string } | { kind: "v"; email: string; token: string };

function pendingCookie(p: Pending): string {
  const value = [p.kind, p.email, p.kind === "v" ? p.token : ""].map(encodeURIComponent).join("|");
  return cookieHeader(PENDING_COOKIE, value, PENDING_TTL_S);
}

function readPending(req: Request): Pending | null {
  const raw = readCookie(req, PENDING_COOKIE);
  if (!raw) return null;
  const [kind, email, token] = raw.split("|").map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return "";
    }
  });
  if (!email || !isEmail(email)) return null;
  if (kind === "m") return { kind, email };
  if (kind === "v" && token) return { kind, email, token };
  return null;
}
