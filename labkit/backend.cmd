@echo off
rem Starts the backend with the labkit profile (JSON logs, read-only staging DB).
setlocal
cd /d "%~dp0..\backend"
set SPRING_PROFILES_ACTIVE=labkit
call mvnw.cmd spring-boot:run %*
