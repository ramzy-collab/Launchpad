import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { accessJwt, call, onOutbound, OWNER, PAGE, uniq } from "./helpers";

// The Worker with notification emails on. Resend itself is mocked via onOutbound.
const EENV = { ...(env as unknown as Env), RESEND_API_KEY: "re_test", EMAIL_FROM: "Formelab <hello@example.com>" } as Env;

type Sent = { from: string; to: string[]; subject: string; text: string; html: string };
let sent: Sent[] = [];

beforeEach(() => {
  sent = [];
  onOutbound(async (req) => {
    if (req.url === "https://api.resend.com/emails") {
      expect(req.headers.get("authorization")).toBe("Bearer re_test");
      sent.push(await req.json<Sent>());
      return Response.json({ id: "email_" + sent.length });
    }
    return new Response("unexpected", { status: 599 });
  });
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

const to = (email: string) => sent.filter((m) => m.to.includes(email));

describe("notification emails", () => {
  it("confirms a waitlist sign-up once, not on repeats", async () => {
    const email = `wl-${uniq()}@example.com`;
    expect((await w("/_api/waitlist", { method: "POST", json: { email }, headers: { "cf-connecting-ip": "203.0.113.50" } })).status).toBe(200);
    expect((await w("/_api/waitlist", { method: "POST", json: { email }, headers: { "cf-connecting-ip": "203.0.113.50" } })).status).toBe(200);
    expect(to(email)).toHaveLength(1);
    expect(to(email)[0]!.subject).toBe("You're on the Formelab waitlist");
    expect(to(email)[0]!.from).toBe("Formelab <hello@example.com>");
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
    expect(sent.map((m) => m.to[0])).toEqual([newcomer]);

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
    onOutbound(() => new Response("boom", { status: 500 }));
    const res = await w("/_api/waitlist", { method: "POST", json: { email: `fail-${uniq()}@example.com` }, headers: { "cf-connecting-ip": "203.0.113.51" } });
    expect(res.status).toBe(200);
  });

  it("sends nothing when no Resend key is set", async () => {
    await call("/_api/admin/waitlist/approve", { as: OWNER, method: "POST", json: { email: `nokey-${uniq()}@example.com` } });
    expect(sent).toHaveLength(0);
  });
});
