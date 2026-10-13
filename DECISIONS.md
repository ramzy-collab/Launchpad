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
- Page JS/CSS are served from `/_assets/*` on the apex, without sign-in (they hold nothing
  private), so the public home page and the dashboard share one stylesheet, `formelab.css`.
- The only third party is Google Fonts (Bricolage Grotesque, Inter, Permanent Marker), allowed by
  `style-src https://fonts.googleapis.com` and `font-src https://fonts.gstatic.com`.

## Home page, login and waitlist

- The home and login pages follow the "wall" prototype (fl.formelab.ai/wall): a big hero, a
  scrolling rail of example apps, the waitlist form and "How it works". They use their own
  stylesheet, `home.css`, and are light only, like the prototype. The rail's second copy (for a
  seamless loop) is rendered on the server and hidden from screen readers.
- The signed-in pages (dashboard, consent) follow the earlier waitlist prototype
  (fl.formelab.ai/waitlist) through `formelab.css`: warm dot-grid canvas, violet accent, pill
  buttons, and light and dark themes. The theme follows the system until the toggle is used.
- `/` is the public home page with the waitlist; `/login` is the login screen; the dashboard
  moved from `/` to `/app`. A request to `/` that already carries a valid Access JWT redirects to
  `/app`, so older Access setups that cover the whole apex keep working.
- **Login stays with Cloudflare Access.** The prototype had email and password fields, but
  Formelab has no passwords: the login screen's button goes to `/app`, where Access asks for a
  one-time code or the configured identity provider. `/cdn-cgi/access/logout` logs out.
- Waitlist sign-ups (`POST /_api/waitlist`, JSON `{ email }`) go to the `waitlist` table in D1.
  Joining twice gives the same answer, so the endpoint never reveals who is on the list.
  Cross-origin posts are refused, and sign-ups are limited to 10 per minute per IP
  (`WAITLIST_LIMITER`, with the D1 counter as fallback). Admins see the list on the dashboard.
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

## Accounts and login (WorkOS AuthKit)

- **WorkOS AuthKit, used server side only.** `/auth/login` redirects to AuthKit's hosted page;
  `/auth/callback` exchanges the code with the API key and starts Formelab's own session. No
  WorkOS JavaScript runs on Formelab pages, so the strict CSP stays as it is. WorkOS was chosen over
  Clerk because the free tier covers 1M monthly users, it sends the sign-in emails, and its
  organizations and SSO fit the later work/company accounts.
- **Sessions live in D1** (`sessions`), keyed by the SHA-256 of a random cookie token. Cookies are
  `__Host-` prefixed (host-only, Secure, HttpOnly, SameSite=Lax). The dashboard session lasts 30
  days. Each namespace host gets a separate 12-hour session through a single-use, 60-second code
  (`auth_codes`) minted by the apex; it ends when the dashboard session does.
- **Cloudflare Access still works** alongside: a request is signed in by a session cookie first,
  then by an Access JWT. That makes the switch-over safe; Access can be removed afterwards.
- **Waitlist gate.** `users.status` is `active` or `waitlisted`. New sign-ins are waitlisted unless
  their email was approved (`waitlist.approved_at`) or is `OWNER_EMAIL`. Waitlisted accounts can't
  create namespaces (and so can't publish), but can open apps shared with them.
- **Private by default.** New apps default to `visibility: "restricted"`, and migration 0004 moved
  existing apps to it. "Shared with me" lists apps someone else owns where the person is named:
  in `allowed_emails`, the app's `editors`, or the namespace's editors. `visibility: "all"` (anyone
  signed in) still exists for apps the owner deliberately opens up, but those don't show up in
  everyone's "Shared with me".
- **Strangers get 404, not 403,** for private apps in the management API and MCP tools, so an app's
  existence isn't revealed.
- **User apps live on their own domain** (see "Hosts" below).

- **Publishing a new version keeps an app's sharing.** `visibility`, `allowed_emails` and
  `editors` on `publish` only apply to a new app; republishing ignores them and, when they differ
  from what the app has, returns a `note` pointing to `update_site`. A blank title or an unticked
  SPA box (as the dashboard form sends) also leaves those settings as they are.

## Notification emails

- **Cloudflare Email Service** (the `send_email` binding `EMAIL`), chosen over Resend for its
  higher volume on the Workers plan we already pay for (3,000/month included, no daily cap),
  and because it needs no extra account or API key. It was in beta when added. The binding only
  allows the `EMAIL_FROM` address. Sends run in `waitUntil`, so a slow or failing email service
  never slows down or fails the request; failures are logged with Cloudflare's error code.
- **Sent once per event:** the waitlist confirmation only on the first insert (so the public form
  can't be used to email someone repeatedly), "you're in" only when `approved_at` goes from empty
  to set, and sharing emails only to addresses newly added to `allowed_emails`, `editors` or a
  namespace's editors. The person making the change is never emailed.
- User-supplied text (app titles, names) is HTML-escaped in the email body.


## Deleting users

- Admins delete a user from the dashboard's **Users** section (typing the email to confirm), or
  with `DELETE /_api/admin/users/:email`. It removes the account and everything it owns: owned
  namespaces with all their apps, the user's other apps (R2 files, KV, secrets), their entries
  on other apps' and namespaces' share and editor lists, tokens, sessions, OAuth grants, the
  waitlist row, and the WorkOS user (best effort). Audit rows are kept as history.
- Admins can't delete themselves or the `OWNER_EMAIL` account. Someone who is deleted can sign in
  again later; they start over on the waitlist.

## Formelab admin area

- Running Formelab lives on `admin.DOMAIN` (Overview, Users, Waitlist), apart from anyone's own
  lab on `APP_DOMAIN`. Admins get an **Admin** link in their lab's nav; for everyone else the admin
  pages are a 404.
- Admins can make other people admins (which also lets them in from the waitlist) and remove
  admin access. The `OWNER_EMAIL` account is always an admin, and nobody can remove their own
  access, so Formelab can't be left without an admin.

## Hosts

- `DOMAIN` (formelab.ai) keeps everything public or protocol-facing: the home page and waitlist,
  `/login` and the WorkOS callback, the MCP connector and its OAuth endpoints, and the deploy API.
  The connector URL (`https://DOMAIN/mcp`) doesn't move, so connected AI apps keep working.
- `APP_DOMAIN` (formelab.app) serves the web app at its root (`/`, `/shared`, `/connect`) and the
  management API; `<ns>.APP_DOMAIN` serves published apps. Apps get a separate registrable domain
  so browsers never count them as "same site" with the sign-in and admin hosts.
- `admin.DOMAIN` serves the admin panel and the management API. `admin` is a reserved namespace
  label, so no one can claim it as an old-style app host.
- Old addresses redirect with 301, keeping path and query: `DOMAIN/app/*` to `APP_DOMAIN/*`,
  `DOMAIN/admin/*` to `admin.DOMAIN/*`, and `<ns>.DOMAIN/*` to `<ns>.APP_DOMAIN/*`.
- **One sign-in, a session per host.** `DOMAIN` talks to WorkOS for everything but the admin
  panel. The web app and app hosts send
  visitors without a session to `DOMAIN/auth/app`, which hands back a single-use code that the
  host trades for its own host-only cookie (as app hosts already did). Child sessions never
  outlive the `DOMAIN` session; logging out on any host deletes the `DOMAIN` session and all its
  children. Session lengths: `DOMAIN` and the web app 30 days, app hosts 12 hours.
- **The admin panel signs in separately.** `admin.DOMAIN` runs the WorkOS flow on its own host
  (`/login`, `/auth/login`, `/auth/callback`, so WorkOS needs that redirect URI too) and never
  accepts a session handed over from `DOMAIN`. Only admins (or `OWNER_EMAIL`) can finish it;
  anyone else gets a 403 and isn't added to the users or the waitlist. Its session lasts 8 hours,
  so a stolen admin cookie is useful for a working day at most, and logging in or out of the lab
  doesn't touch it (or the other way round). The panel has no link back to the lab.
- With Cloudflare Access instead of WorkOS there is no session to hand over, so `/auth/app`
  answers with a sign-in page instead of looping; Access must then cover the other hosts itself.

## Activity logs

- There is no shared "Recent activity" list any more. Every row in the activity log (the `audit`
  table) is either about one app or about Formelab itself:
  - **App activity** (`audit.site_id` set, migration 0005): publishing, new versions, sharing and
    settings changes, secrets saved or removed, and calls made with the app's secrets. It is on
    the app's own page, `APP_DOMAIN/apps/<id>/activity`, linked as **Activity** from My apps (and
    from Shared with me for editors). Only people who can manage the app see it; others get 404.
  - **Formelab activity** (`site_id` NULL): people let in or invited, admin access granted or
    removed, deleted accounts, namespaces, deleted apps (their own log goes with them) and AI apps
    connected. It is the admin panel's **Activity** tab.
- Each row is shown as a sentence describing the action that caused it ("Shared it with
  a@example.com; made b@example.com an editor"), not as an action code and JSON.
- Saving an app's settings only logs (and writes) the fields that actually changed, so saving
  the settings form unchanged adds nothing to the log.

## Web app layout

- The web app has a left menu instead of tabs and one long page. A **+ New app** button sits on
  top (the one primary action), then two groups: **Apps** (My apps, Shared with me, Spaces) and
  **Connect** (Connect your AI, Connected apps, Access keys). The account menu at the foot of the
  menu holds the light/dark switch, the admin panel link (admins only, new tab) and Log out. On
  narrow screens the menu folds behind a menu button in a top bar.
- **New app** offers asking your AI first (an example prompt to copy, and a link to connect one),
  then uploading files you already have. Publishing from there returns to My apps.
- Plain words on the surface: namespaces are called **Spaces** and deploy tokens **Access keys**.
  The API, MCP tools and database keep the old names (`namespace`, `fl_` tokens).
- People still on the waitlist only see Shared with me and Connect your AI.
