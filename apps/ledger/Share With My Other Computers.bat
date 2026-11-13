@echo off
title Share Trendwise Ledger with your other computers
rem Makes the ledger on THIS computer reachable from your other devices through Tailscale
rem (a private, encrypted network between your own devices). Nothing is exposed to the internet.

set "TS=tailscale"
where tailscale >nul 2>nul
if errorlevel 1 set "TS=%ProgramFiles%\Tailscale\tailscale.exe"
if not exist "%TS%" if not "%TS%"=="tailscale" (
  echo.
  echo  Tailscale is not installed on this computer.
  echo  Opening tailscale.com/download - install it, sign in, then run this again.
  start "" https://tailscale.com/download/windows
  pause
  exit /b 1
)

echo.
echo  Turning on private sharing for Trendwise Ledger (port 3000)...
"%TS%" serve --bg 3000
if errorlevel 1 (
  echo.
  echo  That didn't work. The most common reason: HTTPS certificates are not enabled yet.
  echo  In the Tailscale admin console ^(login.tailscale.com^) go to DNS, make sure MagicDNS is on,
  echo  and click "Enable HTTPS". Then run this again. See REMOTE-ACCESS.md for details.
  pause
  exit /b 1
)
echo.
echo  Done. Your other computers can open the address shown below
echo  ^(it starts with https:// and ends with .ts.net^):
echo.
"%TS%" serve status
echo.
echo  This setting stays on, even after a restart. The ledger itself must be running
echo  on this computer ^(Start Ledger.bat^) for the other computers to reach it.
pause
