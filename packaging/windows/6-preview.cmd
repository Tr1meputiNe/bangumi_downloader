@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 番剧自动下载 - 预览这次会下载什么

if not exist "config.json" (
  echo 还没有 config.json，请先双击 1-setup.cmd。
  pause
  exit /b 1
)

echo 只执行一轮，看看会下载哪些集（不推送，纯预览）
echo.
"%~dp0bangumi-downloader.exe" sync --dry-run
echo.
echo ------------------------------------------------------------
echo 以上是「如果现在下载会选哪些种子」。确认没问题后，
echo 双击 3-start.cmd 开始真正下载，或用 4-run-once.cmd 跑一轮真实下载。
echo ------------------------------------------------------------
pause
