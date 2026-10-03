@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 番剧自动下载 - 守护运行中

if not exist "config.json" (
  echo 还没有 config.json，请先双击 1-setup.cmd。
  pause
  exit /b 1
)

echo ============================================================
echo  正在持续运行：每 30 分钟检查一次追番进度并推送新集到 qBittorrent
echo  关闭这个窗口即可停止（qBittorrent 里的下载不受影响）
echo ============================================================
echo.

"%~dp0bangumi-downloader.exe" run
echo.
echo 已停止。
pause
