# Settings redesign, phase 3: test plan

Hands-on browser test plan for phase 3 of the app settings redesign: the Connected apps tab on each app's page (Google Gemini, Google Sheets and saved keys), "Used by" on the Connected apps page, and hiding all of it while the `connected_apps` feature is off. Written to hand to Claude Cowork.

## 1. Instructions for the tester

- Work through every case in order. Each case has an ID (for example `SH-03`), steps, and the expected result.
- Mark each case **Pass**, **Fail** or **Blocked**. For every Fail, record what happened instead, the browser and screen size, and a screenshot.
- Only use the test accounts and the test space below. Never remove keys, spreadsheets or connections on an app outside the test space, and never disconnect a real Google account other apps rely on.
- "Toast" means the short message that appears at the bottom of the screen after an action.
- After any action that saves, reload the page and confirm the change stuck. A change that shows but doesn't survive a reload is a Fail.
- Keep the browser's developer console open. Any red error in the console is a Fail for the case you were on.
- If a case can't be run (missing account, feature off, no Google account to connect), mark it Blocked and say what's missing. Don't skip silently.

## 2. Setup and test data

Ramzy (or whoever hands this off) prepares these before Cowork starts.

> **Where to test:** a test deploy of this change, or locally with `wrangler dev --env dev --var DEV_USER:<email>` (add `--var SECRETS_KEK:<32 bytes of base64>` so keys can be saved). Don't test on production data.

### Accounts

| Name | Notes |
|---|---|
| **Owner** | Owns the test space `qa3` and every test app. Has Google Gemini connected (a free key from Google AI Studio) and Google Sheets connected (a test Google account). |
| **Editor** | Editor on the test apps. |
| **Viewer** | Viewer on the test apps. |

### Feature flags (admin panel, Features)

- `connected_apps`: **off** for section 3, then **on** for everyone for the rest (or on for Owner, Editor and Viewer by name).

### Test apps (all in space `qa3`)

| App | How to set it up | Used for |
|---|---|---|
| **AI notes** | Calls `formelab.gemini.generate()` when you press a button; press it once | Gemini |
| **Tracker** | Uses `formelab.sheets`; list one test spreadsheet for it (Google Sheets link) | Sheets |
| **Inbox** | Saves two keys with `formelab.secrets.set`: `quo` for `api.quo.com` and `stripe` for `api.stripe.com` | Saved keys |
| **Blank** | Uses none of these | Empty state |

## 3. With the feature off

| ID | Steps | Expected |
|---|---|---|
| `FL-01` | With `connected_apps` off, open any page of the web app as Owner. | The left menu has no "Connected apps" link (and no "Soon" badge). |
| `FL-02` | Open Inbox's settings. | Tabs are Sharing, Update, Activity. No Connected apps tab. |
| `FL-03` | Type `/connected` in the address bar. | The "Coming soon" page; nothing about your apps. |
| `FL-04` | Turn the flag on for everyone and reload. | The menu link and the tab appear without signing out. |

## 4. The tab

| ID | Steps | Expected |
|---|---|---|
| `CA-01` | Open Inbox's settings. | Tabs read Sharing, Connected apps, Update, Activity. Connected apps shows a count (2 for Inbox). |
| `CA-02` | Open the tab. | Heading "Connected to this app" and "Services this app can use. To connect a new one, go to Connected apps." with a working link. The address ends in `#connected`; reloading reopens it. |
| `CA-03` | Open Blank's Connected apps tab. | Count 0 and "Nothing connected yet. Connect AI, spreadsheets or other services on the Connected apps page, then let this app use them." with a link. |
| `CA-04` | Use the left and right arrow keys on the tab row. | Moves through all four tabs, including Connected apps. |

## 5. Google Gemini

| ID | Steps | Expected |
|---|---|---|
| `GM-01` | Open AI notes' tab. | A Google Gemini row with "Connected", "AI that writes, sorts and summarizes inside this app, with your Gemini key. Last used …", and "Every one of your apps can use it. Disconnect it on Connected apps." No Remove button. |
| `GM-02` | Open Inbox's tab (never called Gemini). | No Gemini row. |
| `GM-03` | As Editor, open AI notes' tab. | The row names the owner's key ("… with owner's Gemini key"). |
| `GM-04` | Disconnect Gemini on the Connected apps page, then reopen AI notes' tab. Reconnect afterwards. | The row says "Not connected" and that the app can't use Gemini until it's connected again. |

## 6. Google Sheets

| ID | Steps | Expected |
|---|---|---|
| `SH-01` | Open Tracker's tab. | A Google Sheets row with "Connected", "Reads and adds rows to the spreadsheets listed here, with your Google account, and nothing else in your Drive.", the spreadsheet as a link, a Remove button and "+ Add a spreadsheet". |
| `SH-02` | Click the spreadsheet link. | It opens that spreadsheet in Google Sheets in a new tab. |
| `SH-03` | Click "+ Add a spreadsheet", paste another spreadsheet's link and press "Add it". | Toast "Spreadsheet added. This app can read and add rows to it." It appears in the list. Reload: still there. The app can now read it. |
| `SH-04` | Try adding `hello` or a Google Docs link. | Error toast that it doesn't look like a Google Sheets link. Nothing is added. |
| `SH-05` | Remove a spreadsheet. | Toast "Spreadsheet removed. This app can't reach it any more." Gone after reload; the app can no longer read it. |
| `SH-06` | Remove the last spreadsheet. | The page reloads with the toast "Spreadsheet removed. This app doesn't use Google Sheets any more." The Google Sheets row is gone and the count on the tab goes down by one. |
| `SH-07` | As Editor, open Tracker's tab. | The list shows with links, but no Remove buttons and no "+ Add a spreadsheet" (only the owner chooses, since it's their Google account). |
| `SH-08` | Open Blank's tab as Owner (with Sheets connected). | No Google Sheets row, no Google Sheets button, and a count of 0: Blank doesn't use Sheets. Only "Nothing connected yet." shows. |
| `SH-10` | Ask Claude to make Blank save to a Google spreadsheet, then reopen its tab. | A Google Sheets row now lists that spreadsheet, and the count is 1. |
| `SH-11` | Open several apps that don't use Google Sheets. | None of them shows a Google Sheets row, whether or not your Google Sheets is connected. |
| `SH-09` | Disconnect Google Sheets, then open Tracker's tab. Reconnect afterwards. | "Not connected" and a note that the app can't reach these spreadsheets until it's connected. |

## 7. Saved keys

| ID | Steps | Expected |
|---|---|---|
| `KY-01` | Open Inbox's tab. | Rows "quo" and "stripe", each with "Key saved" and "Only ever sent to api.quo.com, never shown in the app or to people you share it with." (or api.stripe.com), with Replace key and Remove. The key itself never appears anywhere on the page or in its source. |
| `KY-02` | Click Replace key on quo, then Cancel. | The field opens and closes; nothing changes. |
| `KY-03` | Replace key on quo with a new value and press Save key. | Toast "Key replaced. quo uses the new one from now on." The app uses the new key from its next call, still only to api.quo.com. |
| `KY-04` | Press Save key with the field empty. | Error toast asking for the new key. |
| `KY-05` | Click Remove on stripe. | A dialog "Remove the key stripe?" explaining the app can't use it any more. "Keep it" and Esc close it with no change. |
| `KY-06` | Confirm Remove. | Toast "stripe removed". The row disappears, the count goes down, and it's gone after reload. Anything in the app needing it now fails. |
| `KY-07` | As Editor, replace and remove a key on Inbox. | Both work (editors manage an app's keys). |
| `KY-08` | As Viewer, try the key buttons (or call `PUT /_api/admin/sites/<id>/keys/quo` in the console). | Viewers don't see the settings page at all; the API call is refused. |
| `KY-09` | Check Inbox's Activity tab. | "You saved the secret quo" (for the replaced key) and "You removed the secret stripe". |

## 8. The Connected apps page

| ID | Steps | Expected |
|---|---|---|
| `UB-01` | Open Connected apps. | Under the service tiles, "Where they're used" lists Google Gemini, Google Sheets and each saved key by name. |
| `UB-02` | Read each row. | Gemini: "Used by AI notes". Sheets: "Used by Tracker". quo: "Used by Inbox". Each app name links to its settings page. A service nothing uses says "Not used by any of your apps yet". |
| `UB-03` | Click an app name. | Opens that app's settings. |
| `UB-04` | Save a key named `quo` on a second test app too, then reload. | The quo row lists both apps. |
| `UB-05` | As Editor (who owns none of the apps), open Connected apps. | Only Editor's own apps are listed; the owner's apps never appear here. |

## 9. Keyboard, phone and themes

| ID | Steps | Expected |
|---|---|---|
| `KB-01` | Using only the keyboard, add a spreadsheet, replace a key and remove a key. | Everything is reachable with Tab; Enter submits; Esc closes the remove dialog; focus is always visible. |
| `KB-02` | Open the tab at phone width (390) in light and dark mode. | Rows stack, buttons wrap under the text, links don't break mid-word, and the page doesn't scroll sideways. |
| `KB-03` | Screen reader on the tab. | Rows read as name, status, description; buttons have clear names; the remove dialog is announced. |

## 10. Regression checks

| ID | Steps | Expected |
|---|---|---|
| `RG-01` | Connect and disconnect Gemini and Google Sheets from their dialogs on the Connected apps page. | Works as before. |
| `RG-02` | Apps using Gemini, Sheets and keys keep working after this deploy, without changes. | No change in behavior: nothing here limits what apps could already use. |
| `RG-03` | Run phase 1 cases `TB-01` to `TB-04` (tabs) and phase 2 cases `ST-01` to `ST-05`. | Still pass. |

## 11. How to report

Finish with a summary, then one block per failure.

```
Summary
  Passed: N   Failed: N   Blocked: N
  Browsers and devices covered: ...

Failure
  Case: SH-03
  Where: Chrome 131, macOS, 1440 wide, dark mode
  Steps: what you did, exactly
  Expected: from the plan
  Actual: what happened
  Console: any errors, copied
  Screenshot: attached
  Severity: blocker | major | minor | cosmetic

Blocked
  Case: GM-01
  Missing: no Gemini key on the test account
```

Severity guide: **blocker** stops an app working, or shows a saved key or another person's data to someone it shouldn't. **Major** is a wrong result with a workaround. **Minor** is a small wrong behavior. **Cosmetic** is looks only.
