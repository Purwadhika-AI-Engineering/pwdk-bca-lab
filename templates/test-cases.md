# Test cases: <feature>

Source: `docs/PRD.md`. Fill this template and save it as `docs/test-cases.md`.

| ID | Scenario | Input | Expected | Level | Suite |
|----|----------|-------|----------|-------|-------|
| T1 | <what is tested, in plain words> (R<n>) | <data or action> | <status, errorCode or screen result> | Unit / API / UI | smoke / regression |

## Rules for filling it

- One row per test case. IDs go T1, T2, T3… and never change once used.
- Scenario: plain words, then the PRD rule ID in brackets, e.g. `Amount below minimum (R3)`.
- Include edge cases for every limit: just below, at and just above it (9.999 · 10.000 · 10.001).
- Include negative cases: wrong input, another user's account, no token.
- Expected: the exact HTTP status and `errorCode` for API rows, the exact message or page for UI rows.
- Level: `Unit`, `API` or `UI`. A rule can have more than one row at different levels.
- Suite: leave empty in Session 1. Fill it in Session 2 (`smoke` or `regression`).
- Use the demo users and accounts from `README.md` only.

## Not testable or unclear

List each rule that is too vague to test, and the question to ask the business.

| Rule | Question |
|------|----------|
| R<n> | <question> |
