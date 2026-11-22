# No access rules warning: test plan

Hands-on browser test plan for the warning on an app's page when it saves data or uses connected services without access rules (`formelab.json`), the last part of step 2 of the [agent access spec](../specs/2026-11-22-agent-access.md). Written to hand to Claude Cowork. The checks on publish and upload are covered by the [Access rules on publish](/test-plans/2026-11-22-access-rules) plan.

## 1. Instructions for the tester

- Work through every case in order. Each case has an ID (for example `SW-04`), steps, and the expected result.
- Mark each case **Pass**, **Fail** or **Blocked**. For every Fail, record what happened instead, the browser and screen size, and a screenshot.
- Only use the test accounts, the test space and the test files below. Never upload to, or change, an app outside the test space.
- "The warning" means the yellow box with a warning sign between the app's name and its tabs (Sharing, Update, Activity). "Dialog" means a box in the middle of the screen with the page dimmed behind it.
- After any upload, reload the app's page and check the warning again.
- Keep the browser's developer console open. Any red JavaScript error is a Fail for the case you were on.
- If a case can't be run (missing account, feature off), mark it Blocked and say what's missing. Don't skip silently.

## 2. Setup and test data

Ramzy (or whoever hands this off) prepares these before Cowork starts.

> **Where to test:** deploy the PR branch to a test Formelab, or run it locally: `npm run db:migrate:local`, then `wrangler dev --env dev --var DEV_USER:<email>`. Give Cowork the web app address. Don't test on production data.

### Accounts

| Name | Role | Notes |
|---|---|---|
| **Owner** | Owns the test space `qa` and every test app | The main account Cowork uses |
| **Editor** | Editor of "Old data" | Has a Formelab account |
| **Space editor** | Editor of the space `qa`, not of any app | Has a Formelab account |
| **Viewer** | In the share list of "Old data" | Has a Formelab account |

### Feature flags

- `connected_apps` on, for "Old sheet".

### Test files

The same files as the [Access rules on publish](/test-plans/2026-11-22-access-rules) plan: `plain.html`, `crm.html`, `sheet.html`, `crm-open.zip` and `crm-invites.zip`. Also make `crm-sheet.html`: like `crm.html`, but its script is `formelab.kv.set("lead:1", 1); formelab.sheets.read("x", "A1");`.

### Test apps (space `qa`)

Apps made before access rules shipped can't be made from the web app any more, so each "Old …" app is made in two steps: upload `plain.html` at its path, mark it as made before access rules with `UPDATE sites SET rules_required = 0 WHERE namespace = 'qa' AND mount_path = '<path>'` (with `wrangler d1 execute launchpad --env dev --local --command "…"` locally, or `--remote` on the test database), then upload the file in the table as a new version from the app's page. Last, clear what Formelab found so the page scans it afresh: `UPDATE sites SET access = NULL WHERE namespace = 'qa'`.

| App | Path | New version uploaded | Used for |
|---|---|---|---|
| **Old data** | `old-data` | `crm.html`; then add Editor and Viewer | The data warning, roles |
| **Old sheet** | `old-sheet` | `sheet.html` | The connected services warning |
| **Old both** | `old-both` | `crm-sheet.html` | Data and services together |
| **Old plain** | `old-plain` | `plain.html` (no second upload needed) | No warning |
| **Open app** | `open-app` | Upload `crm-open.zip` as a new app | No warning |
| **Team app** | `team-app` | Upload `crm-invites.zip` as a new app, choose **Publish anyway** | The public line |

## 3. The warning

Signed in as Owner, on a computer screen at least 1280px wide, light mode.

| ID | Steps | Expected |
|---|---|---|
| `SW-01` | Open Old data's page (My apps, then its gear). | The warning shows between the app's name and the tabs: "**No access rules.** Everyone who can open this app can see all of its saved data, and its users can't connect their AI." followed by an underlined **Add rules**. |
| `SW-02` | Click the Update tab, then Activity, then Sharing. | The warning stays above the tabs on every tab. |
| `SW-03` | Open Old sheet's page. | "**No access rules.** Everyone who can open this app can use its connected services." and **Add rules**. Nothing about saved data. |
| `SW-04` | Open Old both's page. | "…can see all of its saved data, and its users can't connect their AI. They can also use its connected services." and **Add rules**. |
| `SW-05` | Open Old plain's page and Open app's page. | No warning on either. |
| `SW-06` | Open Team app's page. | "**Treated as public.** People using this app can invite anyone, and anyone they invite can open it." No Add rules link. |
| `SW-07` | Reload Old data's page twice. | The warning shows the same each time, and the page doesn't get slower after the first load. |

## 4. Add rules

On Old data's page.

| ID | Steps | Expected |
|---|---|---|
| `AR-01` | Click **Add rules**. | A dialog titled **Add access rules**: "It saves data (we found lead: and settings records) but has no access rules, so we can't tell who should see what.", "**To fix it,** add a formelab.json that says who can see and change each kind of record. Or paste this into Claude, ChatGPT or your AI tool:", the prompt in a box, then **Close** and **Copy prompt**. |
| `AR-02` | Read the prompt. | "My Formelab app saves data under these keys: lead:, settings. Write a formelab.json access rules file for it, following https://<the test Formelab's address>/guide#access-rules. Ask me who should see and change each kind of record before you write it." |
| `AR-03` | Click **Copy prompt** and paste into a text field. | Toast "Prompt copied". The pasted text is the full prompt. |
| `AR-04` | Close the dialog with Close, then with the ×, then by clicking outside it. | Each closes it. The warning is still there. |
| `AR-05` | On Old sheet's page, click **Add rules**. | The dialog says "It uses Google Sheets but has no access rules…", the fix reads "add a formelab.json that says who can use the app.", and the prompt starts "My Formelab app uses Google Sheets." |
| `AR-06` | On Old data's page, upload `crm-open.zip` as a new version (drop it on the upload box, or Update, then "Upload a new version instead"). Reload. | Toast "New version published". After the reload the warning is gone. |
| `AR-07` | Upload `crm.html` to Old data again (no rules). Reload. | Publishes (an older app may), and the warning is back. |

## 5. Roles

| ID | Steps | Expected |
|---|---|---|
| `RL-01` | As Editor, open Old data's page. | The same warning and Add rules link. |
| `RL-02` | As Space editor, open Old data's page (through Spaces, or its address). | The same warning. |
| `RL-03` | As Viewer, try Old data's page address. | Not found, as before: viewers don't get the settings page, so they never see the warning. |

## 6. Phone width

Phone size (390 × 844), or a real phone.

| ID | Steps | Expected |
|---|---|---|
| `PH-01` | Open Old data's page. | The warning fits the screen with the side gutter, wraps onto several lines, and nothing scrolls sideways. The warning sign stays at the top left of the box. |
| `PH-02` | Tap **Add rules**. | The dialog fits; the prompt wraps inside its box; both buttons are visible and tappable. |

## 7. Keyboard and screen reader

| ID | Steps | Expected |
|---|---|---|
| `KB-01` | On Old data's page, press Tab from the top until you reach **Add rules**. | It gets a visible focus ring. |
| `KB-02` | Press Enter. | The dialog opens and focus moves into it. |
| `KB-03` | Press Escape. | The dialog closes and focus returns to **Add rules**. |
| `KB-04` | With VoiceOver (Mac) or NVDA (Windows), move through the top of Old data's page. | The warning is read in full, starting "No access rules.", and **Add rules** is announced as a button that opens a dialog. The dialog is announced as "Add access rules". |

## 8. Light and dark mode

| ID | Steps | Expected |
|---|---|---|
| `TH-01` | In light mode, look at the warning on Old data and Team app. | A pale yellow box with a darker yellow border, dark readable text, the warning sign visible. |
| `TH-02` | Switch to dark mode, repeat. | A dark box with a yellow border, light readable text. Add rules is readable and underlined. |

## 9. Copy

| ID | Steps | Expected |
|---|---|---|
| `CP-01` | Search the warning and the dialog for the long dash "—". | None. |
| `CP-02` | Read the warning on each app. | Plain language that says what's open and how to fix it. Note anything confusing. |

## 10. Regression checks

Code shared with this change. Each should work as before.

| ID | Steps | Expected |
|---|---|---|
| `RG-01` | On New app, upload `crm.html` as a new app. | The refusal dialog, titled **This app can't be published yet**, with Copy prompt working. |
| `RG-02` | On Old plain's page: star it, change its name, copy its link, open the ⋯ menu. | All work as before, with the warning absent. |
| `RG-03` | On Old data's page: switch Invited only and Public, toggle "Viewers can add and change the app's data". | Work as before. The warning doesn't change: it's about access rules, not sharing. |
| `RG-04` | Open the full Activity page of Old data. | Works, no warning there (only the app's main page has it). |

## 11. How to report

Finish with a summary, then one block per failure.

```
Summary
  Passed: N   Failed: N   Blocked: N
  Browsers and devices covered: …

Failure
  Case: SW-04
  Where: Chrome 131, macOS, 1440 wide, light mode
  Steps: what you did, exactly
  Expected: from the plan
  Actual: what happened
  Console: any errors, copied
  Screenshot: attached
  Severity: blocker | major | minor | cosmetic

Blocked
  Case: SW-03
  Missing: connected_apps is off on the test deploy
```

Severity guide: **blocker** hides the warning from an app that saves data without rules, shows another person's data, or breaks the app's page. **Major** is a wrong result with a workaround. **Minor** is a small wrong behavior. **Cosmetic** is looks only.
