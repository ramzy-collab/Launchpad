import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { z } from "zod";
import { filesFromJson } from "./api";
import type { Env, User } from "./env";
import { ApiError } from "./errors";
import { GUIDE_MD } from "./generated/assets";
import { deleteSite, listNamespaces, listSites, publishSite, siteIdByMount, updateSite, type Ctx } from "./sites";

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

export function buildServer(ctx: Ctx): McpServer {
  const server = new McpServer(
    { name: "formelab", version: "1.0.0" },
    {
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
      instructions:
        "Formelab hosts small self-contained web apps at https://<namespace>." +
        ctx.env.DOMAIN +
        "/<mount_path>/. Call get_guide before building an app for the first time, then publish with the publish tool.",
    },
  );

  server.registerTool(
    "whoami",
    { description: "Show the account this token acts as.", annotations: { readOnlyHint: true } },
    () => run(async () => ({ email: ctx.user.email, name: ctx.user.name, isAdmin: ctx.user.isAdmin })),
  );

  server.registerTool(
    "list_namespaces",
    { description: "List the namespaces you own or can edit. Each namespace is a subdomain: https://<namespace>." + ctx.env.DOMAIN + "/", annotations: { readOnlyHint: true } },
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
        "Publish (create or replace) an app and return its URL. Provide exactly one of `html` (a complete single-file HTML document) " +
        "or `zip_base64` (a base64 zip with index.html at its root). Replacing keeps the app's KV data and secrets. " +
        "Creates the namespace if it does not exist yet.",
      inputSchema: {
        html: z.string().optional().describe("Complete HTML document for a single-file app"),
        zip_base64: z.string().optional().describe("Base64-encoded .zip with index.html at its root"),
        namespace: z.string().describe("Namespace (subdomain) label, e.g. \"ramzy\""),
        mount_path: z.string().describe("Path under the namespace, e.g. \"budget\" or \"tools/budget\"; \"\" for the root"),
        title: z.string().optional(),
        spa: z.boolean().optional().describe("Serve index.html for unknown extensionless paths (client-side routing)"),
        visibility: z.enum(["all", "restricted"]).optional().describe("\"restricted\" limits viewers to allowed_emails plus editors"),
        allowed_emails: emails,
      },
    },
    (args) =>
      run(async () => {
        const files = filesFromJson(args as Record<string, unknown>);
        const r = await publishSite(ctx, {
          namespace: args.namespace,
          mountPath: args.mount_path,
          files,
          title: args.title,
          spa: args.spa,
          visibility: args.visibility,
          allowedEmails: args.allowed_emails,
        });
        return { url: r.url, replaced: r.replaced, site: r.site };
      }),
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
    () => run(async () => GUIDE_MD),
  );

  return server;
}

/** Stateless Streamable HTTP: a fresh server and transport per request, JSON responses. */
export async function handleMcp(req: Request, env: Env, user: User, exec: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
  const ctx: Ctx = { env, user, waitUntil: (p) => exec.waitUntil(p), requestUrl: req.url };
  const server = buildServer(ctx);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    exec.waitUntil(server.close().catch(() => {}));
  }
}
