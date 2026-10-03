@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 番剧下载 - 自动追番（常驻）

if not exist "config.json" (
  echo 还没有 config.json，请先双击 1-setup.cmd。
  pause
  exit /b 1
)

echo ============================================================
echo  自动追番模式：每 30 分钟检查一次 Watch Planner 里的追番进度
echo  发现已播出但未看的集数时自动搜种并推送到 qBittorrent
echo  关闭这个窗口即可停止
echo ============================================================
echo.

"%~dp0bangumi-downloader.exe" run
echo.
echo 已停止。
pause
