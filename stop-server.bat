@echo off
rem Stop the mixing-site server (whatever is listening on port 3000)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000 .*LISTENING"') do (
  echo Stopping PID %%a ...
  taskkill /PID %%a /F
)
echo Done.
pause
