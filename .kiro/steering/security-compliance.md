# Security and compliance

Source: `docs/team-rules.md` section 6. Product rules (R1–R14) and error codes: `docs/PRD.md`.

- MUST check that the account belongs to the logged-in user on every account and transfer endpoint. Otherwise return 403 (PRD R2).
- MUST use parameterized queries. MUST NOT build SQL by joining strings.
- MUST NOT return stack traces or raw exception messages to the client.
- MUST NOT put secrets (keys, passwords, tokens) in code or `application.properties`. Read them from environment variables.
- MUST hash passwords with a salted, slow hash (bcrypt or Argon2), never plain SHA-256 or MD5.
- MUST show user text (such as the transfer note) as plain text. MUST NOT use `innerHTML` or `bypassSecurityTrust*` for it (PRD R13).
- MUST NOT add a package with a known high or critical `npm audit` finding.

## Check

| Task | Command (folder) |
|---|---|
| Dependency check | `npm audit` (`frontend`) |
