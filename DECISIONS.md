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

- **Who can change an app's data (audit finding #3).** Shared KV is readable by everyone who can
  open the app; writing depends on `sites.kv_writes`: `editors` (owner, site editors, namespace
  editors) or `all` (everyone who can open it). New apps start as `editors`; apps that existed
  before migration `0012` default to `all`, so nothing that worked stops working. Each person's
  private data (`formelab.kv.mine`, `/_api/me/kv`) lives in its own table, `kv_user`, keyed by
  site and email: only that person reads or changes it (not even the owner), it doesn't count
  against the 1,000 shared keys, and each person may keep 200 keys per app.
- **"all" means members, not everyone signed in (audit finding N2).** Anyone can sign in with
  WorkOS and land on the waitlist, so `canViewSite` only opens `all` apps to active accounts.
  Waitlisted people can still open apps shared with them by name (`allowed_emails`, editors). Every
  path (app files, the runtime API with KV, secrets and connected services, MCP `fetch`, icons,
  listings) goes through `canViewSite`, so this one check covers them all.
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
- **Host allow-lists:** every secret is stored with the hosts it may be sent to (`hosts`, a JSON
  column, required when setting a secret). The proxy checks the final URL's host after
  substitution and returns `host_not_allowed` otherwise. Without this, anyone who could view an app
  could send its secrets to a server of their own (audit finding 1). Hosts are exact names or
  `*.domain` for subdomains, each must pass the SSRF guard, and setting a secret always replaces
  value and hosts together, so an editor can't widen the hosts of a value they never saw. Secrets
  saved before migration `0010` have `hosts = NULL` and are refused (`secret_needs_hosts`) until
  set again: the owner chose a clean break over leaving existing secrets open.
- **Google Sheets is limited per app (audit finding N1).** The owner's Google token reaches every
  spreadsheet they own, so each app carries its own list of spreadsheet ids (`sites.sheets`).
  `sheetsCall` refuses any path that doesn't name a listed spreadsheet (`sheet_not_allowed`), before
  calling Google. Only the app's owner can change the list, since it's their account; editors
  can't. Creating a spreadsheet (`POST spreadsheets`) is owner-only too, and the new id is added to
  the app's list. The `drive.file` scope would be tighter still, but would make every existing
  connection reconnect and stop apps opening sheets by id; it's a possible later step.
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
- **Later changes:** Access keys moved from the menu into the account menu (next to dark mode,
  the admin panel and Log out). **Connected apps** is a "Soon" placeholder for connecting
  services (Google Sheets, Stripe, Slack, email) that apps can use. AI app connections now live
  on **Connect your AI**: a tile per AI app with a **Connected** badge when one of the person's
  OAuth connections matches it by client name (Claude, ChatGPT, Gemini, Claude Code), and the
  setup steps, connection details and Disconnect in a dialog. `/connect#claude` (or `#chatgpt`,
  `#gemini`, `#claude-code`) opens that dialog directly. The logos are the official marks, inlined from LobeHub Icons (`@lobehub/icons-static-svg`, MIT) in `src/dashboard/logos.ts`.
- **Claude Code shows as connected** even though it uses an access key rather than signing in:
  when an MCP request made with a key is the `initialize` handshake, the client's name
  (`clientInfo.name`, "claude-code" for Claude Code) is saved on the key (`tokens.client_name`,
  migration 0006). Connect your AI matches it to a tile like a sign-in's client name, and offers
  **Revoke key** there; Access keys shows it as "Used by".
- **New app hands the idea to the person's own AI** (no AI runs on Formelab's side yet): a
  prompt box with example ideas and **Make it with Claude** / **Make it with ChatGPT** buttons that
  open `claude.ai/new?q=` or `chatgpt.com/?q=` in a new tab with the idea typed in (plus "publish
  it to Formelab" when the idea doesn't mention Formelab), and **Copy for Claude Code**. Each
  button shows Connected, or links to that app's setup on Connect your AI. Gemini has no reliable
  prefill link, so it isn't offered here. A built-in builder (Formelab calling a model itself)
  is the planned next step.

## Browsing apps

- My apps and Shared with me share one app browser (`src/dashboard/apps.ts`): **tiles grouped by
  space** (the default) or a **list** whose column headers sort (click again to reverse), plus
  search (name, address, space, owner), filters (space; who can open it on My apps, your access
  on Shared with me) and a sort menu. The server renders every app in both views; `dashboard.js`
  filters, sorts and switches views without reloading, and remembers the view in localStorage.
- Clicking a tile opens the app in a new tab. The gear (only on apps you can manage) opens the
  app's own page, `/apps/<id>`: its details (space, path, owner, who can open it, dates, size,
  options), settings and sharing, publishing a new version, recent activity (with a link to the
  full log) and Delete. Editors who aren't the owner don't see the editors field (only the owner
  or the space's owner can change it) or Delete.
- Thumbnails are a colored square with the app's first letter; the color comes from the app id
  through one of eight classes, since the CSP allows no inline styles.
- **App icons on tiles:** at publish, Formelab looks for the app's icon: what `index.html` links
  as its icon (apple-touch-icon, then SVG, then any; a small `data:` URI counts), else a
  well-known file at the app's root (`favicon.svg`, `favicon.ico`, `logo.png`, ...). External
  URLs and paths outside the app are ignored. The answer is stored in `sites.icon_path`
  (migration 0007; NULL for older apps, which listing them looks into in the background, up to
  20 at a time, so their icons appear on the next visit). The web app serves
  it at `/apps/<id>/icon` to people who can open the app, with a sandboxing CSP so an SVG opened
  directly can't run script on the web app's host; apps without an icon keep their letter tile.
  The build guide's checklist asks agents to include an icon.
- **AI-made apps must have an icon:** the MCP `publish` tool refuses an app without one
  (`icon_required`, with a hint showing the `<link rel="icon">` to add), so the AI adds one and
  publishes again. Its description and the server's instructions say so up front, and the build
  guide's starter app includes one. Uploads from the web app and the deploy API don't require it.

## Connected apps: Google Gemini

- The first connected app. A person adds their Gemini API key once (Connected apps → Google
  Gemini); Formelab checks it with Google (a free model lookup) and stores it in `service_keys`
  (migration 0008), encrypted with `SECRETS_KEK` like app secrets but bound to the person
  (AAD `user:<email>:gemini`). Only the last four characters are kept in the clear, to show which
  key it is. Deleting the account deletes it.
- Apps call **Gemini 3.5 Flash-Lite** (`gemini-3.5-flash-lite`) through the SDK:
  `formelab.gemini.generate(prompt, { system, schema, json, maxOutputTokens })` or Gemini's own
  `contents`, and `formelab.gemini.available()`. The runtime API (`/_api/ai/gemini`) adds the
  key on the server; it never reaches a browser or the app's files.
- **The app owner's key is used**, also when people the app is shared with use it (they can
  open the app, so they can use its features). Calls count toward the owner's Google usage, are
  limited to 60 a minute per app (the proxy's limiter), and each one is in the app's activity log
  with its token count. Connecting and disconnecting are in the admin activity log.
- AIs learn about it from the build guide (a ground rule and an SDK section) and from `whoami`
  (`connectedApps.gemini`), so they use it instead of asking for an API key.
- **Behind a feature flag.** Connected apps (all of them, Gemini included) are behind the
  `connected_apps` flag (migration 0009, `src/flags.ts`), set in the admin panel's **Features**
  tab: **Off** (the default), **Admins only** or **Everyone**. Off, the Connected apps page still
  shows, but only its "Coming soon" wall, with a **Soon** tag in the menu; the key API answers
  404, apps' Gemini calls answer `not_available` (and `available()` says so), `whoami` leaves out
  `connectedApps`, and the build guide drops its Gemini sections (marked
  `<!-- flag:connected_apps -->` in `guide.md`). For apps the flag follows the app's owner,
  since it's their key. Turning it off deletes nothing; changes are in the admin activity log.

## Building apps in Formelab with the person's own API key

- "The easy way" used to open claude.ai or chatgpt.com with the idea typed in, which only works
  once the Formelab connector is set up there (and in ChatGPT, Developer mode turned on). That
  was the hard part for new people. Now a person can save an **Anthropic or OpenAI API key** on
  the New app page; "Make it" then builds the app on the server (`src/builder.ts`) and publishes
  it to their space, data writes set to everyone. Without a key, the old flow stays for people
  whose Claude or ChatGPT app is already connected.
- **API keys, not Claude/ChatGPT plans.** Claude Pro/Max and ChatGPT Plus/Pro subscriptions can't
  be used by other apps; only API keys can, billed by usage on the person's own API account.
  The key pop-up says so.
- Keys live in `service_keys` next to Gemini's (services `anthropic` and `openai`), encrypted with
  `SECRETS_KEK`, AAD `user:<email>:<service>`, last four characters in the clear. They're only
  used for that person's own builds, never by apps.
- **Behind its own feature flag**, `app_builder` (admin panel → Features), separate from
  `connected_apps` since this isn't a service apps use. Off (the default), New app looks and works
  as before, and `/_api/admin/builders/*` and `/_api/admin/build` answer 404. Keys already saved
  stay saved while it's off.
- Claude: Claude Opus 5.5 through the Anthropic SDK, streaming, adaptive thinking at medium
  effort, the build guide as a cached system prompt, and Anthropic's server-side refusal
  fallback. OpenAI: the Responses API, streaming, with the newest plain `gpt-N.N` model the key
  can list (no `-mini`/dated variants), so it keeps up without code changes.
- One HTML file comes back; Formelab names the app from its `<title>`, picks a free path
  (`lunch-sign-up`, `lunch-sign-up-2`, ...) in the person's first own space (or makes one from
  their email), and publishes. `POST /_api/admin/build` streams NDJSON progress lines so the
  page shows progress and the connection stays busy; the build finishes and publishes even if
  the page is closed. Limited to 5 builds a minute per person; each build is in the app's
  activity log with the model and token count.

### Gemini as a free builder

- Anthropic and OpenAI keys need paid API credits; Gemini's API has a free tier (a key from
  Google AI Studio, no billing). So Gemini is a third builder. It picks the newest plain
  `gemini-N.N-flash` model the key lists (Flash is what the free tier covers; no `-lite`,
  `-preview` or Pro), falling back to Flash-Lite, and streams with `streamGenerateContent?alt=sse`.
  A 429 explains the free limits.
- **One Gemini key, two uses.** The builder's key is the connected app's key: the same
  `service_keys` row (service `gemini`, same encryption scope), saved and checked by
  `connectGemini` and removed by `disconnectGemini` whichever page it's done from. So it moves
  "both ways" with no copying, and there's never a stale second copy. Both pages say so, and
  removing it warns that apps stop using Gemini too. Saving it from New app works even with
  `connected_apps` off; apps only use it once that flag is on for the owner.

### Grok as a fourth builder

- xAI's API is OpenAI-compatible, so Grok checks keys the same way (`GET /v1/models`, though a
  bad key answers 400, not 401) and builds through streaming Chat Completions at
  `api.x.ai/v1`. Keys are service `xai` in `service_keys`. It picks the newest plain `grok-N` or
  `grok-N-M`/`grok-N.M` model the key lists (no `-fast`, `-mini`, `-code` or dated variants), so
  it keeps up without code changes. Like Gemini it only builds here: there's no Grok app to
  open with the idea typed in.

### Changing an existing app

- The app's page gets a **Change it with AI** box (same `app_builder` flag). `POST
  /_api/admin/build` with `site_id` and `change` sends the app's current `index.html` and the
  requested change, and asks for the whole updated file back (no diffs: one complete document is
  what models get right most reliably, and it's what publishing needs). Only `index.html` is
  rewritten; the app's other files are copied into the new version unchanged, and publishing in
  place keeps its data, secrets and sharing as always. The prompt asks to keep `formelab.kv`
  keys and data shapes so saved data still loads.
- Anyone who can manage the app (owner, editors, space owner) can change it, with **their own**
  key. Apps whose `index.html` is over 400 KB are refused, with a pointer to the upload instead.
  Each change is in the app's activity log with what was asked.

## Connecting AI apps over OAuth: the consent page's form-action

- The consent page's CSP `form-action` used to allow only the redirect URI's origin. Browsers
  apply `form-action` to every redirect after the Allow POST, so a client whose callback
  redirects on to another origin, or a native app's own scheme (`cursor://`, whose URL origin is
  `"null"`), was blocked silently and the page sat there with Allow grayed out (reported with
  Grok's custom MCP connector). It now allows `'self' https:` plus the redirect URI's loopback
  origin or scheme. That only lets the browser follow a hand-off; which redirect URIs get a code
  is still decided by the OAuth provider.
- `allowPrivateUseRedirectUris` is on, so native apps like Cursor can get the code back on their
  own scheme (RFC 8252). The consent page shows the warning that access goes to an app on this
  computer for those, as for loopback redirects.
- **Cursor** is a tile on Connect your AI: an `Add to Cursor` deep link
  (`cursor://anysphere.cursor-deeplink/mcp/install`) or `~/.cursor/mcp.json` with the connector
  URL, then OAuth from Cursor. Client names containing "cursor" map to its tile.

## Changelog

- `CHANGELOG.md` lists every change in plain language, newest first, one `## YYYY-MM-DD` heading
  per day and one `- ` item per change. It's bundled at build time and shown in the admin panel's
  **Changelog** tab. Add an entry with every change.
- **Vendors** (admin panel → Vendors) lists every outside service, the AI apps people connect,
  the open-source libraries and artwork built in, and vendors retired or considered, with what
  each is for, its plan and cost, and where it's set up. The list is `src/vendors.ts`; keep it
  current when adding or dropping a vendor.

## Connected apps: Google Sheets (OAuth)

- The first connected app that uses sign-in instead of a key. **Connect with Google** goes to
  `/services/google-sheets/connect` on the web app host, which sends the person to Google with
  state and PKCE in a host-only cookie, asking for `openid email` and the `spreadsheets` scope
  with offline access. The callback trades the code for tokens (with Formelab's client secret)
  and stores them encrypted in `service_keys` (`google_sheets`), with the Google account's email
  as the hint. Access tokens are refreshed when they're within a minute of expiring.
- Apps call it through the SDK (`formelab.sheets.read/append/update/create/request`), which
  posts to `/_api/sheets`; Formelab adds the owner's token and calls
  `https://sheets.googleapis.com/v4/<path>`. The path must start with `spreadsheets` and stay
  inside the Sheets API (encoded dots are refused). Same rules as Gemini: the owner's account,
  60 calls a minute per app, every call in the app's activity log, behind `connected_apps`.
- Why `spreadsheets` and not the narrower `drive.file`: people want their apps to use the
  spreadsheets they already have. It's a sensitive scope, so Google's consent screen stays in
  **Testing** (named test users, 7-day connections) until it passes Google's verification.
- Disconnecting revokes the token at Google (best effort) and deletes it.

## Installing Formelab and its apps (Progressive Web Apps)

- "Native" Formelab and native apps are **installable web apps (PWAs)**, not separate iOS,
  Android or desktop builds: one codebase, no app stores, and every app is always its latest
  published version. Phones get Add to Home Screen; Chrome and Edge install a desktop app with its
  own window; Safari on a Mac has Add to Dock. Wrapping for the App Store or Play Store
  (Capacitor, Tauri and the like) can come later if needed.
- **The web app** (`APP_DOMAIN`) has `/manifest.webmanifest`, PNG icons (`src/dashboard/icons/`,
  bundled as base64 by `gen-assets.mjs`; iOS only uses PNG home screen icons) and a service
  worker at `/sw.js`, all public since browsers fetch them without cookies. The service worker
  caches nothing: it only shows an offline page when a navigation fails, so nobody sees stale
  data. `install.js` turns on the Install button when the browser offers one
  (`beforeinstallprompt`) and opens the right steps on **Get the app** (`/install`).
- **Published apps** need nothing from their makers. Every HTML page gets
  `<link rel="manifest" href="/_platform/manifest.webmanifest?mount=…" crossorigin="use-credentials">`
  after the injected `<base>`, unless the app ships its own manifest. The manifest uses the app's
  mount path as its `id`, `scope` and `start_url`, so several apps on one space host install as
  separate apps, and it needs the same sign-in and access as the app. Its icon is the app's own
  when that's an SVG or a PNG of at least 144px, else the letter tile. A PNG icon is also added as
  `apple-touch-icon` for iOS, unless the app has one.
- **Icon URLs are signed** (`/_platform/app-icon/<id>/<version>/<icon|letter>/<hmac>`, HMAC keyed
  with `SECRETS_KEK`) instead of needing a cookie, because browsers don't reliably send cookies
  when they download icons to install an app. A signature only works for that app's current
  version on its own host, and is only handed out in a manifest or page that already needed
  access. Icons get the same sandboxing CSP as on the web app.
- No service worker for published apps: current Chrome doesn't need one to install, and a
  platform worker on a host shared by several apps could get in the way of their own.
- The SDK gets `formelab.app.installed()`, `canInstall()` and `install()` (plus a
  `formelab:installchange` event) for apps that want their own Install button. Its size budget
  went from 5 KB to 6 KB for this.
- On iPhone and iPad a home screen app keeps its own cookies, separate from Safari, so people sign
  in once more the first time they open it there. Android and desktop share the browser's sign-in.

## One host per app (audit findings #2, #4, N4)

- **Every app has its own host**, `<host_label>.APP_DOMAIN`, where the label is the app's name (its
  mount path, `/` → `-`, or the space for a root app) plus a 4-character code from an alphabet
  without look-alikes: `budget-7kq2.formelab.app`. Browsers isolate by origin, not path, so when
  apps shared `<ns>.APP_DOMAIN`, one app's JavaScript could read a sibling's pages, KV, private
  data and secrets as the visitor (the runtime API picked the app from a header the page set).
  Now the app comes from the host, and the `x-formelab-mount` header is only a CSRF signal.
- **Nobody owns a name for free.** The code makes labels unique, so two people can both have a
  "hoops". Clean names (`hoops.formelab.app`) and custom domains are left for a paid tier; both are
  just more hostnames pointing at an app. A label is fixed when the app is first published and
  kept when it's replaced; new labels also avoid existing namespace labels.
- **Spaces (namespaces) stay** as the way apps are grouped and shared with editors, and as the
  `namespace` + `mount_path` pair that publish and update_site use, but they're no longer
  addresses. A space's link in the web app opens My apps filtered to it (`/?space=<label>`).
- **The web app moved to `app.DOMAIN`**, so APP_DOMAIN holds nothing but published apps: they're
  a different registrable domain (a different site) from the web app, admin panel and sign-in.
  `APP_DOMAIN/...` redirects there. "app" is now a reserved namespace label.
- **Old addresses redirect permanently**: `<ns>.APP_DOMAIN/<mount>/<rest>` and `<ns>.DOMAIN/...`
  go to `<host_label>.APP_DOMAIN/<rest>` (longest matching mount, query kept). The old hosts serve
  nothing else (no `/_api`, no `/_platform`). The redirect doesn't need a sign-in, so it reveals
  that an app exists at a guessed path, but nothing about it; the app's own host checks access.
- **Sessions**: each app host gets its own session through the existing hand-off (`/auth/app` →
  `/_auth/callback`), which now accepts the web app and app hosts. A session for one app doesn't
  open another.
- **Migration 0016** fills `host_label` for existing apps in SQL (`random()` per character) and
  adds a unique index; the chance of two labels colliding is negligible at today's size, and a
  failed run can simply be re-run.
- Dev: `APP_DOMAIN=apps.localhost`, since the web app now takes `app.localhost`.
