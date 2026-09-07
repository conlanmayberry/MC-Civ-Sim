@echo off
REM ============================================================
REM  MC-Civ-Sim -- talk to Dmitri
REM
REM  Same as talk-to-agent.bat, pointed at Dmitri's control port.
REM  Dmitri must already be running (start-dmitri.bat).
REM ============================================================

cd /d "%~dp0"
title MC-Civ-Sim - talk to Dmitri

call npm run talk -- --port 25583
pause
