# Features page with one Save: test plan

Hands-on browser test plan for the admin panel's Features page, which now saves every feature's "Who gets it" with one **Save changes** button. Written to hand to Claude Cowork.

## 1. Instructions for the tester

- Work through every case in order. Each case has an ID (for example `FS-02`), steps, and the expected result.
- Mark each case **Pass**, **Fail** or **Blocked**. For every Fail, record what happened instead, the browser and screen size, and a screenshot.
- Reload after every save and check again. A change that doesn't survive a reload is a Fail.
- Keep the browser's developer console open. Any red JavaScript error is a Fail for the case you were on.
- Only change features on staging, and put each one back the way it was afterwards.

## 2. Setup

> **Where to test:** staging, `https://admin.formelab-staging.com/features` (see `docs/staging.md`), signed in as an admin. Never production.

Note each feature's **Who gets it** before you start, so you can put it back.

## 3. Cases

| ID | Steps | Expected |
|---|---|---|
| `FS-01` | Open the Features page. | Each feature has a **Who gets it** dropdown in its row and no Save button of its own. One **Save changes** button sits under the table. |
| `FS-02` | Without changing anything, press **Save changes**. | "Nothing to save: no feature was changed." Nothing else happens. |
| `FS-03` | Change one feature's dropdown and press **Save changes**. | "Saved 1 change. It applies right away." The page reloads and shows the new value, with today's date under Last changed. |
| `FS-04` | Change two features and press **Save changes**. | "Saved 2 changes. They apply right away." After the reload, both show their new values. |
| `FS-05` | Change a feature, then change it back to what it was, and press **Save changes**. | "Nothing to save". |
| `FS-06` | Open the admin panel's Activity. | One line per feature you changed, like "Set Connected apps to on for admins". |
| `FS-07` | Under a feature, type an email and press **Turn on for this person**. | Works as before: the person is listed under "Also on for". Then press **Remove** next to them. |
| `FS-08` | Use only the keyboard: Tab to a dropdown, change it with the arrow keys, Tab to **Save changes**, press Enter. | Focus is visible, the change is saved. |
| `FS-09` | With VoiceOver or NVDA, move to a dropdown. | It reads "Who gets <feature name>" and its value. |
| `FS-10` | At 375 px wide, open the page. | The table scrolls inside its box, and **Save changes** is reachable at the bottom. |
| `FS-11` | Switch to dark mode and reload. | Dropdowns and the button are readable. |
| `FS-12` | Put every feature back the way it was, and save. | Back to the values you noted. |

## 4. How to report

```
Summary
  Passed: N   Failed: N   Blocked: N
  Browsers and devices covered: …

Failure
  Case: FS-04
  Where: Chrome 131, macOS, 1440 wide
  Steps: what you did, exactly
  Expected: from the plan
  Actual: what happened
  Console: any errors, copied
  Screenshot: attached
  Severity: blocker | major | minor | cosmetic
```

Severity guide: **blocker** means a change isn't saved, or a feature you didn't touch changes. **Major** is a wrong message with the right result. **Minor** is unclear wording. **Cosmetic** is looks only.
