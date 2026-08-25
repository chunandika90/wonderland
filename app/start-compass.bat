@echo off
cd /d "%~dp0"
:loop
echo [%date% %time%] Starting Buranchi Compass...
node server.js
echo [%date% %time%] Server stopped (exit code %errorlevel%) — restarting in 3 seconds...
timeout /t 3 /nobreak >nul
goto loop
