# Formelab agent access

Status: design agreed; steps 1 to 3 and 6 shipped; step 4 built Nov 24, 2026 (parts A, B and C); step 5 built Nov 25, 2026 (parts A and B). Supersedes the Nov 21,
2026 "Agent Access: Modular Feature Proposal". Decisions are recorded in the log at the end; the module sections state the result.

## Why

The Formelab connector can read an app's files (`fetch`, `read_file`) and responses
(`get_responses`), but not its saved data (`formelab.kv`). Apps whose content lives in saved data,
such as Thanksgiving Menu (space `ramzy`, path `thanksgiving-menu`), are unreadable to an agent.
Beyond the owner's own agents, apps should be usable by their own users' AI tools, safely, with
each person seeing only what they are allowed to.

Note: `formelab.kv` is stored in D1 (`kv` and `kv_user` tables, `src/kv.ts`), not Cloudflare KV.
Storage is not the security question; who may read and write is.

## Found while checking (Nov 22, 2026), to fix before step 1

Two existing problems, each a small change of its own (details in step 6 and the open items):

1. People an app is shared with can make any Sheets or connector call, with the owner's account
   or key, beyond what the app's code does, and `data_writes` doesn't limit them. **Partly fixed
   Nov 22, 2026:** people below owner or editor are limited to value reads, row appends and
   updates and tab names (`viewerMayCall`, `src/sheets.ts`); structural edits, clearing, data
   filters and grid data fail with `sheets_editors_only`. Making row writes follow `data_writes`
   was rejected: apps made since migration `0012` default to "editors" and the builder only
   checks `formelab.kv` writes, so it would break apps whose users add rows. They can still read
   any range and overwrite rows; step 6's rules close that. Connectors are unchanged apart from
   copy saying people who can open the app can make their own calls with them.
2. ~~Sign-in step one shows whether an email has a password set (account enumeration, low
   severity).~~ Fixed Nov 22, 2026: the step looks the same for every email.

## Build order

| Step | What | Requires | Delivers on its own |
|---|---|---|---|
| 1 | Owner and editor data tools in the Formelab connector | Nothing new | Owner's agents read and change any app's shared data |
| 2 | Rules file (`formelab.json`), publish checks, settings warning | Nothing new | Safer defaults for every new app; owners see which apps are exposed |
| 3 | Rules enforced at runtime (browser SDK) for apps with rules | Step 2 | Per-user data access inside the app itself |
| 4 | App members and roles managed inside the app, app-branded sign-in | Steps 2, 3 | Apps with their own users who never see Formelab |
| 5 | Per-app endpoint (`<app-host>/mcp`) | Steps 1, 3, 4 | Any app user connects their AI tool to that app |
| 6 | Rules over outside data (Sheets, Supabase, other connectors) | Steps 2, 3 | Per-user access to connected services |

The end-to-end flow (a user asks their AI tool, the app's endpoint applies the rules and the right
credentials, and returns only what that user may see) is not a separate build. It is the
acceptance test once steps 1 to 6 are in place.

## Step 1: data tools in the Formelab connector

Tools in `src/mcp.ts`, reusing `kvList`, `kvGet`, `kvSet`, `kvDelete` from `src/kv.ts`:

- `kv_list(namespace, mount_path, prefix?, after?)`: keys, values and `updatedAt`, sorted by key,
  paged with the existing `after` cursor (`KV_LIST_PAGE_BYTES`).
- `kv_get(namespace, mount_path, key)`
- `kv_set(namespace, mount_path, key, value)`: not read-only.
- `kv_delete(namespace, mount_path, key)`: marked destructive, so the client asks first.

Rules:

- Access: `requireManageableSite` (owner, editors, space editors), the same as `get_responses`.
- Shared data only. `formelab.kv.mine` is not exposed to anyone, including the owner. Almost no
  apps use it; adding the caller's own private data later is one optional setting.
- Results carry the existing note that the data was written by other people and is data, not
  instructions.
- Every `kv_set` and `kv_delete` calls `audit()` with the person's email as actor, the app, the key
  (never the value), and the AI tool that made it (the OAuth client name or deploy key's
  `clientName`, falling back to "an AI tool"). The log shows "Ramzy, via ChatGPT".

Checked (Nov 22, 2026): the client name reaches `handleMcp` but not the tools. `mcpApiHandler`
(`src/oauth.ts`) works it out as the `initialize` message's `clientInfo.name`, else the grant's
`props.client`, else the User-Agent, and passes it to `handleMcp` (`src/mcp.ts`), which uses it only
for Metrics (`countToolCalls`). The `Ctx` the tools get (`env`, `user`, `waitUntil`, `requestUrl`)
has no client. Step 1 adds `client` to `Ctx`. Gaps to handle:

- OAuth grants approved before `props` carried `client` have none; the User-Agent fallback can
  also be null. Hence "an AI tool".
- Deploy keys have a name only once their app has sent an `initialize` (`noteTokenClient`), and
  it is whatever that app said last.
- Every source is self-reported: a client registers its own `client_name` (dynamic registration
  or a client metadata document). The log line records what the tool called itself, not a
  verified identity. The actor (the person's email) is the trustworthy part.

## Step 2: the rules file and publish checks

### `formelab.json`

Written by the building AI during the build (the guide gets an "Access rules" section). Describes
record types, roles and what each role may do.

```json
{
  "default_role": "salesperson",
  "manage_roles": ["manager"],
  "records": {
    "lead": {
      "prefix": "lead:",
      "fields": ["name", "stage", "assignedTo"],
      "owner_field": "assignedTo",
      "read":  { "manager": "all", "salesperson": "own" },
      "write": { "manager": "all", "salesperson": "own" }
    }
  }
}
```

- Each role gets `all`, `own` (records whose `owner_field` is the signed-in person's email) or
  `none`, for read and for write. Roles not listed get `none`.
- `guest` is the role for signed-out visitors (public link). It gets `none` unless granted.
- Simple apps (polls, the menu app) may use a one-line rule: everyone may read and write
  everything. It is an explicit, valid choice.
- Records whose prefix no rule mentions: only the owner and editors reach them.
- The owner and editors always see and change everything.
- Who holds which role is not in the file (app files are readable by anyone who can open the app).
  See step 4.

Team-level access (a manager sees only their team) is left out until a real app needs it.

### Checks on publish and upload

Apply to `publish` through the connector and to manual uploads (`src/upload.ts`) alike.

"New app" means an app created after this ships. Formelab marks it at creation; every later
publish of it follows these rules.

| Situation | Existing app | New app |
|---|---|---|
| Saves no data, uses no connected services | Nothing | Nothing |
| Valid `formelab.json` | Nothing | Nothing |
| `formelab.json` is broken | Refused with the exact error | Refused with the exact error |
| Saves data or uses Sheets or connectors, no `formelab.json` | Nothing at upload; persistent settings warning | Refused (like a missing icon) |
| Rules allow in-app invites (`manage_roles`) | "Treat as public" warning, acknowledged | "Treat as public" warning, acknowledged |

Detection is a fixed scan of the uploaded code for `formelab.kv`, `formelab.sheets` and connector
calls and the key prefixes used. No AI is involved.

Refusal copy (manual upload; the connector returns the same reason and remedy):

> **This app can't be published yet**
> It saves data (we found `lead:` and `settings` records) but has no access rules, so we can't tell
> who should see what.
> **To fix it,** add a `formelab.json` that says who can see and change each kind of record. Or
> paste this into Claude, ChatGPT or your AI tool:
>
> ```
> My Formelab app saves data under these keys: lead:, settings. Write a formelab.json
> access rules file for it, following https://formelab.ai/guide#access-rules. Ask me who
> should see and change each kind of record before you write it.
> ```
>
> [Copy prompt]

The prompt lists the prefixes the scan found. Through the connector, the "treat as public"
warning is passed back to the person to confirm, never confirmed by the AI.

Invite warning copy:

> **People using this app can invite anyone**
> Treat it as public: anyone they invite can open it.
> [Publish anyway] [Cancel]

An acknowledgement means the owner accepts the risk; the app then runs.

### Persistent warning on the app's settings page

Shown to owners and editors while an app saves data without rules:

> **No access rules.** Everyone who can open this app can see all of its saved data, and its users
> can't connect their AI. [Add rules]

Also shown on apps with connected services and no rules ("everyone who can open this app can use
its connected services"), and, for apps that allow in-app invites, a line that the app is treated
as public. Goes away on its own once a valid `formelab.json` is published.

## Step 3: rules at runtime

- For an app with rules, every `formelab.kv` call from the browser (`src/runtime.ts`) is filtered
  by the same rules, so the app shows no more than an agent gets.
- Backstop: a new app with no rules file that reads or writes shared data, Sheets or connectors at
  runtime is refused with a plain error. A scan that missed something can never leave data open.
- Existing apps without rules keep today's behavior: everyone who can open the app (including
  public link guests) reads shared data; writes follow `data_writes`.

## Step 4: app members, roles and sign-in

### Members and roles

- The app's users are one member list per app, keyed by email, with a role each.
- People with access on the Formelab side (owner, editors, share list) appear as app users
  automatically. Share list people get `default_role`, or `none` if there is none.
- Roles are managed inside the app, through new SDK calls (for example
  `formelab.roles.set(email, "salesperson")`), allowed only for the owner, editors and roles in
  `manage_roles`. Formelab's settings keep control of the app itself: who can change it, whether it
  is public, and its share list.
- Adding someone in the app lets them open it.
- Owners get a "Remove this person" action on the member list.

### Decided (Nov 24, 2026): how step 4 works

Built in three parts: **A** members and roles, **B** branded sign-in, **C** deletion.

- **Where the list lives (A).** Table `app_members` (`site_id`, `email`, `role`, `added_by`,
  `created_at`; migration `0029`), code in `src/members.ts`. The owner, editors and share list
  aren't stored: they count as members, share list people with `default_role`. A row for a share
  list person only changes their role; removing it puts them back on `default_role`. Taking them off
  the share list stays a Formelab sharing change. Apps open to "All Formelab members" treat every
  member like the share list.
- **Opening the app (A).** The app-host check (`appAccess`) lets in people with a row, but only
  while the app's rules have records, so dropping the rules can't leave members in. Members needn't
  be active Formelab accounts.
- **Roles (A).** `Who` carries `role`: the member row's, else `default_role` for people the app is
  shared with, `guest` for the public link. `levelFor` and `sourceLevel` read it.
- **SDK (A).** `formelab.roles.list()`, `set(email, role)`, `remove(email)` at `/_api/roles`, for
  the owner, editors and `manage_roles` (`not_allowed` otherwise). A manager may give any role the
  rules name, `manage_roles` included, but never `guest`, and can't touch the owner or editors
  (`manages_app`). The list shows emails, so it's for the same people. `me()` adds `role` and
  `manages`. At most 2,000 rows per app (`members_full`, one statement); people below editor may
  make 20 changes a minute. Apps with `{"everyone":"all"}` have no roles (`roles_unavailable`).
- **Invite link (A).** No token: the link is the app's address. Only being on the list lets
  someone in, so a forwarded link grants nothing.
- **Remove this person (A).** On the app's settings page ("Added in the app"), for the owner and
  editors who may share (`canShareSite`), since it changes who can open the app.
- **Sign-in (B).** App sign-in goes through formelab.ai (`handoffStart`, `/auth/app`, then
  `/login`). `appOfReturn` (`src/login.ts`) finds the app from the return address; the login page
  then reads "Sign in to <app>" with the app's address and "Powered by Formelab", without
  Formelab's menu or "Join the waitlist". The name is capped at 60 characters and the address is
  always shown, since an owner could name an app after another business.
- **App users (B).** `completeSignIn` gets the app. Someone new who is a member (owner, editor,
  share list or `app_members`) gets `users.status = 'app_user'`, no waitlist entry. The flag is on
  the account rather than the session (no migration): formelab.ai and the web app treat an
  `app_user` as signed out, except `/auth/app` to app hosts and logout, so they never see the
  dashboard, MCP consent or "My apps". Signing in to formelab.ai itself turns them into a normal
  `waitlisted` account (`upsertUser`), with the same onboarding as anyone. Existing accounts are
  left as they are. Someone new who isn't a member gets "<email> hasn't been added to <app>": no
  Formelab record is made, and the WorkOS user the sign-in created is deleted, best effort.
  Approving an `app_user` from the waitlist makes them active. The admin panel counts them as
  "People using apps", apart from "People", and tags them "uses apps".
- **Deletion (C).** `dropUnlistedAppUsers` (`src/users.ts`) runs after every removal: in the app
  (`roles.remove`), on the settings page, when an app stops being shared with someone or loses an
  editor, and when an app is deleted (`removeSite`). An `app_user` that no app lists any more
  (owner, editor, share list or `app_members`) is deleted at once with `deleteUser`'s own steps
  (`eraseAccount`): sessions, private data (`kv.mine`), waitlist, AI connections and the WorkOS
  user. Their activity log lines and usage metrics keep a stand-in (`deleted-user-…`) instead of
  their email. Formelab accounts are never deleted this way. There's no scheduled clean-up job.
  Records naming the person (`owner_field` emails, responses) stay as the app's data. Deleting a
  Formelab account in the admin panel now also removes its `app_members` rows.
- **Deletion requests (C).** Admin panel, Users, "Deletion requests": find an email, see every app
  that lists them and how, and **Notify owners**, which emails each owner once with a link to each
  app's page (`deletionRequestEmail`). The page gives the generic reply to send the requester.
  Formelab's own account is deleted with **Delete** as before.
- **Known gaps.** The sign-in code email and the Google consent screen still say Formelab. There is
  no privacy policy page yet, so "Powered by Formelab" links to the home page until there is one.
  The password step and "Forgot password?" are shown to app users too, the same for every email.

### Sign-in

- App users sign in with Formelab's sign-in (WorkOS), branded as the app: "Sign in to Acme CRM",
  with a small "Powered by Formelab" line linking to the privacy policy.
- App users never see the Formelab dashboard, waitlist or "My apps".
- No marketing use of app users' emails. An opt-in checkbox for Formelab news is a separate
  decision, for the owner and a lawyer.

### Invites and email

- In-app invites send no email from Formelab. The app shows "Copy invite link". Sign-in codes still
  come from WorkOS, so Formelab's share email limits (`SHARE_EMAILS_NEW_PER_DAY` = 20) are not hit.
- Invite emails sent in the app's name are a future paid feature (B2C tiers).

### Privacy

- Formelab holds app members' emails on the owner's behalf (owner is controller, Formelab is
  processor). Formelab's terms and privacy policy must say so.
- Being invited stores the email on that app's member list only: no user record, no waitlist entry.
- A user record with status `app_user` is created only on first sign-in. It is kept off the
  waitlist and out of signup numbers; the admin panel counts "people using apps" separately.
- Removing a member, or deleting the app, deletes the entry. If they never signed in, nothing
  about them remains. Their sign-in record is deleted once no app has them as a member.
- Signing up at formelab.ai looks identical whether or not the email was used in an app ("Check
  your email for a code"). After the code: normal new-user onboarding, same sign-in, nothing said
  about earlier app use. App-only memberships do not appear in "My apps".
- Deletion requests:
  - Sent to a customer: covers that customer's apps; they remove the person.
  - Sent to Formelab: Formelab deletes its own data (account, opt-ins). An admin tool finds every
    app with that member and notifies each owner with a one-click remove. The requester is told
    generically that the request was passed to every business on Formelab that has their email,
    never which apps.

## Step 5: per-app endpoint

- `https://<app-host>/mcp` (or the app's custom domain), named and described as the app.
- Tools come from `formelab.json`: named per record type ("List my leads") with real descriptions.
- Signed in through the app-branded sign-in (OAuth), as the app's users.
- Every request applies the rules on the server. Apps without a valid rules file have no endpoint
  for their users; owners and editors still use the Formelab connector (step 1).

### Decided (Nov 25, 2026): how step 5 works

Two parts: **A** the address and its tools, **B** "Use with your AI" on the settings page and the guide.

- **Each app host is its own OAuth server (A).** `src/appmcp.ts`, one `OAuthProvider` per app
  origin, tokens bound to `<origin>/mcp`. The library's separate authorization-server mode needs
  every resource listed at start-up, which apps (made all the time) can't give. Reserved on app
  hosts: `/mcp`, `/.well-known/oauth-*`, `/_platform/oauth/token` and `/_platform/oauth/register`.
  Other paths never build a provider. With the feature on, publishing
  a file at `mcp` or `.well-known/oauth-*` is refused (`reserved_path`).
- **Sign-in and consent (A).** The consent page is on Formelab's own origin,
  `<aiOrigin>/app-authorize/<host label>`, which the app's OAuth metadata names as its
  `authorization_endpoint`; tokens, registration and `/mcp` stay on the app host. On the app's own
  origin, the app's scripts, or a service worker it registers, could read the page or press Allow
  for the person (found by security review: Fetch Metadata checks don't stop a service worker),
  so no consent page is served there. Signing in from it is the app's sign-in (`appOfReturn` knows
  the path), app users may use that one path on Formelab, and the person must be able to open the
  app (`appAccess`). The page reads "Connect Claude to Acme CRM?" with the person's email and the
  app's address, and offers "See and change what you can" or "Only look".
- **Tokens kept apart, two ways (A).** The library binds each token to its address. App grants
  also carry `siteId` in their props and metadata: the app's `/mcp` refuses grants without its own
  `siteId`, Formelab's `/mcp` refuses any grant with one (`wrong_address`), and Connect your AI
  lists only Formelab connections.
- **Checked on every call (A).** Each request runs `appAccess` again, so a role change applies on
  the next call. Removing a member, or deleting the app, also revokes their grants for it
  (`revokeAppGrants`); deleting an account already revokes all of its grants.
- **Tools (A).** Worked out per request from the rules and the caller's role: per record type
  `list_<type>`, `get_<type>(id)`, `save_<type>(id, value)` and `delete_<type>(id)`, shown only when
  the role's level isn't `none`, with save and delete left off read-only connections. `id` is the
  key after the prefix; leaving it out reaches a record saved as the prefix itself. Titles and
  descriptions say "my" and name the owner field for `own`. Values are JSON objects; `fields` show
  in the input schema as optional. The same `mayRead`, `checkWrite` and filtered paging
  (`kvListKept`, moved from `src/runtime.ts` to `src/kv.ts`) as inside the app. `{"everyone":
  "all"}` apps get `list_data`, `get_data`, `save_data` and `delete_data`. Sheets, connectors and
  `kv.mine` aren't offered. Saves and deletes are logged like step 1 ("via Claude").
- **Limits and metrics (A).** 60 calls a minute per person per app. Calls are recorded in
  `mcp_calls` with the app's id (migration `0030`), and the admin panel's Metrics count only calls
  with none, so app use isn't counted as Formelab use.
- **Feature flag (A).** `app_mcp`, following the app's owner. Off: the reserved paths answer 404.
- **Found while building (A).** The OAuth library writes its helpers onto `env`
  (`env.OAUTH_PROVIDER`), an object every request in an isolate shares, so Formelab's consent page
  could pick up an app's helpers and refuse a connection. The app provider now gets its own child of
  `env`, and `oauthHelpers` always builds Formelab's own.
- **Use with your AI (B).** The app's settings page, Sharing tab, shows "Use with your AI" with the
  address, **Copy address** and short steps for Claude and ChatGPT, only when the app has an
  address (feature on, valid rules). The guide's Access rules section gets a flagged "Use with your
  AI" part: what the address is, that tools come from the rules (so list `fields`), an optional
  in-app section for signed-in people only if the person asks, and the reserved paths.
- **Known gaps.** App users can't see or end their AI connections in Formelab (they have no
  dashboard): they disconnect in their AI tool, and access ends when the app removes them. No
  custom domains. The provider cache keeps one object per app origin per isolate.

## Step 6: outside data

Builds on what exists (behind `connected_apps`): Google Sheets (`src/sheets.ts`), custom connectors
(`src/connectors.ts`) and saved keys (`src/secrets.ts`). Credentials already stay server-side.

- Rules can name each connected source and which roles may use it.
- Sheets: rules name an owner column (`"owner_column": "Assigned to"`). Formelab drops rows that
  are not the signed-in person's before returning them, and allows writes only to their rows.
- Supabase: role level only in step 6, like any other connector (see "Decided" below). Per-person
  access through Supabase's RLS is step 6b.
- Any other connected API: role level only (`all` or `none`).

### Decided (Nov 24, 2026): how step 6 works

- **Naming sources.** `formelab.json` gets an optional `sources` next to `records`:
  `sheets` keyed by spreadsheet id (`owner_column`, `read`, `write`) and `connectors` keyed by name
  (`all` or `none` per role). `connectors` covers custom connectors, saved keys and `"gemini"`: all
  three spend the owner's keys, and `formelab.secrets.proxy(name)` already reaches a connector by
  the same name, so a rule on `connectorFetch` alone could be skipped. `guest` can't be given
  services. Not allowed with `{"everyone": "all"}`, which keeps meaning everything.
- **Where.** Connectors, saved keys and Gemini are checked in `src/runtime.ts` before each route
  (`checkSource`); Sheets in `sheetsCall` (`sourceLevel`), since filtering needs Google's answers.
- **Apps whose rules don't name services.** Apps made before access rules keep today's behavior.
  New apps (`rules_required`) are refused at publish if the scan finds Sheets or connectors and
  there's no `sources`, and at runtime a service the rules don't name is for the owner and editors
  only, so a scan that missed a call leaves nothing open.
- **Rows that aren't yours come back empty** (`[]`) instead of being dropped, so row numbers stay
  where the app expects them (apps work out `update` ranges from a read's row index). Trailing ones
  are left off. This shows where other rows are, not what is in them.
- **Formulas are refused** in `own` writes (cells starting with `=`, `+` or `-` and a letter): with
  `USER_ENTERED`, `=D5` in your own row would show you someone else's cell.
- **`own` is values get, append and update only**, plus tab names. `values:batchGet` and
  `values:batchUpdate`, which `viewerMayCall` allows at `all`, are refused at `own`.
- **Appends Google places elsewhere are undone.** Google appends at the table it finds, which can
  start in another column than the range. If the written range starts elsewhere, Formelab clears it
  and refuses (`sheets_append_moved`), since the owner column got a different cell.
- **Known limit.** Sheets has no conditional write: an update is checked, then sent. Rows an owner or
  editor inserts in between can shift. Noted in the code.
- **Spreadsheet ids in `formelab.json`** are readable by anyone who can open the app. An id alone
  grants nothing (`sheet_not_allowed`, the owner's Google sharing), and is usually in the code
  already.

### Step 6b: Supabase per person (not started)

Supabase's RLS trusts only a JWT it can verify (`auth.jwt()`), so "send the person's identity"
needs Formelab to sign a short-lived token per call. A plain header can be forged by anyone with the
project's anon key, and a `service_role` key skips RLS entirely. Options to check: signing with the
project's JWT secret (a second, very powerful secret to store) or Formelab as a third-party auth
provider (depends on which providers Supabase accepts). Either way the owner writes RLS policies
that read the email from the token. Until then the guide warns never to give a connector the
`service_role` key when people below editor can use it.

### Checked (Nov 22, 2026): what people an app is shared with can do today

Yes, they can, and with more reach than the app's own code uses. In `src/runtime.ts`, every
signed-in person who can open the app (`canViewSite`: owner, editors, share list, and every active
Formelab member when visibility is "All Formelab members") may call:

- `POST /_api/sheets` (`sheetsCall`, `src/sheets.ts`): any method (GET, POST, PUT, DELETE) and
  any Sheets API path on the spreadsheets the owner listed for the app, with the owner's Google
  token. Only creating a spreadsheet is owner-only. That includes `spreadsheets/<id>?includeGridData=true`
  (every tab, every cell) and `spreadsheets/<id>:batchUpdate` (delete tabs, rewrite anything).
- `POST /_api/connectors/<name>/fetch` and `/_api/secrets/<name>/proxy`: any method and path on
  the connector's or secret's allowed hosts, with the owner's key.

The app's `data_writes` setting ("only editors change shared data") applies to `formelab.kv` only,
not to Sheets or connectors. Limits per viewer are rate limits (`viewerLimits`, `checkRate`).
Public link guests are refused all of these (sign-in required). `test/sheets.test.ts` asserts that
a share-list person can append rows, so this is intended behavior, not an accident.

For step 6 this means filtering what the SDK helpers return is not enough: a person can skip the
app's code and call the endpoint directly. Rules must be applied in `sheetsCall` and
`connectorFetch` on the server, and for people below owner or editor the Sheets endpoint must only
accept the operations the filter understands (values read, append, update), refusing
`batchUpdate`, `includeGridData`, data filters and developer metadata.

### Checked (Nov 22, 2026): the shape of Sheets reads

`sheetsCall` returns Google's JSON unchanged as `{ status, data }`. A values read is
`{ range, majorDimension, values }` with `values` an array of rows, each an array of cell strings;
`formelab.sheets.read()` returns just `values` (`src/sdk.js`). There are no column names: row 1 is
a header only by convention, and a range that starts below it (`Sheet1!A5:C10`) has none.

So filtering by `owner_column` works, with these conditions:

- Formelab reads the header row itself (row 1 of the tab) to find the column, rather than trusting
  the requested range.
- It forces `majorDimension=ROWS` and a known `valueRenderOption`, since the caller's `query` can
  flip rows and columns or return formulas instead of values.
- Matching is on the normalized email (`normEmail`), and rows with an empty owner cell are dropped.
- Writes are allowed only by row: `append` with the person's email in the owner column, and
  `update` only on ranges whose rows already belong to them. Ranges spanning other people's rows
  are refused.

## Test plans

Every step with a screen gets a browser test plan in `docs/test-plans/` per CLAUDE.md (upload
refusal and warnings, settings warning, sign-in, in-app roles). Step 1 has no screen: its plan uses
the same format and is run in Claude with the Formelab connector, against a test copy of
Thanksgiving Menu. Example cases:

| ID | Steps | Expected |
|---|---|---|
| KV-01 | As the owner, ask what is in each chafer | Lists every dish by chafer, matching the app |
| KV-05 | As a viewer, ask to change a dish | Refused: only the owner and editors can change it |
| KV-08 | Change a dish through Claude, then open the activity log | Entry under your name, via Claude |

## Open items to verify (not design questions)

- How many live apps use a public link and read shared data (affects how loud the existing-app
  warning should be). Not answerable from the code; needs a query on production D1 (`sites` with
  `public_link` set, joined to `kv` by `site_id`).
- ~~Whether the current signup and sign-in pages answer differently for known and unknown
  emails.~~ Checked Nov 22, 2026:
  - Waitlist signup (`POST /_api/waitlist`, `src/waitlist.ts`): same answer for every email. Only
    the first join sends an email, and that email goes to the address itself.
  - Forgot password (`forgotPost`, `src/signin.ts`): same answer for every email.
  - Sign-in step one (`signInPost`, `src/signin.ts`): **differs.** After "Continue with email" the
    password page adds "New here, or haven't set a password? Choose Email me a code." unless
    `users.has_password` is 1. Anyone can learn whether an email has a Formelab account with a
    password set. Unknown emails and accounts without a password look the same. Fixed Nov 22,
    2026: the hint is shown to everyone and the lookup is gone.
  - "Email me a code" and wrong passwords: Formelab's own copy is the same for every email, but
    WorkOS's error message was shown as is when sending a code failed (`sent.message`). Fixed
    Nov 22, 2026: every sign-in step now shows Formelab's own copy (`toPublicAuthError`,
    `src/signin.ts`). Checking WorkOS staging itself for leftovers (extra sign-in steps on a wrong
    password, timing) is on the README's "Before a wider launch" list.
- WorkOS cost for large numbers of app sign-ins.
- Lawyer: processor terms, deletion deadlines (GDPR: one month), marketing consent.

## Decision log

| # | Question | Decision |
|---|---|---|
| 1 | Who can use the connector data tools | Owner, editors, space editors (Manage check) |
| 2 | Writes and logging | Read and write; each write logged under the person, with the AI tool used |
| 3 | `kv.mine` | Not exposed through the connector; others' private data never visible |
| 4 | Scope | Settle every question before building anything |
| 5 | How app users sign in | The app's own sign-in, no Formelab account needed |
| 5b | How the endpoint learns an app's data | `formelab.json` written during the build, plus a guide section |
| 5c | Manual uploads | Checked on every upload; rules enforced on the server, never trusted to app code |
| 6 | Branding | App's address and name; "Powered by Formelab" on the sign-in screen only |
| 7 | Roles | Defined per app in the rules file; values `all`, `own`, `none`; no teams yet |
| 7b | Who assigns roles | Inside the app; Formelab keeps control of the app itself |
| 7c | Default access | Nothing unless the rules grant it; guests see nothing by default |
| 7d | Existing vs new apps | Existing: persistent warning. New: rules required |
| 7e | Seeding and invites | Formelab-side people seeded as app users; adding in the app lets people open it; in-app invites mean "treat as public" |
| 7f | Sign-in system | Formelab's sign-in, branded as the app; no marketing use of emails |
| 8 | Outside data | User-level for Sheets (owner column); role level for other APIs, Supabase included until step 6b (RLS through a signed token) |
| 8b | Sources in the rules | `sources.sheets` by id, `sources.connectors` by name covering connectors, saved keys and Gemini; existing apps without `sources` keep today's behavior, new ones must name them |
| 8c | Rows that aren't yours | Returned empty to keep row positions; formulas refused in own writes |
| 9 | Test plans | Browser plans for screens; connector-run plan for step 1 |
| 10 | Required for new builds | Refuse with reason, remedy and a paste-in prompt, through the connector and manual upload alike; runtime backstop; acknowledgement means the owner accepts the risk |
| 11 | Invites and email | "Copy invite link", no Formelab email; app-branded invite email is a future paid feature |
| 12 | App users on the Formelab side | `app_user` created only on first sign-in, off the waitlist; invites store the email only on the app's member list |
| 13 | Signup privacy | Signup looks the same for any email; app-only memberships hidden |
| 14 | Deletion requests | To a customer: their apps. To Formelab: delete own data, notify each affected owner, never tell the requester which apps |
| 15 | Step 4 member list | `app_members` per app; Formelab-side people counted, not stored; members get in only while rules have records |
| 16 | Who manages people in the app | Owner, editors, `manage_roles`; any role the rules name but `guest`; never the owner or editors; same people may list |
| 17 | Invite link | The app's address, no token; settings "Remove this person" for owner and sharers |
| 18 | App sign-in and records (B, C) | `app_user` off the waitlist, an account status Formelab's pages treat as signed out; non-members keep no record; deletion at removal time |
| 19 | Step 5 address | Each app host its own OAuth server; tokens bound to the app and tagged with `siteId`; access and role checked on every call; tools per record type from the rules |
