# Architecture overview

Lab Bank is a small web app for money transfers.

## Components

| Part | Tech | Port (local and staging) |
|---|---|---|
| Web app | Angular 17 | 4200 |
| API | Spring Boot 3.5, Java 17 | 8080 |
| Database | H2 in memory, Flyway migrations | inside the API |

The web app calls the API under `/api`. The API keeps all data in H2. On restart, Flyway builds the schema and loads the demo data again.

## Backend packages

| Package | What it does |
|---|---|
| `auth` | Login and the Bearer token check |
| `account` | Account list, details and summary |
| `transfer` | Inquiry, transfer, history |
| `common` | Errors, clock (WIB), shared code |

## Main API calls

| Call | Used for |
|---|---|
| `POST /api/auth/login` | Login, returns a token |
| `GET /api/accounts` | Accounts of the logged-in user |
| `GET /api/accounts/{id}/summary` | One account with recent activity |
| `POST /api/transfers/inquiry` | Look up the target account and name |
| `POST /api/transfers` | Make a transfer (needs `Idempotency-Key`) |
| `GET /api/transfers` | Transfer history |

Business rules (R1 to R14) and error codes are in `docs/PRD.md`. Money rules are in the PRD and in `docs/team-rules.md` section 2.

## Observability on staging

- Each API request writes one log line: method, path, status, time in ms and a `traceId`.
- Other log lines from the same request carry the same `traceId`.
- The response header `X-Trace-Id` returns the same id, so you can find a request in Grafana.
- Request log lines mask account numbers: `******7890`. Team rules section 3 says every log line must.
- Grafana has the logs (Loki) and metrics built from them (Prometheus).

## Data access on staging

Engineers get a **read-only** database user. You can run SELECT queries; you cannot change data. Tables you can read: `accounts`, `transfers`, `external_accounts`.
