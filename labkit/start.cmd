@echo off
rem Starts labkit: hub, Jira + Confluence, Grafana. Ctrl+C stops it.
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Install Node 22 or newer, then run labkit\preflight.cmd
  exit /b 1
)
node start.mjs %*
