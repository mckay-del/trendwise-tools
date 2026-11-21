@echo off
rem Puts a "McKay's Taskboard" shortcut on your desktop that runs Start Taskboard.bat.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=[Environment]::GetFolderPath('Desktop'); $s=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $d 'McKay''s Taskboard.lnk')); $s.TargetPath=(Join-Path (Get-Location) 'Start Taskboard.bat'); $s.WorkingDirectory=(Get-Location).Path; $s.IconLocation='%SystemRoot%\System32\shell32.dll,165'; $s.Description='Start McKay''s Taskboard'; $s.Save()"
if errorlevel 1 (
  echo Could not create the shortcut.
) else (
  echo A "McKay's Taskboard" shortcut is now on your desktop.
)
pause
