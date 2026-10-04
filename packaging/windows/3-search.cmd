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
echo  资源搜索界面：在网页里搜番剧名，勾选后点「开始下载」
echo.
echo  注意：界面可能已经作为后台服务在运行（开机自启）。
echo  那种情况下本脚本会提示你直接打开地址，不会重复启动。
echo  想一直用它，双击 9-webui.cmd 或直接访问下面这个地址。
echo ============================================================
echo.

"%~dp0bangumi-downloader.exe" serve

rem 服务已经在后台运行时，上面的命令会提示地址并直接退出（退出码 0），
rem 这时说「已停止」会让人以为把服务关掉了，所以分开提示。
if errorlevel 1 (
  echo.
  echo 启动失败，原因见上面的输出。
) else (
  echo.
  echo 本窗口已退出。若提示「已经有本程序在运行」，后台服务仍在正常工作。
)
pause
