# Connector pages and custom connectors: test plan

Hands-on browser test plan for connector pages and custom connectors. It covers:
- **Connected apps page:** grouped into Connected and More to connect, with **+ Custom connector**.
- **Connector pages:** each connector has its own page (`/connected/<name>`) that lists the apps using it. This replaces "Where they're used".
- **Custom connectors:** for any service with an API key.
- **Apps opt in:** an app uses a connector, Gemini included, only once it's built to.
- **Moving saved keys:** saved keys can move into connectors.

Everything is behind the `connected_apps` feature. Written to hand to Claude Cowork.

## 1. Instructions for the tester

- **Order and IDs:** work through every case in order. Each case has an ID (for example `CC-03`), steps, and the expected result.
- **Marking results:** mark each case **Pass**, **Fail** or **Blocked**. For every Fail, record what happened instead, the browser and screen size, and a screenshot.
- **Test data only:** use only the test accounts and the test space below. Never delete or change a connector, key or app outside the test space. Never paste a real production API key: use the test keys below.
- **Toasts:** "Toast" means the short message that appears at the bottom of the screen after an action.
- **Reload after saving:** after any action that saves, reload the page and confirm the change stuck. A change that shows but doesn't survive a reload is a Fail.
- **Console errors:** keep the browser's developer console open. Any red error in the console is a Fail for the case you were on.
- **Blocked cases:** if a case can't be run (missing account, feature off, no Gemini key), mark it Blocked and say what's missing. Don't skip it silently.
- **Keys never show:** a key must never appear on any page, in the page source, or in an app's network responses. Seeing one is a blocker.

## 2. Setup and test data

Ramzy (or whoever hands this off) prepares these before Cowork starts.

> **Where to test:** a test deploy of this change, or locally with `wrangler dev --env dev --var DEV_USER:<email> --var SECRETS_KEK:<32 bytes of base64>`. Apply migration `0026_connectors.sql` first. Don't test on production data.

### Accounts

| Name | Notes |
|---|---|
| **Owner** | Owns the test space `qa-conn` and every test app. Has Google Gemini connected (a free key from Google AI Studio). |
| **Editor** | Editor on the test apps. |
| **Viewer** | Viewer on the test apps. |

### Feature flags (admin panel, Features)

- `connected_apps`: **off** for section 3, then **on** for everyone for the rest.

### Test service

Use `https://httpbin.org` as the "service". It echoes requests back, which shows what Formelab sent.
- **Test key:** `test-key-AAAA1111`.
- **Second test key:** `test-key-BBBB2222`.

### Test apps (all in space `qa-conn`)

| App | How to set it up | Used for |
|---|---|---|
| **Echo** | Ask Claude for a page with a button that calls `formelab.connectors.fetch("httpbin", "/anything")` and shows `res.text` | Custom connector |
| **Old echo A** and **Old echo B** | Each saves the key `test-key-AAAA1111` with `formelab.secrets.set("echo", ..., { hosts: ["httpbin.org"] })`. Each has a button that calls `formelab.secrets.proxy("echo", { url: "https://httpbin.org/anything", headers: { Authorization: "Bearer {{value}}" } })` and shows the answer | Moving saved keys |
| **Old echo C** | Like Old echo A, but saves `test-key-BBBB2222` | A key that stays |
| **AI notes** | Calls `formelab.gemini.generate()` from a button and has been pressed once before this deploy | Gemini carried over |
| **New AI** | Published after this deploy, calls `formelab.gemini.generate()`, not given `connectors` | Gemini must be declared |

## 3. With the feature off

| ID | Steps | Expected |
|---|---|---|
| `FO-01` | With `connected_apps` off, open `/connected` as Owner. | The "Coming soon" page; no tiles, no + Custom connector. |
| `FO-02` | Type `/connected/new` and `/connected/gemini` in the address bar. | "Not found" for both. |
| `FO-03` | Turn the flag on for everyone and reload `/connected`. | The new page appears without signing out. |

## 4. The Connected apps page

| ID | Steps | Expected |
|---|---|---|
| `CP-01` | Open Connected apps as Owner. | Heading "Connected apps", a line about connecting once and asking your AI, and **+ Custom connector** at the top right as the one primary button. There is no "Where they're used" section. |
| `CP-02` | Look at the Connected section. | Google Gemini (Connected) and every custom connector (Custom chip). Each tile shows how many apps use it, or "Not used yet". |
| `CP-03` | Look at More to connect. | Built-in services you haven't connected (Google Sheets if it isn't connected) with a Connect chip, and a link to make a custom connector. |
| `CP-04` | Disconnect Gemini on its page, then come back. Reconnect afterwards. | Gemini moves from Connected to More to connect, and back once reconnected. |
| `CP-05` | Click each tile. | Each opens its own page: `/connected/gemini`, `/connected/google-sheets`, `/connected/<name>`. |
| `CP-06` | As Editor (who owns no connectors), open Connected apps. | Only Editor's own connectors and connections; none of Owner's. |

## 5. Making a custom connector

| ID | Steps | Expected |
|---|---|---|
| `CC-01` | Click **+ Custom connector**. | A form: Name, What it's for (optional), Only send it to, Send it as, API key, a note that no app uses it yet, Cancel and **Create connector**. |
| `CC-02` | Type `HTTP Bin` as the name. | The hint under it reads "Apps ask for it as `http-bin`" and updates as you type. |
| `CC-03` | Change the name to `httpbin`, hosts `httpbin.org`, Send it as Bearer, key `test-key-AAAA1111`, then **Create connector**. | You land on `/connected/httpbin` with the toast "httpbin is ready. Ask your AI to use it in an app." |
| `CC-04` | Try creating another called `httpbin`. | Error: you already have a connector called httpbin. Nothing new is made. |
| `CC-05` | Try names `gemini` and `new`. | Error that the name is taken by Formelab. |
| `CC-06` | Try hosts `localhost`, then empty. | An error that it isn't an allowed host, or asking which hosts. Nothing is made. |
| `CC-07` | Choose "A header of its own" and leave the header empty, then submit. | A Header field appears when you pick it, and the form asks for the header name. |
| `CC-08` | Press Create with no key. | The form asks for the key. |
| `CC-09` | View the page source of the new connector's page, and its network responses. | The key appears nowhere; only "ending in …1111". |

## 6. A connector's page

| ID | Steps | Expected |
|---|---|---|
| `PG-01` | Open `/connected/httpbin` before any app uses it. | Its logo, name, Custom chip and description; "No app uses httpbin yet" with an example of what to ask your AI; How apps use it, with a code sample; Settings; Key; Recent activity ("You made this connector"); Delete connector at the bottom. |
| `PG-02` | Change "What it's for" and click away. | Toast "Saved". Reload: the change stuck. Recent activity says you changed its description. |
| `PG-03` | Change Only send it to `httpbin.org, *.httpbin.org` and click away. | Saved. The hosts stick after reload. |
| `PG-04` | Change Send it as to "A header of its own", type `X-Api-Key`, click away. Change it back to Bearer afterwards. | Saves only once the header name is typed. Reload: it stuck. |
| `PG-05` | Paste `test-key-BBBB2222` into Key and press **Replace key**. | The page reloads with "Key replaced". The hint now ends in …2222. Activity says you replaced the key. Put `test-key-AAAA1111` back afterwards. |
| `PG-06` | The breadcrumb "Connected apps" link. | Goes back to the Connected apps page. |

## 7. Apps are built to use connectors

| ID | Steps | Expected |
|---|---|---|
| `AP-01` | Open Echo and press its button before it lists the connector. | An error that this app wasn't built to use httpbin. Nothing is sent. |
| `AP-02` | Ask Claude to "let Echo use the httpbin connector". | Claude sets Echo's connectors with update_site. Echo's Connected apps tab now lists httpbin, Connected, "Only sent to httpbin.org, with your key". |
| `AP-03` | Press Echo's button. | The answer shows httpbin's echo with `"Authorization": "Bearer [redacted]"`. The key never shows. |
| `AP-04` | Back on `/connected/httpbin`. | Apps that use it lists Echo, linked to its settings, with "1 request" and "Last used just now". The tile on Connected apps says "1 app uses it". |
| `AP-05` | Echo's Activity tab. | "Called httpbin.org with the connector httpbin (HTTP 200)". |
| `AP-06` | As Editor, ask Claude to add httpbin to an app. | Refused: only the app's owner can add httpbin to this app. |
| `AP-07` | As Viewer, open Echo and press its button. | It works for the viewer, on the owner's key. |
| `AP-08` | Ask Claude to call a connector name that doesn't exist on an app. | Claude's update is refused: it isn't one of the owner's connectors. |

## 8. Removing a connector from an app

| ID | Steps | Expected |
|---|---|---|
| `RM-01` | On Echo's Connected apps tab as Owner. | The httpbin row has **Open** (goes to `/connected/httpbin`) and **Remove**. |
| `RM-02` | As Editor, open Echo's Connected apps tab. | The row shows, but with no Open or Remove. |
| `RM-03` | As Owner, click Remove and cancel the confirm. | Nothing changes. |
| `RM-04` | Click Remove and confirm. | Toast "httpbin removed from this app". The row disappears and the tab's count drops. Reload: still gone. Echo's button now fails as in AP-01. Activity: "Stopped it using httpbin". Add it back with Claude afterwards. |

## 9. Google Gemini

| ID | Steps | Expected |
|---|---|---|
| `GE-01` | Open `/connected/gemini`. | Connected with your key ending in its last 4 characters, the model name, Apps that use it with call counts, Use (calls in 30 days, today against the daily limit), Daily limit, Replace the key, and Disconnect at the bottom. |
| `GE-02` | AI notes (used Gemini before this deploy). | Listed under Apps that use it, and its button still works with no changes. |
| `GE-03` | Press New AI's button. | An error that this app wasn't built to use Google Gemini, with a hint to add it. |
| `GE-04` | Ask Claude to let New AI use Gemini, then press the button. | It works, and New AI joins Apps that use it. |
| `GE-05` | Remove Gemini from AI notes on its Connected apps tab, then press its button. Add it back afterwards. | Refused like GE-03. |
| `GE-06` | Change the daily limit and press Save. | "Daily limit saved." It sticks after reload. |

## 10. Google Sheets

| ID | Steps | Expected |
|---|---|---|
| `GS-01` | Open `/connected/google-sheets` with Sheets connected. | Connected as the Google account, Apps that use it (each with its number of spreadsheets, linked to its Connected apps tab), Reconnect with Google and Disconnect. |
| `GS-02` | Connect or reconnect with Google. | Google's sign-in comes back to `/connected/google-sheets` with "Connected. Your apps can use your Google Sheets now." |
| `GS-03` | Cancel in Google's sign-in. | Back on the page with "You didn't allow access in Google, so nothing was connected." |

## 11. Turning saved keys into connectors

| ID | Steps | Expected |
|---|---|---|
| `MV-01` | With Old echo A, B and C set up, open Connected apps. | A box "Turn your saved keys into connectors" naming `echo` (Old echo A, Old echo B), and saying one stays: echo in Old echo C. |
| `MV-02` | Press **Turn them into connectors**. | The page reloads with "Done. echo is a connector now." An `echo` tile appears saying 2 apps use it, and the box is gone. |
| `MV-03` | Press the buttons in Old echo A and B. | They still work with no changes, sending `test-key-AAAA1111`. |
| `MV-04` | Press Old echo C's button. | Still works with its own key, `test-key-BBBB2222`. Its Connected apps tab still lists echo as a saved key. |
| `MV-05` | Open `/connected/echo`. | Old echo A and B under Apps that use it; Send it as "The app puts it in with {{value}}"; activity "You turned the saved keys of 2 apps into this connector". |
| `MV-06` | In Old echo A, run `formelab.secrets.set("echo", "x", { hosts: ["httpbin.org"] })` from the console. | Refused: echo is one of the owner's connectors, with a hint to replace it on Connected apps. |

## 12. Deleting a connector

| ID | Steps | Expected |
|---|---|---|
| `DL-01` | On `/connected/httpbin`, read the Delete section. | It names the apps that can't reach it after deleting. |
| `DL-02` | Press **Delete httpbin** and cancel. | Nothing changes. |
| `DL-03` | Press it again and confirm. | You land on Connected apps with "httpbin deleted". The tile is gone; Echo's Connected apps tab no longer lists it; Echo's button fails. `/connected/httpbin` says "Not found". |

## 13. Keyboard, phone, screen reader and themes

| ID | Steps | Expected |
|---|---|---|
| `KB-01` | Using only the keyboard, make a connector, change a setting, replace its key and delete it. | Everything is reachable with Tab; tiles show a visible focus ring; Enter opens them and submits forms. |
| `KB-02` | Connected apps at phone width (390) in light and dark mode. | **+ Custom connector** spans the width; tiles are two to a row with name, chip and app count; the page doesn't scroll sideways. |
| `KB-03` | A connector's page at phone width, in both modes. | Sections stack (apps, settings, delete); fields are full width; the code sample scrolls inside its box, not the page. |
| `KB-04` | The custom connector form at phone width. | Fields stack one per row; Cancel and Create connector stay visible. |
| `KB-05` | A screen reader on Connected apps and a connector's page. | Tiles read as name, state, description; the breadcrumb is announced as navigation; form fields have their labels. |
| `KB-06` | Check all UI text on the new pages. | No em dashes anywhere. |

## 14. Regression checks

| ID | Steps | Expected |
|---|---|---|
| `RG-01` | Run phase 3 cases `SH-01` to `SH-11` (spreadsheets on an app's tab) and `KY-01` to `KY-09` (saved keys). | Still pass. |
| `RG-02` | Apps using `formelab.secrets.proxy` with saved keys that weren't moved. | Work as before. |
| `RG-03` | Make it with Gemini on New app, with the `app_builder` feature on. | Still uses the same Gemini key; `/connected/gemini` mentions it. |
| `RG-04` | Run phase 1 cases `TB-01` to `TB-04` (the app page's tabs). | Still pass. |

## 15. How to report

Finish with a summary, then one block per failure.

```
Summary
  Passed: N   Failed: N   Blocked: N
  Browsers and devices covered: ...

Failure
  Case: CC-03
  Where: Chrome 131, macOS, 1440 wide, dark mode
  Steps: what you did, exactly
  Expected: from the plan
  Actual: what happened
  Console: any errors, copied
  Screenshot: attached
  Severity: blocker | major | minor | cosmetic

Blocked
  Case: GE-01
  Missing: no Gemini key on the test account
```

Severity guide:
- **Blocker:** stops an app working, shows a key anywhere, or lets someone use or change another person's connector.
- **Major:** a wrong result with a workaround.
- **Minor:** a small wrong behavior.
- **Cosmetic:** looks only.
