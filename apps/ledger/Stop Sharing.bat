@echo off
title Stop sharing Trendwise Ledger
set "TS=tailscale"
where tailscale >nul 2>nul
if errorlevel 1 set "TS=%ProgramFiles%\Tailscale\tailscale.exe"
"%TS%" serve reset
if errorlevel 1 (echo Could not change the Tailscale setting - is Tailscale installed and signed in?) else (echo Sharing is off. Only this computer can open the ledger now.)
pause
