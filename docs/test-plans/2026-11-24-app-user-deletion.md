# Deleting people who use apps: test plan

Hands-on browser test plan for deleting app-only accounts and handling deletion requests, part C of step 4 of the [agent access spec](../specs/2026-11-22-agent-access.md). Written to hand to Claude Cowork. Each case is run in a real browser against a test Formelab with its own sign-in (WorkOS), since app-only accounts are made by signing in to an app.

## 1. Instructions for the tester

- Work through every case in order. Each case has an ID (for example `DL-03`), steps, and the expected result.
- Mark each case **Pass**, **Fail** or **Blocked**. For every Fail, record what happened instead, which account you were using, the browser and screen size, and a screenshot.
- Only use the test accounts, inboxes and test apps below. Never look up or notify about a real person.
- Use a separate browser profile (or a private window) for each person.
- After every removal, reload the page and check again. A result that changes on reload is a Fail.
- Keep the browser's developer console open. Any red JavaScript error is a Fail for the case you were on. **One exception:** a refused request logs a failed request ("… 401", "… 403"). That's the refusal itself. Any other red line is a Fail.
- If a case can't be run (no inbox, no admin access), mark it Blocked and say what's missing. Don't skip silently.

## 2. Setup and test data

Ramzy (or whoever hands this off) prepares these before Cowork starts.

> **Where to test:** deploy the PR branch to a test Formelab with WorkOS and email sending set up, and run its migrations. Local testing with `wrangler dev --env dev --var DEV_USER:<email>` skips sign-in, so it can't make app-only accounts. Don't test on production data.

### Accounts and inboxes

| Name | What it is | Notes |
|---|---|---|
| **Owner** | Owns the space `qa` and the test apps, and is a Formelab admin | Reads Owner's inbox for the notify cases |
| **Owner 2** | An active Formelab account that owns one test app in its own space | A test inbox you can read |
| **Ada** | Never used Formelab | A test inbox. Added inside two apps |
| **Bo** | Never used Formelab | A test inbox. On one app's share list |
| **Cy** | Never used Formelab | A test inbox. Added inside one app |
| **Member** | An active Formelab account | Added inside one app |

### Test apps

Use the test app and `formelab.json` from [App members and roles](/test-plans/2026-11-24-app-members-roles).

- **CRM one** and **CRM two** in space `qa`, owned by Owner. In both, as Owner, add Ada with role `rep`. In CRM one, also add Member.
- **CRM three** in space `qa`, owned by Owner. Share it with Bo (People, Viewer). As Owner, add Cy inside it.
- **CRM four** in Owner 2's space, owned by Owner 2. As Owner 2, add Ada inside it.

Then sign in to each app once as Ada (CRM one), Bo (CRM three) and Cy (CRM three), so each gets an account that only opens apps. In the admin panel's Users, they show the tag "uses apps".

## 3. Removing someone from their last app

| ID | Steps | Expected |
|---|---|---|
| `DL-01` | As Owner, open CRM one's page in Formelab, Sharing tab, and **Remove** Ada under "Added in the app". | Ada is gone from the list. |
| `DL-02` | In the admin panel's Users, look for Ada. | Ada is still there ("uses apps"): CRM two and CRM four still list her. |
| `DL-03` | As Owner, open CRM two and remove Ada with the test app's **Remove** button (`formelab.roles.remove`). | "Removed". Ada is still in Users (CRM four lists her). |
| `DL-04` | As Owner 2, remove Ada on CRM four's page. Then, as Owner, reload the admin panel's Users. | Ada is gone from Users. |
| `DL-05` | In Ada's browser, reload CRM four. | Ada is asked to sign in again, on CRM four's sign-in page. Signing in gives "<Ada> hasn't been added to CRM four." |
| `DL-06` | As Owner, open CRM one's Activity tab. | The lines about Ada read with a stand-in like "deleted-user-…" instead of her email. No line shows Ada's email. |
| `DL-07` | As Owner, remove Member under "Added in the app" on CRM one. Check Users. | Member is still in Users with their Formelab account: Formelab accounts are never deleted this way. |

## 4. Other ways an app stops listing someone

| ID | Steps | Expected |
|---|---|---|
| `DL-08` | As Owner, on CRM three's page under People, remove Bo's access. Check Users. | Bo is gone from Users. Cy is still there. |
| `DL-09` | As Owner, delete CRM three. Check Users. | Cy is gone from Users. |
| `DL-10` | As Owner, share CRM one and CRM two with a fresh test email (People, Viewer), and sign in to CRM one as that email. Stop sharing CRM one with them, check Users, then stop sharing CRM two. | They stay in Users after the first, and are gone after the second. |
| `DL-11` | As Owner, delete a Formelab test account (Users, **Delete**) that was added inside an app. Open that app's page. | The person is no longer under "Added in the app". |

## 5. Deletion requests in the admin panel

Set up again first: add Ada inside CRM one and CRM four, and sign in to CRM one as Ada.

| ID | Steps | Expected |
|---|---|---|
| `DR-01` | As Owner, open the admin panel's Users. | A **Deletion requests** section at the top, with an email field and **Find**. |
| `DR-02` | Find Ada's email. | "Their account only opens apps." and a table with CRM one (Owner, Added in the app) and CRM four (Owner 2, Added in the app). A **Notify owners** button, and the reply to send: "We've passed your request to every business on Formelab that has your email." |
| `DR-03` | Find an email no app lists. | "No Formelab account. No app lists <email>." No Notify owners button. |
| `DR-04` | Type `not an email` and Find (bypass the browser check by editing the address bar: `?find=not+an+email`). | "That email address is not valid." |
| `DR-05` | Find Owner 2's email. | CRM four shows "Owns it". Notify owners only appears if other apps list them. |
| `DR-06` | Find Ada again and press **Notify owners**, then confirm. | A confirm question first, then "Emailed 2 owners." |
| `DR-07` | Open Owner's and Owner 2's inboxes. | One email each: "<Ada> asked to have their data deleted", naming only their own app with a link to its page, and "We didn't tell them which apps use their email." |
| `DR-08` | Follow the link in Owner 2's email. | CRM four's page in Formelab, where Ada can be removed. |
| `DR-09` | Open Ada's inbox. | Nothing from this. Formelab never emails the person who asked. |
| `DR-10` | Open the admin panel's Activity. | "Told the owners of 2 apps about a request to delete someone's data", without Ada's email. |
| `DR-11` | As a non-admin Formelab account, open the admin panel's Users address. | No access, as before. |

## 6. Phone width, keyboard and screen reader

| ID | Steps | Expected |
|---|---|---|
| `AX-01` | At 375 px wide, open the Deletion requests section with DR-02's results. | The form and table fit; the table scrolls inside its box, the page doesn't scroll sideways. |
| `AX-02` | With the keyboard only, type an email, press Enter, Tab to **Notify owners** and press Enter. | Focus is visible, the confirm question appears, Enter confirms. |
| `AX-03` | With VoiceOver or NVDA, read the section. | The email field reads "Their email", the table's headings are read, the result message is announced. |

## 7. Light and dark mode

| ID | Steps | Expected |
|---|---|---|
| `TH-01` | In light mode, look at the Deletion requests section with results. | Readable text, the table matches the other admin tables. |
| `TH-02` | Switch to dark mode and repeat. | The same in dark colors: no white boxes, no dark text on dark backgrounds. |

## 8. Regression checks

| ID | Steps | Expected |
|---|---|---|
| `RG-01` | As Owner, delete a Formelab test account in Users with **Delete**. | Works as before: its spaces and apps are deleted, it leaves share lists. |
| `RG-02` | Run [App members and roles](/test-plans/2026-11-24-app-members-roles) cases SP-01 to SP-04. | Same results. |
| `RG-03` | Run [Signing in to an app](/test-plans/2026-11-24-app-sign-in) cases AU-01 and NM-01. | Same results. |
| `RG-04` | As Owner, stop sharing an app with an active Formelab account. | They lose access to that app and keep their account. |

## 9. How to report

Finish with a summary, then one block per failure.

```
Summary
  Passed: N   Failed: N   Blocked: N
  Browsers and devices covered: …

Failure
  Case: DL-04
  Signed in as: Owner 2
  Where: Chrome 131, macOS, 1440 wide, light mode
  Steps: what you did, exactly
  Expected: from the plan
  Actual: what happened
  Console: any errors, copied
  Screenshot: attached
  Severity: blocker | major | minor | cosmetic

Blocked
  Case: DR-07
  Missing: email sending isn't set up on the test deploy
```

Severity guide: **blocker** deletes a Formelab account or someone an app still lists, keeps an app-only account after its last app removed it, shows the person's email in the activity log after they're deleted, or tells the person which apps listed them. **Major** is a wrong result with a workaround, such as an owner not emailed. **Minor** is a small wrong behavior or an unclear message. **Cosmetic** is looks only.
