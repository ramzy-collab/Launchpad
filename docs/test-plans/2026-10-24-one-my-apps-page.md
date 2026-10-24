# One My apps page: test plan

Hands-on browser test plan for merging Shared with me into My apps, written to hand to Claude Cowork. My apps now lists your own apps and the apps other people shared with you, in "Made by you" and "Shared with you" sections, with one filter button next to search that holds Owner, Space and Sort. The old `/shared` address redirects to My apps filtered to other people's apps. No data or permission changes.

## 1. Instructions for the tester

- Work through every case in order. Each case has an ID (for example `MY-04`), steps, and the expected result.
- Mark each case **Pass**, **Fail** or **Blocked**. For every Fail, record what happened instead, the browser and screen size, and a screenshot.
- Only use the test accounts and the test spaces below. Never delete, rename or change sharing on an app outside them.
- "Toast" means the short message that appears at the bottom of the screen after an action.
- After any action that saves (a star, a filter in the address), reload the page and confirm the change stuck. A change that shows but doesn't survive a reload is a Fail.
- Keep the browser's developer console open. Any red error in the console is a Fail for the case you were on.
- If a case can't be run (missing account, no second device), mark it Blocked and say what's missing. Don't skip silently.

## 2. Setup and test data

Ramzy (or whoever hands this off) prepares these before Cowork starts.

> **Where to test:** deploy the PR branch to a test Formelab, or run it locally with `npm run dev` and `wrangler dev --env dev --var DEV_USER:<email>`. Give Cowork the web app address. Don't test on production data.

### Accounts

| Name | Notes |
|---|---|
| **Tester** | The main account Cowork uses. Active (not on the waitlist). Owns the space `qa`. |
| **Maya** | Owns the space `qa-maya` and the apps in it. |
| **Jordan** | Owns the space `qa-jordan` and the apps in it. |
| **Fresh** | Active account that owns no apps, with one app shared with it ("Maya's board"). |
| **Empty** | Active account with no apps and nothing shared. |
| **Waitlisted** | On the waitlist, with "Maya's board" shared with it as a Viewer. |

No feature flags are needed.

### Test apps

| App | Owner and space | Sharing | Used for |
|---|---|---|---|
| **Solo notes** | Tester, `qa` | Nobody | "Only you" chip |
| **Lunch poll** | Tester, `qa` | Shared with 3 people | "Shared with 3" chip, starred |
| **Open house** | Tester, `qa` | Public link on | "Public" chip |
| **Maya's board** | Maya, `qa-maya` | Tester as Editor; Fresh and Waitlisted as Viewers | Editor role, starred |
| **Leasing dashboard** | Maya, `qa-maya` | Tester as Admin (Editor who can share) | Admin role |
| **Showing scheduler** | Jordan, `qa-jordan` | Tester as Viewer | Viewer role, no settings |
| **Handed over** | Tester made Jordan its owner (Make owner) | Tester stays as Admin | An app you gave away |

Star **Lunch poll** and **Maya's board** as Tester before starting.

## 3. One page for every app

Signed in as Tester, on a computer screen at least 1280px wide.

| ID | Steps | Expected |
|---|---|---|
| `MY-01` | Open the web app. | The page is titled "My apps" with the line "Apps you made, and apps other people shared with you." |
| `MY-02` | Look at the left menu. | Under Apps: "My apps" (highlighted) and "Spaces". There is no "Shared with me" link. |
| `MY-03` | Look at the page from the top. | Search, one round filter button, then "Starred", then "Made by you", then "Shared with you". No other filter controls show. |
| `MY-04` | Look at "Starred". | Lunch poll and Maya's board, one of each kind. |
| `MY-05` | Look at the "Made by you" heading. | A count of your own apps, and the line "You own these. The chip says who can open each one." Solo notes and Open house are in it; starred Lunch poll is not repeated. |
| `MY-06` | Look at the "Shared with you" heading. | A count of shared apps (including the starred one), and the line "Other people own these. The chip says what you can do." Leasing dashboard, Showing scheduler and Handed over are in it. |
| `MY-07` | Star Showing scheduler, then reload. | It moves up to Starred and stays there after the reload. A toast says it was starred. |
| `MY-08` | Unstar Showing scheduler, then reload. | It goes back to Shared with you. |
| `MY-09` | Type "board" in search. | Only Maya's board and Leasing dashboard show. Sections with no match hide. |
| `MY-10` | Search for Maya's email address. | Her apps show (search covers the owner's email on shared apps). |
| `MY-11` | Search for "zzzz". | "Nothing matches “zzzz”" with "Show all apps". Clicking it clears the search and shows everything. |
| `MY-12` | Click a card's body. | The app opens in a new tab. |

## 4. Your cards and shared cards

| ID | Steps | Expected |
|---|---|---|
| `CA-01` | Look at Solo notes, Lunch poll and Open house. | Plain icon, "qa · Updated <time>", and chips "Only you" (lock), "Shared with 3" (people) and "Public" (globe). A gear shows on each. |
| `CA-02` | Look at Maya's board. | A small yellow circle with "M" on the corner of the icon, "From <Maya's email> · <time>" under the name, and an outlined "Editor" chip with a person icon. A gear shows. |
| `CA-03` | Look at Leasing dashboard. | Owner initial on the icon, "From <Maya's email>", chip "Admin", gear shows. |
| `CA-04` | Look at Showing scheduler. | Owner initial "J", "From <Jordan's email>", chip "Viewer", and no gear. |
| `CA-05` | Look at Handed over. | It's under Shared with you, "From <Jordan's email>", chip "Admin". |
| `CA-06` | Click the gear on Maya's board. | Its settings page opens. The breadcrumb reads "My apps". Click it: My apps opens filtered to Owner: Other people. |
| `CA-07` | Click the gear on Solo notes, then the breadcrumb. | Back on My apps with no filter. |
| `CA-08` | Click the link button on a shared card, then on Open house. | Shared card: toast "Link copied". Open house: the public link is copied. |

## 5. The filter button

| ID | Steps | Expected |
|---|---|---|
| `FI-01` | Click the round filter button. | A menu opens under it with three groups: Owner (Anyone, Me, Other people), Space (All spaces, then each space), Sort (Recently changed, Newest first, Name A to Z). The defaults are selected. |
| `FI-02` | Choose Owner: Me. | Only your apps show; "Shared with you" hides. The button turns purple with a dot. The address ends in `?owner=me`. |
| `FI-03` | Choose Owner: Other people. | Only shared apps show; "Made by you" hides. The address has `?owner=others`. |
| `FI-04` | Reload the page. | The filter is still Other people, and the button still has its dot. |
| `FI-05` | Choose Space: `qa-maya`, Owner: Anyone. | Only Maya's apps show. The address has `?space=qa-maya`. |
| `FI-06` | Choose Sort: Name A to Z. | Cards in every section sort by name. The button shows its dot even with no filter set. |
| `FI-07` | Click Reset at the bottom of the menu. | Everything goes back to Anyone, All spaces, Recently changed. The dot goes, Reset hides, and the address has no `owner`, `space` or `sort`. |
| `FI-08` | Choose a space with no match for your search, for example search "lunch" with Space `qa-maya`. | "Nothing matches “lunch”" with "Show all apps", which clears the search and every filter. |
| `FI-09` | Open the menu, then click anywhere outside it. | It closes. |
| `FI-10` | Open the menu and press Escape. | It closes and focus returns to the filter button. |
| `FI-11` | Sign in as Fresh (whose only app is in one space) and open the filter button. | The Space group doesn't show, since there's only one space. Owner and Sort do. |

## 6. Old links and emails

| ID | Steps | Expected |
|---|---|---|
| `RD-01` | Open `/shared` on the web app. | It lands on My apps with Owner: Other people selected, and the address shows `/?owner=others`. |
| `RD-02` | Open `/shared` while signed out. | Sign in as usual, then land on My apps filtered to Other people. |
| `RD-03` | As Maya, share a new app with Tester. Open the email Tester gets. | It says "you'll find it under **My apps**". The plain text "Everything shared with you" link opens My apps filtered to Other people. |
| `RD-04` | As Maya, add Tester as an editor of `qa-maya`. Open the email. | It says the apps "appear under **My apps**". "See shared apps" opens My apps filtered to Other people; the "Its apps" link opens My apps filtered to the `qa-maya` space. |
| `RD-05` | On an app's People list, read the line under the heading. | "They'll find it under My apps." |
| `RD-06` | As Tester, make Jordan the owner of a test app (Make owner). | The message after the reload says it's still under My apps, as shared with you. The app shows under Shared with you with "Admin". |
| `RD-07` | Install Formelab on a phone (Get the app) and long-press its icon. | Shortcuts: New app, My apps, and "Shared with me", which opens My apps filtered to Other people. |

## 7. Empty and waitlisted

| ID | Steps | Expected |
|---|---|---|
| `EM-01` | Sign in as Empty. | "What do you want to make?" with "+ New app". No filter button. |
| `EM-02` | Sign in as Fresh. | Made by you shows "Nothing yet. Describe an app to your AI and it lands here, live." with "+ New app". Maya's board is under Shared with you, as "Viewer". |
| `EM-03` | As Fresh, choose Owner: Me. | "Nothing matches these filters" with "Show all apps". |
| `EM-04` | As Tester, temporarily remove every share with Tester (or use an account with own apps and nothing shared), then choose Owner: Other people. | "Nothing shared with you yet" with "When someone adds your email to one of their apps, it shows up here." |
| `EM-05` | Sign in as Waitlisted. | "You're on the waitlist" notice, then Maya's board under Shared with you. The menu shows My apps and Connect your AI only. |
| `EM-06` | As Waitlisted, open the filter button. | No Owner group (they only have shared apps); Sort is there. |
| `EM-07` | As Waitlisted, open `/new` and `/spaces`. | Both show the My apps page instead, as before. |

## 8. Phone layout

On a phone, or a browser window 390px wide.

| ID | Steps | Expected |
|---|---|---|
| `PH-01` | Open My apps. | Search and the round filter button in one row. Cards are colored tiles, two to a row, with no sideways scrolling. |
| `PH-02` | Look at a shared tile. | The owner's initial in a yellow circle at the top left, "From <email>", and the role chip at the bottom. |
| `PH-03` | Tap the filter button. | A sheet slides up from the bottom with "Filter and sort", a "Done" button, and the Owner, Space and Sort groups. The page behind is dimmed and doesn't scroll. |
| `PH-04` | Choose Owner: Other people in the sheet. | The list behind updates right away. |
| `PH-05` | Tap Done. | The sheet closes; the filter button shows its dot. |
| `PH-06` | Check every option row in the sheet. | Each is at least 44px tall and easy to tap. |

## 9. Keyboard and screen reader

| ID | Steps | Expected |
|---|---|---|
| `KB-01` | Tab from the search box. | Focus moves to the filter button, with a visible focus ring. |
| `KB-02` | Press Enter on the filter button. | The menu opens and focus moves to the selected Owner option. |
| `KB-03` | Use the arrow keys inside a group, and Tab between groups. | Arrows change the choice and the list updates; Tab moves to the next group, then Reset (when shown). |
| `KB-04` | With a screen reader, focus the filter button. | It's announced as "Filter and sort", a button that opens a dialog, with its expanded state. |
| `KB-05` | With a screen reader, read the groups in the menu. | Each group is announced by its name (Owner, Space, Sort) and each option as a radio button. |
| `KB-06` | With a screen reader, read a shared card. | It reads the app name and "From <owner's email>"; the owner's initial circle is not read on its own. |
| `KB-07` | With a screen reader, move through the page by headings. | "My apps", "Made by you", "Shared with you" are headings. |

## 10. Themes, browsers and sizes

| ID | Steps | Expected |
|---|---|---|
| `TH-01` | Switch to dark mode and open the filter menu. | Menu, chips, owner circle and section headings are readable, with no white boxes. |
| `TH-02` | Light mode: check the outlined role chip and the purple filter button. | Both are readable against the page. |
| `TH-03` | Resize from 1440px down to 390px wide. | The layout changes cleanly; the menu becomes a bottom sheet below 640px; nothing overlaps or scrolls sideways. |
| `TH-04` | Repeat `MY-01` to `FI-07` in Safari and Firefox. | Same results. |

## 11. Copy and design rules

| ID | Steps | Expected |
|---|---|---|
| `CP-01` | Read every label on My apps, the filter menu and the empty states. | No em dashes anywhere. Plain language. |
| `CP-02` | Look for "Shared with me" anywhere in the web app pages and emails. | Gone, except the phone shortcut's name. |
| `CP-03` | Check the page has one primary action. | "+ New app" in the menu (and in the empty state) is the only filled purple button. |

## 12. Regression checks

Pages that share code with the change. Each should work as before.

| ID | Steps | Expected |
|---|---|---|
| `RG-01` | App settings page: Sharing, Update and Activity tabs on an app you own. | Work as before. |
| `RG-02` | Full activity page for an app (`/apps/<id>/activity`). | Opens, with "My apps" highlighted in the menu. |
| `RG-03` | Get the app page. | Lists both your apps and shared apps, as before. |
| `RG-04` | Spaces page: create a space, edit its editors, delete a test space. | Works as before. |
| `RG-05` | Inputs elsewhere (New app description box, Spaces editors, Access keys name, the app name in its header). | Look and work as before. |
| `RG-06` | Delete a test app from its settings page. | It's gone from My apps after the redirect. |

## 13. How to report

Finish with a summary, then one block per failure.

```
Summary
  Passed: N   Failed: N   Blocked: N
  Browsers and devices covered: …

Failure
  Case: FI-04
  Where: Chrome 131, macOS, 1440 wide, dark mode
  Steps: what you did, exactly
  Expected: from the plan
  Actual: what happened
  Console: any errors, copied
  Screenshot: attached
  Severity: blocker | major | minor | cosmetic

Blocked
  Case: RD-07
  Missing: no phone to install the app on
```

Severity guide: **blocker** stops someone finding or opening an app, or shows an app to the wrong people. **Major** is a wrong result with a workaround. **Minor** is a small wrong behavior. **Cosmetic** is looks only.
