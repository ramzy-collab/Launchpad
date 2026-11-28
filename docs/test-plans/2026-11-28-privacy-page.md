# Privacy page: test plan

Hands-on browser test plan for Formelab's privacy page at `/privacy`. Written to hand to Claude Cowork.

## 1. Instructions for the tester

- Work through every case in order. Each case has an ID (for example `PV-02`), steps, and the expected result.
- Mark each case **Pass**, **Fail** or **Blocked**. For every Fail, record what happened instead, the browser and screen size, and a screenshot.
- Keep the browser's developer console open. Any red JavaScript error is a Fail for the case you were on.
- If a case can't be run, mark it Blocked and say what's missing. Don't skip silently.

## 2. Setup

> **Where to test:** staging (`https://formelab-staging.com`, see `docs/staging.md`) with this branch deployed, or `wrangler dev --env dev --var DEV_USER:<email>` for the cases that don't need an app's sign-in page. Don't test on production data.

For PV-06 you need an app shared with a test account that has never signed in, on staging (its sign-in page needs WorkOS).

## 3. Cases

| ID | Steps | Expected |
|---|---|---|
| `PV-01` | Signed out, in a private window, open `/privacy`. | The page opens without signing in. Title "Privacy · Formelab", a "Last updated" date, and sections: What we keep about you, People who use apps built on Formelab, Who else handles it, Google user data, Cookies, Keeping and deleting, Keeping it safe, Changes, Contact. |
| `PV-02` | Open the home page and scroll to the bottom. | The footer has **Privacy** next to Log in, and it opens `/privacy`. |
| `PV-03` | On the privacy page, click the contact email. | Your mail app opens a message to the address shown. |
| `PV-04` | Click the Google API Services User Data Policy link. | Google's policy page opens. |
| `PV-05` | Read the page for dashes: look for long dashes (—) anywhere. | None. |
| `PV-06` | In a private window, open the test app's address so its sign-in page appears ("Sign in to <app>"). | Under the form: "Powered by Formelab · Privacy". **Privacy** opens `/privacy` on Formelab's own address. |
| `PV-07` | At 375 px wide, open `/privacy`. | The text fits, no sideways scrolling, the card has comfortable margins. |
| `PV-08` | Use only the keyboard: Tab through the page. | Focus moves through the logo, the links in the text, and the footer links, and is visible on each. |
| `PV-09` | With VoiceOver or NVDA, move through the headings (H key or rotor). | One level-1 heading "Privacy", then the sections as level-2 headings. |
| `PV-10` | Switch the system to dark mode and reload. | The page stays in its light design, readable, like the home page (the public pages are light only by design). |

## 4. How to report

```
Summary
  Passed: N   Failed: N   Blocked: N
  Browsers and devices covered: …

Failure
  Case: PV-06
  Where: Chrome 131, macOS, 1440 wide
  Steps: what you did, exactly
  Expected: from the plan
  Actual: what happened
  Console: any errors, copied
  Screenshot: attached
  Severity: blocker | major | minor | cosmetic
```

Severity guide: **blocker** means the page doesn't open signed out or a link from sign-in doesn't reach it. **Major** is a wrong or missing section. **Minor** is unclear wording. **Cosmetic** is looks only.
