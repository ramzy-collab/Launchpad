import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { accessJwt, onOutbound, OWNER, PAGE, uniq } from "./helpers";

type Sent = { from: string | { name: string; email: string }; to: string; subject: string; text: string; html: string };
let sent: Sent[] = [];
let failWith: Error | null = null;

// A stand-in for the send_email binding that records what would be sent.
const fakeEmail = {
  async send(m: Sent) {
    if (failWith) throw failWith;
    sent.push(m);
    return { messageId: "msg_" + sent.length };
  },
} as unknown as SendEmail;

// The Worker with notification emails on.
const EENV = { ...(env as unknown as Env), EMAIL: fakeEmail, EMAIL_FROM: "Formelab <hello@example.com>" } as Env;

beforeEach(() => {
  sent = [];
  failWith = null;
});
afterEach(() => onOutbound(undefined));

/** Calls the Worker with emails enabled, waiting for background sends. `as` signs in through Access. */
async function w(url: string, opts: { as?: string; method?: string; json?: unknown; body?: BodyInit; headers?: Record<string, string> } = {}) {
  const headers = new Headers(opts.headers);
  if (opts.as) headers.set("cf-access-jwt-assertion", await accessJwt(opts.as));
  let body = opts.body;
  if (opts.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(opts.json);
  }
  if (url.startsWith("/_api/admin") && opts.method && opts.method !== "GET") headers.set("x-formelab-request", "1");
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://example.com${url}`, { method: opts.method ?? "GET", headers, body, redirect: "manual" }), EENV, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const to = (email: string) => sent.filter((m) => m.to === email);

describe("notification emails", () => {
  it("confirms a waitlist sign-up once, not on repeats", async () => {
    const email = `wl-${uniq()}@example.com`;
    expect((await w("/_api/waitlist", { method: "POST", json: { email }, headers: { "cf-connecting-ip": "203.0.113.50" } })).status).toBe(200);
    expect((await w("/_api/waitlist", { method: "POST", json: { email }, headers: { "cf-connecting-ip": "203.0.113.50" } })).status).toBe(200);
    expect(to(email)).toHaveLength(1);
    expect(to(email)[0]!.subject).toBe("You're on the Formelab waitlist");
    expect(to(email)[0]!.from).toEqual({ name: "Formelab", email: "hello@example.com" });
  });

  it("tells the admin about each new sign-up, once, with the total waiting", async () => {
    const email = `adm-${uniq()}@example.com`;
    await w("/_api/waitlist", { method: "POST", json: { email }, headers: { "cf-connecting-ip": "203.0.113.52" } });
    await w("/_api/waitlist", { method: "POST", json: { email }, headers: { "cf-connecting-ip": "203.0.113.52" } });
    const forAdmin = to(OWNER).filter((m) => m.subject.includes(email));
    expect(forAdmin).toHaveLength(1);
    expect(forAdmin[0]!.subject).toBe(`New waitlist sign-up: ${email}`);
    expect(forAdmin[0]!.text).toContain("signed up on the home page");
    expect(forAdmin[0]!.text).toMatch(/Waitlist total: \d+\./);
    expect(forAdmin[0]!.text).toContain("https://example.com/admin/waitlist");
  });

  it("tells people when they're let in, only the first time", async () => {
    const email = `in-${uniq()}@example.com`;
    await w("/_api/admin/waitlist/approve", { as: OWNER, method: "POST", json: { email } });
    await w("/_api/admin/waitlist/approve", { as: OWNER, method: "POST", json: { email } });
    expect(to(email)).toHaveLength(1);
    expect(to(email)[0]!.subject).toContain("You're in");
    expect(to(email)[0]!.text).toContain("https://example.com/login");
  });

  it("tells people when an app is shared with them, naming who shared it and their access", async () => {
    const ns = uniq();
    const viewer = `v-${uniq()}@example.com`;
    const editor = `e-${uniq()}@example.com`;
    const fd = new FormData();
    fd.set("file", new File([PAGE("x")], "index.html", { type: "text/html" }));
    fd.set("namespace", ns);
    fd.set("mount_path", "planner");
    fd.set("title", "Trip <planner>");
    fd.set("allowed_emails", `${viewer}, ${OWNER}`);
    fd.set("editors", editor);
    const res = await w("/_api/admin/sites", { as: OWNER, method: "POST", body: fd });
    expect(res.status).toBe(201);
    const { site } = await res.json<{ site: { id: string } }>();

    expect(to(viewer)).toHaveLength(1);
    expect(to(viewer)[0]!.subject).toBe(`${OWNER} shared "Trip <planner>" with you on Formelab`);
    expect(to(viewer)[0]!.text).toContain(`https://${ns}.example.com/planner/`);
    expect(to(viewer)[0]!.text).toContain("You can open it.");
    expect(to(viewer)[0]!.html).toContain("Trip &lt;planner&gt;"); // escaped in HTML
    expect(to(viewer)[0]!.html).not.toContain("Trip <planner>");
    expect(to(editor)[0]!.text).toContain("open and update");
    expect(to(OWNER)).toHaveLength(0); // never emails the person sharing

    // Changing the list only emails people who are new to it.
    sent = [];
    const newcomer = `n-${uniq()}@example.com`;
    await w(`/_api/admin/sites/${site.id}`, { as: OWNER, method: "PATCH", json: { allowed_emails: `${viewer}, ${newcomer}`, title: "Trip planner" } });
    expect(sent.map((m) => m.to)).toEqual([newcomer]);

    // Publishing a new version doesn't re-send anything.
    sent = [];
    const fd2 = new FormData();
    fd2.set("file", new File([PAGE("v2")], "index.html", { type: "text/html" }));
    fd2.set("namespace", ns);
    fd2.set("mount_path", "planner");
    expect((await w("/_api/admin/sites", { as: OWNER, method: "POST", body: fd2 })).status).toBe(200);
    expect(sent).toHaveLength(0);
  });

  it("tells new namespace editors", async () => {
    const ns = uniq();
    const editor = `nse-${uniq()}@example.com`;
    await w("/_api/admin/namespaces", { as: OWNER, method: "POST", json: { label: ns } });
    await w(`/_api/admin/namespaces/${ns}`, { as: OWNER, method: "PATCH", json: { editors: editor } });
    await w(`/_api/admin/namespaces/${ns}`, { as: OWNER, method: "PATCH", json: { editors: editor } });
    expect(to(editor)).toHaveLength(1);
    expect(to(editor)[0]!.subject).toContain(`editor of "${ns}"`);
  });

  it("a failing email service never breaks the request", async () => {
    failWith = Object.assign(new Error("sender not verified"), { code: "E_SENDER_NOT_VERIFIED" });
    const res = await w("/_api/waitlist", { method: "POST", json: { email: `fail-${uniq()}@example.com` }, headers: { "cf-connecting-ip": "203.0.113.51" } });
    expect(res.status).toBe(200);
  });

  it("sends nothing without the EMAIL binding or a sender", async () => {
    const off = { ...EENV, EMAIL: undefined } as Env;
    const ctx = createExecutionContext();
    const headers = new Headers({ "cf-access-jwt-assertion": await accessJwt(OWNER), "content-type": "application/json", "x-formelab-request": "1" });
    const req = new Request("https://example.com/_api/admin/waitlist/approve", { method: "POST", headers, body: JSON.stringify({ email: `nokey-${uniq()}@example.com` }) });
    expect((await worker.fetch(req, off, ctx)).status).toBe(200);
    await waitOnExecutionContext(ctx);
    expect(sent).toHaveLength(0);
  });

  it("reads a display name from EMAIL_FROM", async () => {
    const { parseSender } = await import("../src/email");
    expect(parseSender("Formelab <hello@formelab.ai>")).toEqual({ name: "Formelab", email: "hello@formelab.ai" });
    expect(parseSender('"The Lab" <lab@formelab.ai>')).toEqual({ name: "The Lab", email: "lab@formelab.ai" });
    expect(parseSender("hello@formelab.ai")).toBe("hello@formelab.ai");
  });
});
