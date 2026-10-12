// "Connect your AI": how to add Formelab to Claude, ChatGPT and Claude Code.
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { isDev } from "../env";
import { escapeHtml as e } from "../util";
import { shell } from "./page";

export function connectPage(c: Context<AppEnv>): Response {
  const user = c.get("user");
  const origin = isDev(c.env) ? new URL(c.req.url).origin : `https://${c.env.DOMAIN}`;
  const url = `${origin}/mcp`;
  const geminiConfig = JSON.stringify({ mcpServers: { formelab: { httpUrl: url } } }, null, 2);
  const cmd = `claude mcp add --transport http formelab ${url} \\\n  --header "Authorization: Bearer fl_..."`;

  const body = `<section class="howto">
  <h2>Your connector URL</h2>
  <p>Claude, ChatGPT and Gemini all connect to Formelab with this address. You'll sign in to Formelab and click <strong>Allow</strong>; there's no key to copy.</p>
  <div class="copyrow"><pre id="mcp-url">${e(url)}</pre><button type="button" data-copy="#mcp-url">Copy</button></div>
  ${user.active ? "" : `<p class="note">Your account is still on the waitlist. You can connect now, but your AI can only create apps once you're let in.</p>`}
</section>

<section class="howto" id="claude">
  <h2>Claude</h2>
  <p class="muted">claude.ai, the Claude desktop app, and the mobile apps. Works on every plan, including Free. Free accounts can add one custom connector, so if you already use yours, remove it first.</p>
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
</section>

<section class="howto" id="chatgpt">
  <h2>ChatGPT</h2>
  <p class="muted">Needs <strong>Developer mode</strong>, which is on paid plans (Plus and Pro; on Business and Enterprise an admin may have to allow it). ChatGPT on the web is the easiest place to set this up.</p>
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
</section>

<section class="howto" id="gemini">
  <h2>Gemini</h2>
  <p class="muted">Gemini CLI is the dependable way to use Formelab with Gemini today.</p>
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
</section>

<section class="howto" id="claude-code">
  <h2>Claude Code</h2>
  <ol>
    <li>On <a href="/app">My apps</a>, under <strong>Deploy tokens</strong>, create a token (30 days is fine for personal use) and copy it.</li>
    <li>Run this in your terminal, with your token in place of <code>fl_...</code>:</li>
  </ol>
  <div class="copyrow"><pre id="mcp-cmd">${e(cmd)}</pre><button type="button" data-copy="#mcp-cmd">Copy</button></div>
  <p class="muted">Agents can also read the build guide at <a href="/_platform/guide.md">/_platform/guide.md</a>.</p>
</section>

<section class="howto" id="help">
  <h2>If something's off</h2>
  <ul>
    <li><strong>"Your account is still on the waitlist":</strong> your AI can connect but can't create apps until you're let in.</li>
    <li><strong>It asks you to sign in again:</strong> connections last up to 30 days, then the AI app asks you to reconnect.</li>
    <li><strong>Wrong account:</strong> the Formelab window shows who you're signed in as. Log out of Formelab and connect again with the right one.</li>
    <li><strong>To disconnect:</strong> go to <a href="/app">My apps → Connected apps</a> and click <strong>Disconnect</strong>.</li>
    <li><strong>Who can see what your AI publishes:</strong> new apps are private to you. Share them from <a href="/app">My apps</a>, under each app's <strong>Settings</strong>.</li>
  </ul>
</section>`;
  return shell(c, user, "connect", body);
}
