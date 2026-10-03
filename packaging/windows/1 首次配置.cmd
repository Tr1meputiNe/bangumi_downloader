@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 番剧自动下载 - 首次配置

if not exist "config.json" (
  if exist "config.example.json" (
    copy /y "config.example.json" "config.json" >nul
    echo 已根据模板生成 config.json
  ) else (
    echo 找不到 config.example.json，无法生成配置文件。
    pause
    exit /b 1
  )
) else (
  echo config.json 已存在，直接打开编辑。
)

echo.
echo ============================================================
echo  需要填写的内容（用记事本打开后修改下面这几项）：
echo.
echo    qbittorrent.username / password
echo        填 qBittorrent「选项 - WebUI」里的用户名和密码
echo.
echo    qbittorrent.savePath
echo        番剧下载到哪个目录，例如 D:/Anime
echo        留空表示用 qBittorrent 的默认下载目录
echo.
echo    plannerBaseUrl
echo        Bangumi Watch Planner 的地址，默认 http://127.0.0.1:3777
echo.
echo  改完保存关闭记事本即可。
echo ============================================================
echo.
start "" notepad "config.json"
echo 保存好之后，双击「2 检查配置.cmd」验证是否连通。
echo.
pause
