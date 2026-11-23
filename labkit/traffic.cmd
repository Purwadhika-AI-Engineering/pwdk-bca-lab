@echo off
rem Sends demo traffic to the backend so Grafana has data. Add --loop 15 to keep going.
setlocal
cd /d "%~dp0"
node traffic.mjs %*
