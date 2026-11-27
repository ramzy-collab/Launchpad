# Supabase person by person: test plan

Hands-on browser test plan for sending each person's identity to Supabase, step 6b of the [agent access spec](../specs/2026-11-22-agent-access.md). Written to hand to Claude Cowork. It needs a real Supabase test project, since what's tested is Supabase trusting Formelab's tokens and applying its own row-level security.

## 1. Instructions for the tester

- Work through every case in order. Each case has an ID (for example `SI-04`), steps, and the expected result.
- Mark each case **Pass**, **Fail** or **Blocked**. For every Fail, record what happened instead, which account you were using, the browser and screen size, and a screenshot.
- Only use the test accounts, the test Supabase project and the test apps below. Never point a connector at a real project.
- Use a separate browser profile (or a private window) for each account.
- After every change, reload the page and check again. A result that changes on reload is a Fail.
- Keep the browser's developer console open. Any red JavaScript error is a Fail for the case you were on. **One exception:** a refused call logs a failed request ("… 400", "… 403"). That's the refusal itself.
- If a case can't be run (no Supabase project, no second account), mark it Blocked and say what's missing. Don't skip silently.

## 2. Setup and test data

Ramzy (or whoever hands this off) prepares these before Cowork starts.

> **Where to test:** deploy the PR branch to a test Formelab and run its migrations (this PR adds `0031_connector_identity`). Supabase must be able to reach the test deploy's `/oidc/…` addresses over the internet, so local `wrangler dev` can't run these cases. Don't test on production data.

### Feature flags

- **Connected apps** (`connected_apps`) on for Owner.
- **Each person's identity sent to Supabase** (`supabase_identity`) on for Owner only.

### Accounts

| Name | Role on "Leads DB" | Notes |
|---|---|---|
| **Owner** | Owns the space `qa`, the app and the connector | Has both flags |
| **Rep A** | Share list, role `rep` | Email `rep-a@…`, matching a row in the project |
| **Rep B** | Share list, role `rep` | Email `rep-b@…`, matching a row in the project |
| **Other owner** | An account without `supabase_identity` | Owns one custom connector |

### The Supabase test project

Use `formelab-oidc-test` (ref `ulhfsaaudyvuskzfdnli`), or make another. In its SQL editor, make sure it has:

```sql
create table if not exists public.leads (id bigint generated always as identity primary key, name text not null, assigned_to text not null);
alter table public.leads enable row level security;
drop policy if exists "Own rows" on public.leads;
create policy "Own rows" on public.leads for select to authenticated
  using (auth.jwt() ->> 'email' = assigned_to or coalesce((auth.jwt() ->> 'formelab_manages')::boolean, false));
create table if not exists public.vault (id bigint generated always as identity primary key, secret text not null);
alter table public.vault enable row level security;
grant select on public.leads, public.vault to anon, authenticated;
```

Put two rows in `leads`, "Ada" assigned to Rep A's email and "Bo" assigned to Rep B's, and one row in `vault`. Copy the project's **publishable** key (Project Settings, API Keys).

### The test app

**Leads DB** (space `qa`), shared with Rep A and Rep B. Its `index.html` has a **Load leads** button that runs `formelab.connectors.fetch("db", "/rest/v1/leads?select=name")` and shows the answer's text, and a **Load vault** button for `/rest/v1/vault?select=secret`. Its `formelab.json`:

```json
{ "default_role": "rep", "records": { "note": { "prefix": "note:", "read": { "rep": "all" } } }, "sources": { "connectors": { "db": { "rep": "all" } } } }
```

As Owner, under Connected apps, **+ Custom connector**: name `db`, the publishable key, host `<ref>.supabase.co`. On Leads DB's page, Connected apps tab, let it use `db`.

## 3. Turning it on

| ID | Steps | Expected |
|---|---|---|
| `SI-01` | As Owner, open the `db` connector's page. | An **Each person's identity** section with a **Send each person's identity** switch, off. No issuer URL yet. |
| `SI-02` | Turn the switch on. | The page reloads with "On. Now add the issuer URL in Supabase." It shows the issuer URL (`https://<test deploy>/oidc/c/con_…`) with **Copy**, the Supabase steps (Third-Party Auth, Custom OIDC), a note that a role only counts in its own app, and two starter policies: first a restrictive "Only my apps" naming Leads DB's id, then "Own rows". |
| `SI-03` | Open `<issuer URL>/.well-known/openid-configuration` in a private window, then `<issuer URL>/jwks.json`. | Both open without signing in. The first names the issuer URL exactly and a `jwks_uri`. The second has one key with a `kid` and no `d` field. |
| `SI-04` | In Supabase (the test project): Authentication, Sign In / Providers, **Third-Party Auth**, Add provider, **Custom OIDC**. Paste the issuer URL. | Supabase accepts it and lists it. |

## 4. Each person sees their own rows

| ID | Steps | Expected |
|---|---|---|
| `RW-01` | As Rep A, open Leads DB and press **Load leads**. | Only "Ada". |
| `RW-02` | As Rep B, press **Load leads**. | Only "Bo". |
| `RW-03` | As Owner, press **Load leads**. | Both, since the policy lets managers see everything. |
| `RW-04` | As Rep A, press **Load vault**. | Nothing (an empty list): no policy lets anyone read it. |
| `RW-05` | As Owner, open Leads DB's Activity. | Lines for the calls through `db`, under each person. |
| `RW-07` | As Owner, make a second app, "Side app", with the same `formelab.json`, let it use `db`, and make Rep A its Editor. In Supabase, add the "Only my apps" policy from the connector's page with only Leads DB's id. As Rep A, press **Load leads** in Side app. | Nothing: Side app isn't on the policy's list, even though Rep A manages it. Without that policy, Rep A would see Bo too. |
| `RW-06` | In Supabase, change the policy to `using (false)`. As Owner, press **Load leads**. Put the policy back afterwards. | Nothing: Supabase's policies decide, not Formelab. |

## 5. Guard rails

| ID | Steps | Expected |
|---|---|---|
| `GR-01` | On the `db` connector's page, replace the key with the project's **secret** key. | Refused: "Use the project's publishable (anon) key here, not its secret or service_role key." The old key stays. |
| `GR-02` | Change its address to `api.example.com`. | Refused: it can only call a Supabase project's address. |
| `GR-03` | Turn the switch off. Open `<issuer URL>/jwks.json`. Press **Load leads** as Rep A. | The JWKS answers "Not found". Rep A gets nothing (the call no longer carries an identity, so Supabase treats it as signed out). |
| `GR-04` | Turn it on again. | A new issuer key (a different `kid` in the JWKS). Supabase picks it up within about 30 minutes; until then Load leads may fail. |
| `GR-05` | As Other owner, open their connector's page. | No **Each person's identity** section (the feature is off for them). |
| `GR-06` | As Owner, turn `supabase_identity` off for yourself (Features), then press **Load leads** as Rep A. Turn it back on afterwards. | Refused ("isn't available yet"), never sent without an identity. |
| `GR-07` | As Rep A, open the developer tools' Network tab and press **Load leads**. Look at the `/_api/connectors/db/fetch` response. | No token in it (nothing starting `eyJ`), and no key. |

## 6. Phone width, keyboard and screen reader

| ID | Steps | Expected |
|---|---|---|
| `AX-01` | At 375 px wide, open the `db` connector's page with the switch on. | The switch, the issuer URL box and the policy fit; the policy box scrolls inside itself, the page doesn't scroll sideways. |
| `AX-02` | With the keyboard only, Tab to the switch, press Space, then Tab to **Copy** and press Enter. | Focus is visible, the switch toggles, the issuer URL is copied ("Issuer URL copied"). |
| `AX-03` | With VoiceOver or NVDA, move through the section. | The switch reads "Send each person's identity" with its state, and Copy reads "Copy the issuer URL". |

## 7. Light and dark mode

| ID | Steps | Expected |
|---|---|---|
| `TH-01` | Look at the section in light mode. | Readable; the issuer box matches other link boxes. |
| `TH-02` | Switch to dark mode. | The same in dark colors, the policy box readable. |

## 8. Regression checks

| ID | Steps | Expected |
|---|---|---|
| `RG-01` | Run [Access rules over outside data](/test-plans/2026-11-24-access-rules-outside-data) cases CN-01 to CN-03 with an ordinary custom connector. | Same results: connectors without the switch work as before. |
| `RG-02` | Open `/_platform/guide.md` as Owner. | The Access rules section has "Supabase, person by person", and no `<!-- flag:` text anywhere. |
| `RG-03` | Open the guide as Other owner. | No "Supabase, person by person" part, and no `<!-- flag:` text. |

## 9. How to report

Finish with a summary, then one block per failure.

```
Summary
  Passed: N   Failed: N   Blocked: N
  Browsers and devices covered: …

Failure
  Case: RW-01
  Signed in as: Rep A
  Where: Chrome 131, macOS, 1440 wide, light mode
  Steps: what you did, exactly
  Expected: from the plan
  Actual: what happened
  Console: any errors, copied
  Screenshot: attached
  Severity: blocker | major | minor | cosmetic
```

Severity guide: **blocker** shows a person a row their policy doesn't allow, lets the connector save a secret or service key, sends a call without an identity while the switch is on, or shows the token or key to the browser. **Major** is a wrong result with a workaround. **Minor** is unclear copy. **Cosmetic** is looks only.
