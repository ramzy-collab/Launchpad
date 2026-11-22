# Building apps for Formelab

This guide is written for AI agents (and people) building web apps for a Formelab host. Read it
once before you build your first app.

## 1. What Formelab is

Formelab hosts small, self-contained web apps: plain HTML, CSS and JavaScript, with no build step
and no backend of your own. Each app gets its own address, its name plus a short code:

```
https://<name>-<code>.<APP_DOMAIN>/        e.g. https://budget-7kq2.formelab.app/
```

`publish` returns it; always give the user that URL.

- You publish an app to a **namespace** (a "space") and a **mount path** (its name in the space),
  such as space `ramzy`, mount path `budget` or `tools/budget` (`""` is the space's main app).
  Lowercase letters, digits and hyphens. Together they identify the app when you publish or
  update it; the app's address is made from the mount path and never changes.
- A space groups apps and the people who can publish into it (its owner and editors). It isn't an
  address of its own.
- Every app is served from the root of its own address, so `location.pathname` starts at `/`.
- Every page needs a sign-in to Formelab, so you usually know who is looking. The exception is an
  app's **public link** (below): people who open it that way aren't signed in.
- An app is `restricted` by default (only its owner, editors and the emails on its allow-list) or
  `all` (every Formelab member). Either way its owner can also turn on a **public link** that opens
  it for anyone who has the link, no account needed (`update_site` with `public_link: true`).
- Editors can update an app, but only its owner (and the editors the owner lists in `sharers`)
  can change who can open it, and only the owner can delete it. If `update_site` answers
  `sharing_not_allowed` or `delete_site` answers `owner_only`, tell the user to ask the owner.

Apps get platform features through a small browser SDK, `window.formelab`:

- **Identity**: `formelab.me()` tells you who is viewing.
- **Key/value storage**: per-app JSON storage shared by everyone who can see the app.
- **Secrets and a server-side proxy**: store an API key once; call the API through the proxy so
  the key never reaches the browser.
- **Installing on a phone or computer**: every app can be added to a home screen or installed as
  a desktop app, with its own icon and window. Formelab adds the manifest for you (see
  "Installing your app" below).

## 2. Ground rules

1. **Load the SDK only when you need it**:
   `<script src="/_platform/sdk.js"></script>`. A purely static page does not need it.
2. **Use relative URLs for your own assets** (`style.css`, `img/logo.png`, never `/style.css`).
   The platform injects `<base href="/<mount-path>/">` into every HTML page, so relative URLs
   resolve inside your app wherever it is mounted. Always include a `<head>` element.
3. **Never call reserved paths directly.** `/_api/`, `/_platform/`, `/_app/` and `/healthz` belong
   to the platform. Use the SDK instead of calling `/_api/*` by hand. Uploads may not contain files
   under these paths.
4. **Never put secrets in client code.** No API keys in HTML or JS, ever. Store them with
   `formelab.secrets.set()` (or ask the user to paste them into a settings form that calls it),
   then use `formelab.secrets.proxy()` with a `{{value}}` placeholder.
5. **There are no background jobs.** Fetch data when the page loads or when the user acts. Cache
   results (in KV or `localStorage`) so the page paints fast.
6. **Keep uploads small**: at most 25 MB compressed, 100 MB uncompressed, 2,000 files. A single
   HTML file is the best default. Load big libraries from a CDN.
7. **Every app is its own website** (its own browser origin), so `localStorage`, cookies and
   IndexedDB belong to that app alone; no other app can read them. KV and secrets are scoped to
   one app too.
8. Shared KV (`formelab.kv`) is visible to **everyone who can view the app**, and by default only
   the owner and editors can change it. If viewers must write to it (votes, sign-ups, shared
   counters), publish with `data_writes: "everyone"`. Each person's own data (preferences, drafts,
   their answers) goes in `formelab.kv.mine`, which nobody else can read or change.
<!-- flag:responses -->
   **Forms whose answers only the owner should see** (surveys, sign-ups, RSVPs, contact and
   feedback forms) send each answer with `formelab.responses.submit()` instead; see below.
<!-- /flag:responses -->
<!-- flag:connected_apps -->
9. **For AI features, use `formelab.gemini`** (Google Gemini 3.5 Flash-Lite through the owner's
   connected key). Don't ask the user for an AI API key or put one in a secret: they connect
   Gemini once in Formelab (Connected apps → Google Gemini). **An app can only use it once it's
   built to:** after publishing, set `update_site`'s `connectors` to include `"gemini"` (the
   owner only). The `whoami` tool says whether it's connected (`connectedApps.gemini`); if it
   isn't, tell the user to connect it, and build the app to say so too (see
   `formelab.gemini.available()`).
10. **To read or write a spreadsheet, use `formelab.sheets`** (Google Sheets through the owner's
   connected Google account). Never ask for Google credentials. `whoami` says whether it's
   connected (`connectedApps.googleSheets`); if not, tell the user to connect it in Formelab
   (Connected apps → Google Sheets). An app can only use the spreadsheets listed for it: after
   publishing, pass the spreadsheet ids or links the user gave you to `update_site`'s `sheets`.
11. **For any other service with an API key, use the owner's custom connectors**
   (`formelab.connectors.fetch`). `whoami` lists them (`connectors`: name, hosts, how the key is
   sent). Use one by adding its name to `update_site`'s `connectors` after publishing (the owner
   only), then call it by name. Never ask the user to paste a key into chat or into the app: if the
   service isn't there, ask them to add it in Formelab (Connected apps → + Custom connector).
<!-- /flag:connected_apps -->

## 3. SDK reference

Add `<script src="/_platform/sdk.js"></script>`, then use `window.formelab` (also available as
`window.archie`). Every method returns a Promise. On failure it throws an `Error` with `.code`,
`.status` and `.hint` (a plain-language suggestion you can show the user).

### `formelab.me()`

```js
const me = await formelab.me(); // { email: "ana@example.com", name: null }
```

`me()` returns `null` for a **guest**: someone who opened the app through its public link and isn't
signed in (or isn't someone the app is shared with). Guests can see the app and read its shared data
(`formelab.kv.get` and `list`), and that's all: every other call fails with code
`sign_in_required`<!-- flag:responses --> (except `formelab.responses.submit`, if the owner lets them)<!-- /flag:responses -->. If the app may be shared by public link, handle `null` and offer a sign-in
button that calls `formelab.signIn()`, which signs them in and brings them back to the same page:

```js
const me = await formelab.me();
if (!me) showReadOnlyView(); // e.g. hide the vote buttons, show "Sign in to vote" → formelab.signIn()
```

### `formelab.kv`

Per-app JSON storage. Keys are 1–256 characters; values are any JSON up to 64 KB; at most 1,000
shared keys per app.

```js
await formelab.kv.set("settings", { theme: "dark", city: "Boston" });
const settings = await formelab.kv.get("settings");   // the value itself, or null if missing
const all = await formelab.kv.list();                  // [{ key, value, updatedAt }] sorted by key
const votes = await formelab.kv.list("vote:");         // only keys starting with "vote:"
await formelab.kv.delete("settings");
```

**Who can change it.** An app with access rules (`formelab.json`, see "Access rules") follows
them, for reading too. Otherwise everyone who can open the app can read shared KV, and changing it
depends on the app's `data_writes` setting: `"editors"` (the default for new apps) lets only the owner and
editors write; `"everyone"` lets every viewer write. Writing without permission fails with
`read_only_data` (403). Set it with `publish` (new apps) or `update_site`.

**Reading and changing it from an AI.** The app's owner and editors can ask their AI about an app's
saved data, or to change it, through the Formelab connector: `kv_list` (with `prefix` and paging
by `after`), `kv_get`, `kv_set` and `kv_delete`. They reach shared data only, never
`formelab.kv.mine`. Each change is logged in the app's activity under the person, naming the AI
tool, but never the value. Keep a key's value in the shape the app's code expects.

**`formelab.kv.mine`: each person's private data.** The same calls (`get`, `set`, `list`,
`delete`), but the data belongs to the person using the app: nobody else, not even the owner, can
read or change it, whatever `data_writes` says. Up to 200 keys per person per app.

```js
const prefs = (await formelab.kv.mine.get("prefs")) ?? {};
await formelab.kv.mine.set("prefs", { ...prefs, theme: "dark" });
```

<!-- flag:responses -->

### `formelab.responses`: forms, surveys and sign-ups

Answers people send the app, kept for its owner. Anyone who can open the app can **send** one; only
the owner and editors can **list** or **delete** them (everyone else gets 403). Nobody can read
back or change what they sent. Each response is any JSON up to 16 KB (an object of field → answer
is best: the owner downloads them as a spreadsheet with one column per field); at most 5,000 per app.

```js
await formelab.responses.submit({ name: "Ana", email: "ana@example.com", attending: "Yes" });

// Owner and editors only: newest first, up to 500 at a time.
const { total, responses, next } = await formelab.responses.list();
// responses: [{ id, at, email, data }]; email is who sent it, or null for a public-link guest.
const older = next ? await formelab.responses.list({ before: next }) : null;
await formelab.responses.delete(responses[0].id);
```

**Collecting answers from people without a Formelab account.** People who open the app through its
public link are guests (`formelab.me()` is `null`). They can send responses only when the owner
allows it: `update_site` with `guest_responses: true` (and `public_link: true` for the link), or
"Anyone with the link can send answers" on the app's Sharing tab. Otherwise `submit` fails with
`sign_in_required`. Guests can send at most 5 a minute each, and an app takes at most 60 a minute;
guests together can send at most 500 a day unless the owner changes it (`update_site`'s
`guest_responses_per_day`). Too many fails with `rate_limited` (429). The owner and editors read
the answers on the app's **Answers** page, `/answers` on the app's own address (with a
spreadsheet download); Formelab adds a small "Answers" link to the app for them. They can also ask
their AI (the `get_responses` tool). `/answers` and `/answers.csv` are taken by that page, so don't
give the app its own pages at those addresses.

<!-- /flag:responses -->

### `formelab.secrets`

Only the app's owner and editors can set or delete secrets. Anyone who can view the app can *use*
them through the proxy, but nobody can read them back.

Every secret names the **hosts** it may be sent to. The proxy refuses any other host, so a viewer
can't point a secret at a server of their own. List exact host names (`api.example.com`), or
`*.example.com` for any subdomain of `example.com` (not `example.com` itself). Use the API's real
host, with no scheme or path.

```js
await formelab.secrets.set("weather_key", "abc123", { hosts: ["api.openweathermap.org"] });  // a string
await formelab.secrets.set("stripe", { public: "pk_...", secret: "sk_..." }, { hosts: ["api.stripe.com"] });  // an object
await formelab.secrets.list();                                                 // ["stripe", "weather_key"]
await formelab.secrets.delete("weather_key");
```

Names are 1–64 characters of `a-z 0-9 _ -`. Values are at most 8 KB; at most 50 secrets per app.
Setting a secret again replaces both its value and its hosts. To add a host, set the secret again
with the full list. A secret saved before host lists existed fails with `secret_needs_hosts` until it
is set again.

### `formelab.secrets.proxy(name, { url, method, headers, body })`

The server fills placeholders in `url`, header values and `body`, then makes the request:

| Placeholder | Meaning |
|---|---|
| `{{value}}` | the secret, when it is a string |
| `{{field}}` | a field of an object secret, e.g. `{{secret}}` |
| `{{basic}}` | `base64(user:pass)` for objects with `public`+`secret` or `username`+`password` |

```js
const res = await formelab.secrets.proxy("weather_key", {
  url: "https://api.openweathermap.org/data/2.5/weather?q=Boston&appid={{value}}",
});
// res = { status, contentType, text, truncated, json() }
if (res.status === 200) console.log(res.json().main.temp);

await formelab.secrets.proxy("stripe", {
  url: "https://api.stripe.com/v1/customers?limit=3",
  headers: { Authorization: "Basic {{basic}}" },
});

await formelab.secrets.proxy("openai", {
  url: "https://api.example.com/v1/things",
  method: "POST",
  headers: { Authorization: "Bearer {{value}}", "Content-Type": "application/json" },
  body: JSON.stringify({ name: "demo" }), // objects are stringified for you
});
```

Rules: only the secret's own hosts (`host_not_allowed` otherwise); `https` only; public hosts only
(no localhost, private IPs or the platform itself);
GET/POST/PUT/PATCH/DELETE; body up to 1 MB; 20-second timeout; responses are returned as text up
to 5 MB (`truncated: true` if cut); redirects are not followed (you get the 3xx and a `location`);
60 calls per minute per app; an unknown placeholder is an error. If the API echoes the secret back
(as is, or base64-, URL- or hex-encoded), the platform replaces it with `[redacted]`. That's best
effort: only save a secret for hosts you trust with it.

### Installing your app: `formelab.app`

Every app can be installed like a native app: **Add to Home Screen** on iPhone and Android,
**Install** in Chrome and Edge on a computer, **Add to Dock** in Safari on a Mac. It then opens
in its own window with its own icon, starting at the app. You don't need to do anything for this:
Formelab adds a `<link rel="manifest">` to your pages, with the app's title, its icon and its
own address as the scope. (If your app ships its own `<link rel="manifest">`, Formelab leaves it
alone.)

To look good once installed:

- Give it an icon (required anyway). For iPhones and iPads, which only use PNG home screen icons,
  also include a 180×180 PNG as `<link rel="apple-touch-icon" href="apple-touch-icon.png">` in
  the zip; otherwise iOS uses a screenshot. A PNG icon of 192px or more, or an SVG, is used on
  Android and computers.
- Add `<meta name="theme-color" content="#...">` for the title bar color.
- Installed apps have no browser back button or address bar: give every screen a way back.

To offer an **Install** button inside the app:

```js
formelab.app.installed();   // true when running as the installed app
formelab.app.canInstall();  // true when the browser can show its install dialog (Chrome, Edge, Android)
const result = await formelab.app.install(); // "accepted", "dismissed" or "manual"
window.addEventListener("formelab:installchange", update); // canInstall() changed
```

`"manual"` means the browser has no install dialog (Safari on iPhone, iPad and Mac): show the
steps instead, "Tap Share, then Add to Home Screen" on an iPhone or iPad, "File → Add to Dock" in
Safari on a Mac. Hide the button when `installed()` is true.

<!-- flag:connected_apps -->
### Link previews: how your app looks when it's shared

When someone sends your app's link in iMessage, WhatsApp, Slack, Discord or anywhere else that
shows link previews, Formelab answers the preview with the app's title, a line of description
and a big picture, even though opening the app still needs a sign-in. The picture and the text
are public, so keep anyone's data out of them.

That full preview is for apps open to every Formelab member or with a public link. An app only
some people can open gets a private card instead ("A private app on Formelab"), so its name
doesn't show to everyone in a chat. The owner can choose either with `update_site`'s
`link_preview` (`"full"`, `"private"` or `"auto"`) or on the app's page. Give your app:

- **A `<meta name="description">`**: one plain sentence saying what the app does.
- **A share illustration** that shows what the app is: a stylized drawing, not a screenshot.
  Draw it as an SVG 1200 wide and 630 tall (`viewBox="0 0 1200 630"`), with the app's name in
  big type and a simple picture of what it's for (a calendar for a planner, a ball and hoop for
  a league, a ballot for a poll), in the app's own colors. Name it in `<head>`:

  ```html
  <meta property="og:image" content="share.svg">  <!-- share.svg in the zip -->
  <meta property="og:image" content="data:image/svg+xml,%3Csvg ...">  <!-- or inline, URL-encoded, for a single-file app -->
  ```

  Keep it under 20 KB: flat shapes, no embedded photos or fonts, no scripts, no external
  images (they aren't loaded). Text is drawn in Inter or Bricolage Grotesque, whatever
  `font-family` you name. A PNG or JPEG (`share.png`, 1200×630) works too.

Apps without a share illustration get a card made from their icon, title and description.

### `formelab.gemini`: AI in your app

Calls Google **Gemini 3.5 Flash-Lite** (`gemini-3.5-flash-lite`) with the app owner's Gemini key,
which they connected once in Formelab. The key never reaches the browser. Anyone who can open the
app can use it, on the owner's key; calls show up in the app's activity log. Limits: 60 a minute
per app; for each person other than the owner, 20 a minute and 100 a day across the owner's apps;
and the owner's daily limit for all their apps together (1,000 unless they change it). Past one,
`generate` fails with `rate_limited` (429): show `e.message`, and cache answers in KV instead of
asking again.

```js
const { connected, inApp } = await formelab.gemini.available();   // connected: false when the owner hasn't connected Gemini, or the app isn't built to use it (inApp: false)
const r = await formelab.gemini.generate("Summarize this in one sentence: " + text);
r.text;            // the answer
r.usage;           // { inputTokens, outputTokens, totalTokens }

// Options: a system instruction, JSON output (optionally with a JSON Schema), an answer length cap.
const tags = await formelab.gemini.generate("Suggest 3 tags for: " + note, {
  system: "You label notes. Answer only with JSON.",
  schema: { type: "array", items: { type: "string" } },
  maxOutputTokens: 200,
});
tags.json();       // ["work", "ideas", "q3"]

// Full control: Gemini's own `contents` format (several turns, inline images as base64).
await formelab.gemini.generate({ contents: [{ role: "user", parts: [{ text: "Hi" }] }] });
```

Errors: `connector_not_in_app` (403: the app isn't built to use Gemini; add `"gemini"` to
`update_site`'s `connectors`), `gemini_not_connected` (409: show "Connect Google Gemini in Formelab to use this"),
`gemini_key_rejected`, `gemini_quota` (429 from Google), `rate_limited`, `gemini_unreachable`.
Show `e.message` and `e.hint`. Temperature and top-P/K aren't supported by this model.

### `formelab.connectors`: the owner's custom connectors

A custom connector is a service's API key the owner saved once in Formelab, with the hosts it may
be sent to and how the service expects it (an `Authorization: Bearer` header, a header of its own,
a query parameter, or a `{{value}}` placeholder the app puts in). Formelab adds the key on the way
out, so it never reaches the browser, and scrubs it from the answer. **An app can only use the
connectors listed for it**: add their names to `update_site`'s `connectors` (the owner only;
`whoami` lists the names). Anyone who can open the app can use them, on the owner's key; calls
are limited like `formelab.secrets.proxy` and show up in the app's activity log.

```js
await formelab.connectors.list();                       // ["quo"]: the connectors this app uses
const res = await formelab.connectors.fetch("quo", "/v1/messages", {   // a path goes to its first host
  method: "POST",
  body: { to: "+16175550123", content: "See you at 4" },  // objects are sent as JSON
});
res.status;   // 200
res.json();   // the service's answer
await formelab.connectors.fetch("quo", "https://api.quo.com/v1/contacts?limit=10");
```

`formelab.secrets.proxy(name, { url, headers })` reaches a connector by the same name too, with
`{{value}}` placeholders, so apps written for saved keys keep working when the owner moves them
into connectors. Errors: `connector_not_in_app` (403: add it to `connectors`), `connector_missing`
(409: the owner deleted it), `host_not_allowed` (403), `rate_limited`, `upstream_timeout`.

### `formelab.sheets`: Google Sheets in your app

Reads and writes the app owner's Google Sheets with the Google account they connected once in
Formelab. Anyone who can open the app can use it, as the owner; calls are limited to 60 a minute
per app (and 20 a minute for each person other than the owner, across the owner's apps) and show
up in the app's activity log. A spreadsheet's id is the long part of its URL:
`docs.google.com/spreadsheets/d/<id>/edit`.

**An app can only use the spreadsheets listed for it.** The owner lists them in the app's settings
in Formelab, or an AI sets them with `update_site` (`sheets: ["<id or link>"]`). Only the owner can
change the list, and only the owner can `create()` a spreadsheet; one created through the app is
added to its list automatically. Any other spreadsheet fails with `sheet_not_allowed`.

**People using the app read values and add or change rows; only the owner and editors change the
spreadsheet itself.** Everyone who can open the app may use `read`, `append` and `update`, plus
`values:batchGet`, `values:batchUpdate` and the spreadsheet's tab names through `request()`. Other
calls (`batchUpdate` on the spreadsheet, clearing, copying tabs, data filters, developer metadata
and `includeGridData`) work only for the owner and editors, and fail with `sheets_editors_only`
(403) for everyone else. Build those parts of an app for its owner and editors only.

```js
const { connected } = await formelab.sheets.available();   // false: the owner hasn't connected it
const rows = await formelab.sheets.read(id, "Sheet1!A1:C50");              // [["Name","Email"], ...]
await formelab.sheets.append(id, "Sheet1!A:C", [["Ada", "ada@example.com", new Date().toISOString()]]);
await formelab.sheets.update(id, "Sheet1!B2", [["done"]]);
const sheet = await formelab.sheets.create("Lunch sign-ups");             // { id, url }: a new spreadsheet
// Anything else in the Sheets API v4 (path relative to https://sheets.googleapis.com/v4/), owner and editors only:
await formelab.sheets.request("POST", `spreadsheets/${id}:batchUpdate`, { body: { requests: [...] } });
```

Values are entered as if typed (`USER_ENTERED`), so numbers, dates and formulas work. Store the
spreadsheet id in KV rather than hard-coding it.
Errors: `sheets_not_connected` (409), `sheet_not_allowed` (403: not on the app's list),
`sheets_owner_only` (403: only the owner can create), `sheets_editors_only` (403: owner and editors only), `sheets_reconnect` (the owner must reconnect),
`sheets_forbidden`, `sheets_not_found`, `rate_limited`. Show `e.message` and `e.hint`.

#### Combining several spreadsheets

An app can list several spreadsheets (up to 50) and combine them, for example sales, stock and
staffing into one dashboard. List every one in the app's settings or with `update_site`'s
`sheets`. Each spreadsheet read is one call against the app's 60 calls a minute, shared by
everyone using the app, so **don't re-read every sheet for every visitor**. Cache the combined
result in KV and refresh it only when it's a few minutes old:

```js
const SOURCES = [SALES_ID, STOCK_ID, STAFF_ID];   // the ids listed for this app (or keep them in KV)
const MAX_AGE = 5 * 60 * 1000;                     // refresh at most every 5 minutes

async function combined() {
  const cached = await formelab.kv.get("combined");
  if (cached && Date.now() - cached.at < MAX_AGE) return cached.data;
  try {
    const [sales, stock, staff] = await Promise.all([
      formelab.sheets.read(SOURCES[0], "Sheet1!A:F"),
      formelab.sheets.read(SOURCES[1], "Sheet1!A:D"),
      formelab.sheets.read(SOURCES[2], "Roster!A:C"),
    ]);
    const data = summarize(sales, stock, staff);    // keep only what the page shows
    await formelab.kv.set("combined", { at: Date.now(), data });
    return data;
  } catch (e) {
    if (cached) return cached.data;                 // rate-limited or offline: show the last good result
    throw e;
  }
}
```

- Read several ranges of **one** spreadsheet in a single call with
  `formelab.sheets.request("GET", "spreadsheets/" + id + "/values:batchGet", { query: { ranges: ["A!A:C", "B!A:C"] } })`.
- Viewers write the cache, so publish the app with `data_writes: "everyone"`.
- A KV value holds at most 64 KB, so store the summary the page needs, not every raw row. For more,
  split it across keys (`combined:sales`, `combined:stock`).
- Show when the data was last refreshed (`cached.at`), and offer a "Refresh" button that skips the
  cache, for the owner only, so viewers can't use up the limit.

<!-- /flag:connected_apps -->
## 4. Access rules

An app that saves shared data (`formelab.kv`)<!-- flag:connected_apps -->, uses Google Sheets or calls connectors (custom
connectors, saved keys or Gemini)<!-- /flag:connected_apps --> needs **access rules**: a `formelab.json` file at the root of the
app that says who can see and change each kind of record. Formelab refuses to publish a new app
without one (`rules_required`), and refuses a broken one for every app (`rules_invalid`, with the
exact problem). Apps that only use `formelab.kv.mine`<!-- flag:responses --> or `formelab.responses`<!-- /flag:responses -->, or save nothing,
don't need it.

**Ask the person first.** Before you write the file, ask who should see and change each kind of
record. Don't guess: the answer decides who can read other people's data.

**Everyone may read and write everything** (polls, a shared menu, a team board) is one line, and an
explicit, valid choice:

```json
{ "everyone": "all" }
```

**Rules per kind of record**, for apps where people should see only some of the data:

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

- `records`: each kind of record the app saves, by name (lowercase letters, digits, `_` or `-`).
  - `prefix`: the start of its keys, like `"lead:"` for `"lead:42"`. A record you save as one key
    (like `"settings"`) uses the whole key. No prefix may start another (`"lead:"` and
    `"lead:old:"` are refused): use `"lead:"` and `"oldlead:"`.
  - `fields`: the fields in its value (optional; AI tools use them to describe the data).
  - `owner_field`: the field holding the email of the person a record belongs to. Needed for `own`.
  - `read` and `write`: each role gets `"all"`, `"own"` (only records whose `owner_field` is the
    signed-in person's email) or `"none"`. Roles not listed get `"none"`.
- `guest` is the role for people who open the app through its public link, signed out. It gets
  `"none"` unless you grant it.
- `default_role`: the role everyone below editor gets: the people the app is shared with, and
  everyone signed in who can open it. Roles can't be given to particular people inside the app
  yet, so a role like `"manager"` works only through `default_role` for now; people who must see
  everything can be made editors.
- `manage_roles`: roles that may add people and give them roles inside the app. **Only if the person
  asks for it:** people in these roles can invite anyone, so the app counts as public. Publishing
  asks the person to confirm (`confirm_public`); tell them what it says and publish again with
  `confirm_public: true` only if they say yes. Never confirm on their behalf.
- The owner and editors always see and change everything. Records whose prefix no rule mentions
  are only for them.
- Don't list who holds which role: anyone who can open the app can read its files, `formelab.json`
  included.

**Publishing it.** A single-file app with rules is published as `files`
(`{ "index.html": "...", "formelab.json": "..." }`) or as a zip, since `html` carries one file.
To add rules to an existing app, publish `files: { "formelab.json": "..." }`.

**What it does in the app.** Formelab applies the rules to every `formelab.kv` call. Records a
person may not see are left out of `list()`, and `get()` returns `null` for them, as if they didn't
exist, so write the app to cope with missing records. Changing a record they may not change fails
with `not_allowed` (403); with `"own"`, a record must keep their email in its `owner_field`. For an
app with rules, the rules decide who can change its data and `data_writes` no longer applies.
`formelab.kv.mine` isn't affected. An app made since access rules arrived that has no rules can't
use shared data, Sheets or connectors at all: those calls fail with `rules_required`.

## 5. Patterns

### Dashboard over an external API

1. A settings panel (shown to editors) calls `formelab.secrets.set("api_key", value, { hosts: ["api.example.com"] })`.
2. On load, render the last snapshot from `localStorage` immediately, then refresh via the proxy.
3. Save the fresh snapshot to `localStorage` (and to KV if every viewer should share it).

```js
const CACHE = location.pathname + ":snapshot";
const cached = localStorage.getItem(CACHE);
if (cached) render(JSON.parse(cached));
try {
  const res = await formelab.secrets.proxy("api_key", { url: "https://api.example.com/stats?key={{value}}" });
  if (res.status === 200) { localStorage.setItem(CACHE, res.text); render(res.json()); }
  else showError("The API answered " + res.status);
} catch (e) {
  showError(e.message + " " + (e.hint || ""));
}
```

### Shared counter or config in KV

Viewers write to this, so publish the app with `data_writes: "everyone"`.

```js
const n = (await formelab.kv.get("count")) ?? 0;
await formelab.kv.set("count", n + 1); // last write wins; fine for small teams
```

Config only the owner should change (titles, settings) works with the default
`data_writes: "editors"`: viewers can read it but not change it.

### Per-viewer data

```js
const { email } = await formelab.me();
const mine = (await formelab.kv.mine.get("prefs")) ?? {};   // only this person can read or change it
await formelab.kv.mine.set("prefs", { ...mine, lastSeen: Date.now() });
```

<!-- flag:responses -->

### A form for the public (survey, sign-up, RSVP)

Publish it, then turn on the public link and guest responses with `update_site`
(`public_link: true, guest_responses: true`) and give the user `site.publicUrl` to share. Don't
put the answers in shared KV: everyone who can open the app could read them.

```js
form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  try {
    await formelab.responses.submit(Object.fromEntries(new FormData(form)));
    form.replaceWith(Object.assign(document.createElement("p"), { textContent: "Thanks! Your answer was sent." }));
  } catch (e) {
    showError(e.message + " " + (e.hint || ""));
  }
});
```

<!-- /flag:responses -->

## 6. Starter app

A complete single-file app that uses `me`, `kv` and `secrets.proxy`. It greets the viewer, counts
visits, lets an editor store a key, and calls `https://httpbin.org/anything` through the proxy.
Every visitor updates the visit counter, so publish it with `data_writes: "everyone"`.
It saves shared data, so it needs access rules too: publish it with
`files: { "index.html": "...", "formelab.json": "{ \"everyone\": \"all\" }" }` (see "Access rules").

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Starter</title>
  <meta name="description" content="Greets you, counts visits and calls an API through the proxy.">
  <meta property="og:image" content="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1200 630'%3E%3Crect width='1200' height='630' fill='%23EFEDFE'/%3E%3Ccircle cx='930' cy='315' r='190' fill='%235B4CF5'/%3E%3Cpath d='M850 320l55 55 110-125' stroke='white' stroke-width='40' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3Ctext x='90' y='350' font-family='sans-serif' font-weight='800' font-size='110' fill='%231C1B19'%3EStarter%3C/text%3E%3C/svg%3E">
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%235B4CF5'/%3E%3Cpath d='M20 34l8 8 16-18' stroke='white' stroke-width='6' fill='none' stroke-linecap='round'/%3E%3C/svg%3E">
  <style>
    body { font: 16px/1.5 system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; }
    pre { background: #f4f4f4; padding: .75rem; overflow: auto; }
    .err { color: #b00; }
  </style>
  <script src="/_platform/sdk.js"></script>
</head>
<body>
  <h1 id="hello">Hello</h1>
  <p>This page has been opened <strong id="count">…</strong> times.</p>

  <h2>API key</h2>
  <form id="keyform">
    <input id="key" type="password" placeholder="paste a test key" required>
    <button>Save key</button>
  </form>

  <h2>Proxy call</h2>
  <button id="call">Call httpbin through the proxy</button>
  <pre id="out"></pre>
  <p id="error" class="err"></p>

  <script>
    const $ = (id) => document.getElementById(id);
    const fail = (e) => { $("error").textContent = e.message + (e.hint ? " " + e.hint : ""); };

    (async () => {
      try {
        const me = await formelab.me();
        $("hello").textContent = "Hello, " + (me.name || me.email);
        const count = ((await formelab.kv.get("visits")) ?? 0) + 1;
        await formelab.kv.set("visits", count);
        $("count").textContent = count;
      } catch (e) { fail(e); }
    })();

    $("keyform").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      try {
        await formelab.secrets.set("demo_key", $("key").value, { hosts: ["httpbin.org"] });
        $("key").value = "";
        $("error").textContent = "Key saved.";
      } catch (e) { fail(e); }
    });

    $("call").addEventListener("click", async () => {
      try {
        const res = await formelab.secrets.proxy("demo_key", {
          url: "https://httpbin.org/anything?source=formelab",
          headers: { "X-Api-Key": "{{value}}" },
        });
        $("out").textContent = res.status + "\n" + JSON.stringify(res.json(), null, 2);
      } catch (e) { fail(e); }
    });
  </script>
</body>
</html>
```

## 7. Publishing

### With the MCP `publish` tool (preferred)

If the Formelab MCP server is connected (tools named `publish`, `list_sites`, …). This works in
Claude Code (deploy token), Claude chat and ChatGPT (custom connectors with sign-in).

1. `list_namespaces` to see where you can publish. If there are none, pick a short namespace
   name; publishing to a free namespace creates it.
2. `publish` with `html` (a complete document as a string) or `zip_base64`, plus `namespace` and
   `mount_path`. Optional: `title`, `spa`, `visibility`, `allowed_emails`, `data_writes`
   (`"everyone"` if viewers write to shared KV; the default `"editors"` otherwise). If the app saves shared
   data<!-- flag:connected_apps --> or uses Sheets or connectors<!-- /flag:connected_apps -->, include `formelab.json` (send `files` or a zip instead of
   `html`; see "Access rules").
3. Give the user the returned `url` (the app's own address, like `https://budget-7kq2.<APP_DOMAIN>/`).

**Changing an existing app: send only the changes.** Don't resend the whole app; for a large app
that takes minutes. Read the file with `read_file` (`namespace`, `mount_path`, `path`, default
`index.html`; large files come in pages, so pass the `offset` it gives you), then `publish` to the
same `namespace` and `mount_path` with:

- `edits`: `[{ "path": "index.html", "old_str": "...", "new_str": "..." }]`. Each `old_str` is
  copied exactly from the current file (spaces and line breaks included) and must occur exactly
  once; edits apply in order, and if one fails nothing is published. `path` defaults to `index.html`.
- `files`: `{ "app.js": "...whole new text..." }` to add or replace whole text files, `null` to
  delete one. Applied before `edits`.

Files you don't mention stay as they are, and the result lists the files that `changed`. Send the
whole app (`html` or `zip_base64`) only for a new app, or when most of it changes.

Publishing to an existing path replaces the app atomically; its KV data, secrets and sharing
settings (who can open and edit it, who can change its data) are kept. `visibility`,
`allowed_emails` and `data_writes` only apply when an app is first published; change them later
with `update_site`.
`update_site` changes settings without re-uploading; `delete_site` is permanent.

**Sharing publicly.** When the user wants anyone to be able to open the app (no Formelab account),
call `update_site` with `public_link: true` and give them the returned `site.publicUrl` (not the
plain `url`, which still asks for a sign-in). `public_link: "new"` replaces the link so the old one
stops working; `false` turns it off. Only do this when the user asks: anyone who gets the link can
open the app and read its shared data.

### With `scripts/publish.sh` and a deploy token

Create a token in the dashboard, then:

```bash
export FORMELAB_TOKEN=fl_...
export FORMELAB_DOMAIN=example.com
scripts/publish.sh --file app.html --namespace ramzy --path budget --title "Budget"
scripts/publish.sh --file site.zip --namespace ramzy --path docs --spa
scripts/publish.sh --dir dist --changed-only --namespace ramzy --path docs
```

`--dir` zips a folder for you. With `--changed-only`, the script compares the folder with the live
app and uploads only the files that differ (and removes the ones that are gone), so updating a
large app sends a few files instead of all of them.

The script calls `POST https://<DOMAIN>/_api/deploy/sites` (multipart: `file`, `namespace`,
`mount_path`, `title`, `spa`, `visibility`, `allowed_emails`; with `merge=true`, `file` is a zip of
only the changed files and `delete` lists paths to remove, one per line).
`GET /_api/deploy/sites/manifest?namespace=…&mount_path=…` lists the live files with their SHA-256
(`&format=sha256sum` for `sha256sum` lines). The JSON body also takes `edits` and `files`, as above.

## 8. Agent checklist

- [ ] One self-contained `index.html` unless the user needs more files.
- [ ] Has `<head>`; all asset URLs are relative; nothing points at `/_api/` or `/_platform/` except the SDK script tag.
- [ ] No API keys or passwords anywhere in the code. Secrets go through `secrets.set` (with `hosts`) + `secrets.proxy`.
- [ ] Data loads on page load or user action (no background jobs). Fast first paint from a cache where it helps.
- [ ] Every SDK call is wrapped in `try/catch`, and errors show `e.message` and `e.hint` to the user.
- [ ] KV keys are namespaced (`"vote:" + email`), values stay well under 64 KB. Each person's own
      data is in `formelab.kv.mine`; `data_writes: "everyone"` is set only if viewers must write shared KV.
<!-- flag:responses -->
- [ ] Form answers only the owner should see go through `formelab.responses.submit`, not KV. If people
      without a Formelab account must fill it in, `update_site` sets `public_link` and `guest_responses`.
<!-- /flag:responses -->
- [ ] Works on a phone (responsive layout, `<meta name="viewport">`), and as an installed app (every screen has a way back).
- [ ] **Has access rules if it saves shared data<!-- flag:connected_apps --> or uses Sheets or connectors<!-- /flag:connected_apps --> (required for new apps):** a `formelab.json` written after asking the person who should see and change each kind of record (see "Access rules"). `manage_roles` only if they asked for in-app invites.
- [ ] **Has an icon (required):** a small SVG that fits the app, linked in `<head>` as `<link rel="icon" href="data:image/svg+xml,...">` (URL-encoded SVG), or as `<link rel="icon" href="icon.svg">` with `icon.svg` in the zip. Formelab shows it on the app's tile, and the `publish` tool refuses apps without one (`icon_required`).
- [ ] **Has a share illustration and description (recommended):** a 1200×630 SVG that shows what the app is, named by `<meta property="og:image">`, and a one-sentence `<meta name="description">`, for link previews in iMessage, Slack and the rest (see "Link previews"). No one's data in them: they're public.
- [ ] Apps are private by default (only the owner and editors). Add `allowed_emails` for the people who should open it; they see it under "My apps".
- [ ] Published with the right `namespace` and `mount_path`; the URL was shared with the user.
