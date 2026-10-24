# Settings redesign, phase 2: test plan

Hands-on browser test plan for phase 2 of the app settings redesign: stars saved per person, Editors and Admins needing a Formelab account (with sign-up invites), transferring ownership, making a copy, and the automatic Answers page. Written to hand to Claude Cowork.

## 1. Instructions for the tester

- Work through every case in order. Each case has an ID (for example `IV-04`), steps, and the expected result.
- Mark each case **Pass**, **Fail** or **Blocked**. For every Fail, record what happened instead, the browser and screen size, and a screenshot.
- Only use the test accounts and the test space below. Never delete, transfer, copy or change sharing on an app outside the test space.
- "Toast" means the short message that appears at the bottom of the screen after an action.
- After any action that saves, reload the page and confirm the change stuck. A change that shows but doesn't survive a reload is a Fail.
- Keep the browser's developer console open. Any red error in the console is a Fail for the case you were on.
- If a case can't be run (missing account, feature off, no email access), mark it Blocked and say what's missing. Don't skip silently.

## 2. Setup and test data

Ramzy (or whoever hands this off) prepares these before Cowork starts.

> **Where to test:** a test deploy of this change with migration `0025` applied, or locally with `wrangler dev --env dev --var DEV_USER:<email>` after `npm run db:migrate:local`. Don't test on production data.

### Accounts

| Name | Notes |
|---|---|
| **Owner** | Owns the test space `qa2` and every test app. The main account. |
| **Admin** | Has a Formelab account. |
| **Editor** | Has a Formelab account. |
| **Viewer** | Has a Formelab account. |
| **Newcomer** | An email address you can read that has **never** signed in to Formelab. Use a fresh one each run (for example `you+qa1@gmail.com`). |
| **Guest** | Not signed in: a private or incognito window. |

### Feature flags (admin panel, Features)

- `responses` on (for the Answers page). Turned off only for case `AN-09`.

### Test apps (all in space `qa2`)

| App | How to set it up | Used for |
|---|---|---|
| **Board** | Titled "Board"; Admin set as Admin, Editor as Editor, Viewer as Viewer | Stars, roles, transfer |
| **Signups** | Titled "Signups"; its page calls `formelab.responses.submit({ name, coming })` from a form; Editor set as Editor, Viewer as Viewer | Answers page |
| **Plain** | Any app that never uses `formelab.responses` | No Answers link |
| **Copy me** | Titled "Copy me"; has some shared data saved, a public link on, and Viewer invited | Make a copy |

## 3. Stars

| ID | Steps | Expected |
|---|---|---|
| `ST-01` | As Owner, star Board on My apps. Reload. | Toast "Board starred". Board stays in Starred after the reload. |
| `ST-02` | Open My apps in a different browser (or a private window signed in as Owner). | Board is starred there too. Stars follow the account, not the browser. |
| `ST-03` | As Viewer, open Shared with me. | Board is not starred for Viewer. Owner's star is never shown to anyone else. |
| `ST-04` | As Viewer, star Board in Shared with me. Reload. | It moves to Starred and stays there. Owner's My apps is unchanged. |
| `ST-05` | As Owner, star Board from its settings page header, then unstar it. | Toasts "Starred. It shows at the top of your apps." and "Removed from starred". My apps matches each time. |
| `ST-06` | Turn on offline mode in dev tools and click a star. | An error toast; the star goes back to how it was. |
| `ST-07` | If you starred apps during phase 1 in this browser, open My apps once. | Those stars appear in Starred and now also show in other browsers. |
| `ST-08` | Delete a starred test app (make a copy first with `CP-01` and delete the copy). | It disappears from Starred with no errors. |

## 4. Editors and Admins need an account

| ID | Steps | Expected |
|---|---|---|
| `IV-01` | On Board, invite Newcomer as **Viewer**. | They're added as a Viewer straight away. Their row reads "Invited, no Formelab account yet". |
| `IV-02` | Remove Newcomer. Invite them again, this time as **Editor**. | They aren't added. A yellow note: "**Newcomer** doesn't have a Formelab account yet. Editors need one, since they sign in to make changes." with "Send a sign-up invite", "Add as Viewer instead" and "Cancel". The email stays in the field. |
| `IV-03` | Press "Cancel". | The note closes; nothing changes; the field clears. |
| `IV-04` | Repeat `IV-02`, then press "Add as Viewer instead". | Toast; they're a Viewer. |
| `IV-05` | Remove them; invite as Editor again; press "Send a sign-up invite". | Toast "Sign-up invite sent to …". Their row reads "Sign-up invite sent. Becomes an Editor once they join Formelab." and their role shows Viewer. |
| `IV-06` | Check Newcomer's inbox. | An email "… invited you to edit an app on Formelab" with a "Join Formelab" button, saying they can already open the app. No raw HTML or app name in the subject. |
| `IV-07` | In a private window, sign up to Formelab as Newcomer using the email's link. Then, as Owner, reload Board's settings. | Newcomer's row now shows Editor with "Invited". Activity shows "… Joined Formelab and became an Editor". (They may be on the waitlist; that's expected.) |
| `IV-08` | Invite two emails at once as Admin: one with an account (Editor's) and one Newcomer. | The one with an account becomes an Admin right away (toast). The note appears only for the Newcomer. |
| `IV-09` | On a Viewer row with no account, open the role picker and choose Editor. | A dialog "… needs a Formelab account" offering "Send sign-up invite". Cancel leaves them a Viewer. Sending marks the row as invited; they stay a Viewer until they join. |
| `IV-10` | Remove access from someone with a pending sign-up invite. | They're gone. If they later sign up, they don't get any role on Board. |
| `IV-11` | As Admin (not the owner), invite someone as Viewer. | Works. Editor and Admin are disabled in the picker with "Only the owner can give this role". |
| `IV-12` | Ask Claude (MCP `update_site`) to add Newcomer as an editor of Board. | It refuses with a message that they need a Formelab account, and suggests sharing as a viewer or sending a sign-up invite. |

## 5. Transfer ownership

| ID | Steps | Expected |
|---|---|---|
| `OW-01` | As Owner, open Editor's role picker on Board. | Below a divider: "Make owner", disabled, with "Only Admins can become the owner". |
| `OW-02` | Open Admin's role picker. | "Make owner" is enabled: "Hand over the app. You stay an Admin." |
| `OW-03` | Open the role picker of someone with a pending sign-up invite (even if you made them Admin-to-be). | "Make owner" is disabled. |
| `OW-04` | Choose "Make owner" on Admin. | Dialog: "Make Admin the owner? They'll control Board, including deleting it and transferring it again. You'll stay on as an Admin." The "Make owner" button is disabled until "I understand only the new owner can transfer it back" is ticked. Esc and Cancel close it without changes. |
| `OW-05` | Tick the box and press "Make owner". | The page reloads with the toast "… now owns Board. It's under Shared with me." Above People: "**Admin** owns this app. You're an Admin." The "..." menu has no Delete. |
| `OW-06` | As (old) Owner, open My apps and Shared with me. | Board is gone from My apps and listed in Shared with me, with a gear. |
| `OW-07` | As old Owner, change who can open Board, then try to delete it via the API or Claude. | Sharing changes work (they're an Admin). Delete is refused. |
| `OW-08` | As old Owner, try to delete space `qa2` on the Spaces page. | Refused: the space holds an app you gave to someone else. Nothing is deleted. |
| `OW-09` | As Admin (the new owner), open My apps and Board's settings. | Board is in My apps. Its "..." menu has Delete. They received an email "… made you the owner of an app". |
| `OW-10` | As the new owner, make the old Owner the owner again. | Works the same way. Afterwards the old Owner owns it and has Delete again. |
| `OW-11` | Check Board's Activity tab. | "Made … the owner (… stays on as an Admin)". |

## 6. Make a copy

| ID | Steps | Expected |
|---|---|---|
| `CP-01` | As Owner, open Copy me, then "..." and "Make a copy". | You land on the new app's settings with the toast "Made a copy: Copy me (copy). Only you can open it." |
| `CP-02` | Look at the copy. | Name "Copy me (copy)", in space `qa2`, Invited only, no public link, People shows only you. |
| `CP-03` | Open the copy. | Same files as the original. None of the original's saved data is there. |
| `CP-04` | Make another copy of Copy me. | Its path ends in `-copy-2`; names don't clash. |
| `CP-05` | As Editor of an app in a space they can't publish to, open the "..." menu. | No "Make a copy" item. |
| `CP-06` | Check the original after copying. | Unchanged: its people, data, public link and activity (apart from nothing new) are as before. |

## 7. The Answers page

| ID | Steps | Expected |
|---|---|---|
| `AN-01` | As Viewer, open Signups and send two answers (one with an empty field). | Each is accepted by the app. |
| `AN-02` | As Owner, open Signups. | A small purple "Answers" link sits in the bottom right corner of the app. |
| `AN-03` | Click it. | `/answers` on the app's address: banner "Only you and the app's editors can open this page.", the app's name with "answers", "Download as spreadsheet" and "Open app" buttons, stats (Answers count, Newest, Can see this page "You and 1 editor"), and a table with one column per field plus From and Sent. Empty fields show "-". |
| `AN-04` | Press "Download as spreadsheet". | A CSV named "Signups answers.csv" with every answer. |
| `AN-05` | As Editor, open Signups. | The Answers link shows and the page opens. |
| `AN-06` | As Viewer, open Signups, then type `/answers` on its address. | No Answers link. The page says only the app's owner and editors can see what people sent it. |
| `AN-07` | Turn on Signups' public link; open it as Guest; then go to `/answers`. | No link; the page refuses. |
| `AN-08` | As Owner, open Plain. | No Answers link. |
| `AN-09` | Turn the `responses` flag off; as Owner open Signups and `/answers`. | No link; `/answers` shows the app's own "not found" page. Turn the flag back on. |
| `AN-10` | Send an answer containing `<b>hi</b>`. | It shows as text, not bold. |
| `AN-11` | Look for a link to the Answers page in Signups' settings. | There isn't one; the page is reached from the app. |
| `AN-12` | Open `/answers` at phone width and in dark mode. | Stats stack, the table scrolls sideways inside its box, and the page itself doesn't scroll sideways. |

## 8. Keyboard, phone and themes

| ID | Steps | Expected |
|---|---|---|
| `KB-01` | Using only the keyboard, send a sign-up invite (`IV-05`) and transfer ownership (`OW-04` to `OW-05`). | Everything is reachable; the role picker's "Make owner" can be chosen with arrows and Enter; the dialog's checkbox works with Space; Esc closes the dialog. |
| `KB-02` | Screen reader on the transfer dialog and the account note. | The dialog is announced with its title; the note is read when it appears. |
| `KB-03` | At phone width (390), run `IV-02`, `OW-04` and `CP-01`. | The note's buttons wrap, dialogs fit the screen, nothing scrolls sideways. |
| `KB-04` | Dark mode on the settings page. | The yellow note, the "owns this app" note and the pending lines are readable. |

## 9. Regression checks

| ID | Steps | Expected |
|---|---|---|
| `RG-01` | Run the phase 1 cases `MA-01` to `MA-20` and `PP-01` to `PP-21`. | Still pass, except where this plan changes them (stars are now saved per person; Editor and Admin invites need an account). |
| `RG-02` | Ask Claude to publish a new app with an editor who has an account. | Works as before. |
| `RG-03` | Existing apps whose editors never signed in. | They keep their editors (only new ones need an account). Their rows say "Invited, no Formelab account yet". |
| `RG-04` | Delete a space that holds only your own apps. | Works as before. |
| `RG-05` | The admin panel's Activity and an app's full activity page. | The new actions read as plain sentences. |

## 10. How to report

Finish with a summary, then one block per failure.

```
Summary
  Passed: N   Failed: N   Blocked: N
  Browsers and devices covered: ...

Failure
  Case: OW-05
  Where: Chrome 131, macOS, 1440 wide, dark mode
  Steps: what you did, exactly
  Expected: from the plan
  Actual: what happened
  Console: any errors, copied
  Screenshot: attached
  Severity: blocker | major | minor | cosmetic

Blocked
  Case: IV-06
  Missing: no access to the Newcomer inbox
```

Severity guide: **blocker** stops someone using or sharing an app, or exposes an app or its answers to the wrong people. **Major** is a wrong result with a workaround. **Minor** is a small wrong behavior. **Cosmetic** is looks only.
