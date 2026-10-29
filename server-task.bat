@echo off
rem Independent server runner used by the Startup-folder autostart.
rem Exits if port 3000 is already taken (avoids restart loops).
cd /d %~dp0
netstat -ano | findstr ":3000 " | findstr LISTENING >nul
if %errorlevel%==0 exit /b
:loop
node server/index.js >> data\server.log 2>&1
timeout /t 3 /nobreak >nul
goto loop
