# Formelab

A small, personal app host on Cloudflare. You (and a few people you invite) publish self-contained
web apps and get a live URL for each:

```
https://<namespace>.<APP_DOMAIN>/<mount-path>/
```

Apps are plain HTML/CSS/JS (a single `.html` file or a `.zip` with `index.html` at its root). They
get identity, per-app key/value storage, and secrets with a server-side proxy through a tiny
browser SDK (`window.formelab`). Claude Code publishes apps through Formelab's MCP server; there
is also a web dashboard.

- One Worker (`src/index.ts`) serves every host (see [`src/hosts.ts`](src/hosts.ts)):

  | Host | What it serves |
  | --- | --- |
  | `DOMAIN` (formelab.ai) | Home page with the waitlist, `/login`, sign-in, the MCP connector (`/mcp`), OAuth, deploy API |
  | `admin.DOMAIN` | The admin panel, with its own admins-only sign-in (8-hour sessions) |
  | `APP_DOMAIN` (formelab.app) | The web app: My lab, Shared with me, Connect your AI |
  | `<namespace>.APP_DOMAIN` | Published apps |
  | `<namespace>.DOMAIN` | Old app addresses; redirected (301) to `<namespace>.APP_DOMAIN` |

  Apps sit on their own registrable domain, the way GitHub serves pages from `github.io`, so
  browsers never treat an app as "same site" with Formelab's sign-in. You sign in once on
  `DOMAIN`; the web app and each app host get their own session from it, and logging out anywhere
  ends all of them. The admin panel is the exception: admins sign in to it separately.
- D1 holds structured data; R2 holds app files; Cloudflare Access handles all sign-in.
- Agent build guide: [`src/guide.md`](src/guide.md), served at `/_platform/guide.md`.
- Design choices and deviations from the spec: [`DECISIONS.md`](DECISIONS.md).

---

## 1. Cloudflare prerequisites

Do these once. Replace `example.com` everywhere with your domain.

### 1.1 Two domains on Cloudflare DNS

Formelab uses two domains: `DOMAIN` for the home page, sign-in and admin, and `APP_DOMAIN` for the
web app and published apps, with namespaces **one level down**: `ramzy.myformelab.app`. Add both
to Cloudflare, and in each zone create two **proxied** DNS records (the Worker answers them, so the
address is a placeholder): `AAAA @ 100::` and `AAAA * 100::`.

> **Important:** Cloudflare's free Universal SSL certificate covers `DOMAIN` and `*.DOMAIN`, but
> **not** `*.sub.DOMAIN`. If you nest Formelab under a subdomain (`ramzy.apps.example.com`) you
> need Advanced Certificate Manager, which is paid. Use an apex domain.

### 1.2 Workers Paid plan ($5/month)

The free plan's 10 ms CPU limit can't unzip uploads. `wrangler.toml` already sets
`limits.cpu_ms = 30000`.

### 1.3 DNS records

In **DNS → Records**, add two **proxied** (orange cloud) records. The target is a placeholder; the
Worker route catches the traffic:

| Type | Name | Content | Proxy |
|---|---|---|---|
| AAAA | `@` | `100::` | Proxied |
| AAAA | `*` | `100::` | Proxied |

### 1.4 R2 bucket and D1 database

```bash
npm install
npx wrangler login
npx wrangler r2 bucket create launchpad-sites
npx wrangler d1 create launchpad      # copy the database_id it prints
```

Edit `wrangler.toml`:

- Set `database_id` (top-level `[[d1_databases]]`) to the id printed above.
- Replace `formelab.ai` in `routes` and `[vars] DOMAIN`, and `formelab.app` in `routes` and
  `[vars] APP_DOMAIN`, with your two domains.

The routes `DOMAIN/*`, `*.DOMAIN/*`, `APP_DOMAIN/*` and `*.APP_DOMAIN/*` are created on deploy
from `wrangler.toml`.

### 1.5 Cloudflare Zero Trust (free for up to 50 users)

In the [Zero Trust dashboard](https://one.dash.cloudflare.com/):

1. **Settings → Authentication**: add an identity provider: Google, or **One-time PIN** (email codes, zero setup).
2. **Access → Applications → Add an application → Self-hosted**, the **main app**. It covers
   only the signed-in parts of the apex, so the home page (`/`), the login screen (`/login`) and
   the waitlist sign-up stay public:
   - Application domains (add each one): `*.example.com`, `example.com/app`,
     `example.com/authorize`, `example.com/_api/admin` and `example.com/_platform`.
   - Policy: **Allow**, include **Emails**: your email plus any invitees.
   - After saving, open the app's **Overview** and copy the **Application Audience (AUD) Tag**.

   Don't cover all of `example.com`: Access would then put its login in front of the home page.
   Paths outside Access are still safe, because the Worker rejects any request without a valid
   Access JWT except the public pages, their `/_assets/*` files and `/_api/waitlist`. The deploy
   API, `/mcp`, `/oauth/*` and `/.well-known/*` authenticate with tokens and must stay outside
   Access, as they do here.
3. **Upgrading an older setup:** if your main app covers all of `example.com` and you have a
   **bypass** app for `/_api/deploy/*`, `/mcp`, `/oauth/*` and `/.well-known/*`, change the main
   app's domains to the list above. The bypass app is then unnecessary (keeping it is harmless).
   Until you change it, the home page sits behind the login, and signed-in visitors to `/` are
   sent straight to their dashboard.
4. Note your **team domain** (Settings → Custom Pages, or the URL of your login page):
   `<team>.cloudflareaccess.com`.

### 1.6 Worker secrets

```bash
openssl rand -base64 32 | npx wrangler secret put SECRETS_KEK   # encrypts app secrets in D1; back it up!
npx wrangler secret put ACCESS_TEAM_DOMAIN                     # e.g. myteam.cloudflareaccess.com
npx wrangler secret put ACCESS_AUD                             # the AUD tag from step 1.5
npx wrangler secret put OWNER_EMAIL                            # you, the platform admin
```

Keep a copy of `SECRETS_KEK` somewhere safe. If it is lost or changed, stored app secrets can no
longer be decrypted (apps would have to set them again).

---

### 1.7 Formelab login (WorkOS AuthKit)

People sign in with an email code, Google, or any other method you turn on in WorkOS. AuthKit is
free up to 1 million monthly active users and sends the sign-in emails itself. Until these
secrets are set, Formelab keeps using Cloudflare Access (1.5), so you can deploy first and switch
when ready.

1. Create a WorkOS account at <https://workos.com>, then open **Authentication**:
   - Turn on **Email + Magic Auth** (one-time email codes) and **Google OAuth**. In production,
     Google needs your own OAuth client: create one in Google Cloud Console and paste its client
     ID and secret into WorkOS (WorkOS's setup page links the steps).
2. **Redirects**: add `https://example.com/auth/callback` and make it the default, and add
   `https://admin.example.com/auth/callback` for the admin panel's own sign-in. For local
   development, also add `http://localhost:8787/auth/callback` and
   `http://admin.localhost:8787/auth/callback` in the staging environment.
3. Copy the **Client ID** and **API key** from **API Keys**, then:
   ```bash
   npx wrangler secret put WORKOS_CLIENT_ID
   npx wrangler secret put WORKOS_API_KEY
   ```
4. Apply migrations and deploy (section 2), then log in at `https://example.com/login`.
5. **Retire Cloudflare Access**: in Zero Trust, delete the Formelab Access applications (or remove
   all their domains). While Access still covers `/app` or `*.example.com`, its login page shows up
   before Formelab's. The Worker checks every request itself, so nothing becomes public.

How accounts work:
- Anyone can sign in. New people land on the **waitlist**: they can open apps shared with them but
  can't create namespaces or publish. You let them in from the dashboard's **Waitlist** section
  (**Let in**), or invite an address ahead of time with **Invite**. The `OWNER_EMAIL` account, and
  everyone who used Formelab through Access before, are active.
- Apps are **private by default**: only the owner, the app's editors, and namespace editors can
  open them. Add emails under **Share with** to let others open an app; it then appears on their
  **Shared with me** page.
- Each namespace host (`<ns>.example.com`) gets its own session cookie, handed over from the
  dashboard's through a single-use code, so an app's JavaScript can't touch the dashboard login.

### 1.8 Notification emails (Cloudflare Email Service)

Formelab emails people when they join the waitlist, when they're let in, when an app is shared
with them, and when they're made a namespace editor. It also emails you (`OWNER_EMAIL`, or `ADMIN_EMAIL` if
you set that var) about each new waitlist sign-up. Sign-in emails come from WorkOS (1.7).
Emails go through Cloudflare Email Service via the `EMAIL` binding in `wrangler.toml`: it's part
of the Workers Paid plan (3,000 emails a month included, then $0.35 per 1,000) and, at the time
of writing, in beta.

1. In the Cloudflare dashboard, open **Email Service** (search "Email Service" if it isn't in the
   sidebar) and **onboard** `example.com` for sending. Because the domain is already on
   Cloudflare, it adds the SPF, DKIM and DMARC records for you. Wait until the domain shows as
   verified.
2. Check the sender in `wrangler.toml`: `[vars] EMAIL_FROM` (default `Formelab <hello@example.com>`)
   and the matching `allowed_sender_addresses` on the `[[send_email]]` binding.
3. Deploy. Nothing else to set: no API key.

Until the domain is onboarded, sends fail; Formelab logs the failure (`email failed …` in
`wrangler tail`) and carries on. In `npm run dev`, wrangler logs emails instead of sending them.

Each message goes out once: a repeated waitlist sign-up, approving someone twice, or publishing a
new version of a shared app doesn't send it again. Only people newly added to an app's
**Share with** or **Editors** list (or a namespace's editors) are emailed, never the person
making the change.

## 2. Production deploy runbook

First deploy, and every deploy after:

```bash
npm ci
npm run typecheck && npm test           # 1. everything green locally
npm run db:migrate:remote               # 2. apply any new migrations (safe to re-run)
npm run deploy                          # 3. wrangler deploy (runs scripts/gen-assets.mjs first)
```

Then smoke-test the live domain (section 2.2).

### 2.1 Migrations

- Migrations live in `migrations/` and are applied in order by
  `wrangler d1 migrations apply launchpad --remote` (`npm run db:migrate:remote`).
- Always apply migrations **before** deploying code that needs them. Add new migrations as new
  files (`0003_...sql`); never edit one that has been applied.
- Check state: `npx wrangler d1 migrations list launchpad --remote`.

### 2.2 Smoke test

Creates a canary app in your namespace, fetches it, deletes it, and checks it is gone:

```bash
export FORMELAB_DOMAIN=example.com
export FORMELAB_NAMESPACE=yourname
export FORMELAB_TOKEN=fl_...           # create in the dashboard → Deploy tokens
cloudflared access login https://yourname.example.com   # once, so the script can fetch through Access
scripts/smoke.sh
```

If `cloudflared` is not installed you can set `FORMELAB_ACCESS_JWT` instead (the value of the
`CF_Authorization` cookie for `yourname.example.com`). Without either, the publish/list/delete
checks still run and the fetch is skipped with a notice.

### 2.3 Rolling back

`npx wrangler rollback` returns to the previous Worker version. Migrations are not rolled back;
write a new forward migration if you need to undo a schema change.

### 2.4 Rotating things

- **A deploy token leaked:** revoke it in the dashboard. Tokens are stored only as hashes.
- **Access AUD / team domain changed:** `wrangler secret put ACCESS_AUD` (or `ACCESS_TEAM_DOMAIN`).
- **SECRETS_KEK:** there is no automatic re-encryption in v1. Rotating it invalidates every stored
  app secret; app owners must set them again.

---

### 2.5 Before a wider launch

- [x] Move user apps to their own domain (`APP_DOMAIN`, see the top of this file).
- [ ] Use your own Google OAuth client in WorkOS (1.7) so the consent screen shows Formelab.
- [ ] Set up notification emails (1.8) so people hear when they're let in and when apps are
  shared with them.

## 3. Local development

```bash
npm install
cp .dev.vars.example .dev.vars          # then set SECRETS_KEK: openssl rand -base64 32
npm run db:migrate:local
npm run dev                             # wrangler dev --env dev on http://localhost:8787
```

- `[env.dev]` in `wrangler.toml` sets `ENVIRONMENT=dev`, `DOMAIN=localhost` and
  `APP_DOMAIN=app.localhost`, and has no routes, so wrangler keeps the real Host header.
- In dev, `DEV_USER` from `.dev.vars` is the signed-in user (no Access). This bypass only works when
  `ENVIRONMENT` is exactly `dev`; production uses `ENVIRONMENT=production`.
- Home page: <http://localhost:8787/>. Login: <http://localhost:8787/login>. Web app:
  <http://app.localhost:8787/>. Admin: <http://admin.localhost:8787/>. Apps:
  `http://<ns>.app.localhost:8787/<path>/` (browsers resolve
  `*.localhost` to your machine; for curl use `--resolve` or rely on curl's own `*.localhost` handling).
- In dev the secret proxy also allows `http://` URLs (still never private addresses).

### Tests

```bash
npm test          # vitest inside the Workers runtime (@cloudflare/vitest-pool-workers)
npm run typecheck
```

`test/` covers every requirement in spec section 13; each describe block is named after the
requirement it covers (`security 1: ...` through `security 12: ...`).

---

## 4. Connecting Claude (MCP)

### Claude chat (claude.ai, desktop and mobile apps)

The MCP endpoint supports OAuth, so Claude chat connects without a token:

1. In Claude, open **Settings → Connectors → Add custom connector**.
2. Name it `Formelab` and set the URL to `https://example.com/mcp`.
3. Click **Connect**. Sign in through Cloudflare Access, then click **Allow** on the Formelab page.

The connection acts as you. It appears on the dashboard under **Connected apps**, where
**Disconnect** revokes it immediately. Sign-ins last up to 30 days before Claude has to reconnect.

### ChatGPT

ChatGPT connects the same way (OAuth, no token):

1. In ChatGPT, open **Settings → Apps & Connectors → Advanced settings** and turn on
   **Developer mode** (needed for tools that change things, such as `publish`; available on paid
   plans).
2. **Create** a connector: name `Formelab`, URL `https://example.com/mcp`, authentication **OAuth**.
3. Connect it, sign in through Cloudflare Access, and click **Allow** on the Formelab page.

Without Developer mode, ChatGPT only offers tools named `search` and `fetch`. Formelab provides
both, read-only: `search` finds your apps (and the build guide), and `fetch` returns an app's
details and its `index.html` source. ChatGPT connections are listed and revoked under
**Connected apps** like Claude's.

### Gemini

In the Gemini app, custom connectors are only available on Gemini Enterprise and up: an admin adds
Formelab as a custom MCP server with the URL `https://example.com/mcp`. Everyone else can use
Gemini CLI.

Gemini CLI (and Antigravity CLI): add the server to `~/.gemini/settings.json`, then run
`/mcp auth formelab` inside `gemini` to sign in:

```json
{ "mcpServers": { "formelab": { "httpUrl": "https://example.com/mcp" } } }
```

Gemini clients register themselves with OAuth dynamic client registration, like Claude and
ChatGPT; Gemini CLI uses a `localhost` redirect, so the consent page shows the "app on your
computer" warning.

### Claude Code

1. In the dashboard, create a deploy token (30 days is fine for personal use). It is shown once.
2. Run (the dashboard shows this command pre-filled with your domain):

   ```bash
   claude mcp add --transport http formelab https://example.com/mcp \
     --header "Authorization: Bearer fl_..."
   ```

3. Optional: install the skill so Claude knows the workflow:

   ```bash
   mkdir -p ~/.claude/skills/formelab-app
   cp skill/SKILL.md ~/.claude/skills/formelab-app/SKILL.md
   ```

Tools: `whoami`, `list_namespaces`, `list_sites`, `publish`, `update_site`, `delete_site`,
`get_guide`, `search`, `fetch`. Then ask Claude Code something like *"Build me a habit tracker and publish it to
Formelab at yourname/habits."*

## 5. Publishing from scripts

```bash
export FORMELAB_TOKEN=fl_...  FORMELAB_DOMAIN=example.com
scripts/publish.sh --file app.html --namespace yourname --path budget --title "Budget"
scripts/publish.sh --file site.zip --namespace yourname --path docs --spa
scripts/publish.sh --file app.html --namespace yourname --path budget --dry-run
```

The script never prints the token (it passes it to curl on stdin). For local dev use
`FORMELAB_URL=http://localhost:8787` instead of `FORMELAB_DOMAIN`.

---

## 6. API reference (summary)

All errors are JSON: `{ "error": { "code", "message", "hint" } }`.

**Management API**: `https://APP_DOMAIN/_api/admin/*` (signed-in session; writes need the
`x-formelab-request: 1` header, which the dashboard sends) and `https://DOMAIN/_api/deploy/*`
(`Authorization: Bearer fl_...`; same endpoints except `/tokens`).

| Method and path | Purpose |
|---|---|
| `GET /whoami` | `{ email, name, isAdmin }` |
| `GET /namespaces` | Namespaces you own or edit |
| `POST /namespaces` `{ label }` | Create a namespace |
| `PATCH /namespaces/:label` `{ editors }` | Owner only |
| `DELETE /namespaces/:label` | Owner only; deletes every site in it |
| `GET /sites?namespace=` | List sites |
| `POST /sites` | Multipart `file`, `namespace`, `mount_path`, `title?`, `spa?`, `visibility?`, `allowed_emails?`, `editors?`; or JSON with `html` / `zip_base64` instead of `file`. Returns `{ url, site }` |
| `PATCH /sites/:id` | `title`, `hidden`, `spa`, `visibility`, `allowed_emails`, `editors` |
| `DELETE /sites/:id` | Delete the site, its files, KV and secrets |
| `POST /tokens` `{ name, ttlHours }` | `/_api/admin` only: returns the token once (1–720 hours, default 24) |
| `GET /tokens`, `DELETE /tokens/:id` | `/_api/admin` only: list / revoke your tokens |

**Runtime API**: `https://<ns>.APP_DOMAIN/_api/*`, used by the SDK (see the guide):
`GET /me`, `GET /kv?prefix=`, `GET|PUT|DELETE /kv/:key`, `GET /secrets`,
`PUT|DELETE /secrets/:name`, `POST /secrets/:name/proxy`.

## 7. Repo layout

```
wrangler.toml                 bindings, routes, cpu limit, [env.dev]
migrations/                   D1 schema
src/index.ts                  Hono apps + host-based dispatch
src/auth.ts                   Access JWT, deploy tokens, permission rules
src/sites.ts                  namespaces, publish/replace/delete, mount resolution
src/upload.ts                 .html / .zip intake and validation
src/serve.ts                  static serving, <base> injection, SPA fallback
src/api.ts                    admin + deploy management API
src/runtime.ts                per-app /_api/* (CSRF/origin rules, site resolution)
src/kv.ts, src/secrets.ts     KV; encrypted secrets + proxy
src/ssrf.ts                   SSRF guard used by the proxy
src/mcp.ts                    MCP server
src/dashboard/                dashboard HTML, JS, CSS
src/sdk.js, src/guide.md      browser SDK and agent guide
scripts/                      publish.sh, smoke.sh, gen-assets.mjs
skill/SKILL.md                Claude Code skill "formelab-app"
test/                         vitest suites
```
