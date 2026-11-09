// "Connect your AI": a tile per AI app (with a Connected badge when it is), each opening its
// setup steps in a dialog.
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { escapeHtml as e } from "../util";
import { aiOrigin } from "../hosts";
import { listTokens } from "../auth";
import { listConnections } from "../oauth";
import { tileFor } from "./aiapps";
import { AI_LOGOS } from "./logos";
import { fmtTime, shell } from "./page";

const APPS = [
  { id: "claude", name: "Claude", where: "claude.ai, desktop and mobile" },
  { id: "chatgpt", name: "ChatGPT", where: "Developer mode, paid plans" },
  { id: "gemini", name: "Gemini", where: "Gemini CLI, Gemini Enterprise" },
  { id: "grok", name: "Grok", where: "grok.com custom connector" },
  { id: "cursor", name: "Cursor", where: "The AI code editor" },
  { id: "claude-code", name: "Claude Code", where: "In your terminal" },
] as const;

export async function connectPage(c: Context<AppEnv>): Promise<Response> {
  const user = c.get("user");
  const origin = aiOrigin(c.env, c.req.url);
  const url = `${origin}/mcp`;
  const geminiConfig = JSON.stringify({ mcpServers: { formelab: { httpUrl: url } } }, null, 2);
  const cursorConfig = JSON.stringify({ mcpServers: { formelab: { url } } }, null, 2);
  // Cursor's one-click install link: the server's config, base64-encoded.
  const cursorInstall = `cursor://anysphere.cursor-deeplink/mcp/install?name=formelab&config=${encodeURIComponent(btoa(JSON.stringify({ url })))}`;
  const cmd = `claude mcp add --transport http formelab ${url}`;
  const keyCmd = `${cmd} \\\n  --header "Authorization: Bearer fl_..."`;
  const geminiCmd = `gemini mcp add --transport http formelab ${url}`;

  // Connections are OAuth sign-ins (Claude, ChatGPT, Gemini, Grok, Cursor) and access keys an AI app has
  // used over MCP (Claude Code), matched to a tile by the app's name.
  const [grants, tokens] = await Promise.all([listConnections(c.env, user.email).catch(() => []), listTokens(c.env, user)]);
  const t0 = Date.now();
  type Conn = { tile: string | null; text: string; button: string };
  const connections: Conn[] = [
    ...grants.map((k) => ({
      tile: tileFor(k.clientName),
      text: `${k.clientName}, connected ${fmtTime(k.createdAt)}${k.readOnly ? " (can only look)" : ""}`,
      button: `<button class="danger" data-action="connection-revoke" data-id="${e(k.id)}">Disconnect</button>`,
    })),
    ...tokens
      .filter((k) => k.clientName && !k.revoked && k.expiresAt > t0)
      .map((k) => ({
        tile: tileFor(k.clientName!),
        text: `${k.clientName} with the access key "${k.name}", last used ${fmtTime(k.lastUsed)}`,
        button: `<button class="danger" data-action="token-revoke" data-id="${e(k.id)}">Revoke key</button>`,
      })),
  ];
  const byTile = new Map<string, Conn[]>();
  for (const k of connections) if (k.tile) byTile.set(k.tile, [...(byTile.get(k.tile) ?? []), k]);
  const others = connections.filter((k) => !k.tile);

  // Where each chat app adds a connector, for its "Copy URL and open" button.
  const OPEN: Record<string, string> = {
    claude: "https://claude.ai/settings/connectors",
    chatgpt: "https://chatgpt.com/#settings/Connectors",
    grok: "https://grok.com/connectors",
  };
  const more = (title: string, inner: string) => `<details class="steps"><summary>${title}</summary>${inner}</details>`;
  const STEPS: Record<string, string> = {
    claude: `  <ol>
    <li>Click <strong>Add custom connector</strong> and paste the URL. Leave <em>Advanced settings</em> empty.</li>
    <li>Click <strong>Add</strong>, then <strong>Connect</strong>.</li>
    <li>In the Formelab window, check the account shown and click <strong>Allow</strong>.</li>
  </ol>
  <p>It then works in the Claude desktop and mobile apps too. In a chat, make sure Formelab is on in the <strong>+</strong> menu under <strong>Connectors</strong>, then ask, for example:</p>
  <p class="example">Build me a simple tracker for my 12 rental units and publish it to Formelab.</p>
  ${more("Team, Enterprise or Free plan", `<p>Works on every plan. Free accounts can add one custom connector, so remove yours first if you already use it.</p>
  <p>On Team and Enterprise plans, an owner adds it once in <strong>Organization settings, Connectors, Add, Custom, Web</strong>, with the connector URL. Then each person finds Formelab under <strong>Settings, Connectors</strong> and clicks <strong>Connect</strong>.</p>`)}
`,
    chatgpt: `  <ol>
    <li>Under <strong>Advanced settings</strong>, turn on <strong>Developer mode</strong>.</li>
    <li>Click <strong>Create</strong>, name it <strong>Formelab</strong>, paste the URL, pick <strong>OAuth</strong>, and click <strong>Create</strong>.</li>
    <li>In the Formelab window, click <strong>Allow</strong>.</li>
  </ol>
  <p>In a new chat, open the <strong>+</strong> menu, pick <strong>Developer mode</strong> and turn on Formelab. Then ask, for example:</p>
  <p class="example">Make a lunch poll for my team and publish it to Formelab.</p>
  ${more("Can't find Developer mode?", `<p>Developer mode is on paid plans (Plus and Pro). On Business and Enterprise, an admin may have to allow it. If it isn't under <strong>Apps &amp; Connectors</strong>, look under <strong>Settings, Security</strong>.</p>
  <p>Without Developer mode, ChatGPT can still find your apps and read their code, but it can't publish.</p>`)}
`,
    gemini: `  <p>Run this in your terminal:</p>
  <div class="copyrow"><pre id="gemini-cmd">${e(geminiCmd)}</pre><button type="button" data-copy="#gemini-cmd">Copy</button></div>
  <ol>
    <li>Start <code>gemini</code> and run <code>/mcp auth formelab</code>.</li>
    <li>In the Formelab window, click <strong>Allow</strong>. Formelab says access goes to an app on your computer; that's expected.</li>
  </ol>
  <p>Then ask, for example:</p>
  <p class="example">Use Formelab to build a sign-up sheet for our book club and publish it.</p>
  ${more("Other ways to set it up", `<p>To edit the settings file instead, merge this into <code>~/.gemini/settings.json</code>:</p>
  <div class="copyrow"><pre id="gemini-config">${e(geminiConfig)}</pre><button type="button" data-copy="#gemini-config">Copy</button></div>
  <p>Antigravity CLI takes the same settings. In the Gemini app, custom connectors need a <strong>Gemini Enterprise</strong> plan: an admin adds Formelab as a custom MCP server with <code>${e(url)}</code>, then each person connects it. On other plans, use Gemini CLI, or Claude, which works on every plan.</p>`)}
`,
    grok: `  <ol>
    <li>Click <strong>New connector</strong>, pick <strong>Custom</strong>, name it <strong>Formelab</strong> and paste the URL.</li>
    <li>Click to connect. In the Formelab window, check the account shown and click <strong>Allow</strong>.</li>
  </ol>
  <p>In a chat, make sure Formelab is on in the connectors menu, then ask, for example:</p>
  <p class="example">Build a pickup-basketball sign-up sheet and publish it to Formelab.</p>
  ${more("Plans and labels", `<p>Custom connectors are on paid plans. On Business and Enterprise, an admin may have to add it first. Grok moves these menus now and then, so the labels may differ a little.</p>
  <p>Once it's connected, <strong>Make it with Grok</strong> on <a href="/new">New app</a> opens Grok with your idea typed in.</p>`)}
`,
    cursor: `  <p><a class="btn" href="${e(cursorInstall)}">Add to Cursor</a></p>
  <ol>
    <li>In Cursor, click <strong>Install</strong>.</li>
    <li>Formelab shows <strong>Needs login</strong>: click it, then click <strong>Allow</strong> in the Formelab window. Formelab says access goes to an app on your computer; that's expected.</li>
  </ol>
  <p>Then ask in Cursor's chat (Agent mode), for example:</p>
  <p class="example">Build a simple expense splitter and publish it to Formelab.</p>
  ${more("Add it by hand", `<p>In Cursor, open <strong>Settings, MCP &amp; Integrations, New MCP server</strong>, which opens <code>~/.cursor/mcp.json</code>, and merge this in:</p>
  <div class="copyrow"><pre id="cursor-config">${e(cursorConfig)}</pre><button type="button" data-copy="#cursor-config">Copy</button></div>`)}
`,
    "claude-code": `  <p>Run this in your terminal:</p>
  <div class="copyrow"><pre id="mcp-cmd">${e(cmd)}</pre><button type="button" data-copy="#mcp-cmd">Copy</button></div>
  <ol>
    <li>Start <code>claude</code>, run <code>/mcp</code> and pick <strong>formelab</strong>.</li>
    <li>In the Formelab window, click <strong>Allow</strong>. Formelab says access goes to an app on your computer; that's expected.</li>
  </ol>
  ${more("No browser, such as on a server or in CI", `<ol>
    <li>Open <a href="/keys">Access keys</a>, create a key and copy it.</li>
    <li>Run this, with your key in place of <code>fl_...</code>:</li>
  </ol>
  <div class="copyrow"><pre id="mcp-key-cmd">${e(keyCmd)}</pre><button type="button" data-copy="#mcp-key-cmd">Copy</button></div>
  <p>It shows up here as <strong>Connected</strong> the first time it uses Formelab. Agents can also read the build guide at <a href="/_platform/guide.md">/_platform/guide.md</a>.</p>`)}
`,
  };

  const status = (list: typeof connections) =>
    list.length
      ? `<div class="conn-status"><p><span class="dot" aria-hidden="true"></span><strong>Connected</strong> to your Formelab account.</p>${list
          .map((k) => `<div class="inline"><span class="muted">${e(k.text)}</span>${k.button}</div>`)
          .join("")}</div>`
      : "";

  const tiles = APPS.map((a) => {
    const on = (byTile.get(a.id) ?? []).length > 0;
    return `<button type="button" class="ai-tile" data-dialog="dlg-${a.id}" aria-haspopup="dialog">
    <span class="ai-logo">${AI_LOGOS[a.id]}</span>
    <span class="ai-name">${e(a.name)}</span>
    <span class="ai-where">${e(a.where)}</span>
    ${on ? `<span class="badge on"><span class="dot" aria-hidden="true"></span>Connected</span>` : `<span class="badge">Set up</span>`}
  </button>`;
  }).join("");

  const dialogs = APPS.map(
    (a) => `<dialog id="dlg-${a.id}" class="howto-dialog" aria-labelledby="dlg-${a.id}-title">
  <form method="dialog" class="dialog-close"><button aria-label="Close">×</button></form>
  <div class="howto">
    <div class="dialog-head"><span class="ai-logo">${AI_LOGOS[a.id]}</span><h2 id="dlg-${a.id}-title">${e(a.name)}</h2></div>
    <div data-status="${a.id}">${status(byTile.get(a.id) ?? [])}</div>
    ${OPEN[a.id] ? `<p><a class="btn" href="${OPEN[a.id]}" target="_blank" rel="noopener" data-copy-open="#mcp-url-${a.id}">Copy URL and open ${e(a.name)}</a></p>
    <p class="muted">Connector URL</p><div class="copyrow"><pre id="mcp-url-${a.id}">${e(url)}</pre><button type="button" data-copy="#mcp-url-${a.id}">Copy</button></div>` : ""}
    ${STEPS[a.id]}
  </div>
</dialog>`,
  ).join("\n");

  const body = `<section class="howto">
  <h2>Pick your AI</h2>
  ${user.active ? "" : `<p class="note">Your account is still on the waitlist. You can connect now, but your AI can only create apps once you're let in.</p>`}
  <div class="ai-grid">${tiles}</div>
  <div data-status="others">${others.length ? `<h3>Other connected apps</h3>${status(others)}` : ""}</div>
</section>

${dialogs}`;
  return shell(c, user, "connect", body);
}
