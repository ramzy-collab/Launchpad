# Building apps for Formelab

This guide is written for AI agents (and people) building web apps for a Formelab host. Read it
once before you build your first app.

## 1. What Formelab is

Formelab hosts small, self-contained web apps: plain HTML, CSS and JavaScript, with no build step
and no backend of your own. Each app gets a URL:

```
https://<namespace>.<DOMAIN>/<mount-path>/
```

- A **namespace** is a subdomain, such as `ramzy`. Its owner and editors can publish into it.
- A **mount path** is where the app lives inside the namespace, such as `budget` or `tools/budget`.
  The empty mount path `""` is the namespace root. Lowercase letters, digits and hyphens only.
- Every page sits behind single sign-on (Cloudflare Access). Every viewer is signed in, so you
  always know who is looking.
- An app can be `all` (anyone who can sign in) or `restricted` (only its owner, editors and the
  emails on its allow-list).

Apps get platform features through a small browser SDK, `window.formelab`:

- **Identity**: `formelab.me()` tells you who is viewing.
- **Key/value storage**: per-app JSON storage shared by everyone who can see the app.
- **Secrets and a server-side proxy**: store an API key once; call the API through the proxy so
  the key never reaches the browser.

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
7. **Apps in one namespace share a browser origin**, so they are only cooperatively isolated from
   each other: they share `localStorage` and cookies. Prefix your `localStorage` keys with your
   mount path. KV and secrets are always scoped to one app.
8. KV is visible to **everyone who can view the app**. Don't store private data there unless the
   app is `restricted` to the right people.

## 3. SDK reference

Add `<script src="/_platform/sdk.js"></script>`, then use `window.formelab` (also available as
`window.archie`). Every method returns a Promise. On failure it throws an `Error` with `.code`,
`.status` and `.hint` (a plain-language suggestion you can show the user).

### `formelab.me()`

```js
const me = await formelab.me(); // { email: "ana@example.com", name: null }
```

### `formelab.kv`

Per-app JSON storage. Keys are 1–256 characters; values are any JSON up to 64 KB; at most 1,000
keys per app.

```js
await formelab.kv.set("settings", { theme: "dark", city: "Boston" });
const settings = await formelab.kv.get("settings");   // the value itself, or null if missing
const all = await formelab.kv.list();                  // [{ key, value, updatedAt }] sorted by key
const votes = await formelab.kv.list("vote:");         // only keys starting with "vote:"
await formelab.kv.delete("settings");
```

### `formelab.secrets`

Only the app's owner and editors can set or delete secrets. Anyone who can view the app can *use*
them through the proxy, but nobody can read them back.

```js
await formelab.secrets.set("weather_key", "abc123");                         // a string
await formelab.secrets.set("stripe", { public: "pk_...", secret: "sk_..." });  // an object
await formelab.secrets.list();                                                 // ["stripe", "weather_key"]
await formelab.secrets.delete("weather_key");
```

Names are 1–64 characters of `a-z 0-9 _ -`. Values are at most 8 KB; at most 50 secrets per app.

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

Rules: `https` only; public hosts only (no localhost, private IPs or the platform itself);
GET/POST/PUT/PATCH/DELETE; body up to 1 MB; 20-second timeout; responses are returned as text up
to 5 MB (`truncated: true` if cut); redirects are not followed (you get the 3xx and a `location`);
60 calls per minute per app; an unknown placeholder is an error. If the API echoes the secret back,
the platform replaces it with `[redacted]`.

## 4. Patterns

### Dashboard over an external API

1. A settings panel (shown to editors) calls `formelab.secrets.set("api_key", value)`.
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

```js
const n = (await formelab.kv.get("count")) ?? 0;
await formelab.kv.set("count", n + 1); // last write wins; fine for small teams
```

### Per-viewer data

```js
const { email } = await formelab.me();
const mine = (await formelab.kv.get("prefs:" + email)) ?? {};
await formelab.kv.set("prefs:" + email, { ...mine, lastSeen: Date.now() });
```

## 5. Starter app

A complete single-file app that uses `me`, `kv` and `secrets.proxy`. It greets the viewer, counts
visits, lets an editor store a key, and calls `https://httpbin.org/anything` through the proxy.

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Starter</title>
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
        await formelab.secrets.set("demo_key", $("key").value);
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

## 6. Publishing

### With the MCP `publish` tool (preferred)

If the Formelab MCP server is connected (tools named `publish`, `list_sites`, …). This works in
Claude Code (deploy token) and in Claude chat (custom connector with sign-in):

1. `list_namespaces` to see where you can publish. If there are none, pick a short namespace
   name; publishing to a free namespace creates it.
2. `publish` with `html` (a complete document as a string) or `zip_base64`, plus `namespace` and
   `mount_path`. Optional: `title`, `spa`, `visibility`, `allowed_emails`.
3. Give the user the returned `url`.

Publishing to an existing path replaces the app atomically; its KV data and secrets are kept.
`update_site` changes settings without re-uploading; `delete_site` is permanent.

### With `scripts/publish.sh` and a deploy token

Create a token in the dashboard, then:

```bash
export FORMELAB_TOKEN=fl_...
export FORMELAB_DOMAIN=example.com
scripts/publish.sh --file app.html --namespace ramzy --path budget --title "Budget"
scripts/publish.sh --file site.zip --namespace ramzy --path docs --spa
```

The script calls `POST https://<DOMAIN>/_api/deploy/sites` (multipart: `file`, `namespace`,
`mount_path`, `title`, `spa`, `visibility`, `allowed_emails`).

## 7. Agent checklist

- [ ] One self-contained `index.html` unless the user needs more files.
- [ ] Has `<head>`; all asset URLs are relative; nothing points at `/_api/` or `/_platform/` except the SDK script tag.
- [ ] No API keys or passwords anywhere in the code. Secrets go through `secrets.set` + `secrets.proxy`.
- [ ] Data loads on page load or user action (no background jobs). Fast first paint from a cache where it helps.
- [ ] Every SDK call is wrapped in `try/catch`, and errors show `e.message` and `e.hint` to the user.
- [ ] KV keys are namespaced (`"vote:" + email`), values stay well under 64 KB.
- [ ] Works on a phone (responsive layout, `<meta name="viewport">`).
- [ ] `visibility: "restricted"` with `allowed_emails` if the data is private.
- [ ] Published with the right `namespace` and `mount_path`; the URL was shared with the user.
