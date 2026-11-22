# Sign-in answers the same for every email: test plan

Hands-on browser test plan for the sign-in change that stops the login page passing on WorkOS's own error messages, written to hand to Claude Cowork. The goal: someone typing emails into Formelab's login page can't tell which ones have an account. Each case compares what an email **with** an account and an email **without** one see.

## 1. Instructions for the tester

- Work through every case in order. Each case has an ID (for example `SC-04`), steps, and the expected result.
- Mark each case **Pass**, **Fail** or **Blocked**. For every Fail, record what happened instead, the browser and screen size, and a screenshot.
- **"The same page"** means the same heading, text, fields, buttons and messages, apart from the email address shown in it. Compare screenshots side by side. Any other difference, however small, is a Fail: write down exactly what differs.
- Only use the test accounts below, in the WorkOS **staging** environment. Never use real people's emails or the production WorkOS environment.
- Keep the browser's developer console open. Any red error in the console is a Fail for the case you were on.
- Several cases send real sign-in codes. Read them from the test mailbox. Never paste a code anywhere except the Formelab code field.
- WorkOS allows about 3 codes a minute per email. Between cases that send a code to the same email, wait at least 30 seconds, except in the rate-limit cases.
- If a case can't be run (no two-factor account, no SSO domain, no mailbox access), mark it Blocked and say what's missing. Don't skip silently.

## 2. Setup and test data

Ramzy (or whoever hands this off) prepares these before Cowork starts.

> **Where to test:** a test deploy of the PR branch whose WorkOS keys are the **staging** environment's, or locally: in `.dev.vars` set the staging `WORKOS_CLIENT_ID` and `WORKOS_API_KEY` (`sk_test_...`) and **remove `DEV_USER`**, then `npm run dev` and open `http://localhost:8787/login`. Never production data.

### Accounts (WorkOS dashboard, staging environment, Users)

| Name | What it is | Mailbox |
|---|---|---|
| **A, password** | A user with a password, email verified | Cowork can read it |
| **B, no password** | A user with no password, email verified | Cowork can read it |
| **C, unverified** | A user with a password, email **not** verified | Cowork can read it |
| **D, two-factor** | A user with a password, enrolled in two-factor (optional) | Cowork can read it |
| **E, unknown** | An unused address on a domain you own, with **no** user | Cowork can read it |
| **F, unknown SSO** | An unused address on a domain with an SSO connection in staging (optional) | Not needed |
| **G, dead domain** | `enum-check@x.invalid`, no user | Not needed |

Plus addresses work (for example `you+a@yourdomain.com`). Give Cowork the passwords for A, C and D, and access to their mailbox.

### WorkOS settings (dashboard, staging, Authentication)

- Email + Magic Auth and Email + Password on.
- **Sign up** on for sections 3 to 7. Section 8 turns it off and repeats the key cases.
- Cowork needs to see the staging **Users** list, to check whether a user was created, and to change the Sign up setting for section 8. If it can't, Ramzy does those two things when asked.

### Before each case

Open the login page in a fresh private window, so no earlier sign-in or cookie affects it.

## 3. Asking for a code

On the login page: type the email, choose **Continue with email**, then **Email me a code instead**.

| ID | Steps | Expected |
|---|---|---|
| `SC-01` | Ask for a code for **A**. | "Check your email" page: "If there's an account for (A's email), we've sent a code. It works once and expires in 10 minutes." A code arrives in A's mailbox. |
| `SC-02` | Ask for a code for **B**. | The same page as `SC-01`. A code arrives. |
| `SC-03` | Ask for a code for **E** (no account). | The same page as `SC-01`. Note whether a code arrives (with Sign up on, WorkOS may send one). |
| `SC-04` | After `SC-03`, open the WorkOS staging **Users** list and search for E. | Record whether a user now exists for E. Either answer is a Pass; write it down. If one exists, delete it before going on, so E stays an email with no account. |
| `SC-05` | Ask for a code for **G** (`enum-check@x.invalid`). | The same page as `SC-01`. No error about the domain. |
| `SC-06` | Ask for a code for **F** (SSO domain). | The same page as `SC-01`. If it differs, record exactly how. |
| `SC-07` | On the "Check your email" page for A, view the page source and the network tab. | No 6 to 8 digit code appears anywhere in the page, its cookies or its network answers. |
| `SC-08` | Ask for a code for **A** four times within one minute. | The fourth (or whichever WorkOS refuses) shows the login page with "Too many attempts. Try again in a minute." No other wording. |
| `SC-09` | Wait a minute, then ask for a code for **E** four times within one minute. | If one is refused, the message is exactly the same as in `SC-08`. If none is refused, record that. |

## 4. Logging in with a code

| ID | Steps | Expected |
|---|---|---|
| `CL-01` | Ask for a code for **A**, enter the real code. | Logged in; lands in the web app. |
| `CL-02` | Ask for a code for **A**, enter `000000`. | The code page again with "That code is invalid or expired." |
| `CL-03` | Ask for a code for **E**, enter `000000`. | The same page and message as `CL-02`. |
| `CL-04` | For **A**, enter a code you already used in `CL-01`. | "That code is invalid or expired." |
| `CL-05` | Ask for a code for **A**, wait 11 minutes, enter it. | "That code is invalid or expired." (or "That took too long. Enter your email to start again." if the page's own 15-minute window ran out; either is a Pass). |
| `CL-06` | Ask for a code for **A**, enter `000000` six times in a row. | Every attempt reads "That code is invalid or expired.", or "Too many attempts. Try again in a minute." once WorkOS stops it. Never WorkOS's own wording. |
| `CL-07` | With Sign up on, ask for a code for **E** and enter the real one if it arrived (Blocked if none arrived). | Logged in as a new person on the waitlist (they see the waitlist state, not the full web app). Afterwards delete the user for E in WorkOS staging and the waitlist entry in Formelab's admin panel. |

## 5. Logging in with a password

On the login page: type the email, choose **Continue with email**, type the password, choose **Log in**.

| ID | Steps | Expected |
|---|---|---|
| `PW-01` | **A** with the right password. | Logged in. |
| `PW-02` | **A** with `wrong-pass-123`. | The password page again: "That password isn't right. Try again, or choose Email me a code." |
| `PW-03` | **E** (no account) with `wrong-pass-123`. | The same page and message as `PW-02`. |
| `PW-04` | **B** (no password) with `wrong-pass-123`. | The same page and message as `PW-02`. |
| `PW-05` | **C** (unverified) with `wrong-pass-123`. | **Key check.** The same page and message as `PW-02` is a Pass. If instead it shows "Check your email" asking to confirm the address, mark it **Fail, major**: WorkOS asks for the extra step before checking the password, so the page reveals that C's account exists. Screenshot it. |
| `PW-06` | **C** with the right password. | "Check your email": "To confirm it's your email address, enter the code we sent to (C's email)." A code arrives; entering it logs C in. |
| `PW-07` | **D** (two-factor) with `wrong-pass-123`. | **Key check.** The same page and message as `PW-02` is a Pass. If it shows "Your account needs another sign-in step." instead, mark it **Fail, major** (same reason as `PW-05`). |
| `PW-08` | **D** with the right password. | The login page with "Your account needs another sign-in step." and a "Continue on the secure sign-in page" link, which leads to WorkOS's page for the two-factor code. |
| `PW-09` | **F** (SSO domain) with `wrong-pass-123`. | Record what it shows. "Your account needs another sign-in step." is expected for an SSO domain whether or not the person has an account (it depends on the domain), so it's a Pass either way; note it. |
| `PW-10` | **A** with a wrong password repeatedly until refused (up to 10 tries). | Every try reads as `PW-02`, until "Too many attempts. Try again in a minute." Never WorkOS's own wording. |

## 6. Forgot password

On the login page: **Continue with email**, then **Forgot password?**.

| ID | Steps | Expected |
|---|---|---|
| `FP-01` | Enter **A**, choose **Email me a reset link**. | "Check your email": "If there's a Formelab account for (A's email), we've sent it a link to choose a new password." The email arrives. |
| `FP-02` | Enter **E**. | The same page as `FP-01`. No email arrives. |
| `FP-03` | Open the link from `FP-01` and choose a new password that's too short or too common. | WorkOS's reason why it was refused is shown (kept on purpose: this page needs the emailed link, so it reveals nothing). Then set a good one: "Password saved." |

## 7. Screens, keyboard and screen reader

| ID | Steps | Expected |
|---|---|---|
| `UX-01` | At 375px wide (phone), go through `SC-01` and `CL-02`. | Text wraps, nothing overflows sideways, the message sits above the code field, buttons are full width and easy to tap. |
| `UX-02` | Repeat `SC-01`, `CL-02` and `PW-02` in dark mode, then light mode. | All text, including the red message box, is readable in both. |
| `UX-03` | Using only the keyboard (Tab, Shift+Tab, Enter), ask for a code for A and enter a wrong one. | Every field and button is reachable in a sensible order with a visible focus ring; the code field has focus when the code page opens. |
| `UX-04` | With VoiceOver (Mac) or NVDA (Windows), enter a wrong code. | "That code is invalid or expired." is announced straight away (it's an alert). |
| `UX-05` | With the screen reader, ask for a code. | The "If there's an account for (the email), we've sent a code" sentence is read out when the page opens or when moving to it. |
| `UX-06` | Read every message in sections 3 to 6. | Plain language, no em dashes, no technical codes (like `sign_up_not_allowed`), no WorkOS wording. |

## 8. With "Sign up" off

Turn **Sign up** off in the WorkOS staging Authentication settings (or ask Ramzy to). Then:

| ID | Steps | Expected |
|---|---|---|
| `SO-01` | Repeat `SC-01` (A) and `SC-03` (E). | Both show the same "If there's an account" page. A gets a code; E doesn't. |
| `SO-02` | Repeat `CL-02` (A, `000000`) and `CL-03` (E, `000000`). | Both show "That code is invalid or expired." |
| `SO-03` | Repeat `PW-02` (A) and `PW-03` (E). | Both show the same wrong-password page. |
| `SO-04` | Repeat `FP-01` (A) and `FP-02` (E). | The same page for both. |
| `SO-05` | Repeat `SC-05` (G). | The same "If there's an account" page. |
| `SO-06` | Turn **Sign up** back on when done. | Setting restored. |

## 9. Regression checks

| ID | Steps | Expected |
|---|---|---|
| `RG-01` | On the login page, choose **Continue with Google**. | Goes to Google's sign-in, as before. |
| `RG-02` | Log in as A with an emailed code, log out, return to the login page. | "Last used" shows next to **Continue with email**. |
| `RG-03` | On the password page for any email. | The tip "New here, or haven't set a password? Choose Email me a code." shows for every email, A, B and E alike. |
| `RG-04` | Open the admin panel's login (`admin.` address) and log in as a non-admin (A). | "Not an admin", as before. |
| `RG-05` | Signed in as A, set a password under Password in the account menu, using a too-short one first. | The reason it was refused shows, then a good one saves. |
| `RG-06` | Post the login form many times quickly from one browser (about 20 submits in a minute). | Formelab's own limit answers "Too many attempts. Try again in a minute." |

## 10. How to report

Finish with a summary, then one block per failure.

```
Summary
  Passed: N   Failed: N   Blocked: N
  Where tested: test deploy URL or localhost, WorkOS staging
  Browsers and devices covered: …
  Key checks: PW-05 (unverified, wrong password): same page? yes/no
              PW-07 (two-factor, wrong password): same page? yes/no
              SC-04 (code for an unknown email created a user?): yes/no

Failure
  Case: PW-05
  Where: Chrome 131, macOS, 1440 wide, dark mode
  Steps: what you did, exactly
  Expected: from the plan
  Actual: what happened (side-by-side screenshots for "same page" cases)
  Console: any errors, copied
  Screenshot: attached
  Severity: blocker | major | minor | cosmetic

Blocked
  Case: PW-07
  Missing: no two-factor test account
```

Severity guide: **blocker** lets anyone tell which emails have an account for every email (for example, a message that only unknown emails get), or stops people signing in. **Major** reveals accounts of one kind (unverified, two-factor), or a wrong result with a workaround. **Minor** is a small wrong behavior. **Cosmetic** is wording or looks only.
