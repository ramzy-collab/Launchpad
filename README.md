# Launchpad

A small, personal app host on Cloudflare. You (and a few people you invite) publish self-contained
web apps and get a live URL for each:

```
https://<namespace>.<DOMAIN>/<mount-path>/
```

Apps are plain HTML/CSS/JS (a single `.html` file or a `.zip` with `index.html` at its root). They
get identity, per-app key/value storage, and secrets with a server-side proxy through a tiny
browser SDK (`window.launchpad`). Claude Code publishes apps through Launchpad's MCP server; there
is also a web dashboard.

- One Worker (`src/index.ts`) serves the dashboard, APIs, MCP server, SDK and app files.
- D1 holds structured data; R2 holds app files; Cloudflare Access handles all sign-in.
- Agent build guide: [`src/guide.md`](src/guide.md), served at `/_platform/guide.md`.
- Design choices and deviations from the spec: [`DECISIONS.md`](DECISIONS.md).

---

## 1. Cloudflare prerequisites

Do these once. Replace `example.com` everywhere with your domain.

### 1.1 A dedicated domain on Cloudflare DNS

Use a domain just for Launchpad (for example `mylaunchpad.dev`) so namespaces sit **one level
down**: `ramzy.mylaunchpad.dev`.

> **Important:** Cloudflare's free Universal SSL certificate covers `DOMAIN` and `*.DOMAIN`, but
> **not** `*.sub.DOMAIN`. If you nest Launchpad under a subdomain (`ramzy.apps.example.com`) you
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
- Replace `example.com` in `routes` and in `[vars] DOMAIN` with your domain.

The routes `DOMAIN/*` and `*.DOMAIN/*` are created on deploy from `wrangler.toml`.

### 1.5 Cloudflare Zero Trust (free for up to 50 users)

In the [Zero Trust dashboard](https://one.dash.cloudflare.com/):

1. **Settings → Authentication**: add an identity provider: Google, or **One-time PIN** (email codes, zero setup).
2. **Access → Applications → Add an application → Self-hosted**, the **main app**:
   - Application domains: `example.com` and `*.example.com` (add both).
   - Policy: **Allow**, include **Emails**: your email plus any invitees.
   - After saving, open the app's **Overview** and copy the **Application Audience (AUD) Tag**.
3. Add a second **Self-hosted** application, the **bypass app**, for the paths the Worker
   authenticates itself with bearer tokens:
   - Application domains: `example.com/_api/deploy/*` and `example.com/mcp`.
   - Policy: action **Bypass**, include **Everyone**.
   (Access matches the most specific path, so these paths skip the login while everything else
   still requires it.)
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
export LAUNCHPAD_DOMAIN=example.com
export LAUNCHPAD_NAMESPACE=yourname
export LAUNCHPAD_TOKEN=lp_...           # create in the dashboard → Deploy tokens
cloudflared access login https://yourname.example.com   # once, so the script can fetch through Access
scripts/smoke.sh
```

If `cloudflared` is not installed you can set `LAUNCHPAD_ACCESS_JWT` instead (the value of the
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

## 3. Local development

```bash
npm install
cp .dev.vars.example .dev.vars          # then set SECRETS_KEK: openssl rand -base64 32
npm run db:migrate:local
npm run dev                             # wrangler dev --env dev on http://localhost:8787
```

- `[env.dev]` in `wrangler.toml` sets `ENVIRONMENT=dev` and `DOMAIN=localhost`, and has no routes,
  so wrangler keeps the real Host header.
- In dev, `DEV_USER` from `.dev.vars` is the signed-in user (no Access). This bypass only works when
  `ENVIRONMENT` is exactly `dev`; production uses `ENVIRONMENT=production`.
- Dashboard: <http://localhost:8787/>. Apps: `http://<ns>.localhost:8787/<path>/` (browsers resolve
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

## 4. Connecting Claude Code (MCP)

1. In the dashboard, create a deploy token (30 days is fine for personal use). It is shown once.
2. Run (the dashboard shows this command pre-filled with your domain):

   ```bash
   claude mcp add --transport http launchpad https://example.com/mcp \
     --header "Authorization: Bearer lp_..."
   ```

3. Optional: install the skill so Claude knows the workflow:

   ```bash
   mkdir -p ~/.claude/skills/launchpad-app
   cp skill/SKILL.md ~/.claude/skills/launchpad-app/SKILL.md
   ```

Tools: `whoami`, `list_namespaces`, `list_sites`, `publish`, `update_site`, `delete_site`,
`get_guide`. Then ask Claude Code something like *"Build me a habit tracker and publish it to
Launchpad at yourname/habits."*

## 5. Publishing from scripts

```bash
export LAUNCHPAD_TOKEN=lp_...  LAUNCHPAD_DOMAIN=example.com
scripts/publish.sh --file app.html --namespace yourname --path budget --title "Budget"
scripts/publish.sh --file site.zip --namespace yourname --path docs --spa
scripts/publish.sh --file app.html --namespace yourname --path budget --dry-run
```

The script never prints the token (it passes it to curl on stdin). For local dev use
`LAUNCHPAD_URL=http://localhost:8787` instead of `LAUNCHPAD_DOMAIN`.

---

## 6. API reference (summary)

All errors are JSON: `{ "error": { "code", "message", "hint" } }`.

**Management API**: `https://DOMAIN/_api/admin/*` (Access session; writes need the
`x-launchpad-request: 1` header, which the dashboard sends) and `https://DOMAIN/_api/deploy/*`
(`Authorization: Bearer lp_...`; same endpoints except `/tokens`).

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

**Runtime API**: `https://<ns>.DOMAIN/_api/*`, used by the SDK (see the guide):
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
skill/SKILL.md                Claude Code skill "launchpad-app"
test/                         vitest suites
```
