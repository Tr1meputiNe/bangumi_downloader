@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 番剧自动下载 - 执行一次

if not exist "config.json" (
  echo 还没有 config.json，请先双击「1 首次配置.cmd」。
  pause
  exit /b 1
)

echo 只执行一轮，看看会下载哪些集（不推送，纯预览）
echo.
"%~dp0bangumi-downloader.exe" sync --dry-run
echo.
echo ------------------------------------------------------------
echo 以上是「如果现在下载会选哪些种子」。确认没问题后，
echo 双击「3 启动.cmd」开始真正下载，或用「4 执行一次.cmd」跑一轮真实下载。
echo ------------------------------------------------------------
pause
