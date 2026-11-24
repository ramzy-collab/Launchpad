# Access rules over outside data: test plan

Hands-on browser test plan for access rules applied to Google Sheets, custom connectors, saved keys and Gemini, step 6 of the [agent access spec](../specs/2026-11-22-agent-access.md). Written to hand to Claude Cowork. Each case is run in the browser, in a small test app that reads and writes a test spreadsheet and calls the app's connected services, so the rules can be checked person by person.

## 1. Instructions for the tester

- Work through every case in order. Each case has an ID (for example `SR-04`), steps, and the expected result.
- Mark each case **Pass**, **Fail** or **Blocked**. For every Fail, record what happened instead, which account you were signed in as, the browser and screen size, and a screenshot.
- Only use the test accounts, the test spreadsheet and the test apps below. Never open, change or delete data in an app or spreadsheet outside the test space.
- Use a separate browser profile (or a private window) for each account, so you're signed in as the right person. The test app shows who you are at the top: check it before each case.
- After every save, press **Read** again, then reload the page and read again. For writes, also look at the spreadsheet itself in Google Sheets (as Owner). A change that shows but doesn't survive a reload is a Fail.
- Keep the browser's developer console open. Any red JavaScript error is a Fail for the case you were on. **One exception:** a refused call logs a failed request ("… 403", "… 401" or "… 409"). That's the refusal itself. Any other red line is a Fail.
- Some cases ask you to type a line into the console. Copy it exactly, replacing `<id>` with the test spreadsheet's id.
- If a case can't be run (missing account, no Gemini key, no public link), mark it Blocked and say what's missing. Don't skip silently.

## 2. Setup and test data

Ramzy (or whoever hands this off) prepares these before Cowork starts.

> **Where to test:** deploy the PR branch to a test Formelab and run its migrations first (`npm run db:migrate:remote` against the test database), or run it locally: `npm run db:migrate:local`, then `wrangler dev --env dev --var DEV_USER:<email>`. Local testing signs in one person only, so a test deploy is needed for the cases with several accounts. Google Sheets needs the test Formelab's own Google OAuth client (README 1.9). Don't test on production data.

### Feature flags

- **Connected apps** (`connected_apps`) on for Owner.

### Accounts

| Name | Role on the test apps | Notes |
|---|---|---|
| **Owner** | Owns the space `qa` and every test app | Has connected Google Sheets (a test Google account) and, if possible, Google Gemini |
| **Editor** | Editor of "Rules sheet" | Has a Formelab account |
| **Rep A** | In the share list of every test app | Has a Formelab account |
| **Rep B** | In the share list of "Rules sheet" | Has a Formelab account |
| **Member** | Not on any share list | Has a Formelab account. Used for an app open to all Formelab members |
| **Guest** | Not signed in | A private window, opening a public link |

### The test spreadsheet

In Owner's test Google account, make a spreadsheet called **QA leads** with two tabs. Copy its id (the long part of its link, `docs.google.com/spreadsheets/d/<id>/edit`).

Tab **Leads** (row 1 is the heading row):

| | A | B | C |
|---|---|---|---|
| 1 | Name | Stage | Assigned to |
| 2 | Ada | new | *Rep A's email* |
| 3 | Bo | won | *Rep B's email* |
| 4 | Cy | new | *Rep A's email in CAPITALS, with a space before it* |
| 5 | Dee | lost | *(empty)* |

Tab **Gaps**: leave column A empty. Put `Name`, `Stage`, `Assigned to` in B1, C1, D1, and one row in B2:D2: `Fay`, `new`, *Rep B's email*.

Make a second spreadsheet called **QA other** with anything in it, and copy its id too.

### Connected services

As Owner, in Formelab under **Connected apps**:

- **+ Custom connector** named `qa-echo`: any key, host `postman-echo.com`, sent as a Bearer header.
- Google Gemini connected with a test key, if there is one (otherwise the Gemini cases for Owner are Blocked).

### The test app

Save this as `index.html`. It shows who you are, reads, adds and changes rows, and calls the app's services.

```html
<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sheets rules test</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'%3E%3Ccircle cx='5' cy='5' r='5' fill='%235B4CF5'/%3E%3C/svg%3E">
<script src="/_platform/sdk.js"></script>
<style>body{font:16px system-ui;margin:16px;max-width:640px}input,textarea{width:100%;box-sizing:border-box;font:inherit;margin:4px 0 8px}pre{background:#f2f2f2;padding:8px;white-space:pre-wrap}#out{font-weight:600}</style></head>
<body><p>Signed in as: <span id="me">…</span></p>
<label>Spreadsheet id <input id="sheet"></label>
<label>Range <input id="range" value="Leads!A1:C10"></label>
<label>Rows (JSON, one list per row) <textarea id="rows" rows="3">[["Eve","new","rep-a@example.com"]]</textarea></label>
<button id="read">Read</button> <button id="append">Add rows</button> <button id="update">Change rows</button>
<pre id="list"></pre>
<h2>Services</h2>
<label>Name <input id="svc" value="qa-echo"></label>
<button id="fetch">Connector</button> <button id="proxy">Saved key</button> <button id="gemini">Gemini</button>
<p id="out" role="status"></p>
<script>
const $ = (id) => document.getElementById(id);
const say = (t) => { $("out").textContent = t; };
const fail = (e) => say("Error: " + (e.code || "") + " " + e.message);
try { $("sheet").value = localStorage.getItem("sheet") || ""; } catch (e) {}
$("sheet").onchange = () => { try { localStorage.setItem("sheet", $("sheet").value); } catch (e) {} };
$("read").onclick = async () => { try { const rows = await formelab.sheets.read($("sheet").value, $("range").value); $("list").textContent = rows.map((r) => r.length ? r.join(" | ") : "(empty row)").join("\n") || "(nothing)"; say("Read " + rows.length + " rows"); } catch (e) { $("list").textContent = ""; fail(e); } };
$("append").onclick = async () => { try { await formelab.sheets.append($("sheet").value, $("range").value, JSON.parse($("rows").value)); say("Saved"); } catch (e) { fail(e); } };
$("update").onclick = async () => { try { await formelab.sheets.update($("sheet").value, $("range").value, JSON.parse($("rows").value)); say("Saved"); } catch (e) { fail(e); } };
$("fetch").onclick = async () => { try { const r = await formelab.connectors.fetch($("svc").value, "/get"); say("Connector answered " + r.status); } catch (e) { fail(e); } };
$("proxy").onclick = async () => { try { const r = await formelab.secrets.proxy($("svc").value, { url: "https://postman-echo.com/get" }); say("Saved key answered " + r.status); } catch (e) { fail(e); } };
$("gemini").onclick = async () => { try { await formelab.gemini.generate("Say hi"); say("Gemini answered"); } catch (e) { fail(e); } };
formelab.me().then((m) => { $("me").textContent = m ? m.email : "a guest (public link)"; });
</script></body></html>
```

### Test apps (space `qa`)

Each is a zip with the test app's `index.html` and a `formelab.json`. Replace `<id>` with QA leads' id.

| App | Path | `formelab.json` | Then |
|---|---|---|---|
| **Rules sheet** | `rules-sheet` | `{"default_role":"rep","records":{"note":{"prefix":"note:","read":{"rep":"all"}}},"sources":{"sheets":{"<id>":{"owner_column":"Assigned to","read":{"rep":"own"},"write":{"rep":"own"}}},"connectors":{"qa-echo":{"rep":"all"},"gemini":{"rep":"none"}}}}` | Share with Rep A and Rep B, add Editor. On its page, Connected apps tab: add QA leads and QA other. Ask Claude (as Owner, with the Formelab connector) to add `qa-echo` to its connectors. Turn on its public link. |
| **Sheet reader** | `sheet-reader` | `{"default_role":"rep","records":{"note":{"prefix":"note:","read":{"rep":"all"}}},"sources":{"sheets":{"<id>":{"read":{"rep":"all"},"write":{"rep":"none"}}}}}` | Share with Rep A. Add QA leads. |
| **Members sheet** | `members-sheet` | Same as Rules sheet | Visibility: **All Formelab members**. Add QA leads. |
| **Quiet sheet** | `quiet-sheet` | `{"default_role":"rep","records":{"note":{"prefix":"note:","read":{"rep":"all"}}}}` | Upload `index.html` with every `formelab.sheets` changed to `formelab["sheets"]` and every `formelab.connectors`, `formelab.secrets` and `formelab.gemini` changed the same way, so the publish check doesn't see them. Share with Rep A. Add QA leads. |
| **Old sheet** | `old-sheet` | Same as Quiet sheet | An app made before access rules. Ask Ramzy for one in the test space, or have him set `rules_required = 0` on a copy of Quiet sheet in the test database. Then upload the unchanged test app with this `formelab.json`. Share with Rep A. Add QA leads. |

Keep these zips at hand for section 3:

| Zip | `formelab.json` |
|---|---|
| `no-sources.zip` | The one for Quiet sheet, with the unchanged `index.html` |
| `bad-id.zip` | Rules sheet's, with `<id>` replaced by `my-sheet` |
| `no-column.zip` | Rules sheet's, without `"owner_column":"Assigned to",` |
| `own-connector.zip` | Rules sheet's, with `"qa-echo":{"rep":"own"}` |
| `guest-sheet.zip` | Rules sheet's, with `"read":{"rep":"own","guest":"all"}` |

## 3. Rules on upload

| ID | Steps | Expected |
|---|---|---|
| `RV-01` | As Owner, upload `no-sources.zip` as a new app at path `rv-none`. | The dialog "This app can't be published yet" opens: "It uses Google Sheets and connected services, but its access rules don't say who can use them." The prompt starts "My Formelab app uses Google Sheets and connected services. Add a "sources" section to its formelab.json". The app isn't created (it's not in My apps). |
| `RV-02` | Click **Copy prompt** and paste it somewhere. | Toast "Prompt copied". The pasted text is the whole prompt, ending "Ask me who should use each one before you write it." |
| `RV-03` | Upload `bad-id.zip` at path `rv-id`. | Refused with a message under the form (not the dialog): `formelab.json: sources.sheets "my-sheet" isn't a spreadsheet id.` followed by where to find the id, and "Fix formelab.json and publish again." |
| `RV-04` | Upload `no-column.zip` at path `rv-col`. | Refused: the message says the spreadsheet gives "own" access but has no owner_column. |
| `RV-05` | Upload `own-connector.zip` at path `rv-own`. | Refused: `sources.connectors.qa-echo.rep is "own", but Formelab can't tell whose data a connected service returns. Use "all" or "none".` |
| `RV-06` | Upload `guest-sheet.zip` at path `rv-guest`. | Refused: the message says people who open the app through its public link can't use connected services. |
| `RV-07` | In Claude with the Formelab connector, as Owner, ask it to publish `no-sources.zip`'s two files as a new app at `rv-claude`. | Claude reports that the app can't be published yet, with the same reason, and offers to add a `sources` section. It doesn't publish. |

## 4. Reading your own rows

In Rules sheet, put QA leads' id in **Spreadsheet id**.

| ID | Steps | Expected |
|---|---|---|
| `SR-01` | As Owner, read `Leads!A1:C10`. | All five rows: the heading row, Ada, Bo, Cy and Dee. |
| `SR-02` | As Editor, read `Leads!A1:C10`. | The same five rows. |
| `SR-03` | As Rep A, read `Leads!A1:C10`. | Four lines: the heading row, Ada, "(empty row)", Cy. Bo and Dee aren't there. Cy is there although the email is in capitals with a space. |
| `SR-04` | As Rep B, read `Leads!A1:C10`. | Three lines: the heading row, "(empty row)", Bo. |
| `SR-05` | As Rep A, read `Leads!A2:A`. | Three lines: Ada, "(empty row)", Cy. Names only, filtered although the range leaves out the Assigned to column. |
| `SR-06` | As Rep A, read `A1:C10` (no tab). | "Error: not_allowed Name the tab in the range, like "Sheet1!A2:D"." |
| `SR-07` | As Rep A, in the console: `await formelab.sheets.request("GET", "spreadsheets/<id>/values:batchGet", { query: { ranges: ["Leads!A:C"] } })` | Rejected with code `not_allowed`: "People using this app can only read, add and change their own rows." |
| `SR-08` | As Rep A, in the console: `await formelab.sheets.request("GET", "spreadsheets/<id>", { query: { includeGridData: true } })` | Rejected with code `sheets_editors_only`. |
| `SR-09` | As Rep A, in the console: `await formelab.sheets.request("GET", "spreadsheets/<id>", { query: { fields: "sheets.properties.title" } })` | Works: the answer lists the tab names Leads and Gaps, and no cell values. |
| `SR-10` | As Rep A, in the console: `(await formelab.sheets.request("GET", "spreadsheets/<id>/values/Leads!A1:C10", { query: { majorDimension: "COLUMNS", valueRenderOption: "FORMULA" } })).values` | Still rows, not columns, and still only the heading row, Ada, an empty row and Cy. |
| `SR-12` | As Rep A, in the console: `await formelab.sheets.request("GET", "spreadsheets/<id>", { query: { fields: "*" } })` | Works, but the answer has only the spreadsheet's title and tab details: no `data`, no cell values. |
| `SR-11` | As Owner, rename C1 in Google Sheets to `Owner`. As Rep A, read `Leads!A1:C10`. Then rename it back to `Assigned to`. | "Error: sheets_owner_column_missing The tab "Leads" has no "Assigned to" column in row 1." No rows are shown. After renaming back, SR-03's result again. |

## 5. Writing your own rows

In Rules sheet, as Rep A, with QA leads' id. Replace `rep-a@example.com` in the rows box with Rep A's real email (and Rep B's where it says so).

| ID | Steps | Expected |
|---|---|---|
| `SW-01` | Range `Leads!A:C`, rows `[["Eve","new","<Rep A>"]]`, **Add rows**. | "Saved". In Google Sheets (as Owner) Eve is in row 6 with Rep A's email. Rep A reads `Leads!A1:C10` and sees Eve; Rep B doesn't. |
| `SW-02` | Add rows `[["Gus","new","<Rep B>"]]` to `Leads!A:C`. | "Error: not_allowed Each new row needs your email in "Assigned to"." Nothing added in Google Sheets. |
| `SW-03` | Add rows `[["Gus","new"]]` to `Leads!A:B`. | "Error: not_allowed The range must include the "Assigned to" column." |
| `SW-04` | Add rows `[["=C3","new","<Rep A>"]]` to `Leads!A:C`. | "Error: not_allowed Formulas can't be saved in this app." Nothing added. |
| `SW-05` | Add rows `[["'=C3","new","<Rep A>"]]` to `Leads!A:C`. | "Saved". In Google Sheets the new row's A cell shows the text `=C3`, not Bo's email. Delete that row afterwards as Owner. |
| `SW-06` | Range `Leads!B2`, rows `[["won"]]`, **Change rows**. | "Saved". Ada's stage is "won" in Google Sheets. |
| `SW-07` | Range `Leads!B3`, rows `[["lost"]]`, **Change rows**. | "Error: not_allowed That range includes rows that aren't yours." Bo is unchanged. |
| `SW-08` | Range `Leads!B2:B3`, rows `[["x"],["x"]]`, **Change rows**. | The same error. Neither row changes (Ada stays "won"). |
| `SW-09` | Range `Leads!B5`, rows `[["x"]]`, **Change rows**. | The same error (Dee belongs to nobody). |
| `SW-10` | Range `Leads!A1:C1`, rows `[["x","y","<Rep A>"]]`, **Change rows**. | The same error. The heading row is unchanged. |
| `SW-11` | Range `Leads!A2:C2`, rows `[["Ada","won","<Rep B>"]]`, **Change rows**. | "Error: not_allowed Keep your email in "Assigned to": rows can't be given to someone else." |
| `SW-12` | In the console: `await formelab.sheets.request("POST", "spreadsheets/<id>/values/Leads!A:C:clear", { body: {} })` | Rejected with `not_allowed`. The tab is unchanged. |
| `SW-13` | In the console: `await formelab.sheets.request("POST", "spreadsheets/<id>:batchUpdate", { body: { requests: [] } })` | Rejected with `sheets_editors_only`. |
| `SW-14` | Range `Gaps!A:D`, rows `[["","Hal","new","<Rep A>"]]`, **Add rows**. | Either "Saved" with Hal's row in Gaps and Rep A's email under **Assigned to** (column D), or "Error: sheets_append_moved Google Sheets put the new row in other columns than asked, so it wasn't saved." with no new filled row in Gaps. **Fail** if a row ends up in Gaps whose Assigned to isn't Rep A's email. |
| `SW-15` | As Editor, add `[["Ivy","new","<Rep B>"]]` to `Leads!A:C`, then change `Leads!B3` to `[["lost"]]`. | Both work: editors can change every row. |

## 6. Levels and roles

| ID | Steps | Expected |
|---|---|---|
| `LV-01` | In Sheet reader, as Rep A, read `Leads!A1:C10`. | Every row, Bo's and Dee's included (read is "all" there). |
| `LV-02` | In Sheet reader, as Rep A, add `[["Jo","new","<Rep A>"]]` to `Leads!A:C`. | "Error: not_allowed You can't use this spreadsheet in this app." |
| `LV-03` | In Rules sheet, as Rep A, put QA other's id in Spreadsheet id and read `Sheet1!A1:C10`. | "Error: not_allowed You can't use this spreadsheet in this app." (The rules don't name it.) As Owner, the same read works. |
| `LV-04` | In Members sheet, as Member (not on any share list), read `Leads!A1:C10`. | The heading row only: Member has the default role and owns no rows. |
| `LV-05` | Open Rules sheet's public link in a private window and read `Leads!A1:C10`. | "Error: sign_in_required …": people from the public link can't use Sheets. |

## 7. Connectors, saved keys and Gemini

In Rules sheet.

| ID | Steps | Expected |
|---|---|---|
| `CN-01` | As Rep A, name `qa-echo`, **Connector**. | "Connector answered 200". |
| `CN-02` | As Rep A, name `qa-echo`, **Saved key**. | "Saved key answered 200" (a saved key and a connector with the same name share one rule). |
| `CN-03` | As Rep A, name `other`, **Connector**, then **Saved key**. | Both: "Error: not_allowed You can't use other in this app." |
| `CN-04` | As Rep A, **Gemini**. | "Error: not_allowed You can't use gemini in this app." |
| `CN-05` | As Owner, **Connector** and **Gemini**. | "Connector answered 200" and "Gemini answered" (Gemini Blocked if Owner has no Gemini key). |
| `CN-06` | As Editor, **Connector**. | "Connector answered 200". |
| `CN-07` | As Owner, open Rules sheet's page, Activity. | Rep A's refused calls in CN-03 and CN-04 aren't listed as connector calls (they never reached the service). CN-01's call is listed. |

## 8. Apps whose rules don't name services

| ID | Steps | Expected |
|---|---|---|
| `EX-01` | In Old sheet, as Rep A, read `Leads!A1:C10`, then add `[["Kim","new","x@example.com"]]` to `Leads!A:C`. | Works as before access rules: every row, and the row is added with any email. |
| `EX-02` | As Owner, upload a new version of Old sheet with the unchanged test app and the same `formelab.json`. | It publishes; no refusal dialog. |
| `EX-03` | In Quiet sheet, as Rep A, read `Leads!A1:C10`, then **Connector**. | Both: "Error: not_allowed You can't use …". (A new app's rules must name the service, even when the publish check missed the call.) |
| `EX-04` | In Quiet sheet, as Owner, read `Leads!A1:C10`. | Every row: the owner always can. |

## 9. Phone width, keyboard and screen reader

These check Formelab's own screens touched by this change, not the test app.

| ID | Steps | Expected |
|---|---|---|
| `PH-01` | At phone size (390 × 844), upload `no-sources.zip` as a new app. | The refusal dialog fits the screen with a gap on both sides. The prompt wraps inside its box; nothing scrolls sideways. Both buttons are visible without zooming. |
| `PH-02` | Click **Copy prompt**. | Toast "Prompt copied", readable below the dialog. |
| `PH-03` | At phone size, upload `bad-id.zip`. | The error message under the form wraps and is fully readable; nothing scrolls sideways. |
| `KB-01` | Using only the keyboard, upload `no-sources.zip` and press Enter on **Publish**. | The refusal dialog opens and focus moves into it. |
| `KB-02` | Press Tab repeatedly, then Escape. | Focus moves through ×, Close and Copy prompt with a visible focus ring, and stays inside the dialog. Escape closes it and focus returns to the page. |
| `KB-03` | With VoiceOver (Mac) or NVDA (Windows), open the refusal dialog. | Announced as a dialog named "This app can't be published yet", followed by "It uses Google Sheets and connected services, but its access rules don't say who can use them." |

## 10. Light and dark mode

| ID | Steps | Expected |
|---|---|---|
| `TH-01` | In light mode, open the refusal dialog from RV-01 and the error from RV-03. | Readable text, the prompt box has a visible border and background, Copy prompt is the filled (main) button. |
| `TH-02` | Switch the system (or Formelab's theme) to dark, repeat. | The same, in dark colors: no white boxes, no dark text on dark backgrounds. |

## 11. Regression checks

| ID | Steps | Expected |
|---|---|---|
| `RG-01` | Run [Access rules inside apps](/test-plans/2026-11-22-access-rules-in-apps) cases RD-03, WR-03 and NR-02. | Same results as that plan: `formelab.kv` rules are unchanged. |
| `RG-02` | Upload a new app that saves data and has no `formelab.json`. | Still refused with "This app can't be published yet" and the kinds of records found. |
| `RG-03` | Open the page of an older app that saves data without rules. | Still shows "No access rules." with Add rules. |
| `RG-04` | In an older app with no `formelab.json` that uses Sheets, as a person it's shared with, read and add a row. | Works as before. Structural changes (`batchUpdate`) still fail with `sheets_editors_only`. |
| `RG-05` | Open `/guide#access-rules`. | The Access rules section has a "Connected services" part with a `sources` example. The Google Sheets and connectors sections point to it. |

## 12. How to report

Finish with a summary, then one block per failure.

```
Summary
  Passed: N   Failed: N   Blocked: N
  Browsers and devices covered: …

Failure
  Case: SR-03
  Signed in as: Rep A
  Where: Chrome 131, macOS, 1440 wide, light mode
  Steps: what you did, exactly
  Expected: from the plan
  Actual: what happened
  Console: any errors, copied
  Screenshot: attached
  Severity: blocker | major | minor | cosmetic

Blocked
  Case: CN-05
  Missing: Owner has no Gemini key
```

Severity guide: **blocker** shows a person a row their role may not read, lets them add or change a row that isn't theirs, lets a role use a service the rules don't give it, or stops the owner or editors using everything. **Major** is a wrong result with a workaround, or a refusal of something the rules allow. **Minor** is a small wrong behavior or an unclear message. **Cosmetic** is looks only.
