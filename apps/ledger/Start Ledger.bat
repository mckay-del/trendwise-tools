@echo off
title Trendwise Ledger
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js is not installed on this computer.
  echo  Opening nodejs.org - download and install the LTS version, then run this again.
  echo.
  start "" https://nodejs.org
  pause
  exit /b 1
)

rem Stop any copy of the app that is already running, so you always get the current version.
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:"127.0.0.1:3000 .*LISTENING"') do taskkill /PID %%p /F >nul 2>nul

set LEDGER_OPEN_BROWSER=1
node --disable-warning=ExperimentalWarning server\index.js
if errorlevel 1 (
  echo.
  echo  Trendwise Ledger stopped with an error - see the message above.
  pause
)
