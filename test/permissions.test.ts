import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { call, OWNER, PAGE, publishHtml, uniq } from "./helpers";

type View = { visibility: string; allowedEmails: string[]; sharers: string[]; publicUrl: string | null };

async function newApp() {
  const ns = uniq();
  const ed = `ed-${uniq()}@example.com`;
  const sharer = `sharer-${uniq()}@example.com`;
  const nsEditor = `nse-${uniq()}@example.com`;
  const { site } = await (await publishHtml(OWNER, ns, "app", PAGE("x"), { editors: `${ed}, ${sharer}` })).json<{ site: { id: string } }>();
  await call(`/_api/admin/namespaces/${ns}`, { as: OWNER, method: "PATCH", json: { editors: nsEditor } });
  const patch = (as: string, json: unknown) => call(`/_api/admin/sites/${site.id}`, { as, method: "PATCH", json });
  return { ns, id: site.id, ed, sharer, nsEditor, patch };
}

describe("who can share and delete an app (audit #10)", () => {
  it("lets editors update an app but not change who can open it, unless the owner lets them", async () => {
    const { id, ed, sharer, nsEditor, patch } = await newApp();
    for (const who of [ed, nsEditor]) {
      expect((await patch(who, { title: `By ${who}` })).status, who).toBe(200);
      for (const change of [{ visibility: "all" }, { allowed_emails: "friend@example.com" }, { public_link: true }, { link_preview: "full" }]) {
        const res = await patch(who, change);
        expect(res.status, `${who} ${JSON.stringify(change)}`).toBe(403);
        expect((await res.json<{ error: { code: string; hint: string } }>()).error).toMatchObject({ code: "sharing_not_allowed" });
      }
      // The settings form sends every field: unchanged sharing fields are fine.
      expect((await patch(who, { visibility: "restricted", allowed_emails: "", title: "Same sharing" })).status).toBe(200);
    }
    const page = await (await call(`/app/apps/${id}`, { as: ed })).text();
    expect(page).toContain('data-access-choice="public" disabled');
    expect(page).toContain('data-dialog="dlg-reset" disabled');
    expect(page).not.toContain("data-invite>");
    expect(page).not.toContain('data-roles="viewer,editor,admin"');

    // Only the owner chooses who may share, and only among the editors.
    expect((await patch(ed, { sharers: ed })).status).toBe(403);
    expect((await patch(OWNER, { sharers: "stranger@example.com" })).status).toBe(400);
    expect((await (await patch(OWNER, { sharers: sharer })).json<View>()).sharers).toEqual([sharer]);
    expect(await (await call(`/app/apps/${id}`, { as: OWNER })).text()).toContain('data-roles="viewer,editor,admin"');
    const shared = await (await patch(sharer, { visibility: "all", allowed_emails: "friend@example.com", public_link: true })).json<View>();
    expect(shared).toMatchObject({ visibility: "all", allowedEmails: ["friend@example.com"] });
    expect(shared.publicUrl).toBeTruthy();
    expect((await patch(ed, { visibility: "restricted" })).status).toBe(403);

    // Removing someone as an editor removes their sharing too.
    expect((await (await patch(OWNER, { editors: ed })).json<View>()).sharers).toEqual([]);
    expect((await patch(sharer, { visibility: "restricted" })).status).toBe(403); // can open the app (open to all), not change it
    const log = await (await call(`/app/apps/${id}/activity`, { as: OWNER })).text();
    expect(log).toContain(`share it too`);
    expect(log).toContain(sharer);
  });

  it("lets only the owner (or the space's owner) delete an app, through the API or MCP", async () => {
    const { ns, id, ed, nsEditor } = await newApp();
    for (const who of [ed, nsEditor]) {
      const res = await call(`/_api/admin/sites/${id}`, { as: who, method: "DELETE" });
      expect(res.status, who).toBe(403);
      expect((await res.json<{ error: { code: string } }>()).error.code).toBe("owner_only");
    }
    const { token } = await (await call("/_api/admin/tokens", { as: ed, method: "POST", json: { name: "t" } })).json<{ token: string }>();
    const mcp = await call("/mcp", {
      method: "POST",
      token,
      headers: { accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
      json: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "delete_site", arguments: { namespace: ns, mount_path: "app" } } },
    });
    expect((await mcp.json<{ result: { content: { text: string }[] } }>()).result.content[0]!.text).toContain("owner_only");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM sites WHERE id = ?").bind(id).first<{ n: number }>()).toEqual({ n: 1 });
    // Editors can still publish new versions.
    expect((await publishHtml(ed, ns, "app", PAGE("v2"))).status).toBe(200);
    expect((await call(`/_api/admin/sites/${id}`, { as: OWNER, method: "DELETE" })).status).toBe(200);
  });
});
