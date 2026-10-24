import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { accounts, appAt, call, OWNER, PAGE, publishHtml, uniq } from "./helpers";

type View = { id: string; title: string | null; mountPath: string; ownerEmail: string; editors: string[]; sharers: string[]; allowedEmails: string[]; visibility: string; publicUrl: string | null };

async function newApp(extra: Record<string, string> = {}, html = PAGE("x")) {
  const ns = uniq();
  const res = await publishHtml(OWNER, ns, "cfg", html, { title: "Team board", ...extra });
  expect(res.status).toBe(201);
  const { site } = await res.json<{ site: View }>();
  const api = (path: string, json?: unknown, as = OWNER, method = "POST") => call(`/_api/admin/sites/${site.id}${path}`, { as, method, ...(json === undefined ? {} : { json }) });
  const patch = (json: unknown, as = OWNER) => call(`/_api/admin/sites/${site.id}`, { as, method: "PATCH", json });
  const row = () => env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(site.id).first<Record<string, unknown>>();
  return { ns, site, api, patch, row };
}

const person = async (prefix: string) => {
  const email = `${prefix}-${uniq()}@example.com`;
  await accounts(email);
  return email;
};

describe("stars", () => {
  it("are each person's own, and only for apps they can open", async () => {
    const viewer = await person("star");
    const { site, api } = await newApp({ allowed_emails: viewer });
    expect((await api("/star", { starred: true }, OWNER, "PUT")).status).toBe(200);
    const mine = await (await call("/app", { as: OWNER })).text();
    expect(mine).toContain(`class="ac-btn star on" data-star="${site.id}" aria-pressed="true"`);
    // The viewer hasn't starred it.
    const theirs = await (await call("/app", { as: viewer })).text();
    expect(theirs).toContain(`class="ac-btn star" data-star="${site.id}" aria-pressed="false"`);
    expect((await api("/star", { starred: true }, viewer, "PUT")).status).toBe(200);
    expect(await (await call("/app", { as: viewer })).text()).toContain(`data-star="${site.id}" aria-pressed="true"`);
    // Unstar, bad input, and apps you can't open.
    expect((await api("/star", { starred: false }, OWNER, "PUT")).status).toBe(200);
    expect(await (await call("/app", { as: OWNER })).text()).toContain(`data-star="${site.id}" aria-pressed="false"`);
    expect((await api("/star", { starred: "yes" }, OWNER, "PUT")).status).toBe(400);
    expect((await api("/star", { starred: true }, await person("stranger"), "PUT")).status).toBe(404);
    // Deleting the app removes its stars.
    expect((await call(`/_api/admin/sites/${site.id}`, { as: OWNER, method: "DELETE" })).status).toBe(200);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM app_stars WHERE site_id = ?").bind(site.id).first("n")).toBe(0);
  });
});

describe("Editors and Admins need an account", () => {
  it("refuses new editors without one, and says who lacks one", async () => {
    const pal = await person("pal");
    const nobody = `nobody-${uniq()}@example.com`;
    const { api, patch } = await newApp();
    const refused = await patch({ editors: [pal, nobody] });
    expect(refused.status).toBe(409);
    const body = await refused.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("needs_account");
    expect(body.error.message).toContain(nobody);
    expect(body.error.message).not.toContain(pal);
    expect((await patch({ editors: [pal] })).status).toBe(200);
    expect((await (await api("/people/check", { emails: [pal, nobody] })).json<{ withoutAccount: string[] }>()).withoutAccount).toEqual([nobody]);
    // Only people who can share the app may check.
    expect((await api("/people/check", { emails: [nobody] }, pal)).status).toBe(403);
  });

  it("sends a sign-up invite that makes them a Viewer now and an Editor or Admin once they join", async () => {
    const newbie = `new-${uniq()}@example.com`;
    const boss = `boss-${uniq()}@example.com`;
    const { site, api, row } = await newApp();
    const sent = await api("/invites", { emails: [newbie], role: "editor" });
    expect(sent.status).toBe(200);
    const res = await sent.json<{ invited: string[]; site: View }>();
    expect(res.invited).toEqual([newbie]);
    expect(res.site.allowedEmails).toContain(newbie);
    expect((await api("/invites", { emails: [boss], role: "admin" })).status).toBe(200);

    const page = await (await call(`/app/apps/${site.id}`, { as: OWNER })).text();
    expect(page).toContain("Sign-up invite sent. Becomes an Editor once they join Formelab.");
    expect(page).toContain("Sign-up invite sent. Becomes an Admin once they join Formelab.");

    // They join (their first sign-in creates the account): the roles apply and the invites go.
    await call("/_api/admin/whoami", { as: newbie });
    await call("/_api/admin/whoami", { as: boss });
    const after = (await row())!;
    expect(JSON.parse(after.editors as string)).toEqual(expect.arrayContaining([newbie, boss]));
    expect(JSON.parse(after.sharers as string)).toEqual([boss]);
    expect(JSON.parse(after.allowed_emails as string)).not.toContain(newbie);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM pending_role_invites WHERE site_id = ?").bind(site.id).first("n")).toBe(0);
    const log = await (await call(`/app/apps/${site.id}/activity`, { as: OWNER })).text();
    expect(log).toContain("Sent " + newbie + " a sign-up invite to become an Editor");
    expect(log).toContain("Joined Formelab and became an Admin");
  });

  it("only invites people without an account, and only the owner can", async () => {
    const pal = await person("pal");
    const { api, patch } = await newApp();
    expect((await api("/invites", { emails: [pal], role: "editor" })).status).toBe(400);
    expect((await api("/invites", { emails: [`x-${uniq()}@example.com`], role: "viewer" })).status).toBe(400);
    expect((await api("/invites", { emails: ["not an email"], role: "editor" })).status).toBe(400);
    await patch({ editors: [pal], sharers: [pal] });
    expect((await api("/invites", { emails: [`y-${uniq()}@example.com`], role: "editor" }, pal)).status).toBe(403);
  });

  it("drops a sign-up invite when the person loses access", async () => {
    const newbie = `gone-${uniq()}@example.com`;
    const { site, api, patch } = await newApp();
    await api("/invites", { emails: [newbie], role: "editor" });
    expect((await patch({ allowed_emails: [] })).status).toBe(200);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM pending_role_invites WHERE site_id = ?").bind(site.id).first("n")).toBe(0);
  });

  it("notes viewers who have no account yet", async () => {
    const pal = await person("pal");
    const loose = `loose-${uniq()}@example.com`;
    const { site } = await newApp({ allowed_emails: `${pal}, ${loose}` });
    const page = await (await call(`/app/apps/${site.id}`, { as: OWNER })).text();
    expect(page).toContain(`<span class="pe">${loose}</span><span class="ps">Invited, no Formelab account yet</span>`);
    expect(page).toContain(`<span class="pe">${pal}</span><span class="ps">Invited</span>`);
  });
});

describe("transferring ownership", () => {
  it("hands the app to an Admin; the old owner stays an Admin and loses delete", async () => {
    const admin = await person("admin");
    const editor = await person("editor");
    const { ns, site, api, patch, row } = await newApp({ editors: `${admin}, ${editor}` });
    await patch({ sharers: [admin] });
    expect((await api("/transfer", { to: editor, confirm: true })).status).toBe(400); // not an Admin
    expect((await api("/transfer", { to: admin })).status).toBe(400); // not confirmed
    expect((await api("/transfer", { to: admin, confirm: true }, editor)).status).toBe(403); // not the owner

    const done = await api("/transfer", { to: admin, confirm: true });
    expect(done.status).toBe(200);
    const r = (await row())!;
    expect(r.owner_email).toBe(admin);
    expect(r.space_owner_powers).toBe(0);
    expect(JSON.parse(r.editors as string)).toEqual(expect.arrayContaining([OWNER, editor]));
    expect(JSON.parse(r.editors as string)).not.toContain(admin);
    expect(JSON.parse(r.sharers as string)).toEqual([OWNER]);

    // The old owner (who still owns the space) now finds it under Shared with you, as an Admin, and can't delete it.
    const mine = await (await call("/app", { as: OWNER })).text();
    expect(mine).toContain(`data-id="${site.id}" data-owner="shared"`);
    expect(mine).toContain(`From ${admin}`);
    const page = await (await call(`/app/apps/${site.id}`, { as: OWNER })).text();
    expect(page).toContain(`<strong>${admin}</strong> owns this app. You're an Admin.`);
    expect(page).not.toContain('id="dlg-delete"');
    expect((await call(`/_api/admin/sites/${site.id}`, { as: OWNER, method: "DELETE" })).status).toBe(403);
    // They can still share it, as an Admin.
    expect((await patch({ allowed_emails: [`v-${uniq()}@example.com`] })).status).toBe(200);
    // The space can't be deleted from under the new owner.
    expect((await call(`/_api/admin/namespaces/${ns}`, { as: OWNER, method: "DELETE" })).status).toBe(409);
    // The new owner sees it in My apps, can delete it, and the change is in its activity.
    expect(await (await call("/app", { as: admin })).text()).toContain(`data-id="${site.id}"`);
    expect(await (await call(`/app/apps/${site.id}/activity`, { as: admin })).text()).toContain(`Made ${admin} the owner (${OWNER} stays on as an Admin)`);
    expect((await call(`/_api/admin/sites/${site.id}`, { as: admin, method: "DELETE" })).status).toBe(200);
  });

  it("needs the new owner to have an account", async () => {
    const newbie = `acct-${uniq()}@example.com`;
    const { site, api } = await newApp();
    // An Admin without an account, from before accounts were required.
    await env.DB.prepare("UPDATE sites SET editors = ?, sharers = ? WHERE id = ?").bind(JSON.stringify([newbie]), JSON.stringify([newbie]), site.id).run();
    const res = await api("/transfer", { to: newbie, confirm: true });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: { message: string } }>()).error.message).toContain("doesn't have a Formelab account");
  });
});

describe("making a copy", () => {
  it("copies the files into a new invited-only app in the same space, without people or data", async () => {
    const pal = await person("pal");
    const { ns, site, api, patch } = await newApp({ allowed_emails: pal, editors: pal });
    await patch({ public_link: true });
    const first = await api("/copy");
    expect(first.status).toBe(201);
    const copy = (await first.json<{ site: View }>()).site;
    expect(copy).toMatchObject({ title: "Team board (copy)", mountPath: "cfg-copy", ownerEmail: OWNER, editors: [], allowedEmails: [], visibility: "restricted", publicUrl: null });
    expect(copy.id).not.toBe(site.id);
    expect(await (await call(`${await appAt(ns, "cfg-copy")}/`, { as: OWNER, mount: "/" })).text()).toContain("x");
    expect((await (await api("/copy")).json<{ site: View }>()).site.mountPath).toBe("cfg-copy-2");
    // An editor of the app who can't publish in its space can't copy it.
    expect((await api("/copy", undefined, pal)).status).toBe(403);
  });
});

describe("the Answers page", () => {
  const FORM = `<!doctype html><html><head><title>RSVP</title></head><body><script>formelab.responses.submit({})</script></body></html>`;
  beforeAll(async () => {
    await env.DB.prepare("INSERT OR REPLACE INTO feature_flags (name, state, updated_at, updated_by) VALUES ('responses', 'on', 0, 'test')").run();
  });

  it("lists every answer for the owner and editors only, with a spreadsheet download", async () => {
    const editor = await person("editor");
    const viewer = await person("viewer");
    const { ns, patch } = await newApp({ editors: editor, allowed_emails: viewer, title: "RSVP" }, FORM);
    const origin = await appAt(ns, "cfg");
    const app = (path: string, as: string, init: Parameters<typeof call>[1] = {}) => call(`${origin}${path}`, { as, mount: "/", ...init });
    expect((await app("/_api/responses", viewer, { method: "POST", body: JSON.stringify({ name: "Ana", coming: "Yes" }) })).status).toBe(201);
    expect((await app("/_api/responses", OWNER, { method: "POST", body: JSON.stringify({ name: "Sam", note: "<b>hi</b>" }) })).status).toBe(201);

    const res = await app("/answers", OWNER);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await res.text();
    expect(html).toContain("Only you and the app's editors can open this page.");
    expect(html).toContain("<th>name</th><th>coming</th><th>note</th><th>From</th><th>Sent</th>");
    expect(html).toContain("&lt;b&gt;hi&lt;/b&gt;");
    expect(html).toContain("You and 1 editor");
    expect((await app("/answers", editor)).status).toBe(200);
    const csv = await app("/answers.csv", editor);
    expect(csv.headers.get("content-disposition")).toContain("RSVP answers.csv");
    expect(await csv.text()).toContain("Ana");

    // Viewers and guests with the public link can't open it.
    expect((await app("/answers", viewer)).status).toBe(403);
    const { publicUrl } = await (await patch({ public_link: true })).json<View>();
    const cookie = (await call(publicUrl!)).headers.get("set-cookie")!.split(";")[0]!;
    expect((await call(`${origin}/answers`, { headers: { cookie } })).status).toBe(403);
  });

  it("adds an Answers link to the app for its owner and editors only", async () => {
    const viewer = await person("viewer");
    const { ns } = await newApp({ allowed_emails: viewer }, FORM);
    const origin = await appAt(ns, "cfg");
    expect(await (await call(`${origin}/`, { as: OWNER, mount: "/" })).text()).toContain('<a href="/answers" data-formelab-answers');
    expect(await (await call(`${origin}/`, { as: viewer, mount: "/" })).text()).not.toContain("data-formelab-answers");
    // Apps that don't collect answers get no link.
    const plain = await newApp();
    expect(await (await call(`${await appAt(plain.ns, "cfg")}/`, { as: OWNER, mount: "/" })).text()).not.toContain("data-formelab-answers");
  });

  it("leaves /answers to the app when the responses feature is off for its owner", async () => {
    const { ns } = await newApp({}, FORM);
    await env.DB.prepare("UPDATE feature_flags SET state = 'off' WHERE name = 'responses'").run();
    try {
      const res = await call(`${await appAt(ns, "cfg")}/answers`, { as: OWNER, mount: "/" });
      expect(res.status).toBe(404);
      expect(await res.text()).toContain("This app has no file at this address.");
    } finally {
      await env.DB.prepare("UPDATE feature_flags SET state = 'on' WHERE name = 'responses'").run();
    }
  });
});
