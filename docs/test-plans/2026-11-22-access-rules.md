# Access rules on publish: test plan

Hands-on browser test plan for access rules (`formelab.json`) and the checks on publish and upload, step 2 of the [agent access spec](../specs/2026-11-22-agent-access.md). Written to hand to Claude Cowork. Most cases are run in the browser on the web app's upload screens; the connector cases are run by chatting with Claude (or another AI tool) that has the Formelab connector. The settings page warning is not part of this change and is not tested here.

## 1. Instructions for the tester

- Work through every case in order. Each case has an ID (for example `NA-04`), steps, and the expected result.
- Mark each case **Pass**, **Fail** or **Blocked**. For every Fail, record what happened instead, the browser and screen size, and a screenshot. For chat cases, also record the exact prompt and the AI tool's answer.
- Only use the test accounts, the test space and the test files below. Never upload to, or change, an app outside the test space.
- "Toast" means the short message at the bottom of the screen after an action. "Dialog" means a box in the middle of the screen with the page dimmed behind it.
- After any publish, reload the page (or open the app) and confirm the change stuck. A publish that says it worked but leaves nothing behind is a Fail.
- Keep the browser's developer console open. Any red JavaScript error is a Fail for the case you were on. **One exception:** a refused upload logs a failed request ("Failed to load resource … 400" or "… 409"). That's the refusal itself, not a failure. Any other red line is.
- If a case can't be run (missing account, feature off, no AI tool), mark it Blocked and say what's missing. Don't skip silently.

## 2. Setup and test data

Ramzy (or whoever hands this off) prepares these before Cowork starts.

> **Where to test:** deploy the PR branch to a test Formelab and run its migrations first (`npm run db:migrate:remote` against the test database), or run it locally: `npm run db:migrate:local`, then `wrangler dev --env dev --var DEV_USER:<email>`. Give Cowork the web app address. Don't test on production data.

### Accounts

| Name | Role | Notes |
|---|---|---|
| **Owner** | Owns the test space `qa` and every test app | The main account Cowork uses |
| **Editor** | Editor of the app "Old menu" | Has a Formelab account |
| **Space editor** | Editor of the space `qa`, not of any app | Has a Formelab account |
| **Viewer** | In the share list of "Old menu" | Has a Formelab account |

Owner also connects an AI tool (Claude or ChatGPT) to the test Formelab with "Make and change apps".

### Feature flags (admin panel, Features)

- `connected_apps` on (cases `NA-05`, `NA-06`, `GD-03`). Turn it off only for `GD-04`.
- `app_builder` on, with a saved Gemini or Claude key, for `RG-05`.

### Test files

Save each of these on the computer Cowork uses. "Zip" means a .zip with both files at the top level, not inside a folder.

| File | Contents |
|---|---|
| `plain.html` | `<!doctype html><html><head><title>Plain</title></head><body><h1>Hello</h1></body></html>` |
| `crm.html` | `<!doctype html><html><head><title>CRM</title><script src="/_platform/sdk.js"></script></head><body><h1>CRM</h1><script>const id = "1"; formelab.kv.set("lead:" + id, { name: "Ada" }); formelab.kv.get("settings");</script></body></html>` |
| `dynamic.html` | Like `crm.html`, but the script is `const key = location.hash; formelab.kv.get(key);` |
| `mine.html` | Like `crm.html`, but the script is `formelab.kv.mine.set("draft", 1);` |
| `sheet.html` | Like `crm.html`, but the script is `formelab.sheets.read("x", "A1");` |
| `crm-open.zip` | `index.html` = the contents of `crm.html`, and `formelab.json` = `{ "everyone": "all" }` |
| `crm-rules.zip` | `index.html` = `crm.html`, and `formelab.json` = `{"records":{"lead":{"prefix":"lead:","fields":["name","assignedTo"],"owner_field":"assignedTo","read":{"manager":"all","rep":"own"},"write":{"manager":"all"}},"settings":{"prefix":"settings","read":{"manager":"all","rep":"all"}}}}` |
| `crm-broken.zip` | `index.html` = `crm.html`, and `formelab.json` = `{"records":{"lead":{"prefix":"lead:","read":{"manager":"mine"}}}}` |
| `crm-badjson.zip` | `index.html` = `crm.html`, and `formelab.json` = `{ "everyone": "all"` (the closing brace missing) |
| `crm-overlap.zip` | `index.html` = `crm.html`, and `formelab.json` = `{"records":{"a":{"prefix":"lead:"},"b":{"prefix":"lead:old:"}}}` |
| `crm-invites.zip` | `index.html` = `crm.html`, and `formelab.json` = `{"manage_roles":["manager"],"records":{"lead":{"prefix":"lead:","read":{"manager":"all"}}}}` |

### Test apps (space `qa`)

| App | How to set it up | Used for |
|---|---|---|
| **Old menu** | Upload `plain.html` at path `old-menu`, add Editor and Viewer, then mark it as made before access rules: `UPDATE sites SET rules_required = 0, access = NULL WHERE namespace = 'qa' AND mount_path = 'old-menu'` (with `wrangler d1 execute launchpad --env dev --local --command "…"` locally, or `--remote` on the test database) | Older apps keep working |
| **Plain** | Upload `plain.html` at path `plain` | New app that saves nothing |

## 3. New apps: refused without rules

Signed in as Owner, on a computer screen at least 1280px wide, light mode. Every upload is on **New app → Upload an app**, space `qa`.

| ID | Steps | Expected |
|---|---|---|
| `NA-01` | Upload `plain.html` at path `na-plain`. | It publishes: the message "It's live: …" appears and the app opens. No dialog. |
| `NA-02` | Upload `crm.html` at path `na-crm`. | A dialog opens titled **This app can't be published yet**. No error toast or message under the form. |
| `NA-03` | Read the dialog from `NA-02`. | It says "It saves data (we found lead: and settings records) but has no access rules, so we can't tell who should see what.", then "**To fix it,** add a formelab.json that says who can see and change each kind of record. Or paste this into Claude, ChatGPT or your AI tool:", then a box with the prompt, then **Close** and **Copy prompt**. |
| `NA-04` | Read the prompt box. | Exactly: "My Formelab app saves data under these keys: lead:, settings. Write a formelab.json access rules file for it, following https://<the test Formelab's address>/guide#access-rules. Ask me who should see and change each kind of record before you write it." The address is the test Formelab's, not formelab.ai. |
| `NA-05` | Close the dialog. Upload `sheet.html` at path `na-sheet`. | The dialog says "It uses Google Sheets but has no access rules, so we can't tell who should see what." and the fix reads "add a formelab.json that says who can use the app." The prompt starts "My Formelab app uses Google Sheets." |
| `NA-06` | Upload `dynamic.html` at path `na-dynamic`. | Refused. The reason reads "It saves data but has no access rules…" with no "(we found …)" part. The prompt starts "My Formelab app saves data with formelab.kv." |
| `NA-07` | Upload `mine.html` at path `na-mine`. | It publishes. Each person's own data (`formelab.kv.mine`) needs no rules. |
| `NA-08` | After `NA-02`, open My apps and search `na-crm`. | Nothing found: a refused upload creates no app. |
| `NA-09` | Upload `crm-open.zip` at path `na-open`. | It publishes. |
| `NA-10` | Upload `crm-rules.zip` at path `na-rules`. | It publishes. |
| `NA-11` | Upload `crm.html` to the app **Plain** (path `plain`) from its page: open Plain's settings, drop `crm.html` on **Upload a new version**. | The same refusal dialog opens. No toast. The app still shows "Hello" when opened. |
| `NA-12` | Upload `crm-open.zip` to Plain the same way. | Toast "New version published". The app now shows "CRM". |

## 4. The refusal dialog

Still on the dialog from `NA-02` (upload `crm.html` again if needed).

| ID | Steps | Expected |
|---|---|---|
| `RP-01` | Click **Copy prompt**, then paste into a text field (for example the browser's address bar). | Toast "Prompt copied". The pasted text is exactly the prompt in the box. |
| `RP-02` | Paste the prompt into Claude or ChatGPT (with the Formelab connector), with `crm.html`'s code. | The AI asks who should see and change lead and settings records before writing anything. When answered, it writes a `formelab.json` that validates: uploading it with `crm.html` as a zip publishes. |
| `RP-03` | Click **Close**. | The dialog closes. The form keeps what you typed and chose. |
| `RP-04` | Open the dialog again, click outside it (on the dimmed page). | It closes. |
| `RP-05` | Open it again, click the × in the corner. | It closes. |
| `RP-06` | Open the guide link from the prompt in a browser signed in to the test Formelab. | The guide opens (plain text) and has a section "4. Access rules". |

## 5. Broken rules files

New app uploads, space `qa`.

| ID | Steps | Expected |
|---|---|---|
| `RI-01` | Upload `crm-broken.zip` at path `ri-broken`. | Refused with a message under the form (not the dialog): `formelab.json: records.lead.read.manager is "mine". Use "all", "own" or "none".` and "Fix formelab.json and publish again." |
| `RI-02` | Upload `crm-badjson.zip` at path `ri-json`. | Refused: "formelab.json: it isn't valid JSON (…)". |
| `RI-03` | Upload `crm-overlap.zip` at path `ri-overlap`. | Refused: the message names both prefixes ("lead:" and "lead:old:") and says they overlap. |
| `RI-04` | Upload `crm-broken.zip` to **Old menu** from its page. | Refused with the same message as `RI-01`, as a toast. Old menu still shows its old version. A broken rules file is refused for older apps too. |

## 6. Older apps

Apps made before access rules shipped keep publishing without them.

| ID | Steps | Expected |
|---|---|---|
| `OA-01` | As Owner, upload `crm.html` to **Old menu** from its page. | Toast "New version published". No dialog. The app shows "CRM". |
| `OA-02` | As Editor, upload `plain.html` to Old menu. | Publishes. |
| `OA-03` | As Owner, on Old menu's page choose **Make a copy**. | A copy "… (copy)" is made. Then upload `crm.html` to the copy from its page: it publishes without a dialog (a copy of an older app is no newer than the app). |
| `OA-04` | Make a copy of **Plain** (a new app) and upload `crm.html` to the copy. | The refusal dialog opens: a copy of a new app follows the new rules. |

## 7. Rules that let people invite others

| ID | Steps | Expected |
|---|---|---|
| `IW-01` | Upload `crm-invites.zip` at path `iw-team`. | A dialog titled **People using this app can invite anyone** with "Treat it as public: anyone they invite can open it." and **Cancel** and **Publish anyway**. |
| `IW-02` | Click **Cancel**. | The dialog closes. No error message, no toast. My apps has no `iw-team`. |
| `IW-03` | Upload it again and click **Publish anyway**. | "It's live: …". The app opens. |
| `IW-04` | Open the app's settings, Activity. | The entry reads "You published the app (2 files, …), and accepted that people using it can invite anyone". |
| `IW-05` | Upload `crm-invites.zip` to `iw-team` again from its page. | Toast "New version published". No dialog: it was already accepted for this app. |
| `IW-06` | Upload `crm-invites.zip` at path `iw-escape`, then press **Escape** on the dialog. | Same as Cancel: closes, nothing published, no message. |

## 8. Roles

| ID | Steps | Expected |
|---|---|---|
| `RL-01` | As Space editor, upload `crm.html` as a new app in `qa` at path `rl-space`. | The refusal dialog, as for Owner. |
| `RL-02` | As Space editor, upload `crm-open.zip` at path `rl-space`. | Publishes. |
| `RL-03` | As Owner, add Editor as an editor of `iw-team`. Then, as Editor, upload `crm-invites.zip` to `iw-team` from its page. | No dialog (already accepted for this app). Toast "New version published". |
| `RL-04` | As Viewer, open Old menu's settings page. | No upload box, as before this change. |

## 9. Through the connector (AI)

Chat with the AI tool connected as Owner. The connector also requires an icon: if a publish is refused with `icon_required`, let the AI add one and carry on; that's not a failure.

| ID | Steps | Expected |
|---|---|---|
| `CN-01` | Ask: "Make a simple CRM app in the qa space at path cn-crm where my team saves leads, and publish it." | The AI asks who should see and change the leads before publishing (because the guide and tool say so), or publishes and gets refused, then asks. Either way it never publishes without rules. Note which. |
| `CN-02` | Answer: "everyone can see and change everything". | The AI publishes with a `formelab.json` of `{ "everyone": "all" }` (ask it to show the file). The app opens and works. |
| `CN-03` | Ask it to publish `crm.html`'s code as a new app at path `cn-raw`, exactly as is, without rules. | Refused. The AI reports the reason and offers the prompt or to write rules. |
| `CN-04` | Ask it to publish `crm-invites.zip`'s two files at path `cn-team`. | The AI tells you people using the app can invite anyone and asks whether to publish anyway. It does **not** publish on its own. |
| `CN-05` | Answer "yes". | It publishes. The app's Activity shows the acceptance line. |
| `CN-06` | Ask it to publish a broken rules file (`crm-broken.zip`'s files) at path `cn-broken`. | Refused; the AI reports the exact problem with `records.lead.read.manager`. |

## 10. The guide

| ID | Steps | Expected |
|---|---|---|
| `GD-01` | Signed in, open `https://<test Formelab address>/guide`. | The guide opens. Sections run 1 to 8, with "4. Access rules" between "3. SDK reference" and "5. Patterns". |
| `GD-02` | Read "4. Access rules". | It covers: when an app needs the file, asking the person first, the one-line `{ "everyone": "all" }` rule, the per-record example, `guest`, `manage_roles` and confirming, owner and editors seeing everything, not listing who holds roles, how to publish a single-file app with rules (`files` or a zip), and that filtering comes later while `data_writes` decides writes until then. |
| `GD-03` | With `connected_apps` on, read its first sentence. | Mentions Google Sheets and connectors. |
| `GD-04` | Turn `connected_apps` off (only for this case), reload. | The first sentence mentions only `formelab.kv`; no Sheets or connectors anywhere in the section. Turn it back on. |
| `GD-05` | Read "6. Starter app" and "8. Agent checklist". | The starter app says to publish with `{ "everyone": "all" }`; the checklist has an "access rules" item. |
| `GD-06` | Signed out (private window), open `/guide`. | Sends you to sign in, the same as `/_platform/guide.md`. |

## 11. Phone width

Phone size (390 × 844), or a real phone.

| ID | Steps | Expected |
|---|---|---|
| `PH-01` | Upload `crm.html` as a new app. | The refusal dialog fits the screen with a gap on both sides. The prompt wraps inside its box; nothing scrolls sideways. Both buttons are visible without zooming. |
| `PH-02` | Click **Copy prompt**. | Toast "Prompt copied" at the bottom of the screen, readable below the dialog. Pasting gives the full prompt. |
| `PH-03` | Upload `crm-invites.zip` at a new path. | The invite dialog fits; both buttons are visible and tappable. |
| `PH-04` | Drop zone on an app's page: upload `crm.html` to Plain. | Same dialog, same fit. |

## 12. Keyboard and screen reader

| ID | Steps | Expected |
|---|---|---|
| `KB-01` | Using only the keyboard, fill the upload form with `crm.html` and press Enter on **Publish**. | The refusal dialog opens and focus moves into it. |
| `KB-02` | Press Tab repeatedly. | Focus moves through ×, Close and Copy prompt, and stays inside the dialog. Each has a visible focus ring. |
| `KB-03` | Press Enter on Copy prompt, then Escape. | Copies (toast), then the dialog closes and focus returns to the page. |
| `KB-04` | With VoiceOver (Mac) or NVDA (Windows), open the refusal dialog. | It's announced as a dialog named "This app can't be published yet", followed by the reason. The × reads "Close". |
| `KB-05` | With the screen reader, open the invite dialog. | Announced as "People using this app can invite anyone" with "Treat it as public: anyone they invite can open it." |

## 13. Light and dark mode

| ID | Steps | Expected |
|---|---|---|
| `TH-01` | In light mode, open the refusal and invite dialogs. | Readable text, the prompt box has a visible border and background, Copy prompt and Publish anyway are the filled (main) buttons. |
| `TH-02` | Switch the system (or Formelab's theme) to dark, repeat. | Same, in dark colors: no white boxes, no dark text on dark backgrounds. |

## 14. Copy

| ID | Steps | Expected |
|---|---|---|
| `CP-01` | Search the text of both dialogs and the refusal messages for the long dash "—". | None. |
| `CP-02` | Count filled (main) buttons in each dialog. | One per dialog: Copy prompt, Publish anyway. |
| `CP-03` | Read every message you saw in this plan. | Plain language that says what happened and how to fix it. Note anything confusing. |

## 15. Regression checks

Code shared with this change. Each should work as before.

| ID | Steps | Expected |
|---|---|---|
| `RG-01` | Ask the AI (connector) to publish an app without an icon. | Refused with `icon_required`, as before. The icon is checked before rules. |
| `RG-02` | Ask the AI to change one line of **na-open** (an edit, not the whole app). | Publishes; the rules file stays in the app (ask it to `read_file` `formelab.json`). |
| `RG-03` | Upload a new version of Old menu as a zip with only a changed file, using `scripts/publish.sh --dir … --changed-only`, if available. | Publishes as before. |
| `RG-04` | Make a copy of `iw-team` (rules that allow invites). | The copy is made without asking again. |
| `RG-05` | New app → build an app that saves votes with the app builder (saved key), for example "a lunch poll". | It builds and publishes, with no refusal (the builder's apps skip access rules for now). |
| `RG-06` | On New app and Spaces, type `Bad Name!` as a space name and submit. | The browser refuses it ("Please match the requested format") without a console error. `good-name` is accepted. |
| `RG-07` | Open the app settings Activity for an app you published earlier. | Publish entries still read "You published the app (N files, …)" or "You published a new version (…)". |

## 16. How to report

Finish with a summary, then one block per failure.

```
Summary
  Passed: N   Failed: N   Blocked: N
  Browsers and devices covered: …

Failure
  Case: NA-04
  Where: Chrome 131, macOS, 1440 wide, light mode
  Steps: what you did, exactly
  Expected: from the plan
  Actual: what happened
  Console: any errors, copied
  Screenshot: attached
  Severity: blocker | major | minor | cosmetic

Blocked
  Case: RG-05
  Missing: no saved builder key on the test account
```

Severity guide: **blocker** stops someone publishing an app they should be able to publish, lets a new app that saves data publish without rules, or publishes rules that allow invites without the person accepting. **Major** is a wrong result with a workaround. **Minor** is a small wrong behavior. **Cosmetic** is looks only.
