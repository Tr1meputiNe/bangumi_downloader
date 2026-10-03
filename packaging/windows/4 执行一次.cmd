@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 番剧自动下载 - 执行一次

if not exist "config.json" (
  echo 还没有 config.json，请先双击「1 首次配置.cmd」。
  pause
  exit /b 1
)

echo 执行一轮真实下载...
echo.
"%~dp0bangumi-downloader.exe" sync
echo.
pause
