@echo off
REM ============================================================
REM  MC-Civ-Sim -- talk to Bob
REM
REM  Same as talk-to-agent.bat, pointed at Bob's control port.
REM  Bob must already be running (start-bob.bat).
REM ============================================================

cd /d "%~dp0"
title MC-Civ-Sim - talk to Bob

call npm run talk -- --port 25581
pause
