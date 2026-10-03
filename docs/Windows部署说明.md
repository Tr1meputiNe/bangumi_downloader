# Windows 部署说明（bangumi-downloader）

这份说明是给**这台 Windows 机器**（`D:\bangumi-downloader`）写的，记录它实际怎么装的、
怎么用、以及踩过的坑。项目本身的完整文档在 [README.md](README.md)。

---

## 一分钟上手

| 我想… | 双击这个 | 说明 |
| --- | --- | --- |
| 搜一部番、直接下整季 | `8-download.cmd` | 输入番名即可；会逐条实测速度，挑能下动的下 |
| 打开网页搜索界面 | `3-search.cmd` | 浏览器打开 `http://127.0.0.1:3778/`，勾选后下载 |
| 改配置 | `1-setup.cmd` | 用记事本打开 `config.json` |
| 检查连通性 | `2-check.cmd` | 逐项测试片源与下载后端 |
| 自动追番（常驻） | `4-auto.cmd` | 按 `watchlist.json` 每 30 分钟检查一次新集 |
| 自动追番（只跑一轮） | `7-run-once.cmd` | 适合放计划任务 |
| 开机自动追番 | `5-install-startup.cmd` | 注册登录时启动的计划任务；`uninstall-startup.cmd` 取消 |

所有命令都在 `D:\bangumi-downloader\release\windows\` 下，双击即用，不需要装 Node.js。

---

## 这台的配置

配置在 `release\windows\config.json`，关键几项：

```jsonc
{
  "download": {
    "backend": "builtin",        // 用自带的 BT 引擎，不依赖 qBittorrent
    "savePath": "D:/download",   // 番剧下到这里
    "trialSeconds": 75,          // 每条候选试跑多久来判断速度
    "minThroughputKBps": 30,     // 低于这个速度就换下一条候选
    "maxAttempts": 10,           // 最多试几条
    "budgetMinutes": 480         // 一次 download 的总时间预算
  },
  "trackers": {
    "animesGarden": true,
    "nyaa": true,
    "mikan": false               // 这台机器连不上 mikanani.me，已关掉
  }
}
```

> **改完 `config.json` 不用重新构建**。重新构建（`npm run build`）也会保留产物目录里
> 已有的 `config.json`，不会把你的设置清掉。

---

## 自动追番怎么用

不用 Bangumi Watch Planner（那台服务跑在 Mac 上，Windows 这边没有），
改成读同目录的 `watchlist.json`：

```json
{
  "version": 1,
  "entries": [
    { "query": "吹响上低音号 第三季", "lastEpisode": 13 },
    { "query": "葬送的芙莉莲 第二季" }
  ]
}
```

- `query`：搜索关键词，跟你在 `8-download.cmd` 里输的一样
- `lastEpisode`：已经下到第几集。**程序跑完会自动更新这个字段**，一般不用手改
- `startFrom`：可选，从第几集开始追
- `enabled: false`：可选，临时跳过这一条

跑一轮：`bangumi-downloader.exe auto`
常驻：`bangumi-downloader.exe auto --daemon`

只有**真正下完**才会推进 `lastEpisode`，下了一半不会把进度记成已完成。

---

## 排错

**Q：显示「试过的候选都下不动」**

这批种子的 peers 大多在国内，跨境连 BT 常被重置（实测 87 条候选里能拿到数据的只有两三条）。
程序会自己逐条试，全都不行才会报这个错。可以：

1. 换个字幕组的关键词，或者用日文原名（例如「響け！ユーフォニアム」）再搜一次
2. 过一段时间再试 —— 新番刚播完时做种少，几天后会好转
3. 把 `minThroughputKBps` 调低（例如 10），接受更慢的速度

**Q：速度很慢（几十 KB/s）**

这是跨境连国内 peer 的常态，不是程序的问题。程序会把速度达标的候选一直下完，
中途断了重跑会**断点续传**（已经校验通过的分片不会重下）。

**Q：想确认到底下了多少**

看命令行窗口里的 `已完成分片 N/M` 和 `累计收到 block`。
注意**不要用文件大小判断进度** —— 程序会预先分配文件到完整长度（为了断点续传），
所以没下完的文件看起来也是满的。

**Q：想看每个 peer 到底卡在哪**

```bat
cd /d D:\bangumi-downloader
npx tsx scripts\diag-peer.ts <infohash>
```

会逐个 peer 报告 TCP 握手 / 扩展握手 / 元数据三步的结果。
`scripts\probe-reachable.ts "关键词"` 则用来批量看哪些候选真的有可达的 peer。

---

## 这台机器上踩过的坑（留个记录）

1. **qBittorrent 用不了**：winget 装的 5.2.4 在 SSH 会话（Session 0）里启动后卡在初始化，
   CPU 0、不监听 WebUI、无任何输出；换到桌面会话（计划任务）也一样。
   所以改成项目自带的 `builtin` 下载后端 —— 零外部依赖，且能在无桌面环境下跑。
   顺带发现 8080 端口被 Steam 的 CEF 远程调试占着（这也是当初换 8081 的原因）。

2. **BEP 9 元数据曾经完全取不到**，三个独立 bug：
   - BT 握手的保留位没声明扩展协议（`reserved[5] & 0x10`），对端因此**根本不发**扩展握手
   - 扩展 ID 有方向性：入站消息要按**我们宣告给对方的 id** 过滤，而不是对方宣告的 id
   - ut_metadata 的响应是「bencode 头 + 紧跟其后的原始分片」，不是放在 `data` 字段里

3. **事件监听挂晚了会丢消息**：对端常把「BT 握手 + bitfield + 扩展握手」塞进同一个 TCP 段，
   `#onData` 会同步处理完整批帧。所以监听必须在 `connect()` 返回**之前**挂上
   （这就是 `PeerConnection.connect` 的 `setup` 回调存在的原因）。

4. **choke/interested 互锁**：被 choke 时派不到 block，而原来的代码是「派到 block 才发
   interested」——于是永远不会 unchoke。实测现象是「连上 152 个 peer，在途 block 恒为 0」。

5. **稀疏文件不能用来量进度**：文件预分配后 `statSync().size` 一开始就是满的，
   拿它算吞吐会得出 123 MB/s 这种离谱数字，把完全没速度的候选判成「达标」。
