@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 番剧下载 - 网页界面（搜索并挑选）

if not exist "config.json" (
  echo 还没有 config.json，请先双击 1-setup.cmd。
  pause
  exit /b 1
)

echo ============================================================
echo  正在启动网页界面，稍后会自动打开浏览器
echo.
echo  用法：输入番名搜索，点整行勾选，点「开始下载」
echo  下载在后台进行，界面下方能看到进度，可随时暂停/取消
echo  关掉这个窗口就停止服务（已在下载的任务不受影响）
echo ============================================================
echo.

"%~dp0bangumi-downloader.exe" serve
echo.
echo 服务已停止。
pause
