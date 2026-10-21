import { Hono, type Context } from "hono";
import { canManageSite } from "./auth";
import type { AppEnv } from "./env";
import { badRequest, err, forbidden, jsonError, onError } from "./errors";
import { kvDelete, kvGet, kvList, kvSet, type KvScope } from "./kv";
import { proxy, secretDelete, secretList, secretSet } from "./secrets";
import { geminiAvailable, geminiGenerate } from "./gemini";
import { flagOnForOwner } from "./flags";
import { sheetsAvailable, sheetsCall } from "./sheets";
import { getNamespace } from "./sites";
import { deleteResponse, listResponses, submitResponse } from "./responses";

/**
 * The per-app runtime API on an app's own host, <host_label>.APP_DOMAIN/_api/*. The parent sets
 * c.var.user and c.var.site from the host (after checking the user may open the app), so a page
 * can only ever reach its own app's data: each app is its own origin. This router enforces the
 * CSRF/origin rules.
 */
export function runtimeApi() {
  const api = new Hono<AppEnv>();
  api.onError(onError);

  api.use("*", async (c, next) => {
    if (c.req.method === "OPTIONS") {
      // Never answer preflights permissively: no Access-Control-Allow-* headers.
      return jsonError(forbidden("Cross-origin requests are not allowed."));
    }
    const origin = c.req.header("origin");
    if (origin && origin !== new URL(c.req.url).origin) {
      return jsonError(forbidden("Cross-origin requests are not allowed."));
    }
    // The SDK sends this header on every call. It no longer picks the app (the host does), but a
    // custom header still forces a CORS preflight on cross-site requests, which we refuse above.
    if (!c.req.header("x-formelab-mount")) {
      return jsonError(badRequest("Missing x-formelab-mount header.", "Call the API through the SDK: <script src=\"/_platform/sdk.js\"></script>."));
    }
    await next();
    c.header("cache-control", "no-store");
  });

  // Guests (people who came in through the app's public link) can see the app and read its shared
  // data, and send it responses if the owner allows that. Everything else that writes, or spends
  // the owner's keys and accounts, needs a sign-in.
  api.use("*", async (c, next) => {
    if (!c.get("guest")) return next();
    const path = new URL(c.req.url).pathname;
    const reads = c.req.method === "GET" && (path === "/_api/me" || path === "/_api/kv" || path.startsWith("/_api/kv/"));
    if (c.req.method === "POST" && path === "/_api/responses") {
      if (c.get("site").guest_responses) return next();
      throw err(
        401,
        "sign_in_required",
        "Sign in to send this: the app's owner hasn't let people who open it through its public link send responses.",
        "Ask the app's owner to turn on \"Let people with the link send responses\" (its Public link settings, or update_site's guest_responses).",
      );
    }
    if (!reads) {
      throw err(
        401,
        "sign_in_required",
        "Sign in to do that: people who open this app through its public link can only look.",
        "Call formelab.signIn() to send them to sign in, or check formelab.me(), which is null for them.",
      );
    }
    await next();
  });

  api.get("/me", (c) => {
    if (c.get("guest")) return c.json(null);
    const u = c.get("user");
    return c.json({ email: u.email, name: u.name });
  });

  // Keys may contain "/" (sent percent-encoded); take the raw remainder of the path.
  const keyFrom = (path: string, base: string) => {
    const raw = path.slice(path.indexOf(base) + base.length);
    try {
      return decodeURIComponent(raw);
    } catch {
      throw badRequest("The key is not correctly URL-encoded.", "Use the SDK, which encodes keys for you.");
    }
  };
  type Ctx = { env: AppEnv["Bindings"]; get: <K extends keyof AppEnv["Variables"]>(k: K) => AppEnv["Variables"][K]; req: { url: string; text(): Promise<string> } };
  const sharedKey = (c: Ctx) => keyFrom(new URL(c.req.url).pathname, "/_api/kv/");
  const myKey = (c: Ctx) => keyFrom(new URL(c.req.url).pathname, "/_api/me/kv/");
  const readValue = async (c: Ctx) => {
    const body = await c.req.text();
    if (body.length > 64 * 1024 * 4) throw err(413, "value_too_large", "Values can be at most 64 KB of JSON.", "Split the data across several keys.");
    return body;
  };
  const shared = (c: Ctx) => ({ siteId: c.get("site").id });
  const mine = (c: Ctx) => ({ siteId: c.get("site").id, email: c.get("user").email });

  /** Shared data: everyone who can open the app reads it; who may change it is the app's kv_writes setting. */
  const requireDataWrite = async (c: Ctx) => {
    const site = c.get("site");
    if (site.kv_writes !== "editors") return;
    const nsRow = await getNamespace(c.env, c.get("namespace"));
    if (!nsRow || !canManageSite(c.get("user"), site, nsRow)) {
      throw err(
        403,
        "read_only_data",
        "Only this app's owner and editors can change its shared data.",
        "Keep each person's own data in formelab.kv.mine, or ask the owner to let everyone change the app's data (its settings, or update_site's data_writes).",
      );
    }
  };

  // A list too large for one response comes in pages: x-formelab-next names the key to continue after.
  const listKv = async (c: Context<AppEnv>, scope: KvScope) => {
    const { rows, next } = await kvList(c.env, scope, c.req.query("prefix") ?? "", c.req.query("after") ?? "");
    if (next !== null) c.header("x-formelab-next", encodeURIComponent(next));
    return c.json(rows);
  };
  api.get("/kv", (c) => listKv(c, shared(c)));
  api.get("/kv/*", async (c) => c.json(await kvGet(c.env, shared(c), sharedKey(c))));
  api.put("/kv/*", async (c) => {
    await requireDataWrite(c);
    return c.json(await kvSet(c.env, shared(c), sharedKey(c), await readValue(c)));
  });
  api.delete("/kv/*", async (c) => {
    await requireDataWrite(c);
    return c.json(await kvDelete(c.env, shared(c), sharedKey(c)));
  });

  // Each person's private data in this app: only they can read or change it.
  api.get("/me/kv", (c) => listKv(c, mine(c)));
  api.get("/me/kv/*", async (c) => c.json(await kvGet(c.env, mine(c), myKey(c))));
  api.put("/me/kv/*", async (c) => c.json(await kvSet(c.env, mine(c), myKey(c), await readValue(c))));
  api.delete("/me/kv/*", async (c) => c.json(await kvDelete(c.env, mine(c), myKey(c))));

  const requireManage = async (c: { env: AppEnv["Bindings"]; get: <K extends keyof AppEnv["Variables"]>(k: K) => AppEnv["Variables"][K] }, what = "manage its secrets") => {
    const nsRow = await getNamespace(c.env, c.get("namespace"));
    if (!nsRow || !canManageSite(c.get("user"), c.get("site"), nsRow)) {
      throw forbidden(`Only the app's owner or editors can ${what}.`);
    }
  };

  // Responses (see responses.ts): anyone who can open the app sends them; only managers read them.
  // Behind the responses flag, which follows the app's owner.
  const responsesGate = async (c: import("hono").Context<AppEnv>, next: () => Promise<void>) => {
    if (!(await flagOnForOwner(c.env, "responses", c.get("site").owner_email))) {
      throw err(403, "not_available", "Responses aren't available on Formelab yet.", "Check back soon; the app can't collect responses until then.");
    }
    await next();
  };
  api.use("/responses", responsesGate);
  api.use("/responses/*", responsesGate);
  api.post("/responses", async (c) => {
    const guest = !!c.get("guest");
    const body = await c.req.text();
    const ip = c.req.header("cf-connecting-ip") ?? null;
    return c.json(await submitResponse(c.env, c.get("site"), guest ? null : c.get("user").email, body, ip), 201);
  });
  api.get("/responses", async (c) => {
    await requireManage(c, "read its responses");
    const limit = c.req.query("limit");
    return c.json(await listResponses(c.env, c.get("site").id, { before: c.req.query("before"), limit: limit ? Number(limit) : undefined }));
  });
  api.delete("/responses/:id", async (c) => {
    await requireManage(c, "delete its responses");
    return c.json(await deleteResponse(c.env, c.get("site").id, c.req.param("id")));
  });

  api.get("/secrets", async (c) => c.json(await secretList(c.env, c.get("site").id)));
  api.put("/secrets/:name", async (c) => {
    await requireManage(c);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw badRequest("The body must be JSON like { \"value\": \"...\" }.", "Use formelab.secrets.set(name, value).");
    }
    return c.json(await secretSet(c.env, c.get("site"), c.get("user"), c.req.param("name"), body));
  });
  api.delete("/secrets/:name", async (c) => {
    await requireManage(c);
    return c.json(await secretDelete(c.env, c.get("site"), c.get("user"), c.req.param("name")));
  });
  api.post("/secrets/:name/proxy", async (c) => {
    const len = Number(c.req.header("content-length") ?? 0);
    if (len > 2 * 1024 * 1024) throw err(413, "body_too_large", "The proxy request body is larger than 1 MB.", "Send less data.");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw badRequest("The body must be JSON like { \"url\": \"https://...\" }.", "Use formelab.secrets.proxy(name, { url }).");
    }
    if (!body || typeof body !== "object") throw badRequest("The body must be a JSON object.", "Use formelab.secrets.proxy(name, { url }).");
    return c.json(await proxy(c.env, c.get("site"), c.get("user"), c.req.param("name"), body as Record<string, unknown>));
  });

  // Gemini through the app owner's connected key (see gemini.ts). Anyone who can open the app can use it.
  // Behind the connected_apps flag, which follows the app's owner (it's their key).
  const connectedAppsGate = async (c: import("hono").Context<AppEnv>, next: () => Promise<void>) => {
    if (!(await flagOnForOwner(c.env, "connected_apps", c.get("site").owner_email))) {
      if (c.req.method === "GET") return c.json({ connected: false, available: false });
      throw err(403, "not_available", "Connected apps like Google Gemini and Google Sheets aren't available on Formelab yet.", "Check back soon; the app can't use AI until then.");
    }
    await next();
  };
  api.use("/ai/*", connectedAppsGate);
  api.use("/sheets", connectedAppsGate);
  api.get("/ai/gemini", async (c) => c.json({ ...(await geminiAvailable(c.env, c.get("site"))), available: true }));
  api.post("/ai/gemini", async (c) => {
    if (Number(c.req.header("content-length") ?? 0) > 2 * 1024 * 1024) throw err(413, "body_too_large", "The request to Gemini is larger than 1 MB.", "Send a shorter prompt or smaller images.");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw badRequest("The body must be JSON like { \"prompt\": \"...\" }.", 'Use formelab.gemini.generate("your prompt").');
    }
    if (!body || typeof body !== "object") throw badRequest("The body must be a JSON object.", 'Use formelab.gemini.generate("your prompt").');
    return c.json(await geminiGenerate(c.env, c.get("site"), c.get("user"), body as Record<string, unknown>));
  });

  // Google Sheets through the app owner's connected Google account (see sheets.ts).
  api.get("/sheets", async (c) => c.json(await sheetsAvailable(c.env, c.get("site"))));
  api.post("/sheets", async (c) => {
    if (Number(c.req.header("content-length") ?? 0) > 2 * 1024 * 1024) throw err(413, "body_too_large", "The request to Google Sheets is larger than 1 MB.", "Send fewer rows at a time.");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw badRequest("The body must be JSON like { \"method\": \"GET\", \"path\": \"spreadsheets/...\" }.", "Use formelab.sheets.read/append/update/create.");
    }
    if (!body || typeof body !== "object") throw badRequest("The body must be a JSON object.", "Use formelab.sheets.read/append/update/create.");
    return c.json(await sheetsCall(c.env, c.get("site"), c.get("user"), body as Record<string, unknown>));
  });

  api.notFound(() => jsonError(err(404, "not_found", "No such API endpoint.", "Check the SDK reference in /_platform/guide.md.")));
  return api;
}
