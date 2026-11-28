# Staging

A copy of Formelab for testing, with its own Worker, domains, database, files bucket, OAuth store and rate-limit counters. Nothing is shared with production: a test account, app or saved key made here never reaches formelab.ai. The browser test plans in `docs/test-plans/` are run here.

| | Production | Staging |
|---|---|---|
| Site, sign-in, MCP connector | `formelab.ai` | `formelab-staging.com` |
| Web app | `app.formelab.ai` | `app.formelab-staging.com` |
| Admin panel | `admin.formelab.ai` | `admin.formelab-staging.com` |
| Apps | `<label>.formelab.app` | `<label>.formelab-staging.app` |
| Worker | `formelab` | `formelab-staging` |
| D1 | `launchpad` | `launchpad-staging` |
| R2 | `launchpad-sites` | `launchpad-staging-sites` |
| OAuth KV | `formelab-oauth-kv` | `formelab-staging-oauth-kv` |
| Rate-limit namespaces | 1001 to 1005 | 2001 to 2005 |
| `ENVIRONMENT` | `production` | `staging` (never `dev`, so the `DEV_USER` bypass stays off) |

The settings are `[env.staging]` in `wrangler.toml`.

## Deploying

```bash
npx wrangler d1 migrations apply launchpad-staging --remote --env staging
npx wrangler deploy --env staging
```

Deploy the branch you want to test. Run migrations first when the branch adds any.

## Already done (Nov 28, 2026)

- Zones `formelab-staging.com` and `formelab-staging.app`, each with proxied `AAAA @ 100::` and `AAAA * 100::` records.
- D1, R2 and KV created, migrations 0001 to 0031 applied, Worker deployed with its four routes.
- Secrets: `SECRETS_KEK` (its own, generated for staging), `OWNER_EMAIL`, and `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` set to `unused-in-staging` (staging doesn't use Cloudflare Access).

## Still to do

Each step names the secret to set with `npx wrangler secret put <NAME> --env staging`.

### 1. Sign-in (WorkOS)

Until this is done, nobody can sign in to staging.

1. In WorkOS, use the **Staging** environment (not Production).
2. **Authentication**: turn on Email + Magic Auth, Email + Password and Google OAuth.
3. **Redirects**:
   - `https://formelab-staging.com/auth/callback`, as the default
   - `https://admin.formelab-staging.com/auth/callback`
   - **Password reset URL**: `https://formelab-staging.com/reset-password`
   - **Initiate login URI**: `https://formelab-staging.com/auth/login`
4. From **API Keys**, set `WORKOS_CLIENT_ID` and `WORKOS_API_KEY`.

### 2. Emails (Cloudflare Email Service)

Needed for invites, waitlist and deletion-request emails (sign-in codes come from WorkOS).

1. In Cloudflare, **Email Service**: onboard `formelab-staging.com` for sending, and wait until it shows as verified.
2. The sender is already `hello@formelab-staging.com` in `wrangler.toml`.

### 3. Google Sheets (Google OAuth client)

Needed for the outside-data test plan.

1. In Google Cloud Console, a separate project or client for staging, with the Google Sheets API enabled and the `.../auth/spreadsheets` scope.
2. Add each test account's Google address under **Test users**.
3. **Authorized redirect URI**: `https://app.formelab-staging.com/services/google-sheets/callback`.
4. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

### 4. Test accounts and features

Once sign-in works:

1. Sign in once as `OWNER_EMAIL`, which makes you the staging admin.
2. In the admin panel (`admin.formelab-staging.com`), **Features**: turn on, for the owner account, `connected_apps`, `responses`, `app_mcp` and `supabase_identity`.
3. Make the test accounts each plan lists: let them in from the **Waitlist**, or invite their addresses. Test inboxes you can read are needed for codes and invites.
4. Build each plan's test apps as its Setup section says.

### 5. Supabase

The Supabase plan uses a test project. `formelab-oidc-test` was made for the step 6b check; delete it when you're done, or keep it for the plan.

## Running the test plans

Hand them to Claude Cowork in this order, each against staging:

1. [Access rules over outside data](/test-plans/2026-11-24-access-rules-outside-data)
2. [App members and roles](/test-plans/2026-11-24-app-members-roles)
3. [Signing in to an app](/test-plans/2026-11-24-app-sign-in)
4. [Deleting people who use apps](/test-plans/2026-11-24-app-user-deletion)
5. [Each app's address for AI tools](/test-plans/2026-11-25-app-ai-address)
6. [Use with your AI](/test-plans/2026-11-25-use-with-your-ai)
7. [Supabase person by person](/test-plans/2026-11-27-supabase-identity)

Results go in the admin panel's **Test plans** page on production (Import results), since that's where the plans live.
