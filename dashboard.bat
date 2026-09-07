@echo off
REM ============================================================
REM  MC-Civ-Sim -- dashboard
REM
REM  Opens the web dashboard at http://127.0.0.1:25590
REM
REM  Shows live agent state (position, inventory, vitals, spend),
REM  a top-down map, the decision stream, and a chat box for
REM  talking to agents.
REM
REM  Works with or without an agent running: with one you get
REM  live data, without one you can still read the history of
REM  past runs from the telemetry database.
REM ============================================================

cd /d "%~dp0"
title MC-Civ-Sim dashboard

start "" http://127.0.0.1:25590
call npm run dashboard
pause
