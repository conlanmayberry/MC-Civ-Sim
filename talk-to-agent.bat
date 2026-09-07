@echo off
REM ============================================================
REM  MC-Civ-Sim -- talk to a running agent
REM
REM  Opens a chat prompt in this window. You do NOT need to be in
REM  Minecraft; the agent hears you either way.
REM
REM    just type          the agent hears it as speech and may reply
REM    /tell <something>  an operator instruction, recorded as an
REM                       intervention in the telemetry
REM    /state             decisions made, spend so far
REM    /stop              halt the agent
REM    /quit              leave this prompt (agent keeps running)
REM
REM  Talks to Alice by default. Running several agents? Say which
REM  one, either by double-clicking talk-bob.bat / talk-carla.bat /
REM  talk-dmitri.bat, or from a terminal:
REM      talk-to-agent.bat 25581
REM
REM  An agent must already be running (start-alice.bat and friends,
REM  or dry-run-agent.bat).
REM ============================================================

cd /d "%~dp0"
title MC-Civ-Sim - talk to agent

if "%~1"=="" (
  call npm run talk
) else (
  call npm run talk -- --port %1
)
pause
