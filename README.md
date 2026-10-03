<p align="center">
  <strong>bangumi-downloader</strong><br>
  从本机 Bangumi Watch Planner 读取追番进度，自动搜种并推送到 qBittorrent
</p>

把今天要追的新番自动收进 qBittorrent，不用再手动去各个站点找种子。

它读取你本机 **Bangumi Watch Planner**（默认 `http://127.0.0.1:3777`）里的追番数据，
找出「在看」的番剧里**还没看、但已经播出**的集数，去片源站搜索对应发布，
按你的偏好（默认 **MKV + 1080p + 简体中文**）打分挑一个最优的，
然后把磁力链接推给本机 qBittorrent 开始下载。

- **只看你的追番列表**：以 Watch Planner 的数据为准，不受其它订阅源干扰
- **不会下到没播的集**：播出日期晚于今天的集数会被跳过
- **不会重复下载**：按 infohash + 集号记账，推过的不会再推
- **不会为了两集下整个合集**：只缺一两集但只找到合集时，会解析种子文件清单，只勾选需要的那几集
- **单文件 exe，零依赖**：Windows 上解压双击即用，不需要装 Node.js、Python 或 Docker

---

## 目录

- [工作原理](#工作原理)
- [Windows 使用](#windows-使用)
- [配置说明](#配置说明)
- [挑选规则](#挑选规则)
- [命令行用法](#命令行用法)
- [常见问题](#常见问题)
- [开发](#开发)
- [许可](#许可)

---

## 工作原理

```
┌──────────────────────┐
│ Bangumi Watch Planner│  读取 /api/dashboard、/api/subjects/:id/episodes
│ 127.0.0.1:3777       │  → 「在看」且未看、且已播出的集号
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│  片源搜索（三路并行）  │  animes.garden（聚合 dmhy）
│                      │  mikan 官方 RSS
│                      │  nyaa（nyaa.land → nyaa.si 自动回退）
└──────────┬───────────┘
           │  按 infohash 去重合并
           ▼
┌──────────────────────┐
│  打分挑选             │  容器 MKV > MP4；1080p > 2160p > 720p
│                      │  简中 > 繁中；字幕组白/黑名单；做种数
│                      │  排除预告/PV/NCOP 等非正片
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│  qBittorrent WebUI   │  磁力直推；合集则解析 .torrent 只勾选需要的分集
└──────────────────────┘
```

### 为什么 dmhy 走 animes.garden

`dmhy.org` 在部分网络环境下直连会被重置（TLS 握手被 RST）。`animes.garden` 本身就聚合了 dmhy
的内容并直接提供磁力链接，所以程序把 dmhy 当作「经由 animes.garden 获取」，
同时把它当作一个额外的补充源。mikan 和 nyaa 则各自走官方接口，保证覆盖度。

### 为什么需要单独解析 .torrent

通过磁力链接添加种子时，qBittorrent 在取到元数据之前并不知道里面有哪些文件，
因此没法在添加的瞬间说「只下第 3 集」。如果不管这一点，
一个 50 GB 的季度合集会被整个拉下来，而你只缺一集。
所以当程序选中的是合集、且目标只是其中少数几集时（体积大于 4 GB），
它会自己下载一份 `.torrent`，解析出文件清单，挑出目标分集，
再把种子内容直接交给 qBittorrent，这样选择性下载才能生效。

---

## Windows 使用

### 1. 安装并配置 qBittorrent

1. 安装 [qBittorrent](https://www.qbittorrent.org/download)（任意近期版本）。
2. 打开 **选项 → WebUI（网页用户界面/远程控制）**，勾选 **「Web 用户界面(远程控制)」**。
3. 记下端口（默认 `8080`）和用户名密码（默认用户名 `admin`）。
4. 建议把「默认下载路径」或程序配置里的 `savePath` 设成你放番剧的目录，
   例如 `D:/Anime`。

### 2. 确认 Watch Planner 在运行

浏览器打开 `http://127.0.0.1:3777/`，确认能正常看到页面，
并且你想下载的番剧状态是 **「在看」**。

### 3. 解压并配置

1. 从 [Releases](../../releases) 下载 `bangumi-downloader-*-windows-x64.zip`，
   解压到一个固定目录（不要只在压缩包预览里双击运行）。
2. 双击 **`1-setup.cmd`**。它会生成 `config.json` 并用记事本打开。
3. 至少改这两项，然后保存关闭：

   ```jsonc
   {
     "qbittorrent": {
       "url": "http://127.0.0.1:8080",   // 你的 WebUI 端口
       "username": "admin",              // WebUI 用户名
       "password": "你的密码",            // WebUI 密码
       "savePath": "D:/Anime"            // 下载到哪，留空用 qBittorrent 默认目录
     }
   }
   ```

### 4. 检查连通性

双击 **`2-check.cmd`**。它会依次测试 Watch Planner、三个片源和 qBittorrent。

全部显示 `✓` 才算配置正确：

```
✓ Bangumi Watch Planner 可访问：http://127.0.0.1:3777
  收藏状态 3 的番剧 9 部
    · 《相反的你和我 第二季》未看 1 集
✓ 片源 animes.garden 可用，测试搜索返回 59 条
✓ 片源 mikan 可用，测试搜索返回 60 条
✓ 片源 nyaa 可用，测试搜索返回 60 条
✓ qBittorrent 可连接：http://127.0.0.1:8080（应用 v5.0.5，WebAPI 2.11）
```

### 5. 先预览再开跑（推荐）

双击 **`6-preview.cmd`**。它只搜索和挑选、不下载，让你确认选中的版本合不合口味：

```
[dry-run] 《相反的你和我 第二季》第13集 ← animes.garden | 1.2GB | [喵萌奶茶屋&LoliHouse] 相反的你和我 第二季 - 13 [WebRip 1080p HEVC-10bit AAC][简繁日内封字幕]
```

觉得挑得不对，就回去改 [挑选规则](#挑选规则) 里的偏好。

### 文件说明

压缩包里的脚本都用 ASCII 文件名（中文名在 zip 里容易变成乱码），双击后窗口标题会显示中文用途：

| 文件 | 用途 |
| --- | --- |
| `1-setup.cmd` | 首次配置：生成 `config.json` 并用记事本打开 |
| `2-check.cmd` | 检查 Watch Planner、片源、qBittorrent 的连通性 |
| `3-start.cmd` | 常驻运行，每 30 分钟检查一次 |
| `4-run-once.cmd` | 只执行一轮真实下载 |
| `5-install-startup.cmd` | 注册开机自启 |
| `6-preview.cmd` | 预览这次会下载哪些集（不推送） |
| `uninstall-startup.cmd` | 取消开机自启并结束后台进程 |

### 6. 开始下载

- **`3-start.cmd`** —— 常驻运行，每 30 分钟检查一次。**关掉窗口就停止**（qBittorrent 里已开始的下载不受影响）。
- **`4-run-once.cmd`** —— 只跑一轮就退出，适合配合 Windows 任务计划程序。
- **`5-install-startup.cmd`** —— 注册一个登录时自动启动的计划任务，开机后自动在后台跑。
  用 **`uninstall-startup.cmd`** 取消。

> 首次运行某个新番时，片源站可能还没出种（例如刚播完几分钟），
> 这种情况会被记成「无片源」并在下一轮自动重试，属于正常现象。

---

## 配置说明

配置文件是 `config.json`，与 exe 放在同一目录。相对路径都相对于该目录解析。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `plannerBaseUrl` | `http://127.0.0.1:3777` | Watch Planner 地址 |
| `intervalMinutes` | `30` | `run` 模式的轮询间隔（分钟） |
| `collectionTypes` | `[3]` | 抓取哪些收藏状态：3=在看，1=想看，4=搁置 |
| `includeBacklog` | `false` | 是否连同补番计划一起下载 |
| `download.enabled` | `true` | 设为 `false` 等价于全局 dry-run，只挑不下 |
| `download.maxEpisodesPerSubjectPerRun` | `3` | 单部番剧单轮最多处理几集 |
| `download.maxTorrentsPerRun` | `10` | 单轮最多推送几个种子 |
| `download.lookbackDays` | `null` | 只处理最近 N 天内播出的集；`null` 表示不限制 |
| `download.onlyAiredAfter` | `null` | 只处理该日期之后播出的集，例如 `"2026-10-01"` |
| `qbittorrent.url` | `http://127.0.0.1:8080` | qBittorrent WebUI 地址 |
| `qbittorrent.savePath` | `""` | 下载目录，留空用 qBittorrent 默认 |
| `qbittorrent.category` | `Bangumi` | 在 qBittorrent 里归到哪个分类 |
| `qbittorrent.tags` | `["bangumi-downloader"]` | 自动打的标签，方便筛选 |
| `qbittorrent.paused` | `false` | 推送后是否暂停 |
| `trackers.animesGarden` | `true` | 启用 animes.garden（同时是 dmhy 的来源） |
| `trackers.mikan` | `true` | 启用 mikan |
| `trackers.nyaa` | `true` | 启用 nyaa |
| `trackers.nyaaHosts` | `["https://nyaa.land","https://nyaa.si"]` | 按顺序尝试，第一个可用的会被记住 |
| `trackers.maxResultsPerTracker` | `60` | 每个源每个关键词最多取多少条 |
| `state.file` | `./data/state.json` | 已推送记录，用于跨轮去重 |
| `notify.serverChanKey` | 无 | 填了就在有新增下载时推 Server 酱 |
| `notify.telegram` | 无 | 填了就在有新增下载时推 Telegram |

### 想「先攒着不自动下」

把 `download.enabled` 设成 `false`，程序就只搜索和打印，不会碰 qBittorrent。

### 想只追最近的新番、不补历史

```jsonc
"download": {
  "lookbackDays": 7     // 只处理最近 7 天播出的集
}
```

---

## 挑选规则

同一集通常有几十个字幕组版本。程序按「硬性淘汰 + 加权打分」挑最高分。

### 硬性淘汰

命中任意一条直接淘汰，不参与打分：

- 命中 `preference.excludeKeywords`（默认排除 `预告`、`pv`、`cm`、`menu`、`ncop`、`nced`、`sample`）
- 缺少 `preference.requireKeywords` 里的任一关键词（默认空，即不限制）
- 集号不覆盖目标集（合集只要区间覆盖就算覆盖）
- 发布名明确写了**别的季度**（例如目标是第 2 季，而发布写着 `S01`）。
  没写季度的一律放行 —— 很多字幕组不标季度

### 加权打分

| 分项 | 默认权重 | 行为 |
| --- | --- | --- |
| `container` | 30 | `["mkv","mp4","avi"]`，越靠前分越高 |
| `resolution` | 40 | `["1080p","2160p","720p"]`，越靠前分越高 |
| `subtitle` | 50 | `["简日","简繁","简体","简中","chs","cht","繁体","繁中"]` |
| `group` | 20 | `preferGroups` 加分，`avoidGroups` 减分 |
| `seeders` | 15 | 做种数达到 `seederSaturation`（默认 20）拿满分 |
| `batch` | 10 | 缺多集时合集加分 |

另有少量固定调整：`10bit` +3 分；覆盖更多目标集最多 +5 分
（幅度刻意压得比画质分小，避免为了省事下一个巨大的低画质合集）。

### 常用改法

**只要简体，别的都不要**（把简中设成必需）：

```jsonc
"preference": {
  "requireKeywords": ["简"],
  "subtitlePreference": ["简体", "简日", "简繁"]
}
```

**偏好某个字幕组**：

```jsonc
"preference": {
  "preferGroups": ["喵萌奶茶屋", "LoliHouse", "桜都字幕组"],
  "avoidGroups": ["某些不想要的组"]
}
```

**只要 1080p、不要 4K**：

```jsonc
"preference": {
  "resolutionPreference": ["1080p"],
  "excludeKeywords": ["预告", "pv", "cm", "menu", "ncop", "nced", "sample", "2160p", "4k"]
}
```

**不接受 MP4**：

```jsonc
"preference": {
  "containerPreference": ["mkv"]
}
```

改完配置可以先跑 `bangumi-downloader.exe preview --query "番剧名"`（或双击 `6-preview.cmd`）
看排序结果，确认规则符合预期再开跑。

---

## 命令行用法

```bash
bangumi-downloader <命令> [选项]
```

| 命令 | 作用 |
| --- | --- |
| `sync` | 执行一轮完整流程 |
| `run` | 守护模式，按 `intervalMinutes` 定时执行 |
| `check` | 检查配置、Watch Planner、三个片源、qBittorrent 的连通性 |
| `preview` | 只搜索并打印候选排名，不下载（排错用） |
| `config` | 打印当前生效的完整配置 |

| 选项 | 说明 |
| --- | --- |
| `--config <路径>` | 指定配置文件，默认 `./config.json` |
| `--dry-run` | 只挑选并打印，不推送、不写状态 |
| `--query <关键词>` | `preview` 用哪个关键词搜索 |
| `--verbose` | 输出 debug 日志（含每个源的请求细节和淘汰原因） |

```bash
# 看看某部番现在会挑哪一版
bangumi-downloader preview --query "葬送的芙莉莲"

# 完整跑一轮但不下载
bangumi-downloader sync --dry-run

# 排查为什么没选到想要的版本
bangumi-downloader preview --query "冰之城墙" --verbose
```

---

## 常见问题

**Q：显示「无法连接 Bangumi Watch Planner」**

确认 Watch Planner 正在运行，浏览器能打开 `http://127.0.0.1:3777/`。
如果它跑在别的机器或端口，改 `plannerBaseUrl`。

**Q：显示「没有找到收藏状态为 3 的番剧」**

去 Watch Planner 页面把要下载的番剧标记成 **「在看」**。
程序默认只处理「在看」，不碰「想看」和「搁置」。

**Q：某个番剧一直显示「无片源」**

按顺序排查：

1. 该集是否**已经播出**？未播出的集会被有意跳过。
2. 是不是刚播完？片源站出种通常要几分钟到几小时，等下一轮即可。
3. 用 `preview --query "番剧名" --verbose` 看看是搜不到结果，还是结果全被规则淘汰了。
   如果是被淘汰，日志里会写明原因（例如「命中排除词」）。
4. 关键词是否匹配不上？程序会用中文名和原名分别搜索。
   如果两边都对不上（片源站用的是第三种译名），把该译名加进
   `preference.requireKeywords` 是没用的 —— 应当直接用 `preview` 确认片源站的实际标题格式。

**Q：qBittorrent 登录失败**

`config.json` 里的用户名密码要填 **WebUI 的**账号密码，不是 Windows 账号。
默认是 `admin` / `adminadmin`，但新版 qBittorrent 首次启动会生成随机临时密码，
请到 **选项 → WebUI** 里查看或自行修改。

**Q：nyaa 搜不到东西**

`nyaa.land` 在某些网络下返回 403，程序会自动回退到 `nyaa.si`。
如果两个都不通，通常是网络问题；可以把 `trackers.nyaa` 设为 `false`，
只靠 animes.garden 和 mikan（这两个已经覆盖了绝大多数中文字幕组发布）。

**Q：下到一半发现选集选错了**

程序在添加种子时就已经用 `filePrio` 指定了要下载的文件，不会事后删除。
如果选错，到 qBittorrent 里手动调整该种子的文件优先级即可；
同时把 `data/state.json` 里对应的记录删掉，好让它下一轮重新挑。

**Q：想让它重新下载已经推过的集**

编辑 `data/state.json`，删掉对应记录（或直接删掉整个文件，会重新开始记账）。
注意删掉整个文件会让所有历史集数被当成新的，可能触发大量重复下载。

**Q：SmartScreen 提示「Windows 已保护你的电脑」**

当前版本没有商业代码签名。点「更多信息 → 仍要运行」即可。
Releases 里同时提供 `SHA256SUMS.txt` 用于核对文件完整性。

---

## 开发

```bash
npm ci
npm run typecheck    # 类型检查
npm test             # 单元测试
npm run lint         # 代码检查
npm run dev -- sync --dry-run
npm run build        # 打单文件可执行程序到 release/<平台>/
```

### 打 Windows exe

单文件 exe 用 Node 内置的 SEA（Single Executable Application）方案：

```bash
npm run build
```

> **注意**：载体 Node 必须带 SEA 哨兵。Homebrew 安装的 Node 是 `--shared` 构建，
> 哨兵在动态库里，**无法**用来打包（脚本会直接报错并给出提示）。请用 nodejs.org 官方二进制：
> `nvm install 22 && nvm use 22`。
> 也可以直接推送 `v*` 标签，交给
> [.github/workflows/release.yml](.github/workflows/release.yml)
> 在 `windows-latest` 上自动构建、冒烟测试并发布到 Releases。
>
> 如果确实无法使用 SEA，可以改用 `npm run build:portable`，
> 产出一个自带 `node.exe` 的绿色目录。这个方式在 **Windows 上开箱可用**
> （官方 `node.exe` 是静态链接的）；在 macOS + Homebrew Node 上由于实现位于
> `libnode.dylib`，脚本会额外携带一串传递依赖，属于尽力而为的兜底方案。

### 关于「要不要自己写」

社区里已经有一批成熟的追番下载工具（[AutoBangumi](https://github.com/EstrellaXD/Auto_Bangumi)、
[ani-rss](https://github.com/wushuo894/ani-rss)、[AnimeSpace](https://github.com/yjl9903/AnimeSpace) 等）。
但它们**没有一个能直接读取本机 Watch Planner 的追番状态**：

| 工具 | 追番列表来源 | 能否读本机 3777 |
| --- | --- | --- |
| AutoBangumi | 任意 RSS 链接 | ✗ |
| ani-rss | 自己的订阅列表（每条必须绑一个 bgm 条目） | ✗ |
| bangumi-rs | 自己的订阅列表 | ✗ |
| AnimeSpace | `collections/*.yaml` 文件 | ✗（可读 bgm.tv 账号） |

它们都需要先有 RSS 或订阅条目，而本项目要的是「以 Watch Planner 的
在看/搁置/已看 状态为准」——这些语义只存在于本机 3777 的数据库里。
换成读 bgm.tv 账号会丢掉 Planner 里的搁置、跳过、延后等状态，
把你不打算看的番剧也一起下下来。

所以这里的做法是：**保留各自最擅长的部分** —— 片源检索与打分、
qBittorrent 推送、跨轮去重由本项目负责，追番状态直接问 Watch Planner。
整个实现不重复造搜索轮子：`animes.garden` 本身就是 dmhy/mikan/萌番组/ANi 的聚合器，
mikan 和 nyaa 走官方接口，三者合并去重。

### 项目结构

```
src/
  bin.ts               可执行入口
  index.ts             CLI 命令分发
  config.ts            配置类型、默认值与合并逻辑
  planner/client.ts    Watch Planner API 客户端、未看集数计算
  anime/parse.ts       发布名解析（集号/季度/合集/分辨率/容器/字幕）
  anime/rank.ts        硬性淘汰 + 加权打分选种
  trackers/            animes.garden、mikan、nyaa 三个片源
  qbittorrent/client.ts  qBittorrent WebUI API 客户端
  core/sync.ts         主流程编排
  state/store.ts       已推送记录（跨轮去重）
  notify/              Server 酱 / Telegram 通知
  util/                bencode、种子解析、磁力、文本、日志
tests/                 单元测试
packaging/windows/     Windows 中文启动脚本
scripts/               打包脚本
```

依赖全部是 Node 内置模块，`dependencies` 为空 —— 这也是能做到单文件 exe 的前提。
唯一的外部包（esbuild、postject、vitest、eslint、typescript）都只在构建期使用。

---

## 许可

MIT
