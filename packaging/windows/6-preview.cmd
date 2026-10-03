@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 番剧下载 - 预览自动追番会下载什么

if not exist "config.json" (
  echo 还没有 config.json，请先双击 1-setup.cmd。
  pause
  exit /b 1
)

set /p KEYWORD=输入番剧名（留空则只预览自动追番的结果）: 

if "%KEYWORD%"=="" (
  echo.
  echo 预览自动追番这一轮会挑选哪些种子（不会真的下载）...
  echo.
  "%~dp0bangumi-downloader.exe" sync --dry-run
) else (
  echo.
  echo 搜索「%KEYWORD%」的候选并按偏好排序...
  echo.
  "%~dp0bangumi-downloader.exe" search --query "%KEYWORD%"
)

echo.
pause
