# Decisions

Choices made while building v1, including where the build differs from the spec and why.

## Platform and tooling

- **Package versions (Oct 2026):** wrangler 4.147, vitest 4.1 with `@cloudflare/vitest-pool-workers`
  0.22, Hono 4.13, jose 6, fflate 0.8, `@modelcontextprotocol/sdk` 1.32, TypeScript 7.
  `.npmrc` sets `legacy-peer-deps=true` because npm 10's resolver crashes ("Cannot read properties
  of null (reading 'edgesOut')") on vitest 4's optional peer dependencies.
- **vitest-pool-workers 0.22** uses the `cloudflareTest()` Vite plugin and
  `import { env, exports } from "cloudflare:workers"` (the older `SELF`/`env` from `cloudflare:test`
  are deprecated). Migrations are applied in `test/setup.ts` with `applyD1Migrations`.
- **Text assets** (SDK, guide, dashboard JS/CSS, skill) are bundled by `scripts/gen-assets.mjs` into
  `src/generated/assets.ts` (gitignored). Wrangler's `[build] command` and `vitest.config.ts` both run
  it. This avoids loader differences between esbuild (wrangler) and Vite (tests).
- **`nodejs_compat`** is on for the MCP SDK's dependencies.

## Local development

- **`[env.dev]` in `wrangler.toml` with `routes = []`.** With routes present, `wrangler dev` rewrites
  every request's Host to the first route's zone, so `test.localhost:8787` would arrive as
  `example.com` and namespace routing could not work locally. The dev env has no routes, so the
  real Host is kept. Its bindings repeat the top-level ones (wrangler does not inherit bindings into
  environments). `ENVIRONMENT=dev` and `DOMAIN=localhost` are set there; `.dev.vars` holds only
  `DEV_USER`, `OWNER_EMAIL`, `SECRETS_KEK` and placeholder Access values.
- **URLs in dev** use the request's scheme and port (`http://test.localhost:8787/...`); in every
  other environment they are `https://<ns>.DOMAIN/...`.
- In dev the proxy also allows `http:` targets, as the spec permits. Private/loopback addresses are
  still blocked.

## Data model

- **Foreign keys / cascades: deletes are written by hand.** D1 actually enforces foreign keys by
  default (it behaves as if `PRAGMA foreign_keys = ON`), which differs from the spec's note. So
  `ON DELETE CASCADE` would work, but `removeSite()` still deletes `kv`, `secrets` and
  `rate_counters` rows explicitly in one `batch()` before the `sites` row. That is correct whichever
  way the pragma is set, and makes deletion order obvious. Enforced FKs also mean the `users` row
  must exist before a namespace is created; every authenticated request upserts the user first.
- **Migration `0002`** adds indexes (sites by namespace, tokens by owner, audit by actor/target) and
  the `rate_counters` table for the D1 rate-limit fallback. `0001` is exactly the spec's schema.
- Emails are lowercased everywhere (Access identities, editor lists, allow-lists).

## Auth

- **Access JWT** is verified with jose against `https://<team>/cdn-cgi/access/certs`, checking
  `aud`, `iss` (`https://<team>`), expiry and `RS256`. The JWKS is cached in memory per team domain
  (`createRemoteJWKSet`, 10-minute cache). A JWT without an `email` claim (for example an Access
  service token) is rejected, since every action is attributed to a person.
- **Dev bypass** is a strict equality check: `ENVIRONMENT === "dev"` and `DEV_USER` set. A test
  covers `production`, `test`, `Dev`, `DEV`, `development`, `""` and `"dev "`.
- **Deploy tokens cannot manage tokens.** `/_api/deploy/tokens*` returns 403. Otherwise a leaked
  token could mint a fresh 30-day token for itself and outlive its revocation. Tokens are created
  and revoked only from the dashboard (Access session).
- **Admin API CSRF:** `/_api/admin/*` is authenticated by the Access cookie, so (beyond the spec)
  it rejects a mismatched `Origin` and requires `x-formelab-request: 1` on writes, which forces a
  CORS preflight for cross-site callers. The dashboard sends the header.
- **Site editor lists** can only be changed by the site owner or the namespace owner ("Edit editor
  lists: owner only"). Site editors and namespace editors can change the other settings.
- `canViewSite`: visibility `all`, or owner / site editors / namespace owner and editors /
  `allowed_emails`. Restricted sites are reported as 404 (not 403) by the management API to people
  who cannot see them, so their existence is not leaked.

## Publishing and serving

- **Zip parsing is done by hand** (`src/upload.ts`) on top of fflate's streaming `Inflate`. fflate's
  `unzip` APIs don't expose the external attributes needed to detect symlinks, and can't enforce a
  running decompressed-size budget. The parser reads the central directory, rejects symlinks,
  encryption, ZIP64 and unknown methods, validates every path, then inflates in 16 KB steps against
  a shared 100 MB budget, so a zip bomb is stopped early even if its headers lie about sizes.
- An upload is treated as a zip if its name ends in `.zip` or it starts with the `PK` signature;
  otherwise `.html`/`.htm` is stored as `index.html`.
- **Atomic replace** also uses an optimistic check: `UPDATE ... WHERE id = ? AND current_version = ?`.
  If two replacements race, the loser gets 409 and its new files are removed. A failure before the
  D1 update leaves the old version live and schedules the new prefix for deletion.
- **Lookup order for extensionless paths:** `<path>/index.html`, `<path>.html`, then the exact
  `<path>` (so files like `LICENSE` are still reachable), then `index.html` in SPA mode.
- **`<base>` injection:** HTMLRewriter prepends `<base href="/<mount>/">` to `<head>`. If a document
  has no `<head>` at all, one is inserted after `<html>` (or the doctype), because HTMLRewriter
  can't add an element that doesn't exist.
- Non-HTML assets support `If-None-Match` (R2 `onlyIf`) and return 304.
- Mount paths are limited to 8 segments, and `healthz` is reserved as a first segment along with
  the underscore-prefixed paths (which the segment regex already excludes).
- **Publishing into an existing namespace you can't publish to** returns 409 (`namespace_taken`),
  including when you try to replace another person's site, per the spec.

## Secrets and proxy

- **The SSRF guard lives in `src/ssrf.ts`** and is re-exported from `src/secrets.ts`. It blocks the
  spec's categories plus multicast/reserved IPv4, benchmarking ranges, IPv6 multicast,
  documentation, site-local, NAT64 and 6to4 forms of private IPv4, and single-label hosts. It relies
  on WHATWG URL parsing to canonicalize decimal/hex/octal IPv4 forms. **Limitation:** Workers have
  no DNS API, so a public hostname that resolves to a private address can't be detected here.
  Cloudflare's network does not route Worker subrequests into private networks, which covers this
  in practice. The check runs **after** placeholder substitution, so a secret can't smuggle a host.
- **Redaction (beyond the spec):** some APIs echo request headers back (httpbin does). The proxy
  replaces every substituted value of 6+ characters (and the `{{basic}}` value) with `[redacted]` in
  the returned text and `location`, so "secret values never appear in any API response" holds even
  then.
- 3xx responses are returned as-is with an extra `location` field, so apps can see where a redirect
  pointed without the proxy following it.
- Object secrets expose string, number and boolean fields as placeholders. `{{basic}}` is available
  for `public`+`secret` or `username`+`password`.
- **Rate limit:** the Workers Rate Limiting binding `PROXY_LIMITER` (60/minute, keyed by site id).
  If the binding is absent, a fixed-window counter in D1 (`rate_counters`) is used instead.
- Secret plaintext is stored as JSON (`"str"` or `{...}`) and encrypted with AES-256-GCM, a fresh
  12-byte IV per write, and AAD `site_id:name`. A missing or malformed `SECRETS_KEK` returns a 500
  with a hint for the admin, not a crash.

## Runtime API

- `x-formelab-mount` must match `^/([a-z0-9-]+(/[a-z0-9-]+)*/)?$`. Anything else (absolute URLs,
  `..`, uppercase) is a 400, and the mount is looked up only within the request's own namespace.
- `OPTIONS` to `/_api/*` always gets 403 with no `Access-Control-*` headers.
- KV keys may contain `/`; the SDK percent-encodes keys and the route decodes the raw remainder of
  the path.
- KV and secret count limits are enforced inside the `INSERT ... SELECT ... WHERE count < cap` so
  they hold under concurrency.

## MCP

- **Used `@modelcontextprotocol/sdk` directly, not the `agents` package.** The SDK ships
  `WebStandardStreamableHTTPServerTransport`, which works on Workers as-is. Running it **stateless**
  (no session id, a new server per request, JSON responses) needs no Durable Object.
  `CfWorkerJsonSchemaValidator` replaces the default AJV validator, which uses `new Function` and is
  blocked on Workers.
- Tool errors come back as `isError: true` results carrying the same `{ error: { code, message,
  hint } }` JSON as the HTTP API, so agents can act on the hint.
- `update_site` also accepts `hidden` and `editors`, matching `PATCH /sites/:id`.

## Dashboard

- The CSP is stricter than the spec's minimum: `default-src 'self'; script-src 'self'; style-src
  'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none';
  form-action 'self'`. CSS is a served file too, since inline styles would need `unsafe-inline`.
- Dashboard JS/CSS are served from `/_platform/dashboard.{js,css}` on the apex.
- "Recent activity" shows audit rows where you are the actor, or the target is one of your
  namespaces or sites.

## Not verified here

- **M7's production smoke test** (`scripts/smoke.sh` against the real domain) needs the owner's
  Cloudflare account. It passed against `wrangler dev`.
- The **M3 starter-app check against `https://httpbin.org/anything`** couldn't reach httpbin from
  the build sandbox (its egress allowlist blocks the host). The same flow was verified end to end
  in Chromium against `wrangler dev` with an allowed public HTTPS API, and the proxy's handling of
  an echoing upstream is covered by tests.

## Naming

- **Renamed from the spec's placeholder "Launchpad" to "Formelab".** This covers the SDK global
  (`window.formelab`, with `window.archie` still an alias), the Worker
  name, the MCP server name, the skill (`formelab-app`), the request
  headers (`x-formelab-mount`, `x-formelab-request`), the script variables (`FORMELAB_TOKEN`, ...),
  and the deploy-token prefix (`fl_`).
- The R2 bucket and D1 database keep their original names, `launchpad-sites` and `launchpad`,
  because they were created before the rename. Those names are internal and never shown to users.

## OAuth for MCP (Claude chat connector)

- **`@cloudflare/workers-oauth-provider` (1.2) as a combined `OAuthProvider`**, only in front of the
  apex host. Namespace hosts never reach it, so an app can't be confused with an OAuth endpoint.
  It serves `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource/mcp`,
  `/oauth/token`, `/oauth/register` (DCR) and validates tokens on `/mcp`. Client ID Metadata
  Documents are enabled too (MCP 2026-07-28 prefers them), which requires the
  `global_fetch_strictly_public` compatibility flag. The provider is built once per apex origin,
  because the resource URL (`https://DOMAIN/mcp`) is fixed at construction.
- **`/authorize` sits behind Cloudflare Access**, like the dashboard. The person approving is
  identified by the same Access JWT check, so there is no second login system. The Access bypass
  app gains `/oauth/*` and `/.well-known/*`; `/authorize` must never be bypassed.
- **Consent page** uses the library's consent helpers (browser-bound handle cookie, no framing),
  escapes every client-supplied string, and shows where tokens will be sent. Its CSP allows the
  client's redirect origin in `form-action`, because browsers apply `form-action` to the redirect
  that follows the POST.
- **One scope, `mcp`**, covering every tool. A grant acts as the user, with exactly their
  permissions, like a deploy token. Access tokens last 1 hour; grants (refresh) 30 days.
- **Deploy tokens (`fl_...`) keep working on `/mcp`** through `resolveExternalToken`, so Claude Code
  setups are unaffected. An Access JWT is not accepted as an MCP credential.
- **Connected apps** on the dashboard list the user's grants (`listUserGrants`) and revoke them
  (`revokeGrant`). Deploy tokens can't list or revoke connections.
- **Limitation:** removing someone from the Access policy doesn't revoke an OAuth grant they already
  approved. Their connection keeps working until it expires (30 days) or is disconnected. The
  same was already true of deploy tokens.
- **KV namespace `OAUTH_KV`** has no `id` in `wrangler.toml`: `wrangler deploy` provisions it on the
  first deploy.
- `wrangler.toml` now carries the real `formelab.ai` domain and D1 `database_id`. Neither is a
  secret, and keeping them in the repo means `git pull` doesn't fight local edits.

## ChatGPT

- ChatGPT's custom connectors use the same OAuth flow (dynamic registration or a Client ID Metadata
  Document, authorization code with PKCE) and the same Streamable HTTP transport, so the existing
  `/mcp` endpoint serves it unchanged. The consent page is client-neutral: it names the client and
  shows the redirect host, and its CSP `form-action` follows whatever redirect origin the client
  registered.
- Outside Developer Mode, ChatGPT only offers tools named `search` and `fetch`. Both are added,
  read-only, in the shape it expects (`{results: [{id, title, url}]}` and
  `{id, title, text, url, metadata}`). `search` covers the sites you can manage plus the guide;
  `fetch` applies the same rule as opening the app in a browser (`canViewSite`) and includes up to
  200 KB of `index.html`, so an assistant can read an app before republishing it.
