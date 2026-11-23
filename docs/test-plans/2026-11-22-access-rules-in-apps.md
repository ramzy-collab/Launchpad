# Access rules inside apps: test plan

Hands-on browser test plan for access rules applied to `formelab.kv` inside apps, step 3 of the [agent access spec](../specs/2026-11-22-agent-access.md). Written to hand to Claude Cowork. Each case is run in the browser, in a small test app that shows what the signed-in person can see and lets them save and delete records, so the rules can be checked person by person.

## 1. Instructions for the tester

- Work through every case in order. Each case has an ID (for example `RD-04`), steps, and the expected result.
- Mark each case **Pass**, **Fail** or **Blocked**. For every Fail, record what happened instead, which account you were signed in as, the browser and screen size, and a screenshot.
- Only use the test accounts and the test apps below. Never open, change or delete data in an app outside the test space.
- Use a separate browser profile (or a private window) for each account, so you're signed in as the right person. The test app shows who you are at the top: check it before each case.
- After every save or delete, press **Refresh** in the test app, then reload the page, and check the list again. A change that shows but doesn't survive a reload is a Fail.
- Keep the browser's developer console open. Any red JavaScript error is a Fail for the case you were on. **One exception:** a refused save or delete logs a failed request ("… 403" or "… 401"). That's the refusal itself. Any other red line is a Fail.
- If a case can't be run (missing account, no public link), mark it Blocked and say what's missing. Don't skip silently.

## 2. Setup and test data

Ramzy (or whoever hands this off) prepares these before Cowork starts.

> **Where to test:** deploy the PR branch to a test Formelab and run its migrations first (`npm run db:migrate:remote` against the test database), or run it locally: `npm run db:migrate:local`, then `wrangler dev --env dev --var DEV_USER:<email>`. Local testing signs in one person only, so a test deploy is needed for the cases with several accounts. Don't test on production data.

### Accounts

| Name | Role on the test apps | Notes |
|---|---|---|
| **Owner** | Owns the space `qa` and every test app | |
| **Editor** | Editor of "Rules CRM" | Has a Formelab account |
| **Rep A** | In the share list of "Rules CRM" and "Open board" | Has a Formelab account |
| **Rep B** | In the share list of "Rules CRM" | Has a Formelab account |
| **Guest** | Not signed in | A private window, opening the public link |

### The test app

Save this as `index.html`. It shows who you are, lists every record you can see, and saves or deletes one.

```html
<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Rules test</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'%3E%3Ccircle cx='5' cy='5' r='5' fill='%235B4CF5'/%3E%3C/svg%3E">
<script src="/_platform/sdk.js"></script>
<style>body{font:16px system-ui;margin:16px;max-width:640px}input,textarea{width:100%;box-sizing:border-box;font:inherit;margin:4px 0 8px}pre{background:#f2f2f2;padding:8px;white-space:pre-wrap}#out{font-weight:600}</style></head>
<body><p>Signed in as: <span id="me">…</span></p>
<h2>Records you can see</h2><button id="refresh">Refresh</button><pre id="list"></pre>
<h2>Save or delete a record</h2>
<label>Key <input id="key" placeholder="lead:1"></label>
<label>Value (JSON) <textarea id="value" rows="3" placeholder='{"name":"Ada","assignedTo":"rep-a@example.com"}'></textarea></label>
<button id="save">Save</button> <button id="get">Read</button> <button id="del">Delete</button>
<p id="out" role="status"></p>
<script>
const $ = (id) => document.getElementById(id);
const say = (t) => { $("out").textContent = t; };
async function refresh() {
  try { const rows = await formelab.kv.list(); $("list").textContent = rows.map((r) => r.key + "  " + JSON.stringify(r.value)).join("\n") || "(nothing)"; }
  catch (e) { $("list").textContent = "Error: " + e.message; }
}
$("refresh").onclick = refresh;
$("save").onclick = async () => { try { await formelab.kv.set($("key").value, JSON.parse($("value").value)); say("Saved"); } catch (e) { say("Error: " + (e.code || "") + " " + e.message); } refresh(); };
$("get").onclick = async () => { try { say("Read: " + JSON.stringify(await formelab.kv.get($("key").value))); } catch (e) { say("Error: " + (e.code || "") + " " + e.message); } };
$("del").onclick = async () => { try { await formelab.kv.delete($("key").value); say("Deleted"); } catch (e) { say("Error: " + (e.code || "") + " " + e.message); } refresh(); };
formelab.me().then((m) => { $("me").textContent = m ? m.email : "a guest (public link)"; });
refresh();
</script></body></html>
```

### Test apps (space `qa`)

Each is a zip with the test app's `index.html` and a `formelab.json`. Replace the example emails with Rep A's and Rep B's real ones where data uses them.

| App | Path | `formelab.json` | Then |
|---|---|---|---|
| **Rules CRM** | `rules-crm` | `{"default_role":"rep","records":{"lead":{"prefix":"lead:","fields":["name","assignedTo"],"owner_field":"assignedTo","read":{"rep":"own"},"write":{"rep":"own"}},"settings":{"prefix":"settings","read":{"rep":"all","guest":"all"}}}}` | Share with Rep A and Rep B, add Editor. Turn on its public link. |
| **Open board** | `open-board` | `{ "everyone": "all" }` | Share with Rep A. Leave "data_writes" as it was made (only editors). |
| **No rules** | `no-rules` | None: upload `index.html` alone after changing `formelab.kv` to `formelab["kv"]` everywhere in it, so the publish check doesn't see it | It publishes without rules. |

Then, signed in as **Owner** in Rules CRM, save these records with the test app:

| Key | Value |
|---|---|
| `lead:1` | `{"name":"Ada","assignedTo":"<Rep A's email>"}` |
| `lead:2` | `{"name":"Bo","assignedTo":"<Rep B's email>"}` |
| `lead:3` | `{"name":"Cy","assignedTo":"<Rep A's email in CAPITALS>"}` |
| `settings` | `{"theme":"dark"}` |
| `secret` | `"only for owner and editors"` |

## 3. Reading

| ID | Steps | Expected |
|---|---|---|
| `RD-01` | As Owner, open Rules CRM. | The list shows all five records: lead:1, lead:2, lead:3, secret, settings. |
| `RD-02` | As Editor, open Rules CRM. | The same five records. |
| `RD-03` | As Rep A, open Rules CRM. | The list shows lead:1, lead:3 and settings only. lead:3 is there although its email is in capitals. |
| `RD-04` | As Rep B, open Rules CRM. | lead:2 and settings only. |
| `RD-05` | As Rep A, type `lead:2` in Key and press **Read**. | "Read: null", the same as for a key that doesn't exist. No error. |
| `RD-06` | As Rep A, read `secret`. | "Read: null". (No rule covers it, so it's only for the owner and editors.) |
| `RD-07` | As Rep A, read `lead:1`. | "Read: {"name":"Ada",…}". |

## 4. Writing

| ID | Steps | Expected |
|---|---|---|
| `WR-01` | As Rep A, save key `lead:9`, value `{"name":"Dee","assignedTo":"<Rep A's email>"}`. | "Saved". After Refresh and a reload, lead:9 is in Rep A's list. As Rep B, it isn't. As Owner, it is. |
| `WR-02` | As Rep A, save `lead:9` again with `"name":"Dee 2"`. | "Saved". The new name shows. |
| `WR-03` | As Rep A, save `lead:9` with `"assignedTo":"<Rep B's email>"`. | "Error: not_allowed You can only save records with your own email in "assignedTo"." lead:9 is unchanged. |
| `WR-04` | As Rep A, save `lead:2` with Rep A's own email in assignedTo. | "Error: not_allowed You can't change this record." As Owner, lead:2 still belongs to Rep B. |
| `WR-05` | As Rep A, delete `lead:2`. | "Error: not_allowed You can't change this record." lead:2 still exists (check as Owner). |
| `WR-06` | As Rep A, save `settings` with `{"theme":"light"}`. | "Error: not_allowed …". Settings is unchanged. (Reps may read settings but not change them.) |
| `WR-07` | As Rep A, save `secret`. | "Error: not_allowed …". |
| `WR-08` | As Rep A, delete `lead:9`. | "Deleted". It's gone for everyone. |
| `WR-09` | As Editor, save `lead:2` with Editor's email in assignedTo, then delete `secret`. | Both work. (Restore `secret` as Owner afterwards.) |

## 5. Public link visitors

In a private window, open Rules CRM's public link.

| ID | Steps | Expected |
|---|---|---|
| `GU-01` | Look at the top and the list. | "Signed in as: a guest (public link)". The list shows settings only. |
| `GU-02` | Read `lead:1`. | "Read: null". |
| `GU-03` | Save `settings` with any value. | "Error: sign_in_required …". Guests can't save anything, whatever the rules say. |

## 6. The one-line rule

| ID | Steps | Expected |
|---|---|---|
| `OP-01` | As Rep A, open Open board and save key `vote:a`, value `"pizza"`. | "Saved". (Its rules let everyone write, even though it was made with only editors allowed to change data.) |
| `OP-02` | As Owner, open Open board. | vote:a is listed. |
| `OP-03` | As Owner, open Open board's settings page, Sharing tab. | Under "What they can do", no switch for "Viewers can add and change the app's data". Instead: "Who can add and change the app's data. This app's access rules (formelab.json) decide it, for each kind of record. You, Editors and Admins can always change everything." |
| `OP-04` | Open the settings page of an app without rules (for example any older app in the test space). | The switch "Viewers can add and change the app's data" is there and works as before. |

## 7. New apps without rules

| ID | Steps | Expected |
|---|---|---|
| `NR-01` | As Owner, open No rules. | The list shows "Error: This app can't use saved data or connected services until it has access rules." |
| `NR-02` | Save any record. | "Error: rules_required This app can't use saved data or connected services until it has access rules." |
| `NR-03` | Upload a new version of No rules as a zip with `formelab.json` = `{ "everyone": "all" }` (from its page). Reload the app. | The list shows "(nothing)" and saving works. |

## 8. Older apps

| ID | Steps | Expected |
|---|---|---|
| `OL-01` | Open an app in the test space made before access rules that saves data (ask Ramzy for one, or make it the way the [No access rules warning](/test-plans/2026-11-22-access-rules-warning) plan does). As a person it's shared with, use it. | Works exactly as before: they see all its shared data, and can change it only if its "Viewers can add and change the app's data" switch is on. |

## 9. Phone width, keyboard and screen reader

These check Formelab's own screens touched by this change, not the test app.

| ID | Steps | Expected |
|---|---|---|
| `PH-01` | At phone size (390 × 844), open Open board's settings page, Sharing tab. | The note about access rules wraps neatly in the "What they can do" area; nothing scrolls sideways. |
| `KB-01` | On the same page, Tab through "What they can do". | Focus skips the note (it isn't a control) and moves on to the next switch or section. |
| `KB-02` | With VoiceOver or NVDA, read "What they can do". | The note is read as "Who can add and change the app's data", then its explanation. |

## 10. Light and dark mode

| ID | Steps | Expected |
|---|---|---|
| `TH-01` | Look at the note on Open board's settings page in light mode, then dark mode. | Readable in both, styled like the other rows in "What they can do". |

## 11. Regression checks

| ID | Steps | Expected |
|---|---|---|
| `RG-01` | In any app, as anyone, use `formelab.kv.mine` (for example a draft or preference the app saves per person). | Works as before, in apps with and without rules: each person's own data isn't affected. |
| `RG-02` | Ask Claude (with the Formelab connector, as Owner) "what records are in Rules CRM?". | It lists all records, secret included: the connector's data tools are for owners and editors, who see everything. |
| `RG-03` | New app: upload a new app that saves data without rules. | Still refused at upload with "This app can't be published yet". |
| `RG-04` | An older app's page that saves data without rules. | Still shows "No access rules." with Add rules. |

## 12. How to report

Finish with a summary, then one block per failure.

```
Summary
  Passed: N   Failed: N   Blocked: N
  Browsers and devices covered: …

Failure
  Case: RD-03
  Signed in as: Rep A
  Where: Chrome 131, macOS, 1440 wide, light mode
  Steps: what you did, exactly
  Expected: from the plan
  Actual: what happened
  Console: any errors, copied
  Screenshot: attached
  Severity: blocker | major | minor | cosmetic

Blocked
  Case: GU-01
  Missing: the public link isn't on
```

Severity guide: **blocker** shows a person a record their role may not read, lets them change one they may not change, or stops the owner or editors seeing or changing everything. **Major** is a wrong result with a workaround. **Minor** is a small wrong behavior. **Cosmetic** is looks only.
