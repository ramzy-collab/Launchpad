import { Hono, type Context } from "hono";
import { listTokens, mintToken, revokeToken, TOKEN_DEFAULT_TTL_HOURS } from "./auth";
import type { AppEnv } from "./env";
import { ApiError, badRequest, err, errorBody, jsonError, onError } from "./errors";
import {
  createNamespace,
  deleteNamespace,
  deleteSite,
  listNamespaces,
  listSites,
  publishSite,
  requireManageableSite,
  siteIdByMount,
  siteManifest,
  updateNamespaceEditors,
  updateSite,
  type Ctx,
} from "./sites";
import { filesFromHtml, filesFromUpload, filesFromZip, MAX_UPLOAD_BYTES, type FileMap } from "./upload";
import { filesForPublish } from "./changes";
import { listConnections, revokeConnection } from "./oauth";
import { approveWaitlist, setPassword } from "./login";
import { connectGemini, disconnectGemini, geminiStatus } from "./gemini";
import { buildApp, connectBuilder, editApp, disconnectBuilder, parseBuilder } from "./builder";
import { addFlagUser, flagOn, removeFlagUser, setFlag } from "./flags";
import { sheetsDisconnect, sheetsStatus } from "./sheets";
import { deleteUser, listUsers, setAdmin } from "./users";
import { b64decode, isEmail } from "./util";

export const ctxOf = (c: Context<AppEnv>): Ctx => ({
  env: c.env,
  user: c.get("user"),
  waitUntil: (p) => c.executionCtx.waitUntil(p),
  requestUrl: c.req.url,
});

async function jsonBody(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  try {
    const v = await c.req.json();
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {}
  throw badRequest("The request body must be a JSON object.", "Send Content-Type: application/json with an object body.");
}

/** Builds a file map from either a JSON `{ html | zip_base64 }` body or a multipart `file` field. */
export function filesFromJson(body: Record<string, unknown>): FileMap {
  const hasHtml = typeof body.html === "string";
  const hasZip = typeof body.zip_base64 === "string";
  if (hasHtml === hasZip) throw badRequest("Provide exactly one of html or zip_base64.", "Send the page as html (a string), or a zip encoded as base64.");
  if (hasHtml) return filesFromHtml(body.html as string);
  const b64 = (body.zip_base64 as string).replace(/\s+/g, "");
  if (b64.length > Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 4) throw err(413, "too_large", "The upload is larger than 25 MB.", "Shrink the zip and try again.");
  let bytes: Uint8Array;
  try {
    bytes = b64decode(b64);
  } catch {
    throw badRequest("zip_base64 is not valid base64.", "Encode the zip file's bytes with base64.");
  }
  return filesFromZip(bytes);
}

/**
 * The management API. Mounted at /_api/admin (Access-authenticated) and at
 * /_api/deploy (bearer-token-authenticated); the caller sets c.var.user first.
 */
export function managementApi(kind: "admin" | "deploy") {
  const api = new Hono<AppEnv>();

  api.get("/whoami", (c) => {
    const u = c.get("user");
    return c.json({ email: u.email, name: u.name, isAdmin: u.isAdmin });
  });

  api.get("/namespaces", async (c) => c.json(await listNamespaces(ctxOf(c))));
  api.post("/namespaces", async (c) => c.json(await createNamespace(ctxOf(c), (await jsonBody(c)).label), 201));
  api.patch("/namespaces/:label", async (c) => c.json(await updateNamespaceEditors(ctxOf(c), c.req.param("label"), (await jsonBody(c)).editors)));
  api.delete("/namespaces/:label", async (c) => c.json(await deleteNamespace(ctxOf(c), c.req.param("label"))));

  api.get("/sites", async (c) => c.json(await listSites(ctxOf(c), c.req.query("namespace"))));

  // What the live version holds, so a deploy script can upload only what changed (scripts/publish.sh
  // --changed-only). format=sha256sum gives `sha256sum` lines; a file published before hashes were
  // kept shows 64 zeros, so it never matches and is uploaded again.
  api.get("/sites/manifest", async (c) => {
    const ctx = ctxOf(c);
    const { site } = await requireManageableSite(ctx, await siteIdByMount(ctx, c.req.query("namespace"), c.req.query("mount_path") ?? ""));
    const manifest = await siteManifest(c.env, site);
    if (c.req.query("format") === "sha256sum") {
      return c.text(manifest.files.map((f) => `${f.sha256 ?? "0".repeat(64)}  ${f.path}\n`).join(""));
    }
    return c.json(manifest);
  });

  api.post("/sites", async (c) => {
    const len = Number(c.req.header("content-length") ?? 0);
    if (len > MAX_UPLOAD_BYTES * 1.4 + 1024 * 1024) throw err(413, "too_large", "The upload is larger than 25 MB.", "Shrink the upload and try again.");
    const type = c.req.header("content-type") ?? "";
    const ctx = ctxOf(c);
    let fields: Record<string, unknown>;
    let publish: Awaited<ReturnType<typeof filesForPublish>>;
    if (type.includes("application/json")) {
      fields = await jsonBody(c);
      publish = await filesForPublish(ctx, fields);
    } else if (type.includes("multipart/form-data")) {
      const form = await c.req.formData();
      fields = {};
      for (const [k, v] of form.entries()) if (typeof v === "string") fields[k] = v;
      const file = form.get("file");
      if (fields.merge === "true") {
        // Only the changed files (a zip, optional when only deleting) laid over the live version,
        // and `delete`: paths to remove, one per line.
        const overlay = file && typeof file !== "string" ? filesFromZip(new Uint8Array(await file.arrayBuffer()), { partial: true }) : undefined;
        const del = typeof fields.delete === "string" ? fields.delete.split("\n").map((p) => p.trim()).filter(Boolean) : [];
        publish = await filesForPublish(ctx, { namespace: fields.namespace, mount_path: fields.mount_path }, {
          overlay: overlay ?? new Map(),
          ...(del.length ? { deletes: del } : {}),
        });
      } else {
        if (!file || typeof file === "string") throw badRequest("Missing the file field.", "Attach the .html or .zip as a form field named \"file\".");
        publish = { files: filesFromUpload(file.name ?? "", new Uint8Array(await file.arrayBuffer())) };
      }
    } else {
      throw badRequest("Unsupported content type.", "Send multipart/form-data with a file field, or JSON with html, zip_base64, files or edits.");
    }
    const result = await publishSite(ctx, {
      namespace: fields.namespace,
      mountPath: fields.mount_path ?? "",
      files: publish.files,
      expectedVersion: publish.expectedVersion,
      title: fields.title,
      spa: fields.spa,
      visibility: fields.visibility,
      allowedEmails: fields.allowed_emails,
      editors: fields.editors,
      dataWrites: fields.data_writes,
    });
    return c.json({ ...result, ...(publish.changed ? { changed: publish.changed } : {}) }, result.replaced ? 200 : 201);
  });

  api.patch("/sites/:id", async (c) => c.json(await updateSite(ctxOf(c), c.req.param("id"), await jsonBody(c))));
  api.delete("/sites/:id", async (c) => c.json(await deleteSite(ctxOf(c), c.req.param("id"))));

  if (kind === "admin") {
    api.post("/tokens", async (c) => {
      const body = await jsonBody(c);
      const ttl = body.ttlHours === undefined ? TOKEN_DEFAULT_TTL_HOURS : Number(body.ttlHours);
      const { token, info } = await mintToken(c.env, c.get("user"), String(body.name ?? ""), ttl);
      return c.json({ token, ...info }, 201);
    });
    api.put("/account/password", async (c) => {
      await setPassword(c.env, c.get("user"), c.get("sessionId"), (await jsonBody(c)).password);
      return c.json({ ok: true });
    });
    api.get("/tokens", async (c) => c.json(await listTokens(c.env, c.get("user"))));
    api.delete("/tokens/:id", async (c) => {
      await revokeToken(c.env, c.get("user"), c.req.param("id"));
      return c.json({ ok: true });
    });
    api.post("/waitlist/approve", async (c) => {
      if (!c.get("user").isAdmin) throw err(403, "admin_only", "Only an admin can let people in.", "Ask the Formelab owner.");
      const email = String((await jsonBody(c)).email ?? "").trim();
      if (!isEmail(email)) throw badRequest("That email address is not valid.", "Check the address and try again.");
      await approveWaitlist(c.env, email, { actor: c.get("user").email, requestUrl: c.req.url, waitUntil: (p) => c.executionCtx.waitUntil(p) });
      return c.json({ ok: true });
    });
    api.get("/users", async (c) => {
      if (!c.get("user").isAdmin) throw err(403, "admin_only", "Only an admin can list users.", "Ask the Formelab owner.");
      return c.json(await listUsers(c.env));
    });
    api.post("/users/:email/admin", async (c) => c.json(await setAdmin(c.env, c.get("user"), c.req.param("email"), (await jsonBody(c)).admin)));
    api.delete("/users/:email", async (c) => c.json(await deleteUser(c.env, c.get("user"), c.req.param("email"))));
    // The easy way, built in: the person's own Claude or OpenAI key builds and publishes the app.
    // Behind the app_builder flag (admin panel → Features).
    const builderFlag = async (c: Context<AppEnv>, next: () => Promise<void>) => {
      if (!(await flagOn(c.env, "app_builder", c.get("user")))) throw err(404, "not_found", "Building apps with your own API key isn't available yet.", "Check back soon.");
      await next();
    };
    api.use("/builders/*", builderFlag);
    api.use("/build", builderFlag);
    api.put("/builders/:provider", async (c) => c.json(await connectBuilder(c.env, c.get("user"), parseBuilder(c.req.param("provider")), (await jsonBody(c)).apiKey)));
    api.delete("/builders/:provider", async (c) => c.json(await disconnectBuilder(c.env, c.get("user"), parseBuilder(c.req.param("provider")))));
    api.post("/build", async (c) => {
      const body = await jsonBody(c);
      const provider = parseBuilder(body.provider);
      // A build takes a minute or more: stream progress lines (NDJSON) so the page can show it and
      // the connection stays busy. The last line is { done } or { error }.
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      const writer = writable.getWriter();
      const enc = new TextEncoder();
      let open = true;
      const send = (v: unknown) => {
        if (open) writer.write(enc.encode(JSON.stringify(v) + "\n")).catch(() => (open = false));
      };
      let chars = 0;
      let sent = -1;
      const tick = setInterval(() => {
        if (chars !== sent || chars === 0) send({ progress: (sent = chars) });
      }, 1500);
      send({ progress: 0 });
      // With a site_id, change that app; otherwise make a new one from the idea.
      const onProgress = (n: number) => (chars = n);
      const job = body.site_id !== undefined ? editApp(ctxOf(c), provider, body.site_id, body.change, onProgress) : buildApp(ctxOf(c), provider, body.idea, onProgress);
      const work = job
        .then((done) => send({ done }))
        .catch((e) => {
          if (!(e instanceof ApiError)) console.error("build failed", e instanceof Error ? e.message : "");
          send(errorBody(e instanceof ApiError ? e : err(500, "internal", "Something went wrong while building.", "Try again in a moment.")));
        })
        .finally(() => {
          clearInterval(tick);
          if (open) writer.close().catch(() => {});
        });
      // Finish (and publish) even if the page is closed mid-build.
      c.executionCtx.waitUntil(work);
      return new Response(readable, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
    });
    // Connected apps are behind a feature flag (admin panel → Features).
    api.use("/services/*", async (c, next) => {
      if (!(await flagOn(c.env, "connected_apps", c.get("user")))) throw err(404, "not_found", "Connected apps aren't available yet.", "Check back soon.");
      await next();
    });
    api.get("/services/gemini", async (c) => c.json(await geminiStatus(c.env, c.get("user").email)));
    api.put("/services/gemini", async (c) => c.json(await connectGemini(c.env, c.get("user"), (await jsonBody(c)).apiKey)));
    api.delete("/services/gemini", async (c) => c.json(await disconnectGemini(c.env, c.get("user"))));
    api.get("/services/google-sheets", async (c) => c.json(await sheetsStatus(c.env, c.get("user").email)));
    api.delete("/services/google-sheets", async (c) => c.json(await sheetsDisconnect(c.env, c.get("user"))));
    api.put("/features/:name", async (c) => c.json(await setFlag(c.env, c.get("user"), c.req.param("name"), (await jsonBody(c)).state)));
    api.post("/features/:name/users", async (c) => c.json(await addFlagUser(c.env, c.get("user"), c.req.param("name"), (await jsonBody(c)).email)));
    api.delete("/features/:name/users/:email", async (c) => c.json(await removeFlagUser(c.env, c.get("user"), c.req.param("name"), c.req.param("email"))));
    api.get("/connections", async (c) => c.json(await listConnections(c.env, c.get("user").email)));
    api.delete("/connections/:id", async (c) => {
      await revokeConnection(c.env, c.get("user").email, c.req.param("id"));
      return c.json({ ok: true });
    });
  } else {
    api.all("/tokens/*", () => {
      throw err(403, "browser_only", "Deploy tokens can only be managed from the dashboard.", "Open the dashboard in a browser to create or revoke tokens.");
    });
    api.all("/connections", () => {
      throw err(403, "browser_only", "Connected apps can only be managed from the dashboard.", "Open the dashboard in a browser.");
    });
    api.all("/connections/*", () => {
      throw err(403, "browser_only", "Connected apps can only be managed from the dashboard.", "Open the dashboard in a browser.");
    });
    api.all("/tokens", () => {
      throw err(403, "browser_only", "Deploy tokens can only be managed from the dashboard.", "Open the dashboard in a browser to create or revoke tokens.");
    });
  }

  api.notFound(() => jsonError(err(404, "not_found", "No such API endpoint.", "Check the method and path against the README.")));
  api.onError(onError);
  return api;
}
