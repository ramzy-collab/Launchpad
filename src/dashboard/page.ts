import type { Context } from "hono";
import { recentActivity } from "../audit";
import { listTokens } from "../auth";
import type { AppEnv } from "../env";
import { isDev } from "../env";
import { listNamespaces, listSites } from "../sites";
import { escapeHtml as e } from "../util";
import { ctxOf } from "../api";
import { listConnections } from "../oauth";

const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

const fmtTime = (ms: number | null) => (ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "never");
const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export async function dashboardPage(c: Context<AppEnv>): Promise<Response> {
  const ctx = ctxOf(c);
  const user = ctx.user;
  const [namespaces, sites, tokens, activity, connections] = await Promise.all([
    listNamespaces(ctx),
    listSites(ctx),
    listTokens(c.env, user),
    recentActivity(c.env, user.email, 50),
    listConnections(c.env, user.email).catch(() => []),
  ]);
  const origin = isDev(c.env) ? new URL(c.req.url).origin : `https://${c.env.DOMAIN}`;
  const mcpCommand = `claude mcp add --transport http formelab ${origin}/mcp \\\n  --header "Authorization: Bearer fl_..."`;
  const t = Date.now();

  const nsRows = namespaces
    .map(
      (n) => `<tr>
  <td><a href="${e(n.url)}">${e(n.label)}</a></td>
  <td>${e(n.ownerEmail)}</td>
  <td>${
    n.isOwner
      ? `<form class="inline" data-action="ns-editors" data-label="${e(n.label)}">
      <input name="editors" value="${e(n.editors.join(", "))}" placeholder="editor@example.com, ..." aria-label="Editors of ${e(n.label)}">
      <button>Save</button></form>`
      : e(n.editors.join(", ") || "—")
  }</td>
  <td>${n.isOwner ? `<button class="danger" data-action="ns-delete" data-label="${e(n.label)}">Delete</button>` : ""}</td>
</tr>`,
    )
    .join("");

  const siteRows = sites
    .map(
      (s) => `<tr>
  <td><a href="${e(s.url)}">${e(s.url)}</a>${s.hidden ? ' <span class="tag">hidden</span>' : ""}${s.spa ? ' <span class="tag">spa</span>' : ""}</td>
  <td>${e(s.title ?? "")}</td>
  <td>${e(s.visibility)}${s.visibility === "restricted" ? `<div class="muted">${e(s.allowedEmails.join(", "))}</div>` : ""}</td>
  <td class="nowrap">${e(fmtTime(s.updatedAt))}</td>
  <td>${e(fmtBytes(s.totalBytes))} · ${e(s.fileCount)} files</td>
  <td class="actions">
    <form class="inline" data-action="site-replace" data-namespace="${e(s.namespace)}" data-mount="${e(s.mountPath)}">
      <input type="file" name="file" accept=".html,.htm,.zip" required aria-label="Replacement file">
      <button>Replace</button>
    </form>
    <details><summary>Settings</summary>
      <form class="stack" data-action="site-update" data-id="${e(s.id)}">
        <label>Title <input name="title" value="${e(s.title ?? "")}"></label>
        <label>Visibility <select name="visibility">
          <option value="all"${s.visibility === "all" ? " selected" : ""}>all signed-in users</option>
          <option value="restricted"${s.visibility === "restricted" ? " selected" : ""}>restricted</option>
        </select></label>
        <label>Allowed emails <input name="allowed_emails" value="${e(s.allowedEmails.join(", "))}"></label>
        <label>Editors <input name="editors" value="${e(s.editors.join(", "))}"></label>
        <label class="check"><input type="checkbox" name="spa"${s.spa ? " checked" : ""}> SPA fallback</label>
        <label class="check"><input type="checkbox" name="hidden"${s.hidden ? " checked" : ""}> Hidden from listings</label>
        <button>Save settings</button>
      </form>
    </details>
    <button class="danger" data-action="site-delete" data-id="${e(s.id)}" data-mount="${e(s.mountPath)}" data-namespace="${e(s.namespace)}">Delete</button>
  </td>
</tr>`,
    )
    .join("");

  const tokenRows = tokens
    .map((k) => {
      const state = k.revoked ? "revoked" : k.expiresAt <= t ? "expired" : "active";
      return `<tr>
  <td>${e(k.name)}</td><td>${e(state)}</td><td>${e(fmtTime(k.expiresAt))}</td><td>${e(fmtTime(k.lastUsed))}</td>
  <td>${state === "active" ? `<button class="danger" data-action="token-revoke" data-id="${e(k.id)}">Revoke</button>` : ""}</td>
</tr>`;
    })
    .join("");

  const connectionRows = connections
    .map(
      (k) => `<tr>
  <td>${e(k.clientName)}</td><td class="nowrap">${e(fmtTime(k.createdAt))}</td><td class="nowrap">${e(k.expiresAt ? fmtTime(k.expiresAt) : "—")}</td>
  <td><button class="danger" data-action="connection-revoke" data-id="${e(k.id)}">Disconnect</button></td>
</tr>`,
    )
    .join("");

  const activityRows = activity
    .map(
      (a) => `<tr><td class="nowrap">${e(fmtTime(a.at))}</td><td>${e(a.actor)}</td><td>${e(a.action)}</td><td>${e(a.target ?? "")}</td><td class="muted">${e(a.detail ?? "")}</td></tr>`,
    )
    .join("");

  const nsOptions = namespaces.map((n) => `<option value="${e(n.label)}">`).join("");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Formelab</title>
<link rel="stylesheet" href="/_platform/dashboard.css">
<script src="/_platform/dashboard.js" defer></script>
</head>
<body>
<header>
  <h1>Formelab</h1>
  <div>Signed in as <strong>${e(user.email)}</strong>${user.isAdmin ? ' <span class="tag">admin</span>' : ""}</div>
</header>
<main>
<div id="flash" role="status" hidden></div>

<section>
  <h2>Publish an app</h2>
  <form class="grid" data-action="upload">
    <label>Namespace <input name="namespace" list="ns-list" required placeholder="yourname" pattern="[a-z0-9\-]+"></label>
    <datalist id="ns-list">${nsOptions}</datalist>
    <label>Mount path <input name="mount_path" placeholder="my-app (empty for root)"></label>
    <label>File (.html or .zip) <input type="file" name="file" accept=".html,.htm,.zip" required></label>
    <label>Title <input name="title"></label>
    <label>Visibility <select name="visibility"><option value="all">all signed-in users</option><option value="restricted">restricted</option></select></label>
    <label>Allowed emails <input name="allowed_emails" placeholder="a@example.com, b@example.com"></label>
    <label class="check"><input type="checkbox" name="spa"> SPA fallback</label>
    <div><button>Publish</button></div>
  </form>
</section>

<section>
  <h2>Sites</h2>
  ${
    sites.length
      ? `<div class="scroll"><table><thead><tr><th>URL</th><th>Title</th><th>Visibility</th><th>Updated</th><th>Size</th><th>Actions</th></tr></thead><tbody>${siteRows}</tbody></table></div>`
      : `<p class="muted">No sites yet. Publish one above, or connect Claude Code below.</p>`
  }
</section>

<section>
  <h2>Namespaces</h2>
  ${
    namespaces.length
      ? `<div class="scroll"><table><thead><tr><th>Namespace</th><th>Owner</th><th>Editors</th><th></th></tr></thead><tbody>${nsRows}</tbody></table></div>`
      : `<p class="muted">You have no namespaces yet.</p>`
  }
  <form class="inline" data-action="ns-create">
    <input name="label" required placeholder="new-namespace" pattern="[a-z0-9\-]+" aria-label="New namespace">
    <button>Create namespace</button>
  </form>
</section>

<section>
  <h2>Deploy tokens</h2>
  <form class="inline" data-action="token-create">
    <input name="name" required placeholder="token name" aria-label="Token name">
    <select name="ttlHours" aria-label="Lifetime">
      <option value="1">1 hour</option><option value="24" selected>24 hours</option><option value="168">7 days</option><option value="720">30 days</option>
    </select>
    <button>Create token</button>
  </form>
  <div id="new-token" hidden>
    <p><strong>Copy this token now. It will not be shown again.</strong></p>
    <div class="copyrow"><code id="new-token-value"></code><button type="button" data-copy="#new-token-value">Copy</button></div>
  </div>
  ${
    tokens.length
      ? `<div class="scroll"><table><thead><tr><th>Name</th><th>State</th><th>Expires</th><th>Last used</th><th></th></tr></thead><tbody>${tokenRows}</tbody></table></div>`
      : ""
  }
</section>

<section>
  <h2>Connect Claude</h2>
  <h3>Claude chat (claude.ai, desktop and mobile)</h3>
  <p>In Claude, open <strong>Settings → Connectors → Add custom connector</strong>, name it <strong>Formelab</strong>, and use this URL:</p>
  <div class="copyrow"><pre id="mcp-url">${e(origin)}/mcp</pre><button type="button" data-copy="#mcp-url">Copy</button></div>
  <p class="muted">Click <strong>Connect</strong>, sign in, and choose <strong>Allow</strong>. No token needed.</p>
  <h3>Claude Code</h3>
  <p>Create a deploy token (30 days is fine for personal use), then run:</p>
  <div class="copyrow"><pre id="mcp-cmd">${e(mcpCommand)}</pre><button type="button" data-copy="#mcp-cmd">Copy</button></div>
  <p class="muted">Agents can read the build guide at <a href="/_platform/guide.md">/_platform/guide.md</a> or with the <code>get_guide</code> tool.</p>
</section>

<section>
  <h2>Connected apps</h2>
  ${
    connections.length
      ? `<div class="scroll"><table><thead><tr><th>App</th><th>Connected</th><th>Expires</th><th></th></tr></thead><tbody>${connectionRows}</tbody></table></div>`
      : `<p class="muted">No apps are connected through sign-in yet. Deploy tokens are listed above.</p>`
  }
</section>

<section>
  <h2>Recent activity</h2>
  ${
    activity.length
      ? `<div class="scroll"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead><tbody>${activityRows}</tbody></table></div>`
      : `<p class="muted">Nothing yet.</p>`
  }
</section>
</main>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": CSP,
      "x-content-type-options": "nosniff",
      "referrer-policy": "same-origin",
      "x-frame-options": "DENY",
    },
  });
}
