# Labkit implementation plan

Labkit is a local "BCA staging" for Day 2. Participants practise agentic work on Jira, Confluence, Grafana logs, a staging DB and E2E tests, all on `127.0.0.1`, through local MCP servers.

- Branch: `feat/labkit`, from `main` (the participant copy, planted bugs intact).
- Deadline: training on **Thursday 26 Nov 2026**. BCA runs the preflight check before that.

## Constraints

| Constraint | What it means for the design |
|---|---|
| Windows laptops | `.cmd` launchers, no bash, Windows paths, everything binds to `127.0.0.1` (no firewall prompt). |
| Node 22 or newer, JDK 17 | Use built-ins only: `node:http`, `node:sqlite`, `node:test`, global `fetch` and `WebSocket`. |
| No new tools, npm and Maven access unknown | Zero npm dependencies. No new Maven dependencies. Playwright MCP is the only optional extra. |
| MCP works for local servers only | Every mock has a stdio MCP server. A CLI calls the same endpoints, as a fallback. |
| Real services have names, not ports | A gateway (`services/gateway`, in `start.cmd`) routes `*.labbank.localhost` by Host header. `.localhost` names resolve to loopback with no DNS or hosts file. It binds 127.0.0.1:80 (Windows allows it without admin), else :8000 (macOS needs root for 80). Preflight checks name lookup and the port. The 127.0.0.1 addresses keep working. |
| Remote MCP is common at work | Each service also serves its tools at a URL (`/mcp`, MCP Streamable HTTP, Bearer token from `data/mcp-token.txt`), so participants can practise the URL + token setup. stdio stays the default. |
| Jira and Confluence | One Atlassian mock. Tool names follow the Atlassian MCP server, so prompts carry over. |

## Architecture

```
Kiro ──stdio──► mcp/atlassian.mjs ──HTTP──► services/atlassian  :4310  (node:sqlite, seed + reset)
     ──stdio──► mcp/grafana.mjs   ──HTTP──► services/grafana    :4330  (reads backend/logs/app.json)
     ──stdio──► mcp/db.mjs        ──PG────► H2 PG server        :5435  (inside the backend, read-only user)
     ──stdio──► Playwright MCP (optional) ─► installed Chrome ─► Angular :4200 ─► backend :8080
hub page :4300 (links, health, reset)        CLI: node labkit/cli.mjs <service> <command>
```

## Folder layout

```
labkit/
  PLAN.md  README.md
  preflight.cmd  preflight.mjs      checks the laptop, writes preflight-report.txt
  start.cmd  start.mjs              starts hub, atlassian, grafana
  backend.cmd                       starts the backend with SPRING_PROFILES_ACTIVE=labkit (avoids PowerShell -D quoting)
  traffic.cmd                       runs traffic.mjs
  reset.cmd                         restores seed data
  cli.mjs                           fallback for every MCP tool
  traffic.mjs                       drives the API to fill the logs
  lib/
    mcp.mjs                         JSON-RPC: initialize, tools/list, tools/call; stdio and Streamable HTTP (mountHttp)
    token.mjs                       API token for the remote endpoints
    names.mjs  gateway.mjs          host names (*.labbank.localhost) and the host-based proxy
    http.mjs                        tiny router + JSON helpers
    pg.mjs                          minimal Postgres wire client (startup, password, simple query)
  services/
    hub/        server.mjs  ui/
    gateway/    server.mjs          names -> ports, on 127.0.0.1:80 or :8000
    atlassian/  server.mjs  jql.mjs  cql.mjs  ui/
    grafana/    server.mjs  logql.mjs  promql.mjs  ui/
  mcp/          atlassian.mjs  grafana.mjs  db.mjs
  seed/         atlassian.json  traffic-scenario.json
  test/         *.test.mjs (node --test); e2e.test.mjs runs the Day 2 loop over stdio when LABKIT_E2E=1
  docs/img/     README screenshots
  data/         runtime files, gitignored
.kiro/settings/mcp.json             registers the MCP servers
backend/                            small changes, only under the `labkit` Spring profile (Phase 2)
```

## MCP tools

| Server | Tools (names mirror the real servers) |
|---|---|
| atlassian | `searchJiraIssuesUsingJql`, `getJiraIssue`, `createJiraIssue`, `editJiraIssue`, `addCommentToJiraIssue`, `getTransitionsForJiraIssue`, `transitionJiraIssue`, `getConfluenceSpaces`, `searchConfluenceUsingCql`, `getConfluencePage`, `createConfluencePage`, `updateConfluencePage`. Also, because real agents call them first: `getAccessibleAtlassianResources`, `atlassianUserInfo`, `lookupJiraAccountId`, `getVisibleJiraProjects`, `getPagesInConfluenceSpace`. Read-only tools are in `autoApprove`; writes ask the user. |
| grafana | `query_loki_logs`, `list_loki_label_names`, `list_loki_label_values`, `query_prometheus` (metrics derived from logs). Also `list_datasources` and `list_prometheus_metric_names`. |
| db | `list_tables`, `describe_table`, `query` (SELECT only, read-only DB user as the real guard) |
| playwright (optional) | From `@playwright/mcp --browser chrome` |

Query languages are small subsets:
- JQL: `project`, `status`, `assignee`, `labels`, `priority`, `text ~`, `AND`/`OR`, `ORDER BY`.
- CQL: `space`, `title ~`, `text ~`.
- LogQL: label matchers plus `|=`, `!=`, `|~`, `!~`, `| json`, `| field op value`, time range, and `count_over_time` / `rate` with `sum by`.
- PromQL (metrics from the request log): `http_requests_total`, `http_request_duration_seconds_bucket`, `log_messages_total`; `rate`, `increase`, `sum/avg/min/max/count by`, `histogram_quantile`, `+ - * /`.
- DB `query` runs as the read-only user; it is the only DB tool not auto-approved, so the human sees each SQL.

## Status (Mon 23 Nov)

Done and committed on `feat/labkit`: 0.1–0.3, 1.1–1.3, 2.1–2.3, 3.1–3.4. The must-have loop (search a Jira issue, find errors in the logs, query the DB, comment, transition, create a Confluence page) passes over stdio MCP in `test/e2e.test.mjs`. Not yet done: a check in Kiro on Windows (0.3, 4.3) and Phase 4.

## Work map

### Phase 0: preflight and spikes (Mon 23 Nov)

| # | Task | Done when |
|---|---|---|
| 0.1 | `preflight.cmd` / `preflight.mjs`: Node ≥ 22 and `node:sqlite` loads; `java -version` ≥ 17; ports 4300–4330, 5435, 8080, 4200 bind on 127.0.0.1; Chrome found; npm registry and Maven Central reachable (report only, not required). Writes `preflight-report.txt`. | Runs on Windows in under 10 s; the report is easy to paste into chat. **Send to BCA first.** |
| 0.2 | Spike: H2 PG server mode plus `lib/pg.mjs`. Start `org.h2.tools.Server.createPgServer` in the backend, connect from Node, run SELECT on `accounts`. | Rows come back. If not: fall back to a localhost SELECT-only endpoint under the `labkit` profile. |
| 0.2 result | **Works**, with one change. H2's PG server switches the session to PostgreSQL mode on connect, and only an admin may do that. So the bean creates a second in-memory DB (`labkit_staging`, PostgreSQL mode) with `READONLY` linked tables that read the app tables live through the read-only user. The PG server maps database `banklab` to it. Tables exposed: `accounts`, `transfers`, `external_accounts` (not `users`: NIK and password hashes). Writes fail with "Not enough rights". H2 binds to 127.0.0.1 via `h2.bindAddress`, set by `LabkitEnvironment` (an `EnvironmentPostProcessor`, no-op without the profile). | Done. |
| 0.3 | Spike: `lib/mcp.mjs` with one `ping` tool, registered in `.kiro/settings/mcp.json`, loaded by Kiro on Windows. | Kiro lists and calls the tool. This confirms the path format and the `node` command on Windows. |

### Phase 1: Atlassian mock (Tue 24 Nov)

| # | Task | Done when |
|---|---|---|
| 1.1 | `services/atlassian`: node:sqlite schema (issues, comments, transitions, spaces, pages), REST shaped like Jira v3 / Confluence v2 subsets, seed load, reset. | `node --test` passes for CRUD, JQL and CQL. |
| 1.2 | Web UI: Jira board (To Do / In Progress / Done), issue page; Confluence space tree and page view (Markdown). Plain HTML and JS. | A human can see what the agent changed. |
| 1.3 | `mcp/atlassian.mjs` and the matching `cli.mjs atlassian ...` commands. | Kiro can search, read, comment and transition an issue, and create a page. |

### Phase 2: logs, metrics, DB (Tue 24 Nov, can run in parallel with Phase 1)

| # | Task | Done when |
|---|---|---|
| 2.1 | Backend, `labkit` profile only: `application-labkit.properties` with `logging.structured.format.file=ecs` to `logs/app.json`; a request log filter (method, path, status, ms, traceId) that **masks account numbers and names** (team-rules §3); H2 PG server bean on 127.0.0.1:5435 with a read-only user. | `mvnw spring-boot:run -Dspring-boot.run.profiles=labkit` works; nothing changes without the profile. |
| 2.2 | `services/grafana`: tail and index `logs/app.json`, LogQL subset, metrics (request rate, error rate, p95 latency by path), one dashboard page. | Errors from the traffic script show up within 5 s. |
| 2.3 | `mcp/grafana.mjs`, `mcp/db.mjs`, CLI commands. | Kiro finds an error in the logs and confirms it with a DB query. |

### Phase 3: story, launcher, docs (Wed 25 Nov)

| # | Task | Done when |
|---|---|---|
| 3.1 | Seed data: Jira project `LB` with one bug ticket that matches the Lab 5 symptom (balance looks wrong after a transfer), written as a user report with no cause, plus 6 noise tickets. Confluence space `LB` with an architecture page, an incident runbook and a postmortem template. Check against `facilitator/lab-answer-key.md` so nothing spoils. | A facilitator review finds no spoilers. |
| 3.2 | `traffic.mjs`: logs in as demo users, makes normal transfers and the Lab 5 case, plus a few 4xx cases (R-rule violations). | The Grafana dashboard shows a realistic mix. |
| 3.3 | Hub page, `start.cmd`, `reset.cmd`, `labkit/README.md` (Windows-first, with screenshots). | A new person gets from clone to a working Kiro MCP call in 10 minutes. |
| 3.4 | Optional: Playwright MCP entry (disabled by default) with a one-line enable step. | Works when npm is reachable; Day 2 does not depend on it. |

### Phase 4: Day 2 material and dry run (Wed 25 Nov)

| # | Task | Done when |
|---|---|---|
| 4.1 | `day2.html`: labkit intro slide (Session 1 or opening), Jira tickets from triage (Session 3), capstone loop slide (Session 4), Playwright MCP demo note (Session 2). | Slides fit with no overflow. |
| 4.2 | Lab guide steps for Lab 5 (and Lab 4 ticket step) in `webapp/` — coordinate with Naufal, who owns it. | Steps match labkit. |
| 4.3 | Dry run on a Windows machine, from clone to the end of Lab 5. | No blockers; fixes merged. |

## Parallel work

After 0.3 lands (`lib/mcp.mjs`), Phase 1 and Phase 2 do not share files and can run in two sessions. Phase 3.1 and 4.1 need Phases 1–2 done.

## Risks

| Risk | Plan |
|---|---|
| H2 PG mode does not work with a hand-written client | Spike first (0.2). Fallback: profile-gated SELECT endpoint. |
| Kiro on Windows resolves MCP paths differently | Spike 0.3; use absolute paths written by `start.mjs` if needed. |
| `node:sqlite` prints an ExperimentalWarning | Run with `--no-warnings=ExperimentalWarning`. |
| Backend changes show up in the Lab 4 security review | Keep them in one `labkit` package and profile; tell facilitators. |
| Request logs leak personal data | Mask in the filter; unit test the masking. |
| Health checks pollute the backend logs | Hub, CLI and traffic check the backend with a TCP connect, never HTTP (an HTTP probe logs a 4xx/5xx line). |
| `GET /api/accounts` needs `?owner=` | Traffic calls it like the frontend does (`?owner=<full name>`); the request log hides the query value. |
| No time for everything | Must have by Thursday: 0.x, 1.x, 2.1–2.3, 3.1, 3.3. Nice to have: 3.4, Grafana dashboard polish, 4.2. |

## Not in scope

Real Grafana, Loki or Prometheus; Jira workflows beyond three statuses; auth on the mocks (localhost only); Linear and Notion.
