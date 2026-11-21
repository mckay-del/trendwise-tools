@echo off
rem Starts McKay's Taskboard (minimized) every time you sign in to Windows, so it keeps syncing while the computer is on.
rem To undo: press Win+R, type shell:startup, and delete "McKay's Taskboard".
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=[Environment]::GetFolderPath('Startup'); $s=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $d 'McKay''s Taskboard.lnk')); $s.TargetPath=(Join-Path (Get-Location) 'Start Taskboard.bat'); $s.WorkingDirectory=(Get-Location).Path; $s.Arguments='/background'; $s.WindowStyle=7; $s.Description='Start McKay''s Taskboard'; $s.Save()"
if errorlevel 1 (
  echo Could not set this up.
) else (
  echo McKay's Taskboard will now start automatically when you sign in to Windows.
  echo To undo: press Win+R, type shell:startup, and delete "McKay's Taskboard".
)
pause
