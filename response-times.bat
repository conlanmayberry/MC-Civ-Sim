@echo off
REM ============================================================
REM  MC-Civ-Sim -- response times
REM
REM  How long the agent leaves somebody waiting: reply latency,
REM  what it was thinking about, and anything it never answered.
REM
REM  No argument   the current (or most recent) run only.
REM  "all"         every run, one row each, oldest first -- which
REM                is how you see whether a change helped.
REM
REM  Safe to run while the agent is going; it reads the same
REM  database read-only.
REM ============================================================

cd /d "%~dp0"
title MC-Civ-Sim response times

call npm run telemetry latency %1
echo.
pause
