@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 番剧下载 - 搜索并下载整季

if not exist "config.json" (
  echo 还没有 config.json，请先双击 1-setup.cmd。
  pause
  exit /b 1
)

echo 输入番剧名，程序会搜种、逐条实测速度，然后下载能下动的那一条。
echo 没有集号时默认尽量下整季合集；也可以只下几集，例如 1-13 或 3,5,7。
echo.
set /p KEYWORD=番剧名: 
if "%KEYWORD%"=="" (
  echo 没有输入番剧名，已取消。
  pause
  exit /b 1
)

set /p EPS=只要这些集（留空=整季）: 

echo.
if "%EPS%"=="" (
  "%~dp0bangumi-downloader.exe" download --query "%KEYWORD%"
) else (
  "%~dp0bangumi-downloader.exe" download --query "%KEYWORD%" --episodes "%EPS%"
)

echo.
pause
