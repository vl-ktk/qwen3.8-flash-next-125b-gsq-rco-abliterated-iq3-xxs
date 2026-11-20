@echo off
setlocal DisableDelayedExpansion
rem Candidate launcher: one user action, UAC and owner approval still required.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-KTKMCP.ps1" -Enroll
set "result=%ERRORLEVEL%"
pause
exit /b %result%
