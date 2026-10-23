# Working on Formelab

## Every feature PR ships with a test plan

When a PR adds or changes a feature people can see or use (not refactors, dependency bumps or
internal fixes):

1. Write a hands-on browser test plan at `docs/test-plans/YYYY-MM-DD-<feature>.md`, using
   `docs/test-plans/2026-10-23-settings-redesign-phase-1.md` as the model. It is written to be
   handed to Claude Cowork, which runs it in a real browser, so it needs:
   - Instructions for the tester (mark Pass, Fail or Blocked; reload after saves; console errors
     are failures; only touch test data).
   - Setup: the accounts, feature flags and test apps to prepare, and where to test (a test deploy
     or `wrangler dev --env dev --var DEV_USER:<email>`, never production data).
   - Cases grouped by area, each with an ID of two letters and two digits (`MA-04`), exact steps and the expected result,
     covering the happy path, every role and permission, edge cases and errors, phone width,
     keyboard and screen reader use, light and dark mode, and regressions in pages that share code.
   - A report format with severities (blocker, major, minor, cosmetic).
2. The plan shows up in the admin panel under **Test plans** (`/test-plans/<file name without .md>`)
   once deployed: the files are bundled at build time, and results are recorded there (Pass, Fail,
   Blocked and a note per case, or pasted in with Import results). Case IDs must look like `MA-04`
   and sit in tables whose first column is headed `ID`, or the page can't track them.
3. Add one line to that feature's `CHANGELOG.md` entry, linking the plan's admin page:
   `- **Test plan:** [<Feature name>](/test-plans/<file name without .md>), N browser test cases to hand to Claude Cowork.`
4. Link the plan's admin page in the PR description.

## UI copy

Follow the Formelab design system (`--fl-*` tokens in `src/dashboard/formelab.css`), plain
language and one primary action per screen. Never use em dashes in UI copy.
