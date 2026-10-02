import { Hono, type Context } from "hono";
import { listTokens, mintToken, revokeToken, TOKEN_DEFAULT_TTL_HOURS } from "./auth";
import type { AppEnv } from "./env";
import { badRequest, err, jsonError, onError } from "./errors";
import {
  createNamespace,
  deleteNamespace,
  deleteSite,
  listNamespaces,
  listSites,
  publishSite,
  updateNamespaceEditors,
  updateSite,
  type Ctx,
} from "./sites";
import { filesFromHtml, filesFromUpload, filesFromZip, MAX_UPLOAD_BYTES, type FileMap } from "./upload";
import { b64decode } from "./util";

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

  api.post("/sites", async (c) => {
    const len = Number(c.req.header("content-length") ?? 0);
    if (len > MAX_UPLOAD_BYTES * 1.4 + 1024 * 1024) throw err(413, "too_large", "The upload is larger than 25 MB.", "Shrink the upload and try again.");
    const type = c.req.header("content-type") ?? "";
    let fields: Record<string, unknown>;
    let files: FileMap;
    if (type.includes("application/json")) {
      fields = await jsonBody(c);
      files = filesFromJson(fields);
    } else if (type.includes("multipart/form-data")) {
      const form = await c.req.formData();
      const file = form.get("file");
      if (!file || typeof file === "string") throw badRequest("Missing the file field.", "Attach the .html or .zip as a form field named \"file\".");
      files = filesFromUpload(file.name ?? "", new Uint8Array(await file.arrayBuffer()));
      fields = {};
      for (const [k, v] of form.entries()) if (typeof v === "string") fields[k] = v;
    } else {
      throw badRequest("Unsupported content type.", "Send multipart/form-data with a file field, or JSON with html or zip_base64.");
    }
    const result = await publishSite(ctxOf(c), {
      namespace: fields.namespace,
      mountPath: fields.mount_path ?? "",
      files,
      title: fields.title,
      spa: fields.spa,
      visibility: fields.visibility,
      allowedEmails: fields.allowed_emails,
      editors: fields.editors,
    });
    return c.json(result, result.replaced ? 200 : 201);
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
    api.get("/tokens", async (c) => c.json(await listTokens(c.env, c.get("user"))));
    api.delete("/tokens/:id", async (c) => {
      await revokeToken(c.env, c.get("user"), c.req.param("id"));
      return c.json({ ok: true });
    });
  } else {
    api.all("/tokens/*", () => {
      throw err(403, "browser_only", "Deploy tokens can only be managed from the dashboard.", "Open the dashboard in a browser to create or revoke tokens.");
    });
    api.all("/tokens", () => {
      throw err(403, "browser_only", "Deploy tokens can only be managed from the dashboard.", "Open the dashboard in a browser to create or revoke tokens.");
    });
  }

  api.notFound(() => jsonError(err(404, "not_found", "No such API endpoint.", "Check the method and path against the README.")));
  api.onError(onError);
  return api;
}
