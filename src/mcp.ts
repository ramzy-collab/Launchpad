import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { geminiStatus } from "./gemini";
import { sheetsStatus } from "./sheets";
import { enabledFlags, flagOn, withFlags } from "./flags";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { z } from "zod";
import { filesForPublish } from "./changes";
import { recordMcpCall } from "./usage";
import type { Env, User } from "./env";
import { ApiError, notFound } from "./errors";
import { GUIDE_MD } from "./generated/assets";
import { canViewSite } from "./auth";
import { apexOrigin } from "./oauth";
import {
  deleteSite,
  getNamespace,
  getSiteById,
  listNamespaces,
  listSites,
  getSiteByMount,
  publishSite,
  siteIdByMount,
  siteManifest,
  validateLabel,
  validateMountPath,
  siteView,
  updateSite,
  type Ctx,
} from "./sites";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/** Runs a service call and turns the result (or an ApiError) into an MCP tool result. */
async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const value = await fn();
    return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
  } catch (e) {
    if (e instanceof ApiError) {
      return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code: e.code, message: e.message, hint: e.hint } }, null, 2) }] };
    }
    console.error("mcp tool error", e instanceof Error ? e.message : "unknown");
    return { isError: true, content: [{ type: "text", text: "Internal error. Try again." }] };
  }
}

const emails = z.array(z.string()).optional();

export function buildServer(ctx: Ctx, beforeTools?: (server: McpServer) => void): McpServer {
  const server = new McpServer(
    { name: "formelab", version: "1.0.0" },
    {
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
      instructions:
        "Formelab hosts small self-contained web apps, each at its own address like https://hoops-7kq2." +
        ctx.env.APP_DOMAIN +
        "/ (publish returns it). You publish to a namespace (space) and mount_path, which name the app in Formelab. " +
        "Call get_guide before building an app for the first time, then publish with the publish tool. " +
        "Every app needs an icon (a small SVG favicon linked from index.html); publish refuses apps without one.",
    },
  );

  beforeTools?.(server);

  server.registerTool(
    "whoami",
    { description: "Show the account this token acts as, and which connected apps (like Google Gemini) its apps can use.", annotations: { readOnlyHint: true } },
    () =>
      run(async () => ({
        email: ctx.user.email,
        name: ctx.user.name,
        isAdmin: ctx.user.isAdmin,
        // Connected apps this person's apps can use through the SDK (see the guide), once the feature is on.
        ...((await flagOn(ctx.env, "connected_apps", ctx.user)) ? {
              connectedApps: {
                gemini: (await geminiStatus(ctx.env, ctx.user.email)).connected,
                googleSheets: (await sheetsStatus(ctx.env, ctx.user.email)).connected,
              },
            } : {}),
      })),
  );

  server.registerTool(
    "list_namespaces",
    { description: "List the namespaces (spaces) you own or can edit. A space groups apps and their editors; each app still gets its own address.", annotations: { readOnlyHint: true } },
    () => run(() => listNamespaces(ctx)),
  );

  server.registerTool(
    "list_sites",
    {
      description: "List sites. With a namespace: every site in it you can see. Without: every site you can manage.",
      inputSchema: { namespace: z.string().optional().describe("Namespace label, e.g. \"ramzy\"") },
      annotations: { readOnlyHint: true },
    },
    ({ namespace }) => run(() => listSites(ctx, namespace)),
  );

  server.registerTool(
    "publish",
    {
      description:
        "Publish (create or replace) an app and return its URL. Send either the whole app, as `html` (a complete single-file HTML document) " +
        "or `zip_base64` (a base64 zip with index.html at its root), or only changes to an existing app, as `edits` and/or `files`. " +
        "To update an existing app, ALWAYS send changes rather than the whole app: it is far faster for large apps. " +
        "`edits` are exact find-and-replace pairs applied to the app's current files on the server; read the current source first with read_file. " +
        "Files you don't mention stay as they are. Replacing an existing app keeps its KV data, secrets and " +
        "sharing settings: visibility and allowed_emails only apply to a new app; change sharing with update_site. " +
        "Creates the namespace if it does not exist yet. The app MUST have an icon: a small SVG that fits the app, linked from " +
        "index.html's <head> as <link rel=\"icon\" href=\"data:image/svg+xml,...\"> (or an icon.svg file in the zip); without one, publish fails with icon_required. " +
        "Also give it a <meta name=\"description\"> and a share illustration for link previews (iMessage, Slack, WhatsApp): a 1200x630 SVG " +
        "that shows what the app is, named by <meta property=\"og:image\" content=\"share.svg\"> (or an inline data:image/svg+xml URI); see the guide's \"Link previews\".",
      inputSchema: {
        html: z.string().optional().describe("Complete HTML document for a single-file app"),
        zip_base64: z.string().optional().describe("Base64-encoded .zip with index.html at its root"),
        edits: z
          .array(
            z.object({
              path: z.string().optional().describe("File to edit; default \"index.html\""),
              old_str: z.string().describe("Text copied exactly from the current file; must occur exactly once"),
              new_str: z.string().describe("Its replacement (\"\" deletes old_str)"),
            }),
          )
          .optional()
          .describe("Changes to an existing app: find-and-replace edits applied in order, all or nothing. Use instead of resending the whole app."),
        files: z
          .record(z.string(), z.string().nullable())
          .optional()
          .describe("Text files to add or replace whole, by path, e.g. {\"app.js\": \"...\"}; null deletes a file. Other files stay. Applied before edits. A new app can be made from files alone if index.html is among them."),
        namespace: z.string().describe("Namespace (subdomain) label, e.g. \"ramzy\""),
        mount_path: z.string().describe("The app's name in its space, e.g. \"budget\" or \"tools/budget\"; \"\" for the space's main app. Its address is generated from it, like https://budget-7kq2.<domain>/"),
        title: z.string().optional(),
        spa: z.boolean().optional().describe("Serve index.html for unknown extensionless paths (client-side routing)"),
        visibility: z.enum(["all", "restricted"]).optional().describe("Default \"restricted\": only the owner, editors and allowed_emails can open it. \"all\": every Formelab member (people let in, not those still on the waitlist)"),
        allowed_emails: emails,
        data_writes: z
          .enum(["editors", "everyone"])
          .optional()
          .describe("Who can change the app's shared data (formelab.kv): \"editors\" (owner and editors; the default for a new app) or \"everyone\" who can open it (polls, sign-ups, shared counters). Each person's own data goes in formelab.kv.mine either way."),
      },
    },
    (args) =>
      run(async () => {
        const { files, expectedVersion, changed } = await filesForPublish(ctx, args as Record<string, unknown>);
        const r = await publishSite(ctx, {
          namespace: args.namespace,
          mountPath: args.mount_path,
          files,
          expectedVersion,
          title: args.title,
          spa: args.spa,
          visibility: args.visibility,
          allowedEmails: args.allowed_emails,
          dataWrites: args.data_writes,
          requireIcon: true,
        });
        return { url: r.url, replaced: r.replaced, ...(changed ? { changed } : {}), site: r.site, ...(r.note ? { note: r.note } : {}) };
      }),
  );

  server.registerTool(
    "read_file",
    {
      description:
        "Read one file of an app's live version, exactly as published, to change it with publish's edits. " +
        `Returns up to ${READ_LIMIT / 1024} KB per call; for a larger file, call again with the next offset. Also lists the app's files.`,
      inputSchema: {
        namespace: z.string(),
        mount_path: z.string(),
        path: z.string().optional().describe("File path, e.g. \"app.js\"; default \"index.html\""),
        offset: z.number().int().min(0).optional().describe("Character to start from (for files larger than one call returns)"),
      },
      annotations: { readOnlyHint: true },
    },
    (args) => run(() => readFile(ctx, args.namespace, args.mount_path, args.path, args.offset)),
  );

  server.registerTool(
    "update_site",
    {
      description: "Change a site's settings. Fields you leave out stay as they are. Does not change the app's files (use publish for that).",
      inputSchema: {
        namespace: z.string(),
        mount_path: z.string(),
        title: z.string().optional(),
        hidden: z.boolean().optional().describe("Hide from listings (the URL still works)"),
        spa: z.boolean().optional(),
        visibility: z.enum(["all", "restricted"]).optional(),
        allowed_emails: emails,
        editors: emails,
        data_writes: z
          .enum(["editors", "everyone"])
          .optional()
          .describe("Who can change the app's shared data (formelab.kv): \"editors\" (owner and editors; the default for a new app) or \"everyone\" who can open it (polls, sign-ups, shared counters). Each person's own data goes in formelab.kv.mine either way."),
        sheets: z
          .array(z.string())
          .optional()
          .describe("Owner only: the Google spreadsheets (ids or links) this app may use through formelab.sheets. Replaces the list."),
      },
      annotations: { idempotentHint: true },
    },
    ({ namespace, mount_path, ...patch }) =>
      run(async () => updateSite(ctx, await siteIdByMount(ctx, namespace, mount_path), patch)),
  );

  server.registerTool(
    "delete_site",
    {
      description:
        "PERMANENTLY delete a site: its files, KV data and secrets are erased and cannot be recovered. Only call this when the user has clearly asked to delete this exact site.",
      inputSchema: { namespace: z.string(), mount_path: z.string() },
      annotations: { destructiveHint: true },
    },
    ({ namespace, mount_path }) => run(async () => deleteSite(ctx, await siteIdByMount(ctx, namespace, mount_path))),
  );

  server.registerTool(
    "get_guide",
    { description: "Return the Formelab app-building guide (markdown): URL model, SDK reference, patterns, starter app, checklist.", annotations: { readOnlyHint: true } },
    () => run(async () => withFlags(GUIDE_MD, await enabledFlags(ctx.env, ctx.user))),
  );

  // `search` and `fetch` follow the shape ChatGPT expects from connectors (outside Developer Mode
  // it only offers tools with these names): search returns {results: [{id, title, url}]}, fetch
  // returns {id, title, text, url, metadata}. Both are read-only.
  server.registerTool(
    "search",
    {
      description:
        "Search your Formelab apps by title, namespace, path or URL, plus the Formelab app-building guide. Returns ids to pass to fetch. An empty query lists everything.",
      inputSchema: { query: z.string().describe("Words to look for, e.g. \"budget\" or \"ramzy\"") },
      annotations: { readOnlyHint: true },
    },
    ({ query }) => run(() => searchItems(ctx, query)),
  );

  server.registerTool(
    "fetch",
    {
      description:
        "Fetch one item returned by search: an app's details and its index.html source, or the full Formelab guide.",
      inputSchema: { id: z.string().describe("An id from search, e.g. \"site:s_abc123\" or \"guide\"") },
      annotations: { readOnlyHint: true },
    },
    ({ id }) => run(() => fetchItem(ctx, id)),
  );

  return server;
}

const GUIDE_TITLE = "Formelab app-building guide";
const SOURCE_LIMIT = 200 * 1024;
const READ_LIMIT = 512 * 1024;

async function readFile(ctx: Ctx, rawNs: string, rawMount: string, rawPath = "index.html", offset = 0) {
  const label = validateLabel(rawNs);
  const site = await getSiteByMount(ctx.env, label, validateMountPath(rawMount));
  const ns = site ? await getNamespace(ctx.env, label) : null;
  // Same rule as fetch: anyone who may open the app may read its files.
  if (!site || !ns || !canViewSite(ctx.user, site, ns)) throw notFound(`Site ${label}/${rawMount}`);
  const { files } = await siteManifest(ctx.env, site);
  const path = rawPath.replace(/^\/+/, "") || "index.html";
  const listing = files.length > 200 ? `${files.slice(0, 200).map((f) => f.path).join(", ")}, … (${files.length} files)` : files.map((f) => `${f.path} (${f.bytes} bytes)`).join(", ");
  const obj = files.some((f) => f.path === path) ? await ctx.env.BUCKET.get(`sites/${site.id}/${site.current_version}/${path}`) : null;
  if (!obj) throw new ApiError(404, "not_found", `"${path}" is not in this app.`, `The app's files: ${listing}`);
  const bytes = new Uint8Array(await obj.arrayBuffer());
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return `${path} is a binary file (${bytes.length} bytes); it can be replaced but not read or edited as text.\nFiles: ${listing}`;
  }
  const end = Math.min(text.length, offset + READ_LIMIT);
  const more = end < text.length;
  return [
    `File: ${path} (${text.length} characters)${offset || more ? `, characters ${offset}-${end}` : ""}`,
    ...(more ? [`More follows: call read_file again with offset ${end}.`] : []),
    `Files: ${listing}`,
    "",
    text.slice(offset, end),
  ].join("\n");
}

async function searchItems(ctx: Ctx, query: string) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (hay: string) => terms.every((t) => hay.includes(t));
  const sites = await listSites(ctx);
  const results: { id: string; title: string; url: string }[] = sites
    .filter((s) => matches(`${s.title ?? ""} ${s.namespace} ${s.mountPath} ${s.url}`.toLowerCase()))
    .slice(0, 50)
    .map((s) => ({ id: `site:${s.id}`, title: s.title || `${s.namespace}/${s.mountPath || "(root)"}`, url: s.url }));
  const guideHay = `${GUIDE_TITLE} sdk guide help how build publish ${GUIDE_MD}`.toLowerCase();
  if (matches(guideHay)) {
    results.push({ id: "guide", title: GUIDE_TITLE, url: `${apexOrigin(ctx.env, ctx.requestUrl ?? "https://" + ctx.env.DOMAIN)}/_platform/guide.md` });
  }
  return { results };
}

async function fetchItem(ctx: Ctx, id: string) {
  if (id === "guide") {
    return {
      id,
      title: GUIDE_TITLE,
      text: withFlags(GUIDE_MD, await enabledFlags(ctx.env, ctx.user)),
      url: `${apexOrigin(ctx.env, ctx.requestUrl ?? "https://" + ctx.env.DOMAIN)}/_platform/guide.md`,
      metadata: { type: "guide" },
    };
  }
  const m = /^site:(s_[a-z2-7]+)$/.exec(id);
  const site = m ? await getSiteById(ctx.env, m[1]!) : null;
  const ns = site ? await getNamespace(ctx.env, site.namespace) : null;
  // Same rule as opening the app in a browser: anyone who may view it may read it.
  if (!site || !ns || !canViewSite(ctx.user, site, ns)) throw notFound("Item");
  const view = siteView(ctx.env, site, ctx.requestUrl);
  const obj = await ctx.env.BUCKET.get(`sites/${site.id}/${site.current_version}/index.html`);
  let source = obj ? await obj.text() : "";
  const truncated = source.length > SOURCE_LIMIT;
  if (truncated) source = source.slice(0, SOURCE_LIMIT);
  const text = [
    `Title: ${view.title ?? "(none)"}`,
    `URL: ${view.url}`,
    `Namespace: ${view.namespace}`,
    `Mount path: ${view.mountPath || "(root)"}`,
    `Visibility: ${view.visibility}${view.visibility === "restricted" ? ` (${view.allowedEmails.join(", ") || "owner and editors only"})` : ""}`,
    `Files: ${view.fileCount}, ${view.totalBytes} bytes`,
    `Updated: ${new Date(view.updatedAt).toISOString()}`,
    "",
    `index.html${truncated ? " (first 200 KB; read_file returns all of it)" : ""}:`,
    source,
  ].join("\n");
  return {
    id,
    title: view.title || `${view.namespace}/${view.mountPath || "(root)"}`,
    text,
    url: view.url,
    metadata: { namespace: view.namespace, mountPath: view.mountPath, visibility: view.visibility, updatedAt: view.updatedAt },
  };
}

/** Records each tool call (name, outcome, time taken) for the admin panel's Metrics, after it answers. */
function countToolCalls(server: McpServer, ctx: Ctx, client: string | null) {
  const register = server.registerTool.bind(server) as (name: string, config: unknown, cb: (...args: unknown[]) => Promise<ToolResult> | ToolResult) => unknown;
  (server as { registerTool: unknown }).registerTool = (name: string, config: unknown, cb: (...args: unknown[]) => Promise<ToolResult> | ToolResult) =>
    register(name, config, async (...args: unknown[]) => {
      const started = Date.now();
      let ok = false;
      try {
        const result = await cb(...args);
        ok = !result?.isError;
        return result;
      } finally {
        ctx.waitUntil(recordMcpCall(ctx.env, { email: ctx.user.email, client, tool: name, ok, ms: Date.now() - started }).catch(() => {}));
      }
    });
}

/** Stateless Streamable HTTP: a fresh server and transport per request, JSON responses. */
export async function handleMcp(
  req: Request,
  env: Env,
  user: User,
  exec: { waitUntil(p: Promise<unknown>): void },
  usage: { client: string | null; initializing: boolean } = { client: null, initializing: false },
): Promise<Response> {
  const ctx: Ctx = { env, user, waitUntil: (p) => exec.waitUntil(p), requestUrl: req.url };
  if (usage.initializing) ctx.waitUntil(recordMcpCall(env, { email: user.email, client: usage.client, tool: "initialize", ok: true, ms: 0 }).catch(() => {}));
  const server = buildServer(ctx, (s) => countToolCalls(s, ctx, usage.client));
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    exec.waitUntil(server.close().catch(() => {}));
  }
}
