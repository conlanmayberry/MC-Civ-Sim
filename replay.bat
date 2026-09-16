@echo off
REM ============================================================
REM  MC-Civ-Sim -- replay recorded decisions
REM
REM  Puts real situations from the latest session to the CURRENT
REM  prompt (or another model) and shows how the choices change.
REM  No server needed. Use it after changing a prompt, before
REM  spending an hour finding out live.
REM
REM  With no arguments this is a DRY RUN: it prints the cost
REM  estimate and sends nothing. To actually replay:
REM      replay.bat --go
REM      replay.bat --go --model gpt-5.6-terra
REM      replay.bat --go --agent bob --limit 80
REM
REM  Hard cap $1.00 per replay unless raised with --max-usd.
REM ============================================================

cd /d "%~dp0"
title MC-Civ-Sim - replay

set ARGS=%*
echo %ARGS% | findstr /C:"--go" >nul
if errorlevel 1 (
  call npm run replay -- --dry-run %*
) else (
  call npm run replay -- %ARGS:--go=%
)
echo.
pause
