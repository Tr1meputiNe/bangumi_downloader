@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 番剧下载 - 检查配置

if not exist "config.json" (
  echo 还没有 config.json，请先双击 1-setup.cmd。
  pause
  exit /b 1
)

echo 正在检查 Bangumi Watch Planner、各片源和 qBittorrent 的连通性...
echo.
"%~dp0bangumi-downloader.exe" check
echo.
echo ------------------------------------------------------------
echo 上面全部显示 ✓ 就说明配置没问题，可以双击 3-search.cmd 开始下载。
echo 如果有 ✗，请按提示检查对应服务（qBittorrent 必须处于运行状态）。
echo ------------------------------------------------------------
pause
