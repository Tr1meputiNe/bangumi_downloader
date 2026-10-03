@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 番剧下载 - 卸载开机自启

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\uninstall-startup.ps1"
pause
