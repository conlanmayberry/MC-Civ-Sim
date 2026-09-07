@echo off
REM ============================================================
REM  MC-Civ-Sim -- run Bob
REM
REM  WARNING: this spends real money. Each decision is a paid
REM  OpenAI API call. This agent stops at its own budget cap
REM  (AI_BUDGET_USD in .env, default $5 -- set independently for
REM  each agent if you want a different ceiling per agent).
REM
REM  Bob is one of several agents that can run at once, each on
REM  its own control port so the dashboard and talk-to-agent can
REM  tell them apart. This window is Bob's alone -- Ctrl-C here
REM  stops only Bob, not the others.
REM
REM  To watch Bob work WITHOUT spending anything first, run:
REM      npm run agent -- --agent bob --dry-run
REM
REM  The Minecraft server must already be running.
REM ============================================================

cd /d "%~dp0"
title MC-Civ-Sim - Bob (LIVE - spends money)
set AGENT_CONTROL_PORT=25581

echo.
call npm run agent -- --agent bob
echo.
pause
