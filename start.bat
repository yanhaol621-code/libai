@echo off
chcp 65001 >nul
cd /d %~dp0
title 混剪网站服务（最小化即可；关闭窗口即停止）
netstat -ano | findstr ":3000 " | findstr LISTENING >nul
if %errorlevel%==0 (
  echo 服务已经在运行，无需重复启动。
  echo 打开浏览器访问：http://localhost:3000
  timeout /t 5 /nobreak >nul
  exit /b
)
echo ============================================
echo   电商·视频混剪工作台
echo   地址：http://localhost:3000
echo   提示：本窗口可最小化，不要关闭
echo ============================================
if not exist node_modules (
  echo 首次运行，正在安装依赖...
  call npm install
)
:loop
node server/index.js
echo.
echo 服务已退出，3 秒后自动重启（关闭窗口可彻底停止）
timeout /t 3 /nobreak >nul
goto loop
