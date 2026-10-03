@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 番剧自动下载 - 安装开机自启

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-startup.ps1"
pause
