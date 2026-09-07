@echo off
REM ============================================================
REM  MC-Civ-Sim -- run the default agent (Alice, AGENT_ID in .env)
REM
REM  WARNING: this spends real money. Each decision is a paid
REM  OpenAI API call. The run stops at the budget cap set in
REM  .env (AI_BUDGET_USD, default $5).
REM
REM  Running several agents at once? start-alice.bat, start-bob.bat,
REM  start-carla.bat and start-dmitri.bat each launch one on its own
REM  control port, so the dashboard and talk-to-agent can tell them
REM  apart -- use those instead of running this one twice, which is
REM  what "control port already in use" means. This file is the
REM  single-agent case, or a template for adding a fifth: copy
REM  config/agents/alice.json, edit it, then copy one of the
REM  start-<name>.bat files with a new AGENT_CONTROL_PORT.
REM
REM  To watch the loop work WITHOUT spending anything, use
REM  dry-run-agent.bat instead.
REM
REM  The Minecraft server must already be running.
REM
REM  Stop the agent with: "agent stop" in Minecraft chat,
REM  Ctrl-C here, or by creating a file named STOP in this folder
REM  (STOP halts every agent running from this project, not just
REM  one -- for a single agent, use Ctrl-C or /stop in npm run talk).
REM ============================================================

cd /d "%~dp0"
title MC-Civ-Sim agent (LIVE - spends money)

echo.
call npm run agent
echo.
pause
