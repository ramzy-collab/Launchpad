# Settings redesign, phase 1: test plan

Hands-on browser test plan for the new My apps page and app settings page, written to hand to Claude Cowork. Change: [ramzy-collab/Launchpad#33](https://github.com/ramzy-collab/Launchpad/pull/33) (UI only, no backend changes).

## 1. Instructions for the tester

- Work through every case in order. Each case has an ID (for example `MA-04`), steps, and the expected result.
- Mark each case **Pass**, **Fail** or **Blocked**. For every Fail, record what happened instead, the browser and screen size, and a screenshot.
- Only use the test accounts and the test space below. Never delete, rename or change sharing on an app outside the test space.
- "Toast" means the short message that appears at the bottom of the screen after an action.
- After any action that saves, reload the page and confirm the change stuck. A change that shows but doesn't survive a reload is a Fail.
- Keep the browser's developer console open. Any red error in the console is a Fail for the case you were on.
- If a case can't be run (missing account, feature off, no API key), mark it Blocked and say what's missing. Don't skip silently.

## 2. Setup and test data

Ramzy (or whoever hands this off) prepares these before Cowork starts.

> **Where to test:** deploy the PR branch to a test Formelab, or run it locally with `npm run dev` and `wrangler dev --env dev --var DEV_USER:<email>`. Give Cowork the web app address. Don't test on production data.

### Accounts

| Name | Role on the test apps | Notes |
|---|---|---|
| **Owner** | Owns every test app | The main account Cowork uses |
| **Admin** | Editor and sharer on "Team board" | Has a Formelab account |
| **Editor** | Editor (not sharer) on "Team board" | Has a Formelab account |
| **Viewer** | In the share list of "Team board" | Has a Formelab account |
| **Stranger** | No access to anything | Has a Formelab account |
| **Guest** | Not signed in | A private or incognito window |

### Feature flags (admin panel, Features)

- `responses` on, for the guest answers switch. Turn it off only for case `CD-06`.
- `app_builder` on, for the Update tab. Turn it off only for case `UP-09`.
- `connected_apps` off. The Connected apps tab must not appear in Phase 1.

### Test apps (all in one space, for example `qa`)

| App | How to set it up | Used for |
|---|---|---|
| **Solo notes** | Titled, private, shared with nobody | "Only you" states, delete test |
| **Team board** | Titled; Admin, Editor and Viewer set as above; uses `formelab.kv` to save shared data | Roles, data writes |
| **RSVP form** | Titled; public link on; uses `formelab.responses.submit()`; has a meta description | Public states, guest answers, preview |
| **(untitled)** | No title, path `untitled-thing` | Italic path name |
| **Members app** | Set `visibility: "all"` with the MCP `update_site` tool | "Formelab members" note |
| **Override app** | Set `link_preview: "full"` with `update_site`, leave it invited only | Preview reset |
| **Icon app** | Has a favicon linked from index.html | Icon on cards and tiles |
| **Other space app** | Any app in a second space, for example `qa2` | Space filter |

## 3. My apps

Signed in as Owner, on a computer screen at least 1280px wide.

| ID | Steps | Expected |
|---|---|---|
| `MA-01` | Open My apps. | Cards in a grid, not a list or table. A "Starred" section with the hint "Star the apps you use most and they'll wait for you up here.", then "All apps". |
| `MA-02` | Look at the Solo notes card. | Icon or letter, the name, "qa · Updated <time>", and a chip "Only you" with a lock icon. |
| `MA-03` | Look at Team board, RSVP form and Members app. | Chips read "Shared with 3", "Public" (globe) and "Formelab members". |
| `MA-04` | Look at the untitled app. | Name shows as `untitled-thing` in italics, in a lighter color. |
| `MA-05` | Look at Icon app. | Its favicon shows instead of a letter. |
| `MA-06` | Click the middle of a card (not a button). | The app opens in a new tab. My apps stays open. |
| `MA-07` | Click the gear on a card. | The app's settings page opens in the same tab. |
| `MA-08` | Hover a card that isn't starred. | The star and the link button appear. Move away: they hide again. |
| `MA-09` | Click the star on Team board. | Toast "Team board starred". The card moves to Starred, the hint disappears, the lower heading becomes "Everything else". The star stays visible and filled. |
| `MA-10` | Reload the page. | Team board is still starred. |
| `MA-11` | Unstar it. | Toast "Removed from starred". It moves back; the hint returns. |
| `MA-12` | Click the link button on RSVP form, then paste somewhere. | Toast "Link copied. Anyone with it can open the app." The pasted link contains `/_platform/link/` (the public link), not the plain app address. |
| `MA-13` | Copy the link of Solo notes, then Team board, then Members app. | Each pastes the app's own address. Toasts: "Only you can open it right now.", "Only people you invited can open it.", "Anyone signed in to Formelab can open it." |
| `MA-14` | Type `rsvp` in search. | Only RSVP form shows. Heading reads "Results". |
| `MA-15` | Search by a space name, then by a path (for example `untitled`). | Both find the matching apps. |
| `MA-16` | Search `zzzz`. | A box reads Nothing matches “zzzz” with a "Show all apps" button. Clicking it clears search and filter and shows every app. |
| `MA-17` | Pick `qa2` in the space filter. | Only apps in qa2 show. The filter only appears when you have more than one space. |
| `MA-18` | Try each sort: Recently changed, Newest first, Name A to Z. | Order changes correctly. Starred apps stay in Starred, sorted the same way. |
| `MA-19` | Open My apps with `?space=qa2` on the address. | Opens already filtered to qa2. |
| `MA-20` | Sign in as an account with no apps. | The "What do you want to make?" empty state with "+ New app", no empty grid. |

## 4. Shared with me

| ID | Steps | Expected |
|---|---|---|
| `SW-01` | As Editor, open Shared with me. | Team board shows as a card with "Owner's email · qa · Updated …" and a chip "Can edit". It has a gear. |
| `SW-02` | As Viewer, open Shared with me. | Team board shows with chip "Can open" and no gear. |
| `SW-03` | As Viewer, copy the link of an app that has a public link. | Copies the plain app address, never the public link. |
| `SW-04` | Star an app here, then open My apps (as an account that owns apps). | Starring works in Shared with me. Stars are per browser in Phase 1, so they don't follow you to another device. That's expected. |
| `SW-05` | As Stranger, open Shared with me. | "Nothing yet…" message, no errors. |

## 5. Phone layout

Use a real phone, or the browser's device mode at 390 by 844. Repeat on a 320px wide screen.

| ID | Steps | Expected |
|---|---|---|
| `PH-01` | Open My apps. | Search and a small filter button share one row. Space and Sort are hidden. |
| `PH-02` | Tap the filter button. | Space and Sort appear side by side under the search. Tap again: they hide. |
| `PH-03` | Pick a space or a sort other than Recently changed. | A dot shows on the filter button. Set both back: the dot goes away. |
| `PH-04` | Look at the cards. | Two per row. Each card is a square tile in the app's color with the icon or letter large in the middle, and the name, "space · <time> ago", the chip and the link button on the tile. Star and gear in the top right corner. |
| `PH-05` | Check long names (rename an app to 40 or more characters). | Name cuts off with an ellipsis on one line. Nothing overlaps. |
| `PH-06` | Tap a tile, then the gear, the star and the link button. | Tile opens the app. Gear opens settings. Star stars it. Link button copies with a toast. Each target is easy to hit. |
| `PH-07` | Scroll every page in this plan at phone width. | No page scrolls sideways. |
| `PH-08` | Open an app's settings on the phone. | Header stacks: icon, name and star, share pill, then a full-width "Open app" with the "..." button. Tabs fit. People rows don't overflow. |

## 6. App page header

As Owner, open Team board's settings.

| ID | Steps | Expected |
|---|---|---|
| `HD-01` | Look at the top of the page. | Breadcrumb "My apps / Team board". No big page title above it. App icon, the name as an editable field, a star, the share pill, "Updated …", an "Open app" button and a "..." button. |
| `HD-02` | Click "My apps" in the breadcrumb. | Goes back to My apps. As Editor the breadcrumb reads "Shared with me" and goes there. |
| `HD-03` | Click the name, change it to "Team board 2", press Enter. | Toast "Name saved". The breadcrumb, browser tab title and preview card update. Reload: it stuck. |
| `HD-04` | Change the name, then click elsewhere. | Saves the same way. |
| `HD-05` | Change the name, then press Esc. | Goes back to the saved name. Nothing saves. |
| `HD-06` | Clear the name and press Enter. | Saves as untitled. The field shows the path as a placeholder; the breadcrumb shows the path. |
| `HD-07` | Click into the name and press Enter without changing it. | No toast, nothing saves. |
| `HD-08` | Paste a 250 character name. | Field stops at 200 characters. |
| `HD-09` | Click the star in the header, then open My apps. | Toast "Starred. It shows at the top of your apps." The app is in Starred on My apps. |
| `HD-10` | Share pill, left half. | Shows lock "Only you", people "Shared with N", globe "Public" or "Formelab members" to match the app. Clicking it opens the Sharing tab and scrolls to it. |
| `HD-11` | Share pill, link icon. | Copies the same link a card would (public link when public). Toast says who can open it. |
| `HD-12` | Click "Open app". | App opens in a new tab. |
| `HD-13` | Click "...". | Menu with "Add to your phone or computer", a divider, and "Delete app" in red. Clicking outside, pressing Esc, or clicking "..." again closes it. |
| `HD-14` | Choose "Add to your phone or computer". | A dialog with steps for iPhone, Android, Chrome or Edge, and Mac Safari, plus an "Open app" button. Esc or × closes it. |
| `HD-15` | On Solo notes choose "Delete app". | Dialog "Delete Solo notes?" with "Type Solo notes to confirm". "Delete forever" stays disabled. |
| `HD-16` | Type the name with a typo, then in a different case (`solo notes`). | Button stays disabled for both. Exact name only. |
| `HD-17` | Press "Keep it", reopen the dialog. | The typed text is cleared. |
| `HD-18` | Type the exact name and press "Delete forever". | Toast "Solo notes deleted", then My apps without it. Its address no longer works. |
| `HD-19` | As Editor or Admin, open "...". | No "Delete app" item. |
| `HD-20` | Look for any of: a separate copy URL field, a Share button, an admin button, a facts grid (Space, Path, Size, Options, UTC times, Owner). | None of them appear. |

## 7. Tabs

| ID | Steps | Expected |
|---|---|---|
| `TB-01` | Look at the tabs. | Sharing, Update, Activity. Sharing is selected. No "Connected apps" tab. |
| `TB-02` | Click Update, then Activity. | The panel switches. The address ends in `#update`, then `#activity`. |
| `TB-03` | Reload on `#activity`. | Activity tab is open. |
| `TB-04` | Tab to the tab row, press the left and right arrows. | Focus and selection move between tabs and wrap around. |

## 8. Sharing: who can open it

As Owner. Use a private window as Guest to check what a link really does.

| ID | Steps | Expected |
|---|---|---|
| `AC-01` | Open Team board (invited only). | Toggle shows lock "Invited only" selected and globe "Public". Hint: "Only you and the people you invite below. They sign in to open it." No warning, no link box. |
| `AC-02` | Click "Public". | Toast "Anyone with the link can open it now". Yellow warning with an alert icon: "Anyone with the link can open this app, no sign-in needed. …". A link box with the public link, "Copy link" and "Reset link". Pill turns to globe "Public". Guest answers switch appears. Preview card switches to the app's full card. |
| `AC-03` | Copy the link and open it as Guest. | The app opens without signing in. |
| `AC-04` | Click "Reset link". | Dialog "Reset the link?" saying the current one stops working right away. "Cancel" does nothing. |
| `AC-05` | Confirm the reset. | Toast "New link ready. The old one no longer works." The link box shows a new link. As Guest, the old link no longer opens the app; the new one does. |
| `AC-06` | Click "Invited only". | Toast "Only people you invite can open it now". Warning, link box and guest answers switch disappear. Pill goes back to "Shared with N". As Guest, the public link stops working. |
| `AC-07` | Click the already selected option. | Nothing happens, no toast. |
| `AC-08` | Open Members app. | "Invited only" is selected. A note: "Anyone signed in to Formelab can open it too." with "Limit it to people you invite". Pill reads "Formelab members". |
| `AC-09` | Click "Limit it to people you invite". | Toast; the note disappears; pill changes to "Only you" or "Shared with N". As Stranger, the app no longer opens. |
| `AC-10` | Turn another "all members" app Public, then back to Invited only. | After Invited only, it's restricted to invited people (the members note does not come back). |
| `AC-11` | Activity tab after AC-02 to AC-09. | Each change is listed in a plain sentence. |

## 9. Sharing: what they can do

| ID | Steps | Expected |
|---|---|---|
| `CD-01` | Look at "What they can do" on Team board. | Switch "Viewers can add and change the app's data" with "For polls, sign-up sheets and shared lists. When off, only you, Editors and Admins can." |
| `CD-02` | Turn it off. As Viewer, try to save data in the app. | Toast "Only you, Editors and Admins can change its data now". The Viewer's save is refused by the app. |
| `CD-03` | Turn it on. As Viewer, save data again. | Toast "Viewers can change the app's data now". The Viewer's save works. Reload settings: switch still on. |
| `CD-04` | With the switch on, open a role picker. | The Viewer description reads "Can use the app and change its data". Off: "Can open and use the app". |
| `CD-05` | On RSVP form (public), turn on "Anyone with the link can send answers". As Guest, submit the form through the public link. | Toast "Anyone with the link can send answers now". The guest's answer is accepted without signing in. Turn it off: guests can no longer send. |
| `CD-06` | Turn the `responses` flag off and reload RSVP form's settings. | The guest answers switch isn't shown at all, even though the app is public. Turn the flag back on. |
| `CD-07` | Make a switch fail (for example, go offline in dev tools) and flip it. | An error toast explains the problem and the switch flips back to its saved position. |

## 10. Sharing: link preview in chats

| ID | Steps | Expected |
|---|---|---|
| `LP-01` | Invited only app. | A dark Formelab card: "A private app. Sign in to open it.", "A private app on Formelab", and the app's host. Note ends "…it shows a private card and the app's name stays hidden." No dropdown or other control here. |
| `LP-02` | Public app. | A card in the app's color with its icon and name, then the name, its description (or "Made on Formelab."), and host. Note ends "Because the link is public, it shows the app's name and picture." |
| `LP-03` | Open Override app (invited only, preview forced to full). | Card shows the full app card (what chats really show today), with the note "It shows the app's name and picture." |
| `LP-04` | On Override app, switch to Public and back to Invited only. | After going back, the card is the private card. The override is gone for good (reload to confirm). |
| `LP-05` | Paste the app's address into Slack, iMessage or an Open Graph checker for one invited only and one public app. | Real previews match the cards on the page. |

## 11. People and roles

As Owner on Team board unless a case says otherwise. Use fresh test emails you control so share emails can be checked.

| ID | Steps | Expected |
|---|---|---|
| `PP-01` | Look at the People list. | Owner first, with "(you)", "Owner" under it and "Owner" on the right. Then each person with an initial, email, "Invited", and a role picker. |
| `PP-02` | Check roles. | Admin shows "Admin", Editor "Editor", Viewer "Viewer". |
| `PP-03` | Open the invite role picker. | A custom menu, not a native dropdown. Closed it shows only the role name. Open, each option has the name in bold and a description: Viewer "Can open and use the app", Editor "Can edit the app and its data", Admin "Can edit and manage sharing". A checkmark on the current one. |
| `PP-04` | Invite one email as Viewer. | Toast "Invited x as a Viewer". They appear in the list; the field clears; the pill count goes up. They get a share email. |
| `PP-05` | Invite two emails separated by a comma, as Editor. | Toast "Invited 2 people as Editors". Both appear as Editor. As one of them, the app shows under Shared with me with a gear. |
| `PP-06` | Invite one as Admin. | They appear as Admin. As them, they can change who can open it. |
| `PP-07` | Press Invite with the field empty. | Error toast "Add an email first". |
| `PP-08` | Invite `not-an-email`. | Error toast naming the bad address. Nothing saves. |
| `PP-09` | Invite someone already on the list, and the owner's own email. | Error toast that they already have access. Nothing saves. |
| `PP-10` | Invite mixed case (`Pal@Example.com`). | Saved in lowercase. Inviting it again is treated as a duplicate. |
| `PP-11` | Change Viewer to Editor in their row. | Toast "x is now an Editor". Reload: still Editor. As them: they can open settings. |
| `PP-12` | Change Editor to Admin, then Admin to Viewer. | Toasts "… is now an Admin", "… is now a Viewer". As them, access matches each step. |
| `PP-13` | Choose "Remove access". | Below a divider, in red. Toast "x no longer has access". They're gone from the list and lose access. |
| `PP-14` | Open a picker and click outside it; open one and press Esc; open one and press Tab. | Each closes it. Esc returns focus to the picker button. |
| `PP-15` | Open a picker and scroll the page. | The menu stays attached to its button, and closes once the button scrolls out of view. |
| `PP-16` | Open a picker on the last row near the bottom of the window. | It opens upward instead of off screen. |
| `PP-17` | Pick the role the person already has. | Nothing saves, no toast. |
| `PP-18` | As Admin (not owner), open Team board. | Can invite. The role picker allows only Viewer; Editor and Admin are disabled with "Only the owner can give this role". Viewer rows have pickers; Editor and Admin rows show a plain label. |
| `PP-19` | As Editor, open Team board. | No invite row. Every row shows a plain role label. Toggle and Reset link are disabled with a note that only the owner and Admins can change who can open it. |
| `PP-20` | As any non-owner, find your own row. | Shows "(you)" and a plain label; you can't change your own role. |
| `PP-21` | Invite more people than the daily share email limit allows. | The toast names who wasn't emailed. They're still added. |

## 12. Update tab

| ID | Steps | Expected |
|---|---|---|
| `UP-01` | With no AI key saved, open Update. | Heading "What do you want to change?", subtext "Describe it in your own words. Your app's data and sharing stay just as they are.", a big text box, 3 idea chips, and a button "Add your free Gemini key to update with AI". |
| `UP-02` | Click an idea chip twice with different chips. | Each appends to the text, joined with ". ". It doesn't replace what you typed. |
| `UP-03` | Click "Add your free Gemini key…". | The Gemini key dialog opens. Saving a valid key reloads the page. |
| `UP-04` | With a key saved, look at the button. | "Update with Gemini" (or the AI whose key is saved; Gemini wins if several are). |
| `UP-05` | Press it with the text box empty. | Error toast "Tell it what to change first", focus in the text box. |
| `UP-06` | Ask for a small visible change and press the button. | Button disables. Progress shows in plain words, moving through "Reading your app…", "Sketching the changes…", "Wiring it up…", "Almost there…". When done: "It's live. Take a look" with a working link; header says "Updated just now"; text box clears. |
| `UP-07` | Open the app after UP-06. | The change is there. Its data, sharing and public link are unchanged. |
| `UP-08` | Use an invalid key (or cause an error) and run an update. | Progress box turns to an error with a plain explanation; error toast; button works again. |
| `UP-09` | Turn `app_builder` off and reload. | The tab shows only "Upload a new version" with the drop box. No prompt or AI button. Turn it back on. |
| `UP-10` | Click "Upload a new version instead". | A dashed drop box appears: "Drop an .html or .zip file here", with "Choose file". Click again to hide it. |
| `UP-11` | Choose an .html file. | Toast "New version published". The app shows the new version. Data and sharing unchanged. |
| `UP-12` | Drag a .zip with index.html onto the box. | The box highlights while dragging; the drop publishes it. |
| `UP-13` | Drop a .png. | Error toast "Choose an .html or .zip file". Nothing published. |
| `UP-14` | Upload a zip without index.html. | Error toast that explains what's wrong. |

## 13. Activity tab

| ID | Steps | Expected |
|---|---|---|
| `AV-01` | Open Activity after the earlier tests. | "Recent activity" with up to 8 lines, newest first, each a plain sentence and a relative time ("4 minutes ago"). |
| `AV-02` | Check your own actions. | Start with "You", for example "You turned on a public link …", "You renamed it to …". |
| `AV-03` | Have Admin change something, then check as Owner. | That line starts with Admin's email. |
| `AV-04` | Use an app that calls Gemini or Google Sheets, then check. | Lines start with "The app", for example "The app asked Gemini (284 tokens)". |
| `AV-05` | Click "See all activity". | The full activity page for this app opens, with a link back. |
| `AV-06` | On RSVP form after people sent answers. | A line "People sent this app N answers. Download them as a spreadsheet". The download is a CSV of the answers. (Interim until the Phase 2 Answers page.) |
| `AV-07` | New app with no history beyond publishing. | Shows "You published the app". An app with no activity at all shows "Nothing yet." |

## 14. Permissions and safety

| ID | Steps | Expected |
|---|---|---|
| `PS-01` | As Viewer and as Stranger, open Team board's settings address directly. | "Not found" page for both. |
| `PS-02` | As Editor, try to change sharing anyway (for example, re-enable a disabled button in dev tools and click it). | The save is refused with an error toast; nothing changes. |
| `PS-03` | Rename an app to `<img src=x onerror=alert(1)>`; invite `"><b>x@example.com` (should be refused as invalid). | The name shows as plain text everywhere (card, header, breadcrumb, dialogs, tab title). No alert runs. |
| `PS-04` | Check the console on every page. | No errors, including no Content Security Policy errors. |
| `PS-05` | Sign out in another tab, then change a setting. | An error toast, not a silent failure. Signing back in works. |
| `PS-06` | Open settings in two tabs; change the name in one, then a switch in the other. | Both saves land; reload shows both changes. |

## 15. Keyboard and accessibility

| ID | Steps | Expected |
|---|---|---|
| `KB-01` | Using only the keyboard, go through My apps. | Every card, star, gear and link button can be reached with Tab and used with Enter or Space. Focus is always visible. |
| `KB-02` | Focus a role picker, press the down arrow. | It opens with focus on the current role. Up and down arrows, Home and End move. Enter picks. Esc closes and returns focus. Disabled roles are skipped. |
| `KB-03` | Use the "..." menu with the keyboard. | Opens with focus on the first item; arrows move; Esc closes and returns focus to "...". |
| `KB-04` | Open each dialog (install, reset link, delete) with the keyboard. | Focus moves into the dialog; Esc closes it; focus returns to the page. |
| `KB-05` | Use a screen reader (VoiceOver or NVDA) on the settings page. | Buttons have names ("Copy link", "Star this app", "Role for x", "More"). Switches read as switches with their labels. Toasts are announced. Toggle buttons announce pressed or not. |
| `KB-06` | Turn on "reduce motion" in the OS. | No sliding toasts or bouncing switches; spinner doesn't spin. |
| `KB-07` | Zoom the browser to 200%. | Everything still fits and works; no clipped text. |

## 16. Browsers, themes and sizes

Run the main path (MA-01 to MA-12, HD-01 to HD-13, AC-01 to AC-06, PP-03 to PP-13) on each:

- Chrome, Safari and Firefox on a computer.
- Safari on iPhone, Chrome on Android.
- Light and dark mode (Formelab's own toggle in the account menu, and the system setting).
- Widths 320, 390, 768, 1024 and 1440.

| ID | Steps | Expected |
|---|---|---|
| `DV-01` | Dark mode, all pages. | All text readable. Warning box and chips readable. No white flashes or hard-coded light boxes. |
| `DV-02` | Firefox (no automatic field sizing). | The name field and star still sit together sensibly in the header. |
| `DV-03` | Safari, copy link. | Copy works and shows the toast. If the browser blocks it, a clear error toast instead. |
| `DV-04` | Tablet width (768). | Cards and header lay out cleanly; nothing overlaps. |

## 17. Copy and design rules

| ID | Steps | Expected |
|---|---|---|
| `CP-01` | Look for any Save button on My apps and the settings page. | None. Every change saves by itself and shows a toast. |
| `CP-02` | Search the page text of My apps, Shared with me and settings for the long dash character "—". | None found in the new pages. |
| `CP-03` | Check removed items are gone: "Everyone on Formelab" option, link preview dropdown, SPA fallback, Hidden from listings, Google Sheets box, Responses section, Public link card, Forms and sign-ups card, Install card, Publish card, Delete card. | None appear. |
| `CP-04` | Count primary (filled accent) buttons on each screen. | One main action per screen area ("Open app" in the header, "Invite" in People, the update button in Update). |
| `CP-05` | Read every toast and message you saw. | Plain language, says what happened or how to fix it. Note anything confusing. |

## 18. Regression checks

Pages that share code with the change. Each should work as before.

| ID | Steps | Expected |
|---|---|---|
| `RG-01` | New app: open each "Make it with …" key dialog, save and remove a key; upload an app. | Works as before. |
| `RG-02` | New app: build an app with a saved key. | Builds and publishes; the finish screen links to its settings, which open the new page. |
| `RG-03` | Spaces: create a space, edit editors, delete a test space. | Works, with the old messages. |
| `RG-04` | Access keys: create and revoke a key; copy it. | Works. |
| `RG-05` | Connected apps page (flag on, then off). | Unchanged. With the flag off, the settings page still has no Connected apps tab. |
| `RG-06` | Get the app page and the full activity page. | Unchanged and working. |
| `RG-07` | Ask Claude (MCP) to update an app's sharing with `update_site`, then reload settings. | Settings show the change. |
| `RG-08` | Admin panel activity. | Sentences still read as before (they don't start with "You"). |

## 19. How to report

Finish with a summary, then one block per failure.

```
Summary
  Passed: N   Failed: N   Blocked: N
  Browsers and devices covered: …

Failure
  Case: PP-15
  Where: Chrome 131, macOS, 1440 wide, dark mode
  Steps: what you did, exactly
  Expected: from the plan
  Actual: what happened
  Console: any errors, copied
  Screenshot: attached
  Severity: blocker | major | minor | cosmetic

Blocked
  Case: UP-06
  Missing: no Gemini key on the test account
```

Severity guide: **blocker** stops someone using or sharing an app, or exposes an app to the wrong people. **Major** is a wrong result with a workaround. **Minor** is a small wrong behavior. **Cosmetic** is looks only.
