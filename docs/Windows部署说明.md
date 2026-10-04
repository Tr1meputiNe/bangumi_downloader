# Windows 部署说明（bangumi-downloader）

这份说明是给**这台 Windows 机器**写的，记录它实际怎么装的、怎么用、以及踩过的坑。

**目录布局**（软件和下载内容放在一起，但各自独立不混）：

```
D:\anime_download\
├── bangumi-downloader\        ← 软件本体（源码 + 构建产物 + 配置 + 日志）
├── .bangumi-meta\             ← 校验缓存与本地清单（别删）
├── [BDrip] Hibike Euphonium S03 [Sakurato&7³ACG]\    ← 下载的番剧
└── [LinRip] Sound Euphonium Movie Part1 …\           ← 以及自己放进去的片子
```

软件之所以放成**子目录**而不是直接铺在 `D:\anime_download` 根下：
根目录是「下载目录」，程序会自动扫描它来统计内容，
混在一起会把程序文件当成下载内容。扫描逻辑现在会自动识别并跳过程序目录
（判据：目录里有没有 `bangumi-downloader.exe`），所以即使你把它放别处也不会误判。

项目本身的完整文档在 [README.md](README.md)。

---

## 一分钟上手

| 我想… | 双击这个 | 说明 |
| --- | --- | --- |
| 搜一部番、直接下整季 | `8-download.cmd` | 输入番名即可；会逐条实测速度，挑能下动的下 |
| 打开网页搜索界面 | `9-webui.cmd` | 启动服务并自动开浏览器；已在后台常驻时直接访问 `http://127.0.0.1:3778/` |
| 改配置 | `1-setup.cmd` | 用记事本打开 `config.json` |
| 检查连通性 | `2-check.cmd` | 逐项测试片源与下载后端 |
| 自动追番（常驻） | `4-auto.cmd` | 按 `watchlist.json` 每 30 分钟检查一次新集 |
| 自动追番（只跑一轮） | `7-run-once.cmd` | 适合放计划任务 |
| 开机自动追番 | `5-install-startup.cmd` | 注册登录时启动的计划任务；`uninstall-startup.cmd` 取消 |

所有命令都在 `D:\anime_download\bangumi-downloader\release\windows\` 下，双击即用，不需要装 Node.js。

---

## 这台的配置

配置在 `release\windows\config.json`，关键几项：

```jsonc
{
  "download": {
    "backend": "builtin",        // 用自带的 BT 引擎，不依赖 qBittorrent
    "savePath": "D:/anime_download",   // 番剧下到这里
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

## 追番数据从哪来：两种来源

程序支持两种「该下什么」的来源，`auto` 会**优先用 Planner，连不上再退回清单**：

| 来源 | 是什么 | 适合 |
| --- | --- | --- |
| **Bangumi Watch Planner**（默认） | 你在 3777 那个应用里的「在看 / 未看 / 已播出」状态，权威且不用自己维护 | 有在用 Planner（本机或经 Tailscale 的另一台机器） |
| `watchlist.json` | 本地的一个番名清单 | 没有 Planner，或想手动指定要追哪些 |

这台 Windows 上配的是 **Planner 模式**，指向 Mac 上的 Planner（经 Tailscale）：

```jsonc
"plannerBaseUrl": "http://100.71.105.9:3777"
```

也就是说：**你只要在 Mac 的 3777 页面把番剧标成「在看」，Windows 这台就会自动去下。**
不需要在这边重复维护一份清单。

想改成只用清单：加 `--no-planner`，或把 `plannerBaseUrl` 指向一个连不上的地址。

### 「播出后半小时到一小时才有链接」是怎么处理的

这是关键的一点。片源站一般在新番**播出后 30~60 分钟**才出种，
所以只按「播出日期 ≤ 今天」判断的话，播出当天一整天都会反复搜、反复落空。

Planner 的待看集数据里带**播出时刻**（`airTime`），程序用它算一个时间点：

```
该开始找的时间 = 播出日期 + 播出时刻 + readyDelayMinutes（默认 60 分钟）
```

早于这个时间就先跳过，下一轮再看。配合**每 15 分钟**的计划任务触发，
就能在片源出来后的第一个 15 分钟窗口内开始下载，而不是瞎搜一整天。

行为可以这样验证（把缓冲关掉对比）：

```bat
bangumi-downloader.exe auto --dry-run                    :: 用 60 分钟缓冲
bangumi-downloader.exe auto --dry-run --config other.json :: 把 readyDelayMinutes 设 0 做对照
```

关掉缓冲时会看到「1 部番剧有未看集数」，开着时是「0 部」——因为那一集还没到点。

拿不到播出时刻时（老数据或缺字段）不拦，宁可早试几次，
也不要因为缺个字段就永远不下。

## 全自动追番（装一次就不用管）

### 怎么装

1. 编辑 `watchlist.json`，把要追的番名填进去
2. 双击 `5-install-startup.cmd`
3. 完事

之后不用再管：**每 30 分钟自动检查一次新集**，有就下，下不完下次接着下。

### 为什么这样设计

| 问题 | 处理方式 |
| --- | --- |
| 片源站要播出后半小时才有种 | 用 Planner 的播出时刻 + 60 分钟缓冲算「该找了没」，到点才开始搜 |
| 下载要跑好几小时，中途关机/睡眠怎么办 | 用「定时触发」而不是常驻进程，下次触发自动接着下（引擎会跳过已校验的分片） |
| 上一次还没跑完，下一次又触发了 | 程序内有单实例锁，第二次直接退出，不会互相抢分片 |
| 挑到的种子是死种 | 自动逐条候选实测吞吐，换到下得动的那条；整季都不行会退化成单集 |
| 一轮时间预算用完还没下完 | 自动重试（默认 6 轮，带退避），每轮都从磁盘进度继续 |
| 合集只下了一半，会不会被当成已下完 | 不会。只有整包下完才记 `completedEpisodes`，半集绝不会被跳过 |
| 跨境的 peer 时有时无 | 每 30 分钟重来一次，碰上有速度的时段就推进一点；进度永久保留 |

### 清单格式

```json
{
  "version": 1,
  "entries": [
    {
      "query": "吹响上低音号 第三季",
      "lastEpisode": 0,
      "completedEpisodes": []
    },
    { "query": "葬送的芙莉莲 第二季" }
  ]
}
```

- `query`：搜索关键词，跟你在 `8-download.cmd` 里输的一样
- `completedEpisodes` / `lastEpisode`：**程序自动维护**，不用手改。
  `completedEpisodes` 是「哪几集真的下完了」，`lastEpisode` 是「连续追到第几集」
- `startFrom`：可选，从第几集开始追
- `enabled: false`：可选，临时跳过这一条

## 网页界面

有 GUI，就是 `9-webui.cmd`（或直接访问 **`http://127.0.0.1:3778/`**）。

```
9-webui.cmd  →  浏览器自动打开
```

界面上能做的事：

- 输入番名搜索，结果从 animes.garden / nyaa 并行抓取、按偏好打分排序
- 每条标出**集号、分辨率、容器、字幕语言、字幕组、体积**，右边的分数鼠标悬停可看构成
- **点整行勾选**（可多选），右下角一次推送到下载
- 顶部可按片源过滤，或勾「只看符合偏好」把不合偏好的折叠起来
- 选中的是合集时，只下你勾中的那几集

右上角的连接状态现在会显示 **「内置下载引擎（无需 qBittorrent）」**。
（以前没有 qBittorrent 时这里会报「只能搜索，不能下载」——那是旧后端的说法，
现在默认用自带引擎，点下载是真的能下的。）

### 让它常驻

`9-webui.cmd` 是前台运行，关掉窗口就停。想让它一直在（随时打开浏览器就能用），
已经注册了一个后台计划任务 **`BangumiDownloader-GUI`**：

- 登录时启动，另外每 15 分钟自愈一次（崩溃或被关掉会自动回来）
- 已经在跑时，重复触发会因为端口被占而立刻退出，不会起两个

需要停掉它：

```powershell
Stop-ScheduledTask  -TaskName BangumiDownloader-GUI
Unregister-ScheduledTask -TaskName BangumiDownloader-GUI -Confirm:$false
```

注意它只监听 `127.0.0.1`（只有本机能访问）。想从别的机器用，
把 `config.json` 里 `web.host` 改成 `0.0.0.0` —— 但那等于把下载接口开放给局域网，
自己评估风险。

### 报告里的符号怎么看

```
✅  分片哈希逐片校验通过 —— 真的下完了
⚠️  下了一半（会给出真实百分比）
⬜  空壳：一个有效分片都没有
❌  有视频文件播不了（下面会列出具体是哪个文件、什么原因）
📁  本地内容（不是本项目下的，只报体积和抽检结果）
```

`❌` 会直接说明原因，例如：

```
❌ 《某个目录》
     2/3 个视频播不了
       · empty-shell.mkv  → 内容全是零（预分配出来的空壳），播不了
       · no-moov.mp4      → MP4 缺少 moov 索引，无法正常播放/拖动
       · weird-header.mkv → 文件头不是认识的视频格式，播放器多半打不开
```

这套判断**只看文件内容**，不看文件系统给的任何元数据：

1. 容器魔数对不对（MKV 的 EBML / MP4 的 ftyp / AVI 的 RIFF）
2. MP4 的 `moov` 索引在不在（缺了就没法 seek，很多播放器直接拒绝）
3. 8 个采样窗口铺满整个文件，看有没有实际数据。
   窗口宽度**不小于步长**，所以任何连续数据都不可能整段落在采样空隙里
   —— 这一点是踩坑之后才定下的：早先用 16 个固定 1MB 窗口铺 32MB 文件，
   步长 2.16MB、空隙 1.1MB，一个写在中间的 128KB 数据块正好掉进空隙，被判成空壳。

判断刻意保守：只有「魔数之外不足 4KB」才说空壳，只有「不足 256KB」才说可能没下完。
因为文件本该有多大是未知的，误报比不报更糟 —— 会让人不再相信报告。

### 下载目录里还有什么

`D:\anime_download` 里除了本项目下的内容，还可能放着你用别的工具下的片子。
`verify` 会把两类都列出来，用符号区分：

- `✅` 本项目下载、**分片哈希逐片校验通过**
- `📁` 本地内容（无种子元数据，只报体积和文件数，不声称完整）
- `⚠️` / `⬜` 本项目下载但只下了一半 / 完全是空壳

第一次遇到本地内容时用一次 `--add-local`，之后它就会被记进
`D:\anime_download\.bangumi-meta\inventory.json`，以后 `verify` 都会带上它：

```bat
bangumi-downloader.exe verify --add-local
```

### 手动触发 / 观察

```bat
cd /d D:\anime_download\bangumi-downloader\release\windows

bangumi-downloader.exe auto                  :: 立刻检查一轮
bangumi-downloader.exe auto --dry-run        :: 只看会下什么，不下载
bangumi-downloader.exe auto --retry 20       :: 更执着一点，重试 20 轮
bangumi-downloader.exe auto --daemon         :: 常驻模式（不用计划任务时）
```

计划任务的状态：

```powershell
Get-ScheduledTaskInfo -TaskName BangumiDownloader
```

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

用 `verify`，不要看文件大小 —— 程序会预先分配文件到完整长度（为了断点续传），
所以没下完的文件看起来也是满的。实测踩过：13 个看着齐整的 700MB mkv，
分片哈希一验只有前几个分片是真的，播放器打开即报错。

**Q：想看每个 peer 到底卡在哪**

```bat
cd /d D:\anime_download\bangumi-downloader
npx tsx scripts\diag-peer.ts <infohash>
```

会逐个 peer 报告 TCP 握手 / 扩展握手 / 元数据三步的结果。
`scripts\probe-reachable.ts "关键词"` 则用来批量看哪些候选真的有可达的 peer。

---

## 自动化是怎么做到「不用人管」的

无人值守的难点不在下载本身，而在**没人做判断时的每一个岔路口**。逐条对应：

| 岔路口 | 程序里的处理 |
| --- | --- |
| 搜到 87 条候选，选哪条 | 按偏好分档，再对前 12 条**实测真实吞吐**，选能下动的 |
| 选中的那条是死种 | 换下一条；整季都不行就退化成「一集一集下」 |
| 一轮时间预算用完还没下完 | 自动重试 8 轮（退避 5 分钟 → 1 小时），每轮从磁盘进度继续 |
| 上次下到一半，这次重下吗 | 不重下。引擎 `resumeScan()` 把已校验的分片标出来跳过 |
| 怎么知道上次下到哪条了 | 元数据缓存（`D:\download\.bangumi-meta\<infohash>.bin`）让它离线也能定位目录 |
| 计划任务 30 分钟触发一次，会不会打架 | 单实例锁（`data\.bangumi.lock`），第二个实例直接退出 |
| 合集只下了一半，会不会被当成下完了 | 不会。只有**整包下完**才记 `completedEpisodes`，半集绝不跳过 |
| 下完了但没记进度，下轮又下一遍 | 下完立刻写回 `watchlist.json`，下轮不会再挑 |
| 出问题了怎么查 | 固定写 `data\bangumi.log`（超过 8MB 自动轮转），带完整时间线和原因 |
| 清单忘了填 | 启动时明确告警「全被禁用了」，而不是静默什么都不做 |
| 重新构建 exe 会不会把状态清掉 | 不会。`config.json`、`watchlist.json`、`data/` 都会被保留 |

一轮 30 分钟的典型行为：

```
触发 → 抢锁（抢不到就退出）→ 读清单 → 搜新集
     → 有进度就续传 / 没进度就实测候选
     → 下满预算或下完 → 写回进度 → 释放锁
```

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

6. **`(x ?? 1) > 0 ? x : 1` 这种写法会漏出 `undefined`**：本意是「缺省取 1」，
   结果 `x` 为 undefined 时整个表达式返回 undefined，而 `集号 >= undefined` 恒为 false。
   现象极其隐蔽：搜到了 13 集，程序却说「没有新集」，一条都不下。
   同样的写法在 `watchlist.ts` 里还有一处，一并修了，并补了回归测试
   （`tests/auto.test.ts`）。

7. **剧场版会被解析出离谱集号**：「…最终乐章 前篇～」(BDRip 1080p) 解析成第 264 集
   （分辨率残片），「莉兹与青鸟 2018」解析成第 2018 集（年份）。
   结果是「片源最高第 2018 集」→ 整季都被判成没有新集。
   现在按中位数判断：超过中位数 3 倍且大于 52 的集号当噪声丢掉。

8. **自动化最怕的不是失败，是静默**：第一次自动运行「成功」退出但什么都没做，
   且没有任何日志，完全无从查起。所以现在：auto 固定写文件日志、
   异常不向计划任务抛错（避免任务历史里一堆红叉掩盖真问题）、
   清单全禁用时明确告警。
