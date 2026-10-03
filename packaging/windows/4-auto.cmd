@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 番剧下载 - 自动追番（常驻，按 watchlist.json）

if not exist "config.json" (
  echo 还没有 config.json，请先双击 1-setup.cmd。
  pause
  exit /b 1
)

if not exist "watchlist.json" (
  echo 还没有 watchlist.json，先运行一次本脚本会自动生成模板，
  echo 把要追的番名填进 entries 再重新运行即可。
  echo.
)

echo ============================================================
echo  自动追番：每 30 分钟读一次 watchlist.json，
echo  发现清单里的番有没下过的新集就自动下载。
echo  关闭这个窗口即可停止。
echo ============================================================
echo.

"%~dp0bangumi-downloader.exe" auto --daemon
echo.
echo 已停止。
pause
