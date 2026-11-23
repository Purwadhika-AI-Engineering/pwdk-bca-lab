@echo off
rem Restores the Jira + Confluence seed data. Labkit must be running.
rem The staging DB resets when you restart the backend.
setlocal
cd /d "%~dp0"
node cli.mjs reset
