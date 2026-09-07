@echo off
REM ============================================================
REM  MC-Civ-Sim -- talk to Alice
REM
REM  Same as talk-to-agent.bat, pointed at Alice's control port.
REM  Alice must already be running (start-alice.bat).
REM ============================================================

cd /d "%~dp0"
title MC-Civ-Sim - talk to Alice

call npm run talk -- --port 25580
pause
