# Postmortem: staging login outage (LB-0)

## Summary

For 40 minutes nobody could log in on staging. Every login returned an error. Production was not affected.

## Impact

| Question | Answer |
|---|---|
| Who was affected? | QA and the training team, on staging only |
| Since when, until when? | 09:10 to 09:50 WIB |
| Money at risk? | No |
| Data wrong in the DB, or only on screen? | Neither. Logins failed; no data changed. |

## Timeline (WIB)

| Time | What happened |
|---|---|
| 09:10 | QA reports that login fails |
| 09:20 | Grafana shows every `POST /api/auth/login` with status 500 |
| 09:35 | Root cause found: the staging config pointed to an old database file |
| 09:50 | Config fixed, logins work again |

## Root cause

The staging start script used an old config file after a folder move. The API started, but the login query failed.

## Detection

QA noticed it by hand. We had no alert on the login error rate.

## Fix

The start script now checks the config path and stops with a clear message.

## What went well

- The `traceId` in the logs led straight to the failing query.

## What to improve

- Alert when the login error rate is above 20% for 5 minutes.

## Action items

| Action | Owner | Ticket |
|---|---|---|
| Add a login error-rate alert | Dimas | LB-0a |
