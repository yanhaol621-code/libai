@echo off
REM 混剪网站 · 公网隧道启动脚本（Cloudflare quick tunnel，免登录免费）
REM 前提：node 服务已在 127.0.0.1:3000 运行（见 start-all.bat）
cd /d %~dp0
cloudflared.exe tunnel --url http://localhost:3000
