@echo off
REM ============================================================
REM  MC-Civ-Sim -- launch all four agents at once
REM
REM  WARNING: this spends real money, FOUR TIMES OVER. Each of
REM  Alice, Bob, Carla and Dmitri has its own budget cap
REM  (AI_BUDGET_USD in .env, default $5 each) -- so running all
REM  four to their caps costs up to $20, not $5. Lower the cap
REM  first if that is not what you want: either edit AI_BUDGET_USD
REM  in .env (applies to all of them), or edit one start-<name>.bat
REM  to add "--budget 1" after --agent <name>.
REM
REM  Opens four windows, one per agent, each already on its own
REM  control port so the dashboard and talk-to-agent can address
REM  them individually. Closing one window (or its Ctrl-C) stops
REM  only that agent.
REM
REM  The Minecraft server must already be running -- start it
REM  first with start-server.bat and let it finish loading.
REM ============================================================

cd /d "%~dp0"
title MC-Civ-Sim - launching all agents

echo.
echo   Starting Alice, Bob, Carla and Dmitri in separate windows...
echo   Each spends real money independently -- see this file's
echo   comments if that is not what you want.
echo.

start "" start-alice.bat
timeout /t 3 /nobreak >nul
start "" start-bob.bat
timeout /t 3 /nobreak >nul
start "" start-carla.bat
timeout /t 3 /nobreak >nul
start "" start-dmitri.bat

echo   All four launched. Watch them on the dashboard: dashboard.bat
echo.
pause
