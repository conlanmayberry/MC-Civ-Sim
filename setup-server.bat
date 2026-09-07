@echo off
REM ============================================================
REM  MC-Civ-Sim -- one-time server setup
REM
REM  Downloads and checksum-verifies the pinned Paper jar, writes
REM  the server config, and asks you to accept the Minecraft EULA.
REM
REM  Run this once before start-server.bat. It is safe to re-run:
REM  it skips anything already done.
REM ============================================================

cd /d "%~dp0"
title MC-Civ-Sim setup

where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo   Node.js was not found on PATH. Install from https://nodejs.org
    echo.
    pause
    exit /b 1
)

if not exist "node_modules\" (
    echo.
    echo   Installing dependencies ^(first run only^)...
    call npm install
)

echo.
call npm run minecraft:setup
echo.
pause
