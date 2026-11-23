# Staging environment (labkit)

Staging runs on your laptop for the training. Everything listens on `127.0.0.1` only.

| Service | Name | Direct address |
|---|---|---|
| Labkit hub (links, health, reset) | http://labkit.localhost | http://127.0.0.1:4300 |
| Jira | http://jira.labbank.localhost | http://127.0.0.1:4310 |
| Confluence | http://confluence.labbank.localhost | http://127.0.0.1:4310 |
| Grafana (logs and metrics) | http://grafana.labbank.localhost | http://127.0.0.1:4330 |
| API | http://api.labbank.localhost | http://127.0.0.1:8080 |
| Web app | http://app.labbank.localhost | http://127.0.0.1:4200 |
| Database (read-only, Postgres protocol) | | 127.0.0.1:5435, database `banklab` |

If a name does not open, add `:8000` after it (the gateway uses port 8000 when port 80 is not free).

## Start

1. `labkit\start.cmd` starts the hub, Jira/Confluence and Grafana.
2. `labkit\backend.cmd` starts the API with the labkit profile.
3. In `frontend`: `npm start`

## Demo users

All passwords are `Password123!`.

| User ID | Accounts |
|---|---|
| `andi` | `******7890` (savings), `******7891` (current) |
| `budi` | `******8901` |
| `citra` | `******9012` |

## Reset

- Jira and Confluence: `labkit\reset.cmd` or the button on the hub.
- Database: restart the backend. It is in memory.
