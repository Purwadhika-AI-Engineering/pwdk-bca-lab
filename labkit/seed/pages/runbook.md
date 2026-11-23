# Incident runbook

Use this when a customer or a monitor reports a problem on Lab Bank.

## 1. Take the ticket

- Find the ticket in Jira project **LB**. Read the description and comments.
- Assign it to yourself and move it to **In Progress**.
- Add a comment: what you will check first.

## 2. Reproduce on staging

- Use a demo user that matches the report. Do the same steps.
- Write down the time (WIB) and, if you can, the `X-Trace-Id` response header.

## 3. Check logs and metrics in Grafana

Start wide, then narrow down.

| Question | Example query |
|---|---|
| Any errors in the last hour? | `{job="banklab-backend", level=~"warn\|error"}` |
| All API calls that failed | `{job="banklab-backend"} \| json \| status >= 400` |
| Everything for one request | `{job="banklab-backend"} \| json \| traceId="<id>"` |
| Calls to one endpoint | `{logger="labkit.request"} \|= "/api/transfers"` |
| Error rate per status | `sum by (status) (increase(http_requests_total[1h]))` |

A problem does not always show up as an error. A wrong value can come with status 200.

## 4. Check the data

- Use the read-only DB user. SELECT only.
- Start with `list_tables` and `describe_table`, then query.
- Example: the last transfers: `SELECT * FROM transfers ORDER BY created_at DESC LIMIT 5`
- Compare what the customer saw with what is stored. Which one is right?

## 5. Write it down on the ticket

Add a comment with:

- what you saw (logs, data), with times and trace ids;
- the layer where it goes wrong, and why you think so;
- what is **not** affected.

Do not paste full account numbers or names into tickets. Mask them: `******7890`.

## 6. Fix

- Write a bugfix spec: current behavior, expected behavior, unchanged behavior.
- Write a failing test first. Then fix the root cause, not the symptom.
- Follow `docs/team-rules.md`.

## 7. Close

- Move the ticket to **Done** when the fix is verified.
- Write a postmortem page from the **Postmortem template** for every customer-facing bug.
