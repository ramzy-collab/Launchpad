import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { call, OWNER, PAGE, publishHtml, publishZip, uniq } from "./helpers";

type Refusal = { error: { code: string; message: string; hint: string; details?: { title: string; prompt: string; prefixes: string[] } } };
type Published = { site: { id: string } };

const DATA_APP = PAGE(`<script>formelab.kv.set("lead:" + id, v); formelab.kv.get("settings")</script>`);
const INVITES = JSON.stringify({ manage_roles: ["manager"], records: { lead: { prefix: "lead:", read: { manager: "all" } } } });
const row = (id: string) => env.DB.prepare("SELECT rules_required, access FROM sites WHERE id = ?").bind(id).first<{ rules_required: number; access: string }>();
const siteAt = (ns: string, mount: string) => env.DB.prepare("SELECT id FROM sites WHERE namespace = ? AND mount_path = ?").bind(ns, mount).first<{ id: string }>();

describe("access rules on publish", () => {
  it("refuses a new app that saves data without rules, with a prompt to paste into an AI tool", async () => {
    const ns = uniq();
    const res = await publishHtml(OWNER, ns, "crm", DATA_APP);
    expect(res.status).toBe(400);
    const { error } = await res.json<Refusal>();
    expect(error.code).toBe("rules_required");
    expect(error.message).toBe("This app can't be published yet. It saves data (we found lead: and settings records) but has no access rules, so we can't tell who should see what.");
    expect(error.details!.title).toBe("This app can't be published yet");
    expect(error.details!.prefixes).toEqual(["lead:", "settings"]);
    expect(error.details!.prompt).toBe(
      "My Formelab app saves data under these keys: lead:, settings. Write a formelab.json access rules file for it, following https://example.com/guide#access-rules. Ask me who should see and change each kind of record before you write it.",
    );
    expect(error.hint).toContain(error.details!.prompt);
    expect(await siteAt(ns, "crm")).toBeNull();
  });

  it("refuses a new app that only uses connected services, saying so", async () => {
    const res = await publishHtml(OWNER, uniq(), "s", PAGE(`<script>formelab.sheets.read(id, "A1")</script>`));
    const { error } = await res.json<Refusal>();
    expect(error.message).toBe("This app can't be published yet. It uses Google Sheets but has no access rules, so we can't tell who should see what.");
    expect(error.details!.prompt).toMatch(/^My Formelab app uses Google Sheets\. Write a formelab\.json/);
  });

  it("publishes a new app with valid rules, or one that saves nothing, and remembers the scan", async () => {
    const ns = uniq();
    const ok = await publishZip(OWNER, ns, "crm", { "index.html": DATA_APP, "formelab.json": '{"everyone":"all"}' });
    expect(ok.status).toBe(201);
    const r = (await row((await ok.json<Published>()).site.id))!;
    expect(r.rules_required).toBe(1);
    expect(JSON.parse(r.access)).toEqual({ kv: true, prefixes: ["lead:", "settings"], dynamic: false, sheets: false, connectors: false, rules: true, invites: false });

    const plain = await publishHtml(OWNER, ns, "plain", PAGE("hi"));
    expect(plain.status).toBe(201);
    // Still marked new: adding data later needs rules.
    const again = await publishHtml(OWNER, ns, "plain", DATA_APP);
    expect((await again.json<Refusal>()).error.code).toBe("rules_required");
  });

  it("refuses a broken formelab.json for every app, with the exact problem", async () => {
    const ns = uniq();
    const res = await publishZip(OWNER, ns, "x", { "index.html": PAGE("hi"), "formelab.json": '{"records":{"lead":{"prefix":"l:","read":{"boss":"mine"}}}}' });
    expect(res.status).toBe(400);
    expect((await res.json<Refusal>()).error).toMatchObject({ code: "rules_invalid", message: 'formelab.json: records.lead.read.boss is "mine". Use "all", "own" or "none".' });

    const old = await publishHtml(OWNER, ns, "old", PAGE("hi"));
    const id = (await old.json<Published>()).site.id;
    await env.DB.prepare("UPDATE sites SET rules_required = 0 WHERE id = ?").bind(id).run();
    const broken = await publishZip(OWNER, ns, "old", { "index.html": PAGE("hi"), "formelab.json": "{" });
    expect((await broken.json<Refusal>()).error.code).toBe("rules_invalid");
  });

  it("lets apps made before rules keep publishing data without them, noting it for the settings warning", async () => {
    const ns = uniq();
    const id = (await (await publishHtml(OWNER, ns, "menu", PAGE("hi"))).json<Published>()).site.id;
    await env.DB.prepare("UPDATE sites SET rules_required = 0, access = NULL WHERE id = ?").bind(id).run();
    const res = await publishHtml(OWNER, ns, "menu", DATA_APP);
    expect(res.status).toBe(200);
    expect(JSON.parse((await row(id))!.access)).toMatchObject({ kv: true, rules: false });

    // A copy of it is no newer than the app.
    const copy = await call(`/_api/admin/sites/${id}/copy`, { as: OWNER, method: "POST" });
    expect(copy.status).toBe(201);
    expect((await row((await copy.json<Published>()).site.id))!.rules_required).toBe(0);
  });

  it("asks once before publishing rules that let people in the app invite others", async () => {
    const ns = uniq();
    const files = { "index.html": DATA_APP, "formelab.json": INVITES };
    const ask = await publishZip(OWNER, ns, "team", files);
    expect(ask.status).toBe(409);
    expect((await ask.json<Refusal>()).error).toMatchObject({
      code: "confirm_public",
      message: "People using this app can invite anyone. Treat it as public: anyone they invite can open it.",
    });
    expect(await siteAt(ns, "team")).toBeNull();

    const yes = await publishZip(OWNER, ns, "team", files, { confirm_public: "true" });
    expect(yes.status).toBe(201);
    const id = (await yes.json<Published>()).site.id;
    const logged = await env.DB.prepare("SELECT detail FROM audit WHERE site_id = ? AND action = 'publish'").bind(id).first<{ detail: string }>();
    expect(JSON.parse(logged!.detail).confirmedPublic).toBe(true);

    // Already accepted: the next version doesn't ask again.
    expect((await publishZip(OWNER, ns, "team", files)).status).toBe(200);
  });
});
