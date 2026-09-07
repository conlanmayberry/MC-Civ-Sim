@echo off
REM ============================================================
REM  MC-Civ-Sim -- run the autonomous agent
REM
REM  WARNING: this spends real money. Each decision is a paid
REM  OpenAI API call. The run stops at the budget cap set in
REM  .env (AI_BUDGET_USD, default $5).
REM
REM  To watch the loop work WITHOUT spending anything, use
REM  dry-run-agent.bat instead.
REM
REM  The Minecraft server must already be running.
REM
REM  Stop the agent with: "agent stop" in Minecraft chat,
REM  Ctrl-C here, or by creating a file named STOP in this folder.
REM ============================================================

cd /d "%~dp0"
title MC-Civ-Sim agent (LIVE - spends money)

echo.
call npm run agent
echo.
pause
