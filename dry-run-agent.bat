@echo off
REM ============================================================
REM  MC-Civ-Sim -- agent dry run
REM
REM  Runs the full observe/decide/act/record loop against the
REM  live Minecraft server using scripted decisions instead of
REM  a model. No API calls, no API key needed, costs $0.00.
REM
REM  Use this to check the agent works before spending anything.
REM  The Minecraft server must already be running.
REM ============================================================

cd /d "%~dp0"
title MC-Civ-Sim agent (dry run - free)

echo.
call npm run agent -- --dry-run
echo.
pause
