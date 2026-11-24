import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
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
