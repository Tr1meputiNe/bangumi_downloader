#!/usr/bin/env bash
#
# 把当前源码部署到那台 Windows 机器上并重新打包。
#
# 为什么要有这个脚本：部署步骤有好几个「顺序不能错」的地方，
# 手动敲很容易漏 —— 漏了任何一步的表现都是「改了代码但界面没变」，
# 而原因（进程占着产物目录 / 没重新打包 / 没同步脚本）各不相同。
#
#   1. 先停服务并**禁用**计划任务。GUI 那个任务每 15 分钟会自愈重启，
#      不管它的话，打包到一半 exe 会被重新启动并锁住产物目录。
#   2. 传源码 → 在那边打包（单文件 exe 必须用目标平台的 Node 来注入）。
#   3. 同步 packaging/windows 里的脚本到 release 目录。
#   4. 恢复计划任务并启动，最后确认服务真的起来了（版本号要对得上）。
#
# 用法：scripts/deploy-windows.sh [ssh主机别名]
set -euo pipefail

HOST="${1:-win}"
REMOTE_DIR='D:\anime_download\bangumi-downloader'
RELEASE_DIR="$REMOTE_DIR\\release\\windows"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARBALL="$(mktemp -t bd-src-XXXXXX.tar.gz)"

cleanup() {
  rm -f "$TARBALL"
}
trap cleanup EXIT

echo "== 本地检查 =="
(cd "$ROOT" && node scripts/build-client.mjs >/dev/null && npx tsc --noEmit && npx eslint . >/dev/null)
echo "   类型检查与 lint 通过"

echo "== 停服务、禁用计划任务 =="
# 任务禁用失败不算错（可能这台机器上根本没装）
ssh -o BatchMode=yes "$HOST" "schtasks /Change /TN BangumiDownloader-GUI /DISABLE >nul 2>&1 & schtasks /Change /TN BangumiDownloader /DISABLE >nul 2>&1 & taskkill /F /IM bangumi-downloader.exe >nul 2>&1 & echo ok"

echo "== 传源码 =="
(cd "$ROOT" && COPYFILE_DISABLE=1 tar czf "$TARBALL" \
  --exclude=node_modules --exclude=release --exclude=.git --exclude=dist \
  --exclude=data --exclude='._*' --exclude='*.tar.gz' .)
cat "$TARBALL" | ssh -o BatchMode=yes "$HOST" "cd /d $REMOTE_DIR && tar xzf - && echo ok"

echo "== 打包（前端 + 单文件 exe） =="
ssh -o BatchMode=yes "$HOST" "cd /d $REMOTE_DIR && npm run build"

echo "== 同步启动脚本 =="
ssh -o BatchMode=yes "$HOST" "cd /d $REMOTE_DIR && xcopy packaging\\windows release\\windows /E /Y >nul && echo ok"

echo "== 恢复计划任务并启动 =="
ssh -o BatchMode=yes "$HOST" "schtasks /Change /TN BangumiDownloader-GUI /ENABLE >nul && schtasks /Change /TN BangumiDownloader /ENABLE >nul && schtasks /Run /TN BangumiDownloader-GUI >nul && echo ok"

echo "== 确认服务 =="
sleep 8
for attempt in 1 2 3 4 5; do
  if status=$(ssh -o BatchMode=yes "$HOST" "curl -s -m 10 http://127.0.0.1:3778/api/status" 2>/dev/null) && [ -n "$status" ]; then
    echo "   $status"
    exit 0
  fi
  echo "   第 $attempt 次没起来，再等 5 秒…"
  sleep 5
done

echo "服务没有在预期时间内响应，去那台机器上看 data/bangumi.log" >&2
exit 1
