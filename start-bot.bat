@echo off
REM ============================================================
REM  MC-Civ-Sim -- start the bot
REM
REM  The Minecraft server must already be running: launch
REM  start-server.bat first, in its own window.
REM
REM  Stop the bot with Ctrl-C here, or by saying `bot quit` in
REM  Minecraft chat. Neither reconnects.
REM ============================================================

cd /d "%~dp0"
title MC-Civ-Sim bot

echo.
call npm run bot
if errorlevel 1 (
    echo.
    echo   The bot exited with an error -- see above.
    echo   The most common cause is the server not running yet.
)
echo.
pause
