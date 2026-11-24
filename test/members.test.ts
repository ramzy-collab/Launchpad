import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Env, User } from "../src/env";
import { notifyOwnersOfDeletion } from "../src/users";
import { appAt, call, OWNER, PAGE, publishZip, uniq } from "./helpers";

// App members and roles managed inside the app (spec step 4).
const BOSS = "boss@example.com"; // on the share list, made a manager in the app
const REP = "rep@example.com"; // on the share list, default role
const NEW = "new@example.com"; // nobody's shared the app with them
const EDITOR = "ed@example.com";
const CRM = {
  default_role: "rep",
  manage_roles: ["manager"],
  records: {
    lead: { prefix: "lead:", fields: ["name", "assignedTo"], owner_field: "assignedTo", read: { manager: "all", rep: "own" }, write: { manager: "all", rep: "own" } },
  },
};
const CODE = PAGE(`<script>formelab.kv.set("lead:" + id, v)</script>`);
type Err = { error: { code: string; message: string } };

async function app(rules: unknown = CRM) {
  const ns = uniq();
  const res = await publishZip(OWNER, ns, "crm", { "index.html": CODE, "formelab.json": JSON.stringify(rules) }, { allowed_emails: `${BOSS}, ${REP}`, editors: EDITOR, confirm_public: "true" });
  expect(res.status).toBe(201);
  const { site } = await res.json<{ site: { id: string } }>();
  const origin = await appAt(ns, "crm");
  const api = (as: string, path: string, method = "GET", json?: unknown) => call(`${origin}/_api/${path}`, { as, mount: "/", method, ...(json === undefined ? {} : { json }) });
  const setRole = (as: string, email: string, role: string) => api(as, `roles/${encodeURIComponent(email)}`, "PUT", { role });
  return { id: site.id, api, setRole };
}
const code = async (res: Response) => (await res.json<Err>()).error.code;

describe("app members and roles", () => {
  it("lets a manager add someone, who can then open the app with that role", async () => {
    const { api, setRole } = await app();
    expect((await api(NEW, "me")).status).toBe(403);
    expect((await setRole(OWNER, BOSS, "manager")).status).toBe(200);
    expect((await setRole(BOSS, NEW, "rep")).status).toBe(200);
    expect(await (await api(NEW, "me")).json()).toEqual({ email: NEW, name: null, role: "rep", manages: false });

    // Their role decides what they read: a rep sees only their own leads, a manager all of them.
    await api(OWNER, "kv/lead%3A1", "PUT", { name: "Ada", assignedTo: NEW });
    await api(OWNER, "kv/lead%3A2", "PUT", { name: "Bo", assignedTo: REP });
    const keys = async (as: string) => (await (await api(as, "kv")).json<{ key: string }[]>()).map((r) => r.key);
    expect(await keys(NEW)).toEqual(["lead:1"]);
    expect(await keys(REP)).toEqual(["lead:2"]);
    expect(await keys(BOSS)).toEqual(["lead:1", "lead:2"]);

    expect(await (await api(BOSS, "roles")).json()).toEqual([
      { email: OWNER, role: null, manages: true, member: false },
      { email: EDITOR, role: null, manages: true, member: false },
      { email: BOSS, role: "manager", manages: false, member: true },
      { email: REP, role: "rep", manages: false, member: false },
      { email: NEW, role: "rep", manages: false, member: true },
    ]);

    expect((await api(BOSS, `roles/${encodeURIComponent(NEW)}`, "DELETE")).status).toBe(200);
    expect((await api(NEW, "me")).status).toBe(403);
    // Someone the app is shared with in Formelab keeps opening it, back on default_role.
    expect((await api(OWNER, `roles/${encodeURIComponent(BOSS)}`, "DELETE")).status).toBe(200);
    expect(await (await api(BOSS, "me")).json()).toMatchObject({ role: "rep" });
  });

  it("keeps roles for the owner, editors and manage_roles", async () => {
    const { api, setRole } = await app();
    for (const res of [await api(REP, "roles"), await setRole(REP, NEW, "rep"), await api(REP, `roles/${encodeURIComponent(BOSS)}`, "DELETE")]) {
      expect(res.status).toBe(403);
      expect(await code(res)).toBe("not_allowed");
    }
    expect((await setRole(EDITOR, NEW, "manager")).status).toBe(200);
  });

  it("refuses roles the rules don't name, and people who already manage the app", async () => {
    const { setRole } = await app();
    expect(await code(await setRole(OWNER, NEW, "intern"))).toBe("role_unknown");
    expect(await code(await setRole(OWNER, NEW, "guest"))).toBe("role_unknown");
    expect(await code(await setRole(OWNER, "not an email", "rep"))).toBe("bad_request");
    expect(await code(await setRole(OWNER, EDITOR, "rep"))).toBe("manages_app");
    expect(await code(await setRole(OWNER, OWNER.toUpperCase(), "rep"))).toBe("manages_app");
  });

  it("has no roles in apps whose rules let everyone do everything", async () => {
    const { setRole } = await app({ everyone: "all" });
    expect(await code(await setRole(OWNER, NEW, "rep"))).toBe("roles_unavailable");
  });

  it("lists members on the settings page, where the owner can remove them", async () => {
    const { id, api, setRole } = await app();
    await setRole(OWNER, NEW, "rep");
    const page = await (await call(`/app/apps/${id}`, { as: OWNER })).text();
    expect(page).toContain("Added in the app");
    expect(page).toContain(`data-member-remove="${NEW}"`);
    // Editors who weren't let share the app can't change who opens it.
    const byEditor = await call(`/_api/admin/sites/${id}/members/${encodeURIComponent(NEW)}`, { as: EDITOR, method: "DELETE" });
    expect(byEditor.status).toBe(403);
    expect((await call(`/_api/admin/sites/${id}/members/${encodeURIComponent(NEW)}`, { as: OWNER, method: "DELETE" })).status).toBe(200);
    expect((await api(NEW, "me")).status).toBe(403);
    const log = await (await call(`/app/apps/${id}/activity`, { as: OWNER })).text();
    expect(log).toContain(`Gave ${NEW} the role rep in the app`);
    expect(log).toContain(`Removed ${NEW} from the app&#39;s members`);
  });

  it("deletes the member list with the app", async () => {
    const { id, setRole } = await app();
    await setRole(OWNER, NEW, "rep");
    expect((await call(`/_api/admin/sites/${id}`, { as: OWNER, method: "DELETE" })).status).toBe(200);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM app_members WHERE site_id = ?").bind(id).first("n")).toBe(0);
  });
});

describe("app user accounts go once no app lists them", () => {
  /** An app user account (part B makes these on first sign-in), with a session and a log line. */
  async function appUser(email: string) {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (email, name, is_admin, created_at, status) VALUES (?, NULL, 0, ?, 'app_user')").bind(email, Date.now()),
      env.DB.prepare("INSERT INTO sessions (id, email, host, expires_at, created_at) VALUES (?, ?, 'example.com', ?, ?)").bind(`s-${email}`, email, Date.now() + 3600_000, Date.now()),
    ]);
  }
  const exists = async (email: string) => !!(await env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind(email).first());
  const sessions = async (email: string) => env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE email = ?").bind(email).first("n");

  it("deletes the account when its last app removes them, and takes their email out of the activity log", async () => {
    const who = `gone-${uniq()}@example.com`;
    await appUser(who);
    const first = await app();
    const second = await app();
    await first.setRole(OWNER, who, "rep");
    await second.setRole(OWNER, who, "rep");
    await first.api(OWNER, `roles/${encodeURIComponent(who)}`, "DELETE");
    expect(await exists(who)).toBe(true); // the second app still lists them
    await call(`/_api/admin/sites/${second.id}/members/${encodeURIComponent(who)}`, { as: OWNER, method: "DELETE" });
    expect(await exists(who)).toBe(false);
    expect(await sessions(who)).toBe(0);
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE actor = ?1 OR target = ?1 OR detail LIKE ?2").bind(who, `%${who}%`).first("n");
    expect(left).toBe(0);
    // The log keeps the lines, under a stand-in.
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE site_id = ? AND detail LIKE '%deleted-user-%'").bind(first.id).first("n")).toBe(2);
  });

  it("deletes them with their app, or when the app stops being shared with them", async () => {
    const added = `added-${uniq()}@example.com`;
    const shared = `shared-${uniq()}@example.com`;
    await appUser(added);
    await appUser(shared);
    const a = await app();
    await a.setRole(OWNER, added, "rep");
    expect((await call(`/_api/admin/sites/${a.id}`, { as: OWNER, method: "DELETE" })).status).toBe(200);
    expect(await exists(added)).toBe(false);

    const b = await app();
    await call(`/_api/admin/sites/${b.id}`, { as: OWNER, method: "PATCH", json: { allowed_emails: [BOSS, REP, shared] } });
    expect(await exists(shared)).toBe(true);
    await call(`/_api/admin/sites/${b.id}`, { as: OWNER, method: "PATCH", json: { allowed_emails: [BOSS, REP] } });
    expect(await exists(shared)).toBe(false);
  });

  it("never deletes a Formelab account", async () => {
    const waiting = `waiting-${uniq()}@example.com`;
    await env.DB.prepare("INSERT INTO users (email, name, is_admin, created_at, status) VALUES (?, NULL, 0, ?, 'waitlisted')").bind(waiting, Date.now()).run();
    const a = await app();
    await a.setRole(OWNER, waiting, "rep");
    await a.api(OWNER, `roles/${encodeURIComponent(waiting)}`, "DELETE");
    expect(await exists(waiting)).toBe(true);
  });
});

describe("deletion requests in the admin panel", () => {
  it("finds every app that lists someone and emails each owner once", async () => {
    const who = `asks-${uniq()}@example.com`;
    const a = await app();
    const b = await app();
    await a.setRole(OWNER, who, "rep");
    await b.setRole(OWNER, who, "manager");
    const found = await call(`/_api/admin/users/${encodeURIComponent(who)}/apps`, { as: OWNER });
    expect(await found.json()).toMatchObject({ email: who, account: null, apps: [{ how: "member", owner: OWNER }, { how: "member", owner: OWNER }] });
    expect((await call(`/_api/admin/users/${encodeURIComponent(who)}/apps`, { as: REP })).status).toBe(403);
    expect(await (await call(`/admin/users?find=${encodeURIComponent(who)}`, { as: OWNER })).text()).toContain('data-action="deletion-notify"');

    const sent: { to: string; subject: string; text: string }[] = [];
    const EENV = { ...(env as unknown as Env), EMAIL: { send: async (m: never) => { sent.push(m); return { messageId: "m" }; } }, EMAIL_FROM: "Formelab <hello@example.com>" } as unknown as Env;
    const admin: User = { email: OWNER, name: null, isAdmin: true, active: true };
    expect(await notifyOwnersOfDeletion(EENV, admin, who, "https://admin.example.com/")).toEqual({ ok: true, owners: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: OWNER, subject: `${who} asked to have their data deleted` });
    expect(sent[0]!.text).toContain(`https://app.example.com/apps/${a.id}`);
    expect(sent[0]!.text).toContain(`https://app.example.com/apps/${b.id}`);
  });
});
