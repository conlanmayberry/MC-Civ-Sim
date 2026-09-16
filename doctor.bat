@echo off
REM ============================================================
REM  MC-Civ-Sim -- health check for the latest session
REM
REM  Checks the telemetry for every failure pattern this project
REM  has actually hit: the same failure repeated, actions that
REM  mostly fail, handovers never picked up, starvation, agents
REM  standing still, talking more than doing, and agents running
REM  different or uncommitted code.
REM
REM  Free, read-only, and safe while agents are running. Each
REM  agent also prints its own report when it stops.
REM
REM    doctor.bat              the latest session
REM    doctor.bat previous     the one before it
REM    doctor.bat all          everything
REM ============================================================

cd /d "%~dp0"
title MC-Civ-Sim - doctor

call npm run doctor -- %*
echo.
pause
