# Signing in to an app: test plan

Hands-on browser test plan for the app-branded sign-in and app-only accounts, part B of step 4 of the [agent access spec](../specs/2026-11-22-agent-access.md). Written to hand to Claude Cowork. Each case is run in a real browser against a test Formelab with its own sign-in (WorkOS), since that's what the cases test.

## 1. Instructions for the tester

- Work through every case in order. Each case has an ID (for example `AU-03`), steps, and the expected result.
- Mark each case **Pass**, **Fail** or **Blocked**. For every Fail, record what happened instead, which account you were using, the browser and screen size, and a screenshot.
- Only use the test accounts and the test apps below. Never sign in with a real customer's email or open apps outside the test space.
- Use a separate browser profile (or a private window) for each person, and close it between cases that say "a fresh private window", so no earlier sign-in carries over.
- Sign-in codes arrive by email. Use the test inboxes below, and only codes sent in the last few minutes.
- After every sign-in, reload the page you land on. A result that changes on reload is a Fail.
- Keep the browser's developer console open. Any red JavaScript error is a Fail for the case you were on. **One exception:** a refused request logs a failed request ("… 401", "… 403"). That's the refusal itself. Any other red line is a Fail.
- If a case can't be run (no inbox, no second browser), mark it Blocked and say what's missing. Don't skip silently.

## 2. Setup and test data

Ramzy (or whoever hands this off) prepares these before Cowork starts.

> **Where to test:** deploy the PR branch to a test Formelab with WorkOS set up (its own WorkOS staging keys), and run its migrations. Local testing with `wrangler dev --env dev --var DEV_USER:<email>` skips sign-in entirely, so it can't run these cases. Don't test on production data.

### Accounts and inboxes

| Name | What it is | Notes |
|---|---|---|
| **Owner** | Owns the space `qa` and the test apps | A Formelab admin, for the AD cases |
| **Friend** | In the share list of "Acme CRM". Has never used Formelab | A test inbox you can read |
| **Added** | Added inside "Acme CRM" with `formelab.roles.set`. Has never used Formelab | A test inbox you can read |
| **Stranger** | Not on any list. Has never used Formelab | A test inbox you can read |
| **Waiting** | On the waitlist already (joined at the home page and signed in once), not let in | A test inbox you can read |
| **Member** | An active Formelab account, in the share list of "Acme CRM" | |

### Test apps (space `qa`)

- **Acme CRM** (mount `acme`): the test app from [App members and roles](/test-plans/2026-11-24-app-members-roles), with its `formelab.json`. Rename it to **Acme CRM** on its page. Share it with Friend and Member. As Owner, open the app and add Added with role `rep`.
- **Long name** (mount `long`): any app with an icon. Rename it to `<b>PayPal PayPal PayPal PayPal PayPal PayPal PayPal PayPal PayPal</b>` and share it with Friend.

## 3. The sign-in page

| ID | Steps | Expected |
|---|---|---|
| `BR-01` | In a fresh private window, open Acme CRM's address. | The sign-in page reads **Sign in to Acme CRM**, with "Use your email to open the app at <b>acme host</b>." and the app's real address. The tab title is "Sign in to Acme CRM". |
| `BR-02` | Look over the whole page. | No Formelab menu or logo bar at the top, no "Join the waitlist", no "Welcome back to your Formelab workspace". A small "Powered by Formelab" line at the bottom of the card. |
| `BR-03` | Click **Powered by Formelab**. | Opens Formelab's home page. |
| `BR-04` | Back on the sign-in page, enter an email and choose **Continue with email**, then **Email me a code instead**. | The password and code steps keep "Powered by Formelab" and no Formelab menu. |
| `BR-05` | In a fresh private window, open Long name's address. | The title shows the name as plain text (the `<b>` tags visible as text, not bold), cut to about 60 characters. The app's address shows under it. |
| `BR-06` | In a fresh private window, open Formelab's own login page (`/login`). | The usual "Log in" page with Formelab's menu and "Join the waitlist". |

## 4. People the app is shared with or added to

| ID | Steps | Expected |
|---|---|---|
| `AU-01` | In a fresh private window, open Acme CRM and sign in as Friend with an emailed code. | Friend lands in Acme CRM. The app's top line shows Friend's email. |
| `AU-02` | In Friend's window, open Formelab's home page. | The public home page, not My apps. No sign that Friend is signed in. |
| `AU-03` | In Friend's window, open the web app's address (`app.` host) or `/connect`. | Formelab's usual **Log in** page, not My apps or the waitlist page. |
| `AU-04` | In Friend's window, close and reopen Acme CRM. | Opens without asking to sign in again. |
| `AU-05` | Repeat AU-01 as Added, in a fresh private window. | Added lands in Acme CRM with "(role: rep)". |
| `AU-06` | As Friend, open Long name. | Opens without another sign-in. |
| `AU-07` | As Friend, choose **Log in** on Formelab's home page and sign in with a code. | Friend now sees Formelab's normal waitlist page ("You're on the waitlist"), the same as any new person. Nothing mentions Acme CRM. |
| `AU-08` | As Owner, open the admin panel's Waitlist. | Friend is on it (after AU-07). Added is not. |

## 5. Someone the app hasn't added

| ID | Steps | Expected |
|---|---|---|
| `NM-01` | In a fresh private window, open Acme CRM and sign in as Stranger with a code. | A page "No access": "<Stranger> hasn't been added to Acme CRM. Ask whoever sent you the link to add you, then open it again." |
| `NM-02` | Reload, then open Formelab's home page in the same window. | Still not signed in anywhere: the home page, and Acme CRM asks to sign in again. |
| `NM-03` | As Owner, look for Stranger in the admin panel's Users and Waitlist. | Not in either. |
| `NM-04` | As Owner, add Stranger inside Acme CRM. Then, as Stranger, open it and sign in again. | Stranger lands in the app. |

## 6. Formelab accounts stay as they are

| ID | Steps | Expected |
|---|---|---|
| `FA-01` | In a fresh private window, open Acme CRM and sign in as Member. | Member lands in the app. |
| `FA-02` | In Member's window, open the web app. | Member's usual My apps, with Acme CRM under Shared with you. |
| `FA-03` | In a fresh private window, open Acme CRM and sign in as Waiting. | The app's "You don't have access to this app. Ask its owner to add your email…" page (Waiting isn't on its list). |
| `FA-04` | As Waiting, open the web app. | The waitlist page, as before. |

## 7. Admin panel

| ID | Steps | Expected |
|---|---|---|
| `AD-01` | As Owner, open the admin panel's Overview after AU-01 and AU-05. | A **People using apps** tile counts Friend (until AU-07) and Added. **People** doesn't count them. |
| `AD-02` | Open **Users**. | Added shows the tag "uses apps". Friend shows "waitlist" after AU-07. |
| `AD-03` | On the Waitlist, let Added in (if they're listed), or invite Added's email. As Added, open the web app and log in. | Added becomes a normal active account and sees My apps. |

## 8. Phone width, keyboard and screen reader

| ID | Steps | Expected |
|---|---|---|
| `AX-01` | At 375 px wide, open Acme CRM signed out. | The sign-in card fits, the title wraps, the app's address wraps instead of making the page scroll sideways. |
| `AX-02` | Sign in with the keyboard only (Tab, Enter). | Every field and button can be reached, focus is visible, and the email field has focus when the page opens. |
| `AX-03` | With VoiceOver or NVDA, open the sign-in page. | The page title and heading read "Sign in to Acme CRM", the address is read, "Powered by Formelab" is read as a link. |

## 9. Light and dark mode

| ID | Steps | Expected |
|---|---|---|
| `TH-01` | In light mode, look at BR-01's page and NM-01's page. | Readable text, the card and buttons look like Formelab's login. |
| `TH-02` | Switch the system to dark mode and repeat. | The sign-in card is in dark colors with readable text. Note how NM-01's page looks; a plain light page is a minor issue, not a blocker. |

## 10. Regression checks

| ID | Steps | Expected |
|---|---|---|
| `RG-01` | In a fresh private window, log in at Formelab's own login page as a brand new test email. | The waitlist page, and the email is on the admin Waitlist, as before. |
| `RG-02` | Run [Sign-in answers the same for every email](/test-plans/2026-11-22-signin-enumeration) cases that use the code step, from Acme CRM's sign-in page. | The same answers for every email: "If there's an account for this email, we've sent a code". |
| `RG-03` | As Owner, log out from the web app, then open Acme CRM. | Asked to sign in again, on the Acme CRM page. |
| `RG-04` | As Owner, open the admin panel signed out. | The admin login ("Formelab admin"), not an app's name. |
| `RG-05` | Open a public link to Acme CRM signed out, then press the app's sign-in (`formelab.signIn()` if the app has one) or reload `/_platform/sign-in`. | The Acme CRM sign-in page, then back to the same page in the app. |

## 11. How to report

Finish with a summary, then one block per failure.

```
Summary
  Passed: N   Failed: N   Blocked: N
  Browsers and devices covered: …

Failure
  Case: AU-03
  Signed in as: Friend
  Where: Chrome 131, macOS, 1440 wide, light mode
  Steps: what you did, exactly
  Expected: from the plan
  Actual: what happened
  Console: any errors, copied
  Screenshot: attached
  Severity: blocker | major | minor | cosmetic

Blocked
  Case: AX-03
  Missing: no screen reader on this machine
```

Severity guide: **blocker** shows an app-only account Formelab's dashboard, My apps or the waitlist page, puts an app user on the waitlist without them signing in to Formelab, keeps a record of someone the app hasn't added, or stops a member signing in to the app. **Major** is a wrong result with a workaround, or Formelab branding on the app's sign-in page. **Minor** is a small wrong behavior or an unclear message. **Cosmetic** is looks only.
