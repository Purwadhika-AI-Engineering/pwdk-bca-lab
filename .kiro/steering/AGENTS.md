# AGENTS.md: Lab Bank transfer app

Training sample banking app with made-up data. Users log in, check their balance, and transfer money to another account at Lab Bank or at another bank.

Source of these rules: `docs/team-rules.md` sections 1–4. Product rules (R1–R14) and error codes: `docs/PRD.md`.

## Project

| Folder | What it is |
|---|---|
| `backend/` | Spring Boot 3.5, Java 17, Maven (`mvnw`), H2 in-memory database, Flyway. Port 8080 |
| `frontend/` | Angular 17 (standalone components), Jasmine + Karma. Port 4200, `/api` proxied to the backend via `proxy.conf.json` |
| `docs/PRD.md` | Product rules for the transfer feature |
| `docs/team-rules.md` | Team coding, test and security rules |
| `postman/` | Postman collection and the `sit` environment |

## 1. Commands

| Task | Command (folder) |
|---|---|
| Run backend | `./mvnw spring-boot:run` (`backend`) |
| All backend tests | `./mvnw test` (`backend`) |
| One backend test | `./mvnw test -Dtest=TransferServiceTest` (`backend`) |
| Frontend tests | `npm test -- --watch=false` (`frontend`) |
| Frontend build | `npm run build` (`frontend`) |

On Windows, use `.\mvnw.cmd` instead of `./mvnw`.

## 2. Money

- MUST use `BigDecimal` for money, scale 2, rounding `HALF_EVEN`. Why: `double` loses cents, and `HALF_UP` adds up in the bank's favor over many transfers (PRD R11).
- MUST return all API amounts in rupiah, never in cents (PRD R11).
- MUST keep debit and credit in one transaction (`@Transactional`). Why: if one fails, neither may be saved (PRD R9).

## 3. Personal data (PII) and logging

- MUST NOT write account numbers or NIK to logs in clear text. Mask them: `******7890` (PRD R12).
- MUST NOT log passwords, tokens or full request bodies.
- MUST mask account numbers on screen (PRD R12).

## 4. Code changes

- MUST NOT add a new Maven or npm dependency without approval in the pull request.
- MUST NOT edit files in `backend/src/main/resources/db/migration`. Add a new migration file instead.
- MUST follow the existing package layout: `account`, `auth`, `transfer`, `common` (backend) and `core`, `pages`, `shared` (frontend).
- MUST return errors as `{ "errorCode", "message" }` with the codes in `docs/PRD.md`.
- MUST NOT change or remove a test assertion (unit, Postman or Katalon) to make a failing test pass. Find the cause first, or ask. Why: a weakened test hides the bug.
