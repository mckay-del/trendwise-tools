@echo off
rem Starts Trendwise Ledger (minimized) every time you sign in to Windows.
rem To undo: press Win+R, type shell:startup, and delete "Trendwise Ledger".
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=[Environment]::GetFolderPath('Startup'); $s=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $d 'Trendwise Ledger.lnk')); $s.TargetPath=(Join-Path (Get-Location) 'Start Ledger.bat'); $s.WorkingDirectory=(Get-Location).Path; $s.Arguments='/background'; $s.WindowStyle=7; $s.Description='Start Trendwise Ledger'; $s.Save()"
if errorlevel 1 (
  echo Could not set this up.
) else (
  echo Trendwise Ledger will now start automatically when you sign in to Windows.
  echo To undo: press Win+R, type shell:startup, and delete "Trendwise Ledger".
)
pause
