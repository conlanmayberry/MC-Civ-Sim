@echo off
REM ============================================================
REM  MC-Civ-Sim -- start the Minecraft server
REM
REM  Double-click this file, or run it from anywhere. It changes
REM  to the project directory itself, so you never have to cd or
REM  remember the npm script name.
REM
REM  The server console stays interactive: type `list`, `save-all`
REM  or `stop` directly into this window. Ctrl-C performs a
REM  graceful save-and-stop rather than killing the JVM.
REM ============================================================

REM %~dp0 is this file's own folder, so the script works no matter
REM where it is launched from. /d handles a different drive letter.
cd /d "%~dp0"

title MC-Civ-Sim server

where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo   Node.js was not found on PATH.
    echo   Install it from https://nodejs.org and open a NEW terminal.
    echo.
    pause
    exit /b 1
)

if not exist "node_modules\" (
    echo.
    echo   Installing dependencies ^(first run only^)...
    echo.
    call npm install
    if errorlevel 1 goto failed
)

echo.
call npm run minecraft
if errorlevel 1 goto failed

REM A clean `stop` exits 0 and lands here. Pause so the window stays
REM open long enough to read the shutdown messages.
echo.
echo   Server stopped.
pause
exit /b 0

:failed
echo.
echo   The server exited with an error -- see the messages above.
echo.
echo   If it asked you to run setup, close this window and run
echo   setup-server.bat first.
echo.
pause
exit /b 1
