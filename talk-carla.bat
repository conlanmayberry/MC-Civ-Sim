@echo off
REM ============================================================
REM  MC-Civ-Sim -- talk to Carla
REM
REM  Same as talk-to-agent.bat, pointed at Carla's control port.
REM  Carla must already be running (start-carla.bat).
REM ============================================================

cd /d "%~dp0"
title MC-Civ-Sim - talk to Carla

call npm run talk -- --port 25582
pause
