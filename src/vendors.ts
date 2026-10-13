// Every outside service, platform and open-source project Formelab uses (or used, or weighed), for
// the admin panel's Vendors tab. Keep it current when adding or dropping one.

export type VendorGroup = "service" | "ai" | "open-source" | "past";

export interface Vendor {
  name: string;
  group: VendorGroup;
  /** What Formelab uses it for. */
  purpose: string;
  /** Plan and cost, as far as we know it. */
  plan: string;
  /** Where it's set up or configured. */
  setup: string;
  since: string;
  url: string;
}

export const VENDOR_GROUPS: Record<VendorGroup, { title: string; intro: string }> = {
  service: { title: "Services in use", intro: "Outside services Formelab runs on." },
  ai: { title: "AI apps Formelab works with", intro: "Not paid by Formelab: people connect their own accounts to publish apps." },
  "open-source": { title: "Open-source libraries and artwork", intro: "Code and assets built into Formelab, under their licenses." },
  past: { title: "Retired or considered", intro: "Used before, or weighed and not chosen." },
};

export const VENDORS: Vendor[] = [
  // Services in use
  {
    name: "Cloudflare Workers",
    group: "service",
    purpose: "Runs all of Formelab: the home page, web app, admin panel, AI connector and every published app.",
    plan: "Workers Paid ($5/month), needed for enough CPU time to unzip uploads.",
    setup: "Cloudflare dashboard; wrangler.toml; `npm run deploy`.",
    since: "2026-10-02",
    url: "https://workers.cloudflare.com",
  },
  {
    name: "Cloudflare D1",
    group: "service",
    purpose: "The database: people, apps, spaces, sharing, activity, keys and settings.",
    plan: "Included in Workers Paid, billed by usage beyond its allowance.",
    setup: "Database \"launchpad\"; migrations/ with `npm run db:migrate:remote`.",
    since: "2026-10-02",
    url: "https://developers.cloudflare.com/d1/",
  },
  {
    name: "Cloudflare R2",
    group: "service",
    purpose: "Stores the files of every published app.",
    plan: "Billed by storage and requests; no fees for downloads.",
    setup: "Bucket \"launchpad-sites\".",
    since: "2026-10-02",
    url: "https://developers.cloudflare.com/r2/",
  },
  {
    name: "Cloudflare Workers KV",
    group: "service",
    purpose: "Sign-ins of AI apps (Claude, ChatGPT, Gemini) to the connector.",
    plan: "Included in Workers Paid, billed by usage beyond its allowance.",
    setup: "Binding OAUTH_KV, created on first deploy.",
    since: "2026-10-07",
    url: "https://developers.cloudflare.com/kv/",
  },
  {
    name: "Cloudflare Email Service",
    group: "service",
    purpose: "Notification emails: waitlist, \"you're in\", apps shared with you, and new sign-ups for admins.",
    plan: "3,000 emails/month included with Workers Paid (beta when added).",
    setup: "Sender hello@formelab.ai; Email Sending onboarding for formelab.ai.",
    since: "2026-10-12",
    url: "https://developers.cloudflare.com/email-service/",
  },
  {
    name: "Cloudflare DNS and SSL",
    group: "service",
    purpose: "The formelab.ai and formelab.app domains, their addresses and certificates.",
    plan: "Free with the domains on Cloudflare.",
    setup: "Zones formelab.ai and formelab.app (proxied @ and * records).",
    since: "2026-10-02",
    url: "https://www.cloudflare.com/dns/",
  },
  {
    name: "Cloudflare Rate Limiting",
    group: "service",
    purpose: "Limits on waitlist sign-ups and on apps' calls to outside services (secrets proxy, Gemini).",
    plan: "Included with Workers.",
    setup: "Bindings PROXY_LIMITER, WAITLIST_LIMITER and LOGIN_LIMITER in wrangler.toml.",
    since: "2026-10-02",
    url: "https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/",
  },
  {
    name: "WorkOS AuthKit",
    group: "service",
    purpose: "Sign-in with Google or an email code, for the web app and (separately) the admin panel.",
    plan: "Free up to 1 million monthly active users.",
    setup: "WorkOS dashboard; redirects formelab.ai/auth/callback and admin.formelab.ai/auth/callback; secrets WORKOS_CLIENT_ID, WORKOS_API_KEY.",
    since: "2026-10-12",
    url: "https://workos.com/user-management",
  },
  {
    name: "Google sign-in (through WorkOS)",
    group: "service",
    purpose: "\"Continue with Google\" on the login screens.",
    plan: "Free. Before a wider launch, use Formelab's own Google OAuth client so Google's screen says Formelab.",
    setup: "WorkOS → Authentication → Google OAuth.",
    since: "2026-10-12",
    url: "https://console.cloud.google.com/apis/credentials",
  },
  {
    name: "Google Gemini API",
    group: "service",
    purpose: "The first connected app: people's apps call Gemini 3.5 Flash-Lite with the app owner's own key.",
    plan: "Paid by each person on their own Google account; Formelab pays nothing. Behind the connected_apps feature flag.",
    setup: "Nothing on Formelab's side; people add keys under Connected apps.",
    since: "2026-10-13",
    url: "https://ai.google.dev/gemini-api/docs",
  },
  {
    name: "Google Sheets API (Google sign-in)",
    group: "service",
    purpose: "The Google Sheets connected app: people sign in with Google and their apps read and write their spreadsheets.",
    plan: "Free. In Google's Testing mode: up to 100 test users, connections last 7 days; going public needs Google's verification of the spreadsheets scope.",
    setup: "Google Cloud project with the Sheets API and an OAuth client; secrets GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET; redirect formelab.app/services/google-sheets/callback.",
    since: "2026-10-13",
    url: "https://developers.google.com/sheets/api",
  },
  {
    name: "Google Fonts",
    group: "service",
    purpose: "The typefaces: Bricolage Grotesque, Inter, Inter Tight and Permanent Marker.",
    plan: "Free.",
    setup: "Loaded by the pages (src/dashboard/layout.ts).",
    since: "2026-10-09",
    url: "https://fonts.google.com",
  },
  {
    name: "GitHub",
    group: "service",
    purpose: "Hosts Formelab's code.",
    plan: "Account plan.",
    setup: "Repository ramzy-collab/launchpad.",
    since: "2026-10-02",
    url: "https://github.com/ramzy-collab/launchpad",
  },

  // AI apps people connect
  {
    name: "Claude (Anthropic)",
    group: "ai",
    purpose: "People connect Claude (claude.ai, desktop, mobile) to build and publish apps through the connector.",
    plan: "People's own Claude plan; custom connectors work on every plan, including Free.",
    setup: "Connector URL formelab.ai/mcp (OAuth sign-in).",
    since: "2026-10-07",
    url: "https://claude.ai",
  },
  {
    name: "Claude Code (Anthropic)",
    group: "ai",
    purpose: "Builds and publishes apps from the terminal through the connector.",
    plan: "People's own Claude plan.",
    setup: "Connector URL with an access key.",
    since: "2026-10-02",
    url: "https://claude.com/claude-code",
  },
  {
    name: "ChatGPT (OpenAI)",
    group: "ai",
    purpose: "People connect ChatGPT (Developer mode) to build and publish apps.",
    plan: "People's own paid ChatGPT plan.",
    setup: "Connector URL formelab.ai/mcp (OAuth sign-in).",
    since: "2026-10-09",
    url: "https://chatgpt.com",
  },
  {
    name: "Gemini CLI and Gemini Enterprise (Google)",
    group: "ai",
    purpose: "People connect Gemini CLI, or the Gemini app on Enterprise plans, to build and publish apps.",
    plan: "People's own Google plan.",
    setup: "Connector URL formelab.ai/mcp (OAuth sign-in).",
    since: "2026-10-12",
    url: "https://github.com/google-gemini/gemini-cli",
  },

  {
    name: "Anthropic API (Claude)",
    group: "ai",
    purpose: "Builds apps from a description on the New app page, with the person's own API key (Claude Opus 5.5).",
    plan: "Paid by each person on their own Anthropic API account; Formelab pays nothing.",
    setup: "Nothing on Formelab's side; people paste a key on New app.",
    since: "2026-10-13",
    url: "https://console.anthropic.com",
  },
  {
    name: "OpenAI API",
    group: "ai",
    purpose: "Builds apps from a description on the New app page, with the person's own API key (newest GPT model).",
    plan: "Paid by each person on their own OpenAI API account; Formelab pays nothing.",
    setup: "Nothing on Formelab's side; people paste a key on New app.",
    since: "2026-10-13",
    url: "https://platform.openai.com",
  },

  // Open source
  { name: "Hono", group: "open-source", purpose: "The web framework the Worker is built on.", plan: "MIT license.", setup: "package.json", since: "2026-10-02", url: "https://hono.dev" },
  { name: "MCP TypeScript SDK", group: "open-source", purpose: "The AI connector (Model Context Protocol server).", plan: "MIT license.", setup: "@modelcontextprotocol/sdk", since: "2026-10-02", url: "https://github.com/modelcontextprotocol/typescript-sdk" },
  { name: "workers-oauth-provider", group: "open-source", purpose: "OAuth sign-in for AI apps connecting to the connector.", plan: "MIT license (Cloudflare).", setup: "@cloudflare/workers-oauth-provider", since: "2026-10-07", url: "https://github.com/cloudflare/workers-oauth-provider" },
  { name: "Anthropic TypeScript SDK", group: "open-source", purpose: "Calls Claude for building apps with people's own keys.", plan: "MIT license.", setup: "@anthropic-ai/sdk", since: "2026-10-13", url: "https://github.com/anthropics/anthropic-sdk-typescript" },
  { name: "Zod", group: "open-source", purpose: "Checks the inputs of the connector's tools.", plan: "MIT license.", setup: "zod", since: "2026-10-02", url: "https://zod.dev" },
  { name: "jose", group: "open-source", purpose: "Checks sign-in tokens (JWTs).", plan: "MIT license.", setup: "jose", since: "2026-10-02", url: "https://github.com/panva/jose" },
  { name: "fflate", group: "open-source", purpose: "Unzips uploaded apps.", plan: "MIT license.", setup: "fflate", since: "2026-10-02", url: "https://github.com/101arrowz/fflate" },
  { name: "@cfworker/json-schema", group: "open-source", purpose: "JSON Schema checks for the connector on Workers.", plan: "MIT license.", setup: "@cfworker/json-schema", since: "2026-10-02", url: "https://github.com/cfworker/cfworker" },
  { name: "LobeHub Icons", group: "open-source", purpose: "The Claude, ChatGPT, Gemini and Claude Code logos on Connect your AI.", plan: "MIT license; the logos are their owners' trademarks.", setup: "src/dashboard/logos.ts", since: "2026-10-13", url: "https://github.com/lobehub/lobe-icons" },
  { name: "Simple Icons", group: "open-source", purpose: "The service logos on the Connected apps wall.", plan: "CC0; the logos are their owners' trademarks.", setup: "src/dashboard/services.ts", since: "2026-10-13", url: "https://simpleicons.org" },
  { name: "Wrangler, Vitest, TypeScript", group: "open-source", purpose: "Building, testing and deploying Formelab (not shipped to people).", plan: "MIT / Apache 2.0 licenses.", setup: "package.json devDependencies", since: "2026-10-02", url: "https://developers.cloudflare.com/workers/wrangler/" },

  // Retired or considered
  {
    name: "Cloudflare Access (Zero Trust)",
    group: "past",
    purpose: "Formelab's first sign-in, in front of the web app and apps.",
    plan: "Free up to 50 people.",
    setup: "Retired: the Access applications were deleted after the move to WorkOS (the code still accepts Access as a fallback).",
    since: "2026-10-02 to 2026-10-12",
    url: "https://www.cloudflare.com/zero-trust/products/access/",
  },
  {
    name: "Resend",
    group: "past",
    purpose: "Considered for notification emails.",
    plan: "The free plan allows 100 emails a day.",
    setup: "Not used: Cloudflare Email Service gives more emails on the plan Formelab already pays for, with no extra account.",
    since: "2026-10-12",
    url: "https://resend.com",
  },
  {
    name: "Clerk",
    group: "past",
    purpose: "Considered for sign-in.",
    plan: "Free tier.",
    setup: "Not used: WorkOS AuthKit was chosen.",
    since: "2026-10-12",
    url: "https://clerk.com",
  },
  {
    name: "Neon",
    group: "past",
    purpose: "Considered as the database.",
    plan: "Free tier.",
    setup: "Not needed: Cloudflare D1 covers it.",
    since: "2026-10-12",
    url: "https://neon.tech",
  },
];
