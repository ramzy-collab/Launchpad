# App members and roles: test plan

Hands-on browser test plan for app members and roles managed inside an app (`formelab.roles`), part A of step 4 of the [agent access spec](../specs/2026-11-22-agent-access.md). Written to hand to Claude Cowork. Each case is run in the browser, in a small test app that shows who you are, manages its members and reads and writes records, so roles can be checked person by person. The branded "Sign in to <app>" page is part B and isn't tested here: people sign in with Formelab's own sign-in for now.

## 1. Instructions for the tester

- Work through every case in order. Each case has an ID (for example `MA-04`), steps, and the expected result.
- Mark each case **Pass**, **Fail** or **Blocked**. For every Fail, record what happened instead, which account you were signed in as, the browser and screen size, and a screenshot.
- Only use the test accounts and the test apps below. Never open, change or delete data in an app outside the test space.
- Use a separate browser profile (or a private window) for each account, so you're signed in as the right person. The test app shows who you are and your role at the top: check it before each case.
- After every save, reload the page and check again. A change that shows but doesn't survive a reload is a Fail.
- Keep the browser's developer console open. Any red JavaScript error is a Fail for the case you were on. **One exception:** a refused call logs a failed request ("… 400", "… 403" or "… 409"). That's the refusal itself. Any other red line is a Fail.
- If a case can't be run (missing account, no second browser), mark it Blocked and say what's missing. Don't skip silently.

## 2. Setup and test data

Ramzy (or whoever hands this off) prepares these before Cowork starts.

> **Where to test:** deploy the PR branch to a test Formelab and run its migrations first (`npm run db:migrate:remote` against the test database; this PR adds `0029_app_members`). Local testing (`npm run db:migrate:local`, then `wrangler dev --env dev --var DEV_USER:<email>`) signs in one person only, so it covers just the Owner cases. Don't test on production data.

### Accounts

| Name | Role on "Members CRM" | Notes |
|---|---|---|
| **Owner** | Owns the space `qa` and both test apps | |
| **Admin** | Editor who may share (Admin in the People list) | Has a Formelab account |
| **Editor** | Editor who may not share | Has a Formelab account |
| **Boss** | In the share list (Viewer) | Has a Formelab account. Made a manager inside the app in MA-01 |
| **Rep** | In the share list (Viewer) | Has a Formelab account |
| **Newcomer** | Not in the share list | An email that has never used Formelab. Gets in only by being added inside the app |
| **Guest** | Not signed in | A private window, opening the public link |

### The test app

Save this as `index.html`. It shows who you are, lists and changes the app's members, and saves leads.

```html
<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Members test</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'%3E%3Ccircle cx='5' cy='5' r='5' fill='%235B4CF5'/%3E%3C/svg%3E">
<script src="/_platform/sdk.js"></script>
<style>body{font:16px system-ui;margin:16px;max-width:640px}input{width:100%;box-sizing:border-box;font:inherit;margin:4px 0 8px}pre{background:#f2f2f2;padding:8px;white-space:pre-wrap}#out{font-weight:600}</style></head>
<body><p>Signed in as: <span id="me">…</span></p>
<h2>Members</h2>
<label>Email <input id="email"></label>
<label>Role <input id="role" value="rep"></label>
<button id="set">Add or change</button> <button id="remove">Remove</button> <button id="list">List</button> <button id="invite">Copy invite link</button>
<pre id="people"></pre>
<h2>Leads</h2>
<label>Lead name <input id="lead" value="Ada"></label>
<label>Assigned to <input id="to"></label>
<button id="save">Save lead</button> <button id="leads">Show leads</button>
<pre id="rows"></pre>
<p id="out" role="status"></p>
<script>
const $ = (id) => document.getElementById(id);
const say = (t) => { $("out").textContent = t; };
const fail = (e) => say("Error: " + (e.code || "") + " " + e.message);
$("set").onclick = async () => { try { const m = await formelab.roles.set($("email").value, $("role").value); say("Saved: " + m.email + " is " + m.role); } catch (e) { fail(e); } };
$("remove").onclick = async () => { try { await formelab.roles.remove($("email").value); say("Removed"); } catch (e) { fail(e); } };
$("list").onclick = async () => { try { const p = await formelab.roles.list(); $("people").textContent = p.map((x) => x.email + " | " + (x.manages ? "manages" : x.role) + (x.member ? " | added in the app" : "")).join("\n"); say("Listed " + p.length); } catch (e) { $("people").textContent = ""; fail(e); } };
$("invite").onclick = async () => { await navigator.clipboard.writeText(location.origin); say("Invite link copied"); };
$("save").onclick = async () => { try { await formelab.kv.set("lead:" + $("lead").value, { name: $("lead").value, assignedTo: $("to").value }); say("Saved"); } catch (e) { fail(e); } };
$("leads").onclick = async () => { try { const r = await formelab.kv.list("lead:"); $("rows").textContent = r.map((x) => x.value.name + " | " + x.value.assignedTo).join("\n") || "(nothing)"; say("Read " + r.length); } catch (e) { fail(e); } };
formelab.me().then((m) => { $("me").textContent = m ? m.email + " (role: " + (m.manages ? "manages the app" : m.role || "none") + ")" : "a guest (public link)"; $("to").value = m ? m.email : ""; });
</script></body></html>
```

### Test apps (space `qa`)

Each is a zip with the test app's `index.html` and a `formelab.json`.

**Members CRM** (mount `members-crm`). Publishing asks "People using this app can invite anyone": choose **Publish anyway**. Then, in its People list, add Admin as Admin, Editor as Editor, and Boss and Rep as Viewers. Turn on its public link.

```json
{
  "default_role": "rep",
  "manage_roles": ["manager"],
  "records": {
    "lead": { "prefix": "lead:", "fields": ["name", "assignedTo"], "owner_field": "assignedTo", "read": { "manager": "all", "rep": "own" }, "write": { "manager": "all", "rep": "own" } }
  }
}
```

**Open board** (mount `open-board`), shared with Rep:

```json
{ "everyone": "all" }
```

## 3. Adding people and giving roles

| ID | Steps | Expected |
|---|---|---|
| `MA-01` | As Owner, open Members CRM. Email: Boss's email, role `manager`, **Add or change**. Reload. | "Saved: <Boss> is manager". As Boss, the top line reads "(role: manager)". |
| `MA-02` | As Newcomer, open Members CRM's address. Sign in when asked. | Formelab's sign-in, then "You don't have access to this app" (or the app refuses with 403). |
| `MA-03` | As Boss, add Newcomer with role `rep`. As Newcomer, reload the app. | Boss sees "Saved: <Newcomer> is rep". Newcomer now opens the app; the top line reads "(role: rep)". |
| `MA-04` | As Boss, press **List**. | Owner, Admin and Editor show "manages". Boss shows "manager \| added in the app", Rep shows "rep", Newcomer "rep \| added in the app". |
| `MA-05` | As Boss, change Newcomer's role to `manager`. As Newcomer, reload. | Newcomer's top line reads "(role: manager)". |
| `MA-06` | As Boss, press **Copy invite link** and paste it in a new tab. | The app's own address (`https://…formelab.app`), nothing else. No email was sent to anyone. |
| `MA-07` | As Boss, enter Newcomer's email in capitals with spaces around it, role `rep`, **Add or change**, then **List**. | One Newcomer entry, in lower case, role rep. No duplicate. |

## 4. Roles decide what people see and change

| ID | Steps | Expected |
|---|---|---|
| `RL-01` | As Owner, save a lead "Ada" assigned to Rep, and "Bo" assigned to Newcomer. | Both saved. |
| `RL-02` | As Rep, **Show leads**. | Only Ada. |
| `RL-03` | As Newcomer with role `rep` (set it back if MA-05 made them manager), **Show leads**. | Only Bo. |
| `RL-04` | As Boss (manager), **Show leads**. | Ada and Bo. |
| `RL-05` | As Rep, save a lead "Cy" assigned to Boss. | "Error: not_allowed You can only save records with your own email…". |
| `RL-06` | As Owner, give Rep the role `manager`. As Rep, reload and **Show leads**. | Ada and Bo: a role given in the app overrides `default_role`. |
| `RL-07` | As Owner, remove Rep (email: Rep, **Remove**). As Rep, reload and **Show leads**. | Rep still opens the app (they're on the share list), with "(role: rep)", and sees only Ada again. |

## 5. Who may manage people

| ID | Steps | Expected |
|---|---|---|
| `MP-01` | As Rep, press **List**. | "Error: not_allowed You can't change who uses this app." |
| `MP-02` | As Rep, try to add Newcomer as `manager`. | The same not_allowed error. Newcomer's role is unchanged (check with List as Boss). |
| `MP-03` | As Rep, try to remove Boss. | The same not_allowed error. Boss is still a manager. |
| `MP-04` | As Editor, add a new test email as `rep`, then remove it. | Both work: editors manage people in the app. |
| `MP-05` | As Guest (public link, signed out), press **List**, then try **Add or change**. | Both fail with "Error: sign_in_required …". The top line reads "a guest (public link)". |
| `MP-06` | As Owner, remove Boss. As Boss, reload and press **List**. | Boss is back on role rep and gets not_allowed. |

## 6. Errors

| ID | Steps | Expected |
|---|---|---|
| `ER-01` | As Owner, add Newcomer with role `intern`. | "Error: role_unknown "intern" isn't one of this app's roles." and names manager and rep. |
| `ER-02` | As Owner, add Newcomer with role `guest`. | role_unknown. |
| `ER-03` | As Owner, add `not an email` with role `rep`. | "Error: bad_request … isn't an email address." |
| `ER-04` | As Owner, give Editor the role `rep`. | "Error: manages_app … is this app's owner or an editor, so they already see and change everything." |
| `ER-05` | As Owner, remove an email that was never added. | "Error: not_found …". |
| `ER-06` | As Owner, open Open board and press **List**, then add Rep as `rep`. | Both fail with "Error: roles_unavailable This app has no roles to give people." |
| `ER-07` | As Boss (manager again), press **Add or change** 25 times quickly. | After about 20: "Error: rate_limited You changed people in this app more than 20 times in a minute." A minute later it works again. The Owner has no such limit. |

## 7. The member list on the app's settings page

| ID | Steps | Expected |
|---|---|---|
| `SP-01` | As Owner, add Newcomer as `rep` in the app. In Formelab, open Members CRM's page, Sharing tab. | Under People, "Added in the app" lists Newcomer with "rep" and a **Remove** button. Boss shows there too if still a manager. |
| `SP-02` | Press **Remove** next to Newcomer. | A dialog: "Remove <Newcomer>?" with "They can't open the app any more, unless you also shared it with them here. Data they saved in it stays." and **Keep them** / **Remove this person**. |
| `SP-03` | Press **Keep them**. | The dialog closes, Newcomer is still listed. |
| `SP-04` | Press **Remove** again, then **Remove this person**. Reload. | A toast "<Newcomer> was removed from the app". Newcomer is gone after reload. As Newcomer, reloading the app now refuses them. |
| `SP-05` | Remove everyone under "Added in the app". | The heading and its line disappear with the last person. Reload: still gone. |
| `SP-06` | As Admin, open the page. | The list and **Remove** buttons show, and removing works. |
| `SP-07` | As Editor (not allowed to share), open the page. | The list shows without **Remove** buttons. |
| `SP-08` | Open the Activity tab. | Lines like "<Boss> gave <Newcomer> the role rep in the app" and "You removed <Newcomer> from the app's members". No values of records. |
| `SP-09` | Open an app with no one added in it. | No "Added in the app" section. |

## 8. Phone width, keyboard and screen reader

| ID | Steps | Expected |
|---|---|---|
| `AX-01` | At 375 px wide, open Members CRM's settings page with two people added in the app. | Each row fits: email wraps or truncates, the **Remove** button stays visible, no sideways scrolling. |
| `AX-02` | With the keyboard only, Tab to a **Remove** button, press Enter, then Tab through the dialog and press Escape. | Focus is visible on each control, the dialog opens with focus inside it, Escape closes it. |
| `AX-03` | Open the dialog again with Enter and choose **Remove this person** with Enter. | The person is removed and the toast is announced. |
| `AX-04` | With VoiceOver or NVDA, move through "Added in the app". | The list is announced with its heading. Each button reads "Remove <email>", not just "Remove". The dialog reads its title. |

## 9. Light and dark mode

| ID | Steps | Expected |
|---|---|---|
| `TH-01` | In light mode, look at "Added in the app" and the remove dialog. | Readable text; **Remove this person** is the red (danger) button, **Keep them** the plain one. |
| `TH-02` | Switch to dark mode and repeat. | The same in dark colors: no white boxes, no dark text on dark backgrounds. |

## 10. Regression checks

| ID | Steps | Expected |
|---|---|---|
| `RG-01` | Run [Access rules inside apps](/test-plans/2026-11-22-access-rules-in-apps) cases RD-03, WR-03 and NR-02. | Same results: people on the share list still get `default_role`. |
| `RG-02` | On Members CRM's settings page, invite a new Viewer, change a role, and remove one in **People**. | Works as before; the "Added in the app" list is unchanged by it. |
| `RG-03` | As Owner, delete a copy of Members CRM that has people added in it. | Deleted. Those people can't open anything at its address. |
| `RG-04` | Open `/guide#access-rules`. | A "Members and roles" part shows `formelab.roles.set`, `remove` and `list`, and **Copy invite link**. The `formelab.me()` part mentions `role` and `manages`. |
| `RG-05` | In an app with no `formelab.json`, shared with Rep, open it as Rep. | Opens as before. The top line reads "(role: none)". |

## 11. How to report

Finish with a summary, then one block per failure.

```
Summary
  Passed: N   Failed: N   Blocked: N
  Browsers and devices covered: …

Failure
  Case: MA-03
  Signed in as: Boss
  Where: Chrome 131, macOS, 1440 wide, light mode
  Steps: what you did, exactly
  Expected: from the plan
  Actual: what happened
  Console: any errors, copied
  Screenshot: attached
  Severity: blocker | major | minor | cosmetic

Blocked
  Case: AX-04
  Missing: no screen reader on this machine
```

Severity guide: **blocker** lets someone open the app or see records their role may not, lets a role that may not manage people change roles, or leaves a removed person able to open the app. **Major** is a wrong result with a workaround, or a refusal of something the rules allow. **Minor** is a small wrong behavior or an unclear message. **Cosmetic** is looks only.
