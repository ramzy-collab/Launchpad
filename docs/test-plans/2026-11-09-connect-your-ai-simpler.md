# Simpler Connect your AI: test plan

Hands-on browser test plan for the simpler setup on **Connect your AI** (`/connect`). It covers:
- **One main action per app:** Claude, ChatGPT and Grok get a **Copy URL and open** button. Cursor keeps **Add to Cursor**. Gemini CLI and Claude Code get a single command to copy.
- **Three steps at most:** rarer cases (other plans, manual setup, no browser) sit in a closed section under the steps.
- **Claude Code without a key:** it logs in through the browser. The access key route stays, under "No browser".
- **Gemini CLI as one command:** `gemini mcp add` instead of editing the settings file by hand.
- **Badges update on return:** coming back to the tab after connecting turns the tile to **Connected** without a reload.

Written to hand to Claude Cowork.

## 1. Instructions for the tester

- **Order and IDs:** work through every case in order. Each case has an ID (for example `CL-03`), steps, and the expected result.
- **Marking results:** mark each case **Pass**, **Fail** or **Blocked**. For every Fail, record what happened instead, the browser and screen size, and a screenshot.
- **Test data only:** use only the test accounts below. Only disconnect connections you made during this test. Never remove connectors other than Formelab from the AI apps' settings.
- **Toasts:** "Toast" means the short message that appears at the bottom of the screen after an action.
- **Reload after saving:** after connecting or disconnecting, reload `/connect` and confirm the badge and status stuck. A change that shows but doesn't survive a reload is a Fail.
- **Console errors:** keep the browser's developer console open. Any red error in the console is a Fail for the case you were on.
- **Blocked cases:** if a case can't be run (no paid ChatGPT or Grok plan, no Cursor, no terminal), mark it Blocked and say what's missing. Don't skip it silently.

## 2. Setup and test data

Ramzy (or whoever hands this off) prepares these before Cowork starts.

> **Where to test:** a test deploy of this change, or locally with `wrangler dev --env dev --var DEV_USER:<email>`. Don't test on production data. The chat apps (Claude, ChatGPT, Grok) can only reach a public address, so cases that finish a connection in them need a test deploy. Locally, mark those Blocked after checking the button and steps.

### Accounts

| Name | Notes |
|---|---|
| **Member** | An active Formelab account with nothing connected yet. |
| **Waitlisted** | A Formelab account still on the waitlist. |
| **Claude Free** | A claude.ai Free account with no custom connector yet. |
| **ChatGPT Plus** | A paid ChatGPT account (Developer mode is on paid plans). |
| **Grok paid** | A paid grok.com account. |

### Tools on the tester's computer

- **Cursor**, installed.
- **Claude Code** (`npm install -g @anthropic-ai/claude-code`) and **Gemini CLI** (`npm install -g @google/gemini-cli`), each signed in to its own AI account.
- If Formelab was added to them before, remove it first: `claude mcp remove formelab` and `gemini mcp remove formelab`.

### Feature flags

None. This change isn't behind a flag.

## 3. The page

| ID | Steps | Expected |
|---|---|---|
| CA-01 | Sign in as **Member** and open `/connect`. | Six tiles: Claude, ChatGPT, Gemini, Grok, Cursor, Claude Code. Each says **Set up**. No waitlist note. |
| CA-02 | Click each tile in turn, then close its dialog with the **×** button. | Each opens a dialog with the app's logo and name. Each closes with **×**. |
| CA-03 | Open `/connect#chatgpt` directly. | The ChatGPT dialog opens on load. |
| CA-04 | In any dialog, click the dark area outside the dialog box. | The dialog closes. |
| CA-05 | Open each dialog and count the numbered steps in the main flow (not inside the closed section). | Three steps or fewer in every dialog. |
| CA-06 | Read every dialog, including each closed section. | No em dashes (—) anywhere. The words are plain and nothing is cut off. |
| CA-07 | Sign out, then open `/connect`. | You're sent to the sign-in screen. |
| CA-08 | Sign in as **Waitlisted** and open `/connect`. | A note says the account is on the waitlist and the AI can only create apps once you're let in. The tiles still work. |

## 4. Claude

| ID | Steps | Expected |
|---|---|---|
| CL-01 | As **Member**, open the Claude tile. | A purple **Copy URL and open Claude** button is the first thing under the heading. Under it are the connector URL with a **Copy** button, three steps, an example prompt and a closed section called **Team, Enterprise or Free plan**. |
| CL-02 | Click **Copy URL and open Claude**. | A new tab opens `claude.ai/settings/connectors`. Back on Formelab, a toast says "Connector URL copied. Paste it in Claude." Pasting anywhere gives the connector URL shown in the dialog, ending in `/mcp`. |
| CL-03 | Click the small **Copy** button next to the URL. | The button says **Copied** for a moment, then **Copy** again. The clipboard holds the URL. |
| CL-04 | Open **Team, Enterprise or Free plan**. | It explains the one-connector limit on Free and the owner-first steps for Team and Enterprise. |
| CL-05 | Signed in to claude.ai as **Claude Free**, follow the three steps (test deploy only). | Claude adds Formelab. A Formelab window asks to allow Claude for the Member account. After **Allow**, Claude shows Formelab as connected. |
| CL-06 | Without reloading, switch back to the Formelab tab. | Within a few seconds the Claude tile says **Connected** with a green dot. Opening it shows "Connected to your Formelab account" with **Disconnect**. |
| CL-07 | Reload `/connect`. | The Claude tile still says **Connected**. |
| CL-08 | In a Claude chat, ask the example prompt from the dialog. | Claude uses Formelab and publishes an app. |
| CL-09 | In the Claude dialog, click **Disconnect** and reload. | The Claude tile says **Set up** again. |

## 5. ChatGPT

| ID | Steps | Expected |
|---|---|---|
| CG-01 | Open the ChatGPT tile. | **Copy URL and open ChatGPT** first, then the URL, three steps (turn on Developer mode, Create, Allow), an example prompt and a closed section called **Can't find Developer mode?**. |
| CG-02 | Click **Copy URL and open ChatGPT**. | A new tab opens ChatGPT on its connector settings (or on ChatGPT's home page if signed out). A toast says "Connector URL copied. Paste it in ChatGPT." |
| CG-03 | Open **Can't find Developer mode?**. | It names the plans, the admin case and the other menu to look in, and says what works without Developer mode. |
| CG-04 | As **ChatGPT Plus**, follow the three steps (test deploy only). | ChatGPT creates the connector and a Formelab window opens. After **Allow**, it's connected. |
| CG-05 | Switch back to the Formelab tab without reloading. | The ChatGPT tile turns **Connected**. |

## 6. Grok

| ID | Steps | Expected |
|---|---|---|
| GR-01 | Open the Grok tile. | **Copy URL and open Grok** first, then the URL, two steps, an example prompt and a closed section called **Plans and labels**. |
| GR-02 | Click **Copy URL and open Grok**. | A new tab opens `grok.com/connectors`. A toast says "Connector URL copied. Paste it in Grok." |
| GR-03 | Open **Plans and labels**. | It names the plans and links to **New app**. The link works. |
| GR-04 | As **Grok paid**, follow the steps (test deploy only), then switch back to Formelab. | Grok connects after **Allow**. The Grok tile turns **Connected**. |

## 7. Gemini CLI

| ID | Steps | Expected |
|---|---|---|
| GM-01 | Open the Gemini tile. | "Run this in your terminal:" with `gemini mcp add --transport http formelab <your URL>/mcp` and a **Copy** button. Then two steps and a closed section called **Other ways to set it up**. No **Copy URL and open** button. |
| GM-02 | Click **Copy** and paste in a terminal, then press Enter. | Gemini CLI says it added the server `formelab`. |
| GM-03 | Start `gemini` and run `/mcp auth formelab`. | The browser opens a Formelab window warning that access goes to an app on your computer. After **Allow**, Gemini CLI says it's authenticated. |
| GM-04 | In Gemini CLI, run `/mcp`, then switch back to Formelab. | Formelab is listed as connected. The Gemini tile turns **Connected**. |
| GM-05 | Open **Other ways to set it up**. | It shows the settings file JSON with its own **Copy** button, and explains Antigravity and Gemini Enterprise. Copying gives valid JSON with `httpUrl` set to the connector URL. |

## 8. Cursor

| ID | Steps | Expected |
|---|---|---|
| CU-01 | Open the Cursor tile. | **Add to Cursor** first, then two steps, an example prompt and a closed section called **Add it by hand**. |
| CU-02 | Click **Add to Cursor**. | The browser asks to open Cursor. Cursor opens with an install prompt for `formelab`. |
| CU-03 | Click **Install** in Cursor, then **Needs login**, then **Allow** in the Formelab window. | Formelab turns green in Cursor's MCP settings. |
| CU-04 | Switch back to Formelab. | The Cursor tile turns **Connected**. |
| CU-05 | Open **Add it by hand** and copy the JSON. | Valid JSON with `url` set to the connector URL. |

## 9. Claude Code

| ID | Steps | Expected |
|---|---|---|
| CC-01 | Open the Claude Code tile. | "Run this in your terminal:" with `claude mcp add --transport http formelab <your URL>/mcp` (no `--header` line) and a **Copy** button. Then two steps and a closed section called **No browser, such as on a server or in CI**. |
| CC-02 | Copy the command, paste it in a terminal and press Enter. | Claude Code says it added `formelab`. |
| CC-03 | Start `claude`, run `/mcp`, pick **formelab** and choose to authenticate. | The browser opens a Formelab window naming Claude Code, with the warning that access goes to an app on your computer. |
| CC-04 | Click **Allow**. | Claude Code says authentication succeeded and lists Formelab's tools. No access key was needed. |
| CC-05 | Switch back to Formelab without reloading. | The Claude Code tile turns **Connected**. The dialog shows "Claude Code (formelab), connected ..." with **Disconnect**. |
| CC-06 | In Claude Code, ask: "Use Formelab's whoami tool." | It answers with the Member's email. |
| CC-07 | Open **No browser, such as on a server or in CI**. | Two steps: make a key on **Access keys** (the link works), then the same command with a `--header "Authorization: Bearer fl_..."` line, with its own **Copy** button. |
| CC-08 | Copy that command and paste it into a text editor. | It's one line with no backslash, ending in `--header "Authorization: Bearer fl_..."`. |
| CC-09 | Make a key, run `claude mcp remove formelab`, run the key command with your key, then ask Claude Code to use Formelab. | It works without a browser. After a reload, `/connect` shows Claude Code connected with "the access key ...". |
| CC-10 | Revoke the key from the dialog and delete it from Access keys. | It's gone from the dialog after a reload. |

## 10. Badges on return

| ID | Steps | Expected |
|---|---|---|
| BD-01 | With a dialog open, switch to another tab and back without connecting anything. | Nothing jumps. The dialog stays open and its steps and closed sections stay as they were. |
| BD-02 | Disconnect an app from its dialog in a second Formelab tab, then switch back to the first. | The tile in the first tab goes back to **Set up**. |
| BD-03 | After a badge updates on return, click that tile. | Its dialog opens normally. |
| BD-04 | Turn off the network (developer tools, Offline) and switch tabs and back. | No error shows and nothing breaks. Turn the network back on afterwards. |

## 11. Phone, keyboard and screen reader

| ID | Steps | Expected |
|---|---|---|
| PH-01 | At 390 px wide, open each dialog. | No sideways scrolling. Buttons are full size and easy to tap. Long commands and URLs wrap inside their boxes. |
| PH-02 | At 390 px wide, tap **Copy URL and open Claude**. | Claude opens and the URL is copied. |
| KB-01 | Using only the keyboard, Tab to a tile and press Enter. | Its dialog opens and focus moves into it. |
| KB-02 | Tab through a dialog. | Focus reaches the main button, **Copy**, every link, the closed section and **×**, in that order, with a visible focus ring. Enter or Space opens the closed section. |
| KB-03 | Press Escape. | The dialog closes and focus returns to the tile. |
| SR-01 | With VoiceOver or NVDA, open the Claude dialog. | The dialog is read with its name ("Claude"). The main button is read as a link, "Copy URL and open Claude". The closed section is read as collapsed. |
| SR-02 | With a screen reader, return to a tab where a badge just changed. | The tile reads "Connected". |

## 12. Light and dark mode

| ID | Steps | Expected |
|---|---|---|
| TH-01 | In light mode, open each dialog. | Text is readable, the main button is purple with white text, and the closed sections have a visible border. |
| TH-02 | Repeat in dark mode. | Same, with dark backgrounds and no white boxes left over. |

## 13. Pages that share code

| ID | Steps | Expected |
|---|---|---|
| RG-01 | Open **My apps** (`/`) as **Member** with nothing connected. | The prompt to connect your AI links to `/connect#claude` and opens the Claude dialog. |
| RG-02 | On **New app**, use **Make it with Claude**, **Make it with ChatGPT** and **Copy for Claude Code**. | They work as before. |
| RG-03 | Open **Connected apps** and an app's page. Use any **Copy** button there. | Copying works as before. |
| RG-04 | Open **Access keys** and create, then revoke, a test key. | Works as before. |
| RG-05 | In the admin panel, open **Test plans** and this plan. | The plan shows with every case ID listed. |

## 14. How to report

Finish with a summary, then one block per failure.

```
Summary
  Passed: N   Failed: N   Blocked: N
  Browsers and devices covered: ...

Failure
  Case: CL-02
  Where: Chrome 131, macOS, 1440 wide, dark mode
  Steps: what you did, exactly
  Expected: from the plan
  Actual: what happened
  Console: any errors, copied
  Screenshot: attached
  Severity: blocker | major | minor | cosmetic

Blocked
  Case: CG-04
  Missing: no paid ChatGPT account
```

Severity guide:
- **Blocker:** an app can't connect at all, or a connection goes to the wrong Formelab account.
- **Major:** a wrong result with a workaround, such as a button that doesn't copy or a badge that never updates.
- **Minor:** a small wrong behavior.
- **Cosmetic:** looks only.
