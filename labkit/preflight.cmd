@echo off
rem Labkit preflight: checks this laptop for Day 2. Writes preflight-report.txt.
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [FAIL] Node.js not found. Install Node 22 or newer.
  echo [FAIL] Node.js not found. Install Node 22 or newer.> preflight-report.txt
  exit /b 1
)
node preflight.mjs %*
exit /b %errorlevel%
