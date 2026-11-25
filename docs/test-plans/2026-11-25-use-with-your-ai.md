# Use with your AI: test plan

Hands-on browser test plan for the "Use with your AI" box on an app's page and the guide's new part, part B of step 5 of the [agent access spec](../specs/2026-11-22-agent-access.md). Written to hand to Claude Cowork. Run it after (or with) [Each app's address for AI tools](/test-plans/2026-11-25-app-ai-address), which tests the address itself.

## 1. Instructions for the tester

- Work through every case in order. Each case has an ID (for example `UA-03`), steps, and the expected result.
- Mark each case **Pass**, **Fail** or **Blocked**. For every Fail, record what happened instead, which account you were using, the browser and screen size, and a screenshot.
- Only use the test accounts and test apps below.
- After every change, reload the page and check again. A result that changes on reload is a Fail.
- Keep the browser's developer console open. Any red JavaScript error is a Fail for the case you were on.
- If a case can't be run, mark it Blocked and say what's missing. Don't skip silently.

## 2. Setup and test data

> **Where to test:** a test deploy of the PR branch, or `wrangler dev --env dev --var DEV_USER:<Owner's email>` for the cases signed in as Owner. Don't test on production data.

### Feature flags

- **Each app's address for AI tools** (`app_mcp`) on for Owner only.

### Accounts and apps

| Name | What it is |
|---|---|
| **Owner** | Owns the space `qa`, has `app_mcp` |
| **Editor** | Editor of "Leads" |
| **Other owner** | An account without `app_mcp`, owning one app with access rules |

- **Leads** (space `qa`): an app with the `formelab.json` from [Each app's address for AI tools](/test-plans/2026-11-25-app-ai-address). Editor is its Editor.
- **Plain** (space `qa`): an app with no `formelab.json`.

## 3. The box on the app's page

| ID | Steps | Expected |
|---|---|---|
| `UA-01` | As Owner, open Leads' page in Formelab, Sharing tab, and scroll past People. | A **Use with your AI** section: one line on who can connect and what their AI sees, the address `https://<leads host>/mcp`, a **Copy address** button, and three short steps for Claude, ChatGPT and signing in. |
| `UA-02` | Press **Copy address** and paste it into a text field. | Exactly the app's address plus `/mcp`. A "Address copied" message shows. |
| `UA-03` | Paste the address into Claude (Settings, Connectors, Add custom connector) as Owner. | Claude connects after "Connect Claude to Leads?" on Formelab's own address. |
| `UA-04` | As Editor, open Leads' page. | The same section and address. |
| `UA-05` | As Owner, open Plain's page. | No **Use with your AI** section (Plain has no access rules). |
| `UA-06` | As Other owner, open their app's page. | No **Use with your AI** section (the feature is off for them). |
| `UA-07` | Turn `app_mcp` off for Owner, reload Leads' page. Turn it back on afterwards. | The section is gone while the feature is off. |

## 4. The guide

| ID | Steps | Expected |
|---|---|---|
| `GD-01` | As Owner (feature on), open the guide in Formelab (`/_platform/guide.md`) and find Access rules. | A **Use with your AI** part: the address is the app's address plus `/mcp`, tools come from `formelab.json` per record type, list each record's `fields`, add an in-app section only if asked, and don't put files at `mcp` or `.well-known/oauth-…`. |
| `GD-02` | As Other owner (feature off), open the guide. | No **Use with your AI** part. |
| `GD-03` | In Claude with Formelab's own connector, as Owner: "Add a Use with your AI section to Leads." | The AI shows the address with a Copy button only to signed-in people, using `location.origin + "/mcp"`. Publishing works. Check it in the app as a signed-in person, then as a public-link guest (no section). |

## 5. Phone width, keyboard and screen reader

| ID | Steps | Expected |
|---|---|---|
| `AX-01` | At 375 px wide, open Leads' page, Sharing tab. | The section fits: the address may be cut short with "…", the Copy address button stays visible, no sideways scrolling. |
| `AX-02` | With the keyboard only, Tab to **Copy address** and press Enter. | Focus is visible, and the address is copied. |
| `AX-03` | With VoiceOver or NVDA, move through the section. | The heading "Use with your AI", the address, the button read as "Copy the app's address for AI tools", and the steps as a numbered list. |

## 6. Light and dark mode

| ID | Steps | Expected |
|---|---|---|
| `TH-01` | In light mode, look at the section. | The address box matches the public link box above it. |
| `TH-02` | Switch to dark mode. | Readable text, the address box in dark colors. |

## 7. Regression checks

| ID | Steps | Expected |
|---|---|---|
| `RG-01` | On Leads' page, turn on the public link and press **Copy link**. | Still copies the public link, not the AI address. |
| `RG-02` | On Leads' page, invite someone and remove someone under "Added in the app". | Work as before. |

## 8. How to report

Finish with a summary, then one block per failure.

```
Summary
  Passed: N   Failed: N   Blocked: N
  Browsers and devices covered: …

Failure
  Case: UA-02
  Signed in as: Owner
  Where: Chrome 131, macOS, 1440 wide, light mode
  Steps: what you did, exactly
  Expected: from the plan
  Actual: what happened
  Console: any errors, copied
  Screenshot: attached
  Severity: blocker | major | minor | cosmetic
```

Severity guide: **blocker** shows a wrong address (another app's, or one that doesn't work), or shows the box for an app with no address. **Major** is a wrong result with a workaround, such as Copy not working. **Minor** is unclear copy. **Cosmetic** is looks only.
