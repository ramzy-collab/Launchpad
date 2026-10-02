---
name: launchpad-app
description: Build and publish a small web app to the user's Launchpad host (https://<namespace>.<DOMAIN>/<path>/). Use when the user asks to make, ship, host, publish or update a web app, dashboard, tool, tracker or page "on Launchpad" (or "on Archie"), or wants a quick internal app with sign-in, shared storage or an API key kept server-side.
---

# Launchpad app builder

Launchpad hosts self-contained HTML/CSS/JS apps behind single sign-on, with a browser SDK for
identity (`launchpad.me()`), per-app key/value storage (`launchpad.kv`), and secrets with a
server-side proxy (`launchpad.secrets.proxy`). Apps are published through the `launchpad` MCP
server.

## Steps

1. **Read the guide first** (once per session): call the MCP tool `get_guide`. If the MCP server
   is not connected, fetch `https://<DOMAIN>/_platform/guide.md` instead, and tell the user to
   connect it with the command on their Launchpad dashboard:
   `claude mcp add --transport http launchpad https://<DOMAIN>/mcp --header "Authorization: Bearer lp_..."`.
2. **Pick where it goes.** Call `list_namespaces`. Use the user's namespace unless they say
   otherwise. Choose a short, lowercase `mount_path` (letters, digits, hyphens), e.g. `budget`.
   Check `list_sites` so you don't overwrite an existing app by accident; if the path is taken,
   ask before replacing.
3. **Build a single-file app**: one complete `index.html` with inline CSS and JS.
   - Include `<head>` and `<meta name="viewport">`; keep asset URLs relative.
   - Add `<script src="/_platform/sdk.js"></script>` only if you use the SDK.
   - Never embed API keys. Add a small settings form that calls `launchpad.secrets.set(...)`, and
     call APIs with `launchpad.secrets.proxy(name, { url, headers })` using `{{value}}`.
   - No background jobs: fetch on load or on click; cache in `localStorage` for fast first paint.
   - Wrap SDK calls in `try/catch` and show `e.message` and `e.hint`.
4. **Publish** with the `publish` tool: `html`, `namespace`, `mount_path`, `title`, and
   `visibility: "restricted"` plus `allowed_emails` if the data is private. Use `spa: true` only
   for client-side routing.
5. **Report** the returned URL to the user, plus anything they must do next (for example, "open the
   app and paste your API key in Settings").

For later changes, publish again to the same `namespace` + `mount_path` (data and secrets are kept),
or use `update_site` for settings only. `delete_site` is permanent; only use it when asked.
