# Each app's address for AI tools: test plan

Hands-on test plan for each app's own address for AI tools (`<app-host>/mcp`), part A of step 5 of the [agent access spec](../specs/2026-11-22-agent-access.md). Written to hand to Claude Cowork. The consent and sign-in pages are checked in a real browser; the tools are checked by adding the app's address as a custom connector in Claude (claude.ai) and in ChatGPT, then asking them questions, as the step 1 plan does for Formelab's own connector.

## 1. Instructions for the tester

- Work through every case in order. Each case has an ID (for example `TL-04`), steps, and the expected result.
- Mark each case **Pass**, **Fail** or **Blocked**. For every Fail, record what happened instead, which account you were using, which AI tool, the browser and screen size, and a screenshot of the chat or page.
- Only use the test accounts and the test apps below. Never connect an AI tool to a real customer's app.
- Use a separate browser profile for each person, each signed in to its own test Claude or ChatGPT account.
- After every change made through an AI tool, open the app in the browser and reload it to check the change is really there.
- When an AI tool answers, check what it says against the app itself. An answer that names a record the person may not see is a **blocker**, even if the tool later says it can't.
- Keep the browser's developer console open on Formelab pages. Any red JavaScript error is a Fail for the case you were on. **One exception:** a refused request logs a failed request ("… 401", "… 403", "… 404"). That's the refusal itself.
- If a case can't be run (no ChatGPT account with custom connectors, no second browser), mark it Blocked and say what's missing. Don't skip silently.

## 2. Setup and test data

Ramzy (or whoever hands this off) prepares these before Cowork starts.

> **Where to test:** deploy the PR branch to a test Formelab with WorkOS set up, and run its migrations (this PR adds `0030_mcp_calls_site`). Claude and ChatGPT must be able to reach the test deploy over the internet, so local `wrangler dev` can't run these cases. Don't test on production data.

### Feature flags

- **Each app's address for AI tools** (`app_mcp`) on for Owner only (Features, add Owner), so the feature follows the app's owner.

### Accounts

| Name | Role on "Leads" | Notes |
|---|---|---|
| **Owner** | Owns the space `qa` and the test apps, has `app_mcp` | |
| **Rep A** | Share list (Viewer), role `rep` | A test Claude account |
| **Rep B** | Share list (Viewer), role `rep` | A test ChatGPT account (custom connectors on) |
| **Boss** | Added inside the app with role `manager` | Never used Formelab. A test Claude account |
| **Stranger** | Not on any list | A test Claude account |

### Test apps (space `qa`)

**Leads** (mount `leads`): the test app from [App members and roles](/test-plans/2026-11-24-app-members-roles) with this `formelab.json`. Rename it **Leads** on its page. Share it with Rep A and Rep B. As Owner, add Boss inside the app as `manager`. As Owner, save leads: "Ada" assigned to Rep A, "Bo" assigned to Rep B, "Cy" assigned to Rep A.

```json
{
  "default_role": "rep",
  "manage_roles": ["manager"],
  "records": {
    "lead": { "prefix": "lead:", "fields": ["name", "assignedTo"], "owner_field": "assignedTo", "read": { "manager": "all", "rep": "own" }, "write": { "manager": "all", "rep": "own" } }
  }
}
```

**Menu** (mount `menu`): any app with `{ "everyone": "all" }`, shared with Rep A, with a saved key `dish:1` = `{ "name": "Pie" }`.

**Plain** (mount `plain`): any app without a `formelab.json`.

**Other owner's app**: an app with rules, owned by an account that doesn't have `app_mcp`.

Write down each app's address (`https://….formelab.app`). The AI address is that plus `/mcp`.

## 3. Connecting

| ID | Steps | Expected |
|---|---|---|
| `CN-01` | As Rep A, in Claude, add a custom connector with Leads' address plus `/mcp` and choose Connect. | A browser window opens on Leads' own sign-in page ("Sign in to Leads"), not Formelab's. |
| `CN-02` | Sign in as Rep A. | A page "Connect Claude to Leads?" with "The app at <leads host>", Rep A's email, "See and change what you can" (chosen) and "Only look", **Allow** as the main button and **Deny**, and "Powered by Formelab". |
| `CN-03` | Press **Allow**. | Back in Claude, the connector shows as connected, with tools named list_lead, get_lead, save_lead, delete_lead. |
| `CN-04` | As Owner, open Leads' Activity tab in Formelab. | "<Rep A> connected Claude to this app". |
| `CN-05` | As Rep A, open Formelab's Connect your AI page (if Rep A has a Formelab account) or the admin panel's view of their connections. | The Leads connection isn't listed with Formelab's own connections. |
| `CN-06` | As Rep B, repeat CN-01 to CN-03 in ChatGPT. | The same, with "Connect ChatGPT to Leads?". |
| `CN-07` | Start connecting again as Rep A, and press **Deny**. | Claude says the connection was refused or cancelled. Nothing new in Activity. |
| `CN-08` | As Stranger, add Leads' address in Claude and sign in as Stranger. | Stranger is refused before the consent page ("hasn't been added to Leads" or "You don't have access"). |
| `CN-09` | Add Plain's address plus `/mcp` in Claude. | Claude can't connect: the address answers "not found". |
| `CN-10` | Add the other owner's app's address plus `/mcp`. | Claude can't connect: "not found", since the feature is off for that owner. |

## 4. Tools follow the person's role

| ID | Steps | Expected |
|---|---|---|
| `TL-01` | As Rep A in Claude: "List my leads in Leads." | Ada and Cy only. Never Bo. |
| `TL-02` | As Rep A: "Show me the lead Bo." | Claude says it can't find it (or it isn't visible to them). It never shows Bo's details. |
| `TL-03` | As Rep A: "Add a lead called Dee, assigned to me." Reload Leads in the browser as Rep A. | Dee is saved with Rep A's email. Activity shows "<Rep A> changed "lead:…" in the app's data, via Claude". |
| `TL-04` | As Rep A: "Reassign Dee to <Rep B's email>." | Refused: "You can only save records with your own email in "assignedTo"." Dee still belongs to Rep A after a reload. |
| `TL-05` | As Rep A: "Change Bo's name to Bob." | Refused (not allowed). Bo is unchanged. |
| `TL-06` | As Rep A: "Delete Dee." | Claude asks to confirm first (the tool is marked destructive), then Dee is gone after a reload. |
| `TL-07` | As Rep B in ChatGPT: "List my leads." | Bo only. |
| `TL-08` | As Boss in Claude (connect first, as in CN-01 to CN-03): "List all leads." | Ada, Bo and Cy. The tool's title reads "List lead records", without "my". |
| `TL-09` | As Boss: "Reassign Cy to <Rep B's email>." Then as Rep B: "List my leads." | Boss's change works. Rep B now sees Bo and Cy. |
| `TL-10` | Ask Claude, as Rep A, what tools the Leads connector has, with their descriptions. | Descriptions name the fields (name, assignedTo) and say Rep A only sees records whose "assignedTo" is their email. |

## 5. Changes to people take effect straight away

| ID | Steps | Expected |
|---|---|---|
| `RL-01` | As Owner, give Rep A the role `manager` (in the app, with the test app's Members section). As Rep A in Claude: "List all leads." | Ada, Bo and Cy: the new role counts on the next request, without reconnecting. |
| `RL-02` | As Owner, set Rep A back to `rep` (Remove in the test app, since Rep A is on the share list). Ask again without reconnecting. | Only Rep A's own leads, and the connection still works. |
| `RL-03` | As Owner, remove Boss under "Added in the app" on Leads' page. As Boss in Claude: "List all leads." | Claude reports the connection no longer works (it asks to reconnect, or says it's unauthorized). Reconnecting fails at sign-in. |
| `RL-04` | As Owner, stop sharing Leads with Rep B. As Rep B in ChatGPT: "List my leads." | Refused: Rep B can't open the app any more. |

## 6. Connections stay with their app

| ID | Steps | Expected |
|---|---|---|
| `SP-01` | As Rep A, in Claude, connect Menu too. Ask: "List the data in Menu." | Menu's own tools (list_data, …) answer with dish:1. Leads' connector doesn't answer for Menu. |
| `SP-02` | As Owner, connect Formelab's own connector in Claude. Ask "What's in Leads' data?" through it. | Formelab's connector answers with its own tools (kv_list), as an owner: unchanged by this feature. |
| `SP-03` | Ask Claude, as Rep A (no Formelab connector), to publish or delete an app. | It can't: the Leads connector has no such tools. |

## 7. Only look, and open apps

| ID | Steps | Expected |
|---|---|---|
| `RO-01` | As Rep A, connect Leads again choosing **Only look**. | Only list_lead and get_lead are offered. Asking to add a lead, Claude says it can't. |
| `RO-02` | As Owner, open Leads' Activity. | "<Rep A> connected Claude to this app, to look only". |
| `OP-01` | As Rep A in Claude, with Menu connected: "Add a dish called Soup to Menu." Reload Menu. | Saved as a new key. Activity shows it under Rep A via Claude. |

## 8. Pages, phone width, keyboard and screen reader

| ID | Steps | Expected |
|---|---|---|
| `AX-01` | At 375 px wide (a phone or a narrow window), go through CN-01 to CN-03. | The sign-in and consent pages fit with no sideways scrolling, and the app address wraps. |
| `AX-02` | On the consent page, use only the keyboard: Tab to the choices, pick **Only look** with the arrow keys, Tab to **Allow** and press Enter. | Focus is visible on each control, and the choice is kept. |
| `AX-03` | With VoiceOver or NVDA, read the consent page. | The heading "Connect Claude to Leads?", the choices with their explanations, and the buttons are read. The choice group is read with its label "What it can do". |
| `TH-01` | Look at the consent page in light mode. | Readable text, purple Allow button, plain Deny button. |
| `TH-02` | Switch the system to dark mode and reload the consent page. | Dark background, readable text, nothing white or invisible. |

## 9. Errors and regressions

| ID | Steps | Expected |
|---|---|---|
| `ER-01` | As Owner (with `app_mcp`), upload a new version of Leads that includes a file named `mcp`. | Refused: ""mcp" is reserved for the app's address for AI tools." |
| `ER-03` | As Owner, publish a version of Leads whose page runs `fetch("/_platform/authorize?client_id=x").then(r => r.status).then(console.log)` when loaded, and open it as Rep A. | The console shows 403: the app's own code can't read the consent page. Remove the line again afterwards. |
| `ER-02` | As Rep A, ask Claude to list leads 70 times in a minute (or have it loop). | After 60, "You made more than 60 calls to this app in a minute." A minute later it works again. |
| `RG-01` | Run [Connector data tools](/test-plans/2026-11-22-connector-data-tools) cases KV-01, KV-05 and KV-08 with Formelab's own connector. | Same results as that plan. |
| `RG-02` | As Owner, connect Formelab's own connector in Claude right after using Leads' address (CN-03). | Connects normally. |
| `RG-03` | Open Leads in the browser as Rep A and use it. | Works as before. Opening `<leads address>/mcp` directly in the browser shows an error, not an app page. |
| `RG-04` | As Owner, open the admin panel's Metrics. | AI tool calls to Leads' address aren't counted in Formelab's AI usage numbers. |

## 10. How to report

Finish with a summary, then one block per failure.

```
Summary
  Passed: N   Failed: N   Blocked: N
  AI tools and browsers covered: …

Failure
  Case: TL-02
  Person: Rep A
  AI tool: Claude (claude.ai), Chrome 131, macOS
  Steps: what you did or asked, exactly
  Expected: from the plan
  Actual: what happened, with the AI tool's answer copied
  Console: any errors, copied
  Screenshot: attached
  Severity: blocker | major | minor | cosmetic

Blocked
  Case: CN-06
  Missing: no ChatGPT account with custom connectors
```

Severity guide: **blocker** shows a person, through their AI tool, a record their role may not read, lets them change something they may not, keeps a removed person's connection working, or lets a connection to one app (or to Formelab) work at another. **Major** is a wrong result with a workaround, or a refusal of something the rules allow. **Minor** is a small wrong behavior or an unclear message. **Cosmetic** is looks only.
