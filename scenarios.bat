@echo off
REM ============================================================
REM  MC-Civ-Sim -- scenario tests
REM
REM  Small repeatable tests on a glass arena far from the world
REM  (x=25000, z=25000): handovers, getting round a wall, following
REM  a moving player, building, mining, crafting, eating. Free.
REM  A scenario that passed before and fails now is reported as
REM  REGRESSED.
REM
REM  Needs the server running with RCON enabled. One time only:
REM      npm run minecraft:enable-rcon     then restart the server
REM
REM  Safe while agents are running: the arena is far away, and test
REM  agents only ever talk to each other.
REM
REM    scenarios.bat                   every free scenario
REM    scenarios.bat --live            also live agent tests (a few cents)
REM    scenarios.bat --list            what exists
REM    scenarios.bat --cleanup         remove the arena from the world
REM ============================================================

cd /d "%~dp0"
title MC-Civ-Sim - scenarios

call npm run scenarios -- %*
echo.
pause
