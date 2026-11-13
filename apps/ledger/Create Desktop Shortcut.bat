@echo off
rem Puts a "Trendwise Ledger" shortcut on your desktop that runs Start Ledger.bat.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=[Environment]::GetFolderPath('Desktop'); $s=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $d 'Trendwise Ledger.lnk')); $s.TargetPath=(Join-Path (Get-Location) 'Start Ledger.bat'); $s.WorkingDirectory=(Get-Location).Path; $s.IconLocation='%SystemRoot%\System32\shell32.dll,43'; $s.Description='Start Trendwise Ledger'; $s.Save()"
if errorlevel 1 (
  echo Could not create the shortcut.
) else (
  echo A "Trendwise Ledger" shortcut is now on your desktop.
)
pause
