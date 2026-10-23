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
   - Cases grouped by area, each with an ID (`AREA-NN`), exact steps and the expected result,
     covering the happy path, every role and permission, edge cases and errors, phone width,
     keyboard and screen reader use, light and dark mode, and regressions in pages that share code.
   - A report format with severities (blocker, major, minor, cosmetic).
2. Add one line to that feature's `CHANGELOG.md` entry, linking the plan:
   `- **Test plan:** [<Feature name>](https://github.com/ramzy-collab/Launchpad/blob/main/docs/test-plans/<file>.md), N browser test cases to hand to Claude Cowork.`
   The admin panel's Changelog renders the link.
3. Link the plan in the PR description, and also publish it as a page with a "Copy plan for
   Cowork" button when the session can publish artifacts, and give Ramzy the link.

## UI copy

Follow the Formelab design system (`--fl-*` tokens in `src/dashboard/formelab.css`), plain
language and one primary action per screen. Never use em dashes in UI copy.
