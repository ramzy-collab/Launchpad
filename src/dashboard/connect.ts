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
  { id: "claude-code", name: "Claude Code", where: "In your terminal" },
] as const;

export async function connectPage(c: Context<AppEnv>): Promise<Response> {
  const user = c.get("user");
  const origin = aiOrigin(c.env, c.req.url);
  const url = `${origin}/mcp`;
  const geminiConfig = JSON.stringify({ mcpServers: { formelab: { httpUrl: url } } }, null, 2);
  const cmd = `claude mcp add --transport http formelab ${url} \\\n  --header "Authorization: Bearer fl_..."`;

  // Connections are OAuth sign-ins (Claude, ChatGPT, Gemini) and access keys an AI app has
  // used over MCP (Claude Code), matched to a tile by the app's name.
  const [grants, tokens] = await Promise.all([listConnections(c.env, user.email).catch(() => []), listTokens(c.env, user)]);
  const t0 = Date.now();
  type Conn = { tile: string | null; text: string; button: string };
  const connections: Conn[] = [
    ...grants.map((k) => ({
      tile: tileFor(k.clientName),
      text: `${k.clientName}, connected ${fmtTime(k.createdAt)}`,
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

  const STEPS: Record<string, string> = {
    claude: `  <p class="muted">claude.ai, the Claude desktop app, and the mobile apps. Works on every plan, including Free. Free accounts can add one custom connector, so if you already use yours, remove it first.</p>
  <h3>Free, Pro and Max plans</h3>
  <ol>
    <li>On <a href="https://claude.ai/settings/connectors" rel="noopener">claude.ai</a>, open <strong>Settings → Connectors</strong>.</li>
    <li>Click <strong>Add custom connector</strong>.</li>
    <li>Name it <strong>Formelab</strong> and paste the connector URL above. Leave <em>Advanced settings</em> empty.</li>
    <li>Click <strong>Add</strong>, then <strong>Connect</strong>. A Formelab window opens: log in, check the account shown, and click <strong>Allow</strong>.</li>
  </ol>
  <p>Once added on the web, Formelab is available in the desktop and mobile apps too.</p>
  <h3>Team and Enterprise plans</h3>
  <ol>
    <li>An owner of your Claude organization adds it once: <strong>Organization settings → Connectors → Add → Custom → Web</strong>, with the connector URL above.</li>
    <li>Then each person finds Formelab under <strong>Settings → Connectors</strong> and clicks <strong>Connect</strong>.</li>
  </ol>
  <h3>Use it</h3>
  <p>In a chat, open the <strong>+</strong> menu, choose <strong>Connectors</strong>, and make sure Formelab is on. Then ask, for example:</p>
  <p class="example">Build me a simple tracker for my 12 rental units and publish it to Formelab.</p>
`,
    chatgpt: `  <p class="muted">Needs <strong>Developer mode</strong>, which is on paid plans (Plus and Pro; on Business and Enterprise an admin may have to allow it). ChatGPT on the web is the easiest place to set this up.</p>
  <ol>
    <li>Open <strong>Settings → Apps &amp; Connectors → Advanced settings</strong> and turn on <strong>Developer mode</strong>. (If it isn't there, look under <strong>Settings → Security</strong>; OpenAI has moved it before.)</li>
    <li>Back in <strong>Apps &amp; Connectors</strong>, click <strong>Create</strong>.</li>
    <li>Fill in:
      <ul>
        <li><strong>Name:</strong> Formelab</li>
        <li><strong>Description:</strong> Build and publish small web apps to Formelab.</li>
        <li><strong>MCP server URL:</strong> the connector URL above</li>
        <li><strong>Authentication:</strong> OAuth</li>
      </ul>
    </li>
    <li>Confirm you trust the app and click <strong>Create</strong>. A Formelab window opens: log in and click <strong>Allow</strong>.</li>
  </ol>
  <h3>Use it</h3>
  <p>In a new chat, open the <strong>+</strong> menu, pick <strong>Developer mode</strong>, and turn on Formelab. Then ask, for example:</p>
  <p class="example">Make a lunch poll for my team and publish it to Formelab.</p>
  <p class="muted">Without Developer mode, ChatGPT can still use Formelab's read-only tools to find your apps and read their code, but it can't publish.</p>
`,
    gemini: `  <p class="muted">Gemini CLI is the dependable way to use Formelab with Gemini today.</p>
  <h3>Gemini CLI (and Antigravity)</h3>
  <ol>
    <li>Add Formelab to <code>~/.gemini/settings.json</code> (merge it with anything already there):</li>
  </ol>
  <div class="copyrow"><pre id="gemini-config">${e(geminiConfig)}</pre><button type="button" data-copy="#gemini-config">Copy</button></div>
  <ol start="2">
    <li>Start <code>gemini</code> and run <code>/mcp auth formelab</code>. Your browser opens Formelab: log in and click <strong>Allow</strong>. Formelab warns that access goes to an app on your computer; that's expected here.</li>
    <li>Run <code>/mcp</code> to check that Formelab is connected.</li>
  </ol>
  <h3>Gemini app (Gemini Enterprise only)</h3>
  <p class="muted">In the Gemini app, custom connectors like Formelab are only available on <strong>Gemini Enterprise</strong> plans and up. On a personal or standard Google Workspace plan, use Gemini CLI above, or Claude, which works on every plan.</p>
  <ol>
    <li>An admin of your Gemini Enterprise organization adds Formelab as a custom MCP server, with the connector URL above.</li>
    <li>Each person then connects it from Gemini, logs in to Formelab, and clicks <strong>Allow</strong>.</li>
  </ol>
  <p>Then mention Formelab in a chat, for example:</p>
  <p class="example">Use Formelab to build a sign-up sheet for our book club and publish it.</p>
  <p class="muted">Antigravity CLI, which Google is moving Gemini CLI users to, takes the same server URL as Gemini CLI.</p>
`,
    "claude-code": `  <ol>
    <li>Open <a href="/keys">Access keys</a>, create a key (30 days is fine for personal use) and copy it.</li>
    <li>Run this in your terminal, with your token in place of <code>fl_...</code>:</li>
  </ol>
  <div class="copyrow"><pre id="mcp-cmd">${e(cmd)}</pre><button type="button" data-copy="#mcp-cmd">Copy</button></div>
  <p>Then start Claude Code. It shows up here as <strong>Connected</strong> the first time it uses Formelab.</p>
  <p class="muted">Agents can also read the build guide at <a href="/_platform/guide.md">/_platform/guide.md</a>.</p>
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
    ${status(byTile.get(a.id) ?? [])}
    ${a.id === "claude-code" ? "" : `<p class="muted">Connector URL</p><div class="copyrow"><pre id="mcp-url-${a.id}">${e(url)}</pre><button type="button" data-copy="#mcp-url-${a.id}">Copy</button></div>`}
    ${STEPS[a.id]}
  </div>
</dialog>`,
  ).join("\n");

  const body = `<section class="howto">
  <h2>Pick your AI</h2>
  ${user.active ? "" : `<p class="note">Your account is still on the waitlist. You can connect now, but your AI can only create apps once you're let in.</p>`}
  <div class="ai-grid">${tiles}</div>
  ${others.length ? `<h3>Other connected apps</h3>${status(others)}` : ""}
</section>

${dialogs}`;
  return shell(c, user, "connect", body);
}
