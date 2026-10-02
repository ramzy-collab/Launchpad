import { describe, expect, it } from "vitest";
import { call, OWNER, PAGE, uniq } from "./helpers";

async function token(as = OWNER) {
  const res = await call("/_api/admin/tokens", { as, method: "POST", json: { name: "deploy-test", ttlHours: 1 } });
  return (await res.json<{ token: string }>()).token;
}

describe("deploy API (bearer token)", () => {
  it("publishes, lists, updates and deletes as the token's owner", async () => {
    const t = await token();
    const ns = uniq();
    const fd = new FormData();
    fd.set("file", new File([PAGE("deployed")], "app.html"));
    fd.set("namespace", ns);
    fd.set("mount_path", "d");
    fd.set("title", "Deployed");
    const pub = await call("/_api/deploy/sites", { token: t, method: "POST", body: fd });
    expect(pub.status).toBe(201);
    const { url, site } = await pub.json<{ url: string; site: { id: string; ownerEmail: string } }>();
    expect(url).toBe(`https://${ns}.example.com/d/`);
    expect(site.ownerEmail).toBe(OWNER);

    const list = await (await call(`/_api/deploy/sites?namespace=${ns}`, { token: t })).json<{ id: string }[]>();
    expect(list.map((s) => s.id)).toEqual([site.id]);
    const ns2 = await (await call("/_api/deploy/namespaces", { token: t })).json<{ label: string }[]>();
    expect(ns2.map((n) => n.label)).toContain(ns);

    expect((await call(`/_api/deploy/sites/${site.id}`, { token: t, method: "PATCH", json: { title: "Renamed" } })).status).toBe(200);
    expect((await call(`/_api/deploy/sites/${site.id}`, { token: t, method: "DELETE" })).status).toBe(200);
  });

  it("a token has exactly its owner's permissions", async () => {
    const ns = uniq();
    const ownerToken = await token();
    const fd = () => {
      const f = new FormData();
      f.set("file", new File([PAGE("x")], "x.html"));
      f.set("namespace", ns);
      return f;
    };
    expect((await call("/_api/deploy/sites", { token: ownerToken, method: "POST", body: fd() })).status).toBe(201);
    const other = await token("other@example.com");
    expect((await call("/_api/deploy/sites", { token: other, method: "POST", body: fd() })).status).toBe(409);
  });
});
