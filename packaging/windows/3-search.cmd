@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 番剧下载 - 资源搜索界面

if not exist "config.json" (
  echo 还没有 config.json，请先双击 1-setup.cmd。
  pause
  exit /b 1
)

echo ============================================================
echo  正在启动资源搜索界面，启动后会自动打开浏览器
echo  在网页里搜索番剧名，挑选后点「推送到 qBittorrent」
echo  关闭这个窗口即可停止网页服务（已开始的下载不受影响）
echo ============================================================
echo.

"%~dp0bangumi-downloader.exe" serve
echo.
echo 网页服务已停止。
pause
