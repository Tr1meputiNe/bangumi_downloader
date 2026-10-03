<p align="center">
  <strong>bangumi-downloader</strong><br>
  番剧资源搜索 + 自动追番，统一推送到 qBittorrent
</p>

一个工具，两种用法，共用同一套片源与挑选规则：

**① 手动搜索**（Web 界面）—— 想看什么自己搜，挑完再下

```bash
bangumi-downloader serve        # 打开 http://127.0.0.1:3778/
```

在网页里输入番剧名，结果会从 **animes.garden、mikan、nyaa** 三个站并行抓取并按偏好排序，
每条都标出**集号、分辨率、容器、字幕语言、字幕组、体积、做种数**，
勾选后一键推送到 qBittorrent。

**② 自动追番**（常驻）—— 新番更新后自动收

```bash
bangumi-downloader run          # 每 30 分钟检查一次
```

读取你本机 **Bangumi Watch Planner**（默认 `http://127.0.0.1:3777`）里的追番数据，
找出「在看」的番剧里**还没看、但已经播出**的集数，搜种、打分、自动推送。

两者共享的挑选逻辑：

- **按偏好打分**：默认 **MKV + 1080p + 简体中文**，权重、字幕组白/黑名单全部可配置
- **自动排除干扰项**：预告、PV、NCOP/NCED、菜单、字体包不会进候选
- **不会为了两集下整个合集**：只缺一两集但只找到合集时，会解析种子文件清单，只勾选需要的那几集
- **跨源去重**：同一发布被多个站收录时按 infohash 合并成一条
- **单文件 exe，零依赖**：Windows 上解压双击即用，不需要装 Node.js、Python 或 Docker

自动追番还额外保证：**不会下到没播的集**、**不会重复下载**（按 infohash + 集号记账）。

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

两个入口，一条流水线：

```
① 手动搜索：Web 界面输入关键词
② 自动追番：Bangumi Watch Planner（127.0.0.1:3777）的「在看 + 未看 + 已播出」集数
                          │
                          ▼
        ┌─────────────────────────────────────┐
        │  片源搜索（三路并行，按 infohash 去重） │
        │  animes.garden（聚合 dmhy/mikan/萌番组）│
        │  mikan 官方 RSS                      │
        │  nyaa（nyaa.land → nyaa.si 自动回退） │
        └────────────────┬────────────────────┘
                         ▼
        ┌─────────────────────────────────────┐
        │  发布名解析 + 偏好打分                 │
        │  集号 / 季度 / 合集区间 / 分辨率 / 容器 │
        │  字幕语言 / 字幕组 / 做种数            │
        └────────────────┬────────────────────┘
                         ▼
        ┌─────────────────────────────────────┐
        │  qBittorrent WebUI                  │
        │  磁力直推；合集只勾选需要的分集        │
        └─────────────────────────────────────┘
```

两个入口共用 `src/core/search.ts` 这同一条「搜索 + 打分」代码路径，
区别只有一点：**自动追番会按集号做硬性淘汰**（下错集是硬伤），
**手动搜索不做**（否则搜「葬送的芙莉莲」会因为目标是第 1 集而淘汰掉绝大多数结果）。
所以两边不会出现「打分规则不一致」的问题。

### 为什么 dmhy 走 animes.garden

`dmhy.org` 在部分网络环境下直连会被重置（TLS 握手被 RST）。`animes.garden` 本身就聚合了 dmhy
的内容并直接提供磁力链接，所以程序把 dmhy 当作「经由 animes.garden 获取」，
同时把它当作一个额外的补充源。mikan 和 nyaa 则各自走官方接口，保证覆盖度。

### 为什么需要单独解析 .torrent

通过磁力链接添加种子时，qBittorrent 在取到元数据之前并不知道里面有哪些文件，
因此没法在添加的瞬间说「只下第 3 集」。如果不管这一点，
一个 50 GB 的季度合集会被整个拉下来，而你只缺一集。
所以当程序选中的是合集、且目标只是其中少数几集时，
它会自己下载一份 `.torrent`，解析出文件清单，挑出目标分集，
再把种子内容直接交给 qBittorrent，这样选择性下载才能生效。

手动的 Web 搜索也会走同一套逻辑：如果你在一个合集上点了下载，
程序会尽量只拉你勾中的那几集。

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

### 6. 开始使用

**手动搜索（日常推荐）**

双击 `3-search.cmd`，浏览器会自动打开 `http://127.0.0.1:3778/`。

在搜索框里输入番剧名，例如「葬送的芙莉莲」。结果会从三个片源并行抓取，
去掉重复后按偏好排序。每一条都标了集号、分辨率、容器、字幕语言、字幕组、体积和做种数，
最右边是偏好得分（鼠标悬停可以看到得分构成）。

用法要点：

- **点整行**即可勾选，可以多选，底部会汇总已选数量和总体积
- **筛选**：顶部可以按片源过滤，或勾「只看符合偏好」把不符合的折叠掉
- 不合偏好的结果不会消失，只会被标注出来（例如「✕ 命中排除词 pv」），
  这样你能看到「为什么没选它」，也仍然可以强行下载
- 勾完点右下角**推送到 qBittorrent**，程序会连同分类和标签一起推过去
- 如果选中的是合集，程序会尽量只下载你需要的分集（见上文说明）
- 同一个关键词 5 分钟内重复搜索会直接走缓存，不再重复请求片源站

关掉那个命令行窗口就会停止网页服务（已经开始的下载不受影响）。

**自动追番**

- `4-auto.cmd` —— 常驻运行，每 30 分钟检查一次 Watch Planner 里的追番进度
- `7-run-once.cmd` —— 只跑一轮，适合配合 Windows 任务计划程序
- `5-install-startup.cmd` —— 开机自动在后台跑自动追番；用 `uninstall-startup.cmd` 取消

> 首次运行某个新番时，片源站可能还没出种（例如刚播完几分钟），
> 这种情况会被记成「无片源」并在下一轮自动重试，属于正常现象。

### 文件说明

压缩包里的脚本都用 ASCII 文件名（中文名在 zip 里容易变成乱码），双击后窗口标题会显示中文用途：

| 文件 | 用途 |
| --- | --- |
| `1-setup.cmd` | 首次配置：生成 `config.json` 并用记事本打开 |
| `2-check.cmd` | 检查 Watch Planner、片源、qBittorrent 的连通性 |
| `3-search.cmd` | **启动资源搜索界面**（推荐日常用这个） |
| `4-auto.cmd` | 自动追番，常驻运行每 30 分钟一轮 |
| `5-install-startup.cmd` | 注册开机自启（自动追番） |
| `6-preview.cmd` | 预览：自动追番会挑什么，或搜索某个关键词 |
| `7-run-once.cmd` | 自动追番只执行一轮 |
| `uninstall-startup.cmd` | 取消开机自启并结束后台进程 |

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
| `web.port` | `3778` | 资源搜索界面的端口（刻意避开 Planner 的 3777） |
| `web.host` | `127.0.0.1` | 监听地址。**改成 `0.0.0.0` 等于把下载接口开放给局域网，请自行评估风险** |
| `web.openBrowser` | `true` | 启动 `serve` 时自动打开浏览器 |
| `notify.serverChanKey` | 无 | 填了就在有新增下载时推 Server 酱 |
| `notify.telegram` | 无 | 填了就在有新增下载时推 Telegram |

### 想「先攒着不自动下」

把 `download.enabled` 设成 `false`，自动追番就只搜索和打印，不会碰 qBittorrent。
注意这也会让 Web 界面只能搜索、不能下载（界面右上角会显示「qBittorrent 未连接」）。

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
- 集号不覆盖目标集（合集只要区间覆盖就算覆盖）。
  **这一条只对自动追番生效**；手动搜索不按集号淘汰，否则搜「葬送的芙莉莲」
  会因为目标是第 1 集而把其余几十条全滤掉
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
| `serve` | **启动 Web 搜索界面**（手动搜索 + 挑选下载） |
| `search` | 命令行搜索并打印候选排名，不下载 |
| `sync` | 自动追番：执行一轮完整流程 |
| `run` | 自动追番：守护模式，按 `intervalMinutes` 定时执行 |
| `check` | 检查配置、Watch Planner、三个片源、qBittorrent 的连通性 |
| `preview` | 查看「自动追番」在某个关键词上会怎么选（按集号严格淘汰） |
| `config` | 打印当前生效的完整配置 |

`search` 与 `preview` 的区别：`search` 是给你自己看的（不做集号淘汰，列出全部资源），
`preview` 是给排错用的（模拟自动追番的严格匹配）。

| 选项 | 说明 |
| --- | --- |
| `--config <路径>` | 指定配置文件，默认 `./config.json` |
| `--query <关键词>` | `search` / `preview` 用哪个关键词搜索 |
| `--port <端口>` | 覆盖 Web 界面端口 |
| `--no-open` | 启动 Web 界面时不自动打开浏览器 |
| `--dry-run` | 只挑选并打印，不推送、不写状态 |
| `--verbose` | 输出 debug 日志（含每个源的请求细节和淘汰原因） |

```bash
# 启动搜索界面（日常最常用）
bangumi-downloader serve

# 命令行搜索，看看有哪些资源
bangumi-downloader search --query "冰之城墙"

# 看看自动追番会挑哪一版
bangumi-downloader preview --query "葬送的芙莉莲"

# 完整跑一轮自动追番但不下载
bangumi-downloader sync --dry-run

# 排查为什么没选到想要的版本
bangumi-downloader search --query "冰之城墙" --verbose
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

**Q：双击 3-search.cmd 后浏览器显示「无法访问此网站」**

看命令行窗口里的错误。常见原因：

- 端口被占用 —— 改 `config.json` 里的 `web.port`
- 杀毒软件/防火墙拦了本地端口 —— 放行 `bangumi-downloader.exe`
- 窗口一闪就关了 —— 说明启动即报错，在命令行里手动运行
  `bangumi-downloader.exe serve` 可以看到完整报错

**Q：Web 界面能搜索，但点下载没反应 / 提示未连接**

右上角显示「qBittorrent 未连接」说明 WebUI 连不上。
界面仍然可以用来搜索和查看，但下载会失败。请检查 qBittorrent 是否在运行、
`config.json` 里的 `qbittorrent.url` 端口和账号密码是否正确。

**Q：搜索结果里有些条目被标了「✕」**

那是被偏好规则淘汰的（例如命中了排除词 `pv`、或者季度对不上）。
手动搜索**不会**把它们藏起来 —— 让你能看见「为什么没选它」，
也仍然可以强行勾选下载。想只看符合偏好的，勾上顶部「只看符合偏好」。

**Q：搜索结果里的集号为什么有的是「集号未知」**

发布名里确实没写集号，通常是整季合集（标题只写「合集」）或者字幕组的特殊命名。
这类条目仍然可以下载，只是程序无法帮你判断它包含哪些集，
所以下载时不会做分集选择，会整包拉下来 —— 勾选前留意一下体积。

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
  index.ts             CLI 命令分发（serve / search / sync / run / check / preview）
  config.ts            配置类型、默认值与合并逻辑
  planner/client.ts    Watch Planner API 客户端、未看集数计算
  anime/parse.ts       发布名解析（集号/季度/合集/分辨率/容器/字幕）
  anime/rank.ts        硬性淘汰 + 加权打分选种
  trackers/            animes.garden、mikan、nyaa 三个片源
  core/search.ts       共用的「搜索 + 打分」路径（Web 与自动追番都走这里）
  core/push.ts         共用的「推送到 qBittorrent」路径（含合集分集选择）
  core/sync.ts         自动追番的编排
  qbittorrent/client.ts  qBittorrent WebUI API 客户端
  web/server.ts        Web 界面服务端（只用 node:http，无 Web 框架）
  web/serialize.ts     后端类型 → 前端类型的转换层
  web/client/          前端源码（preact + htm，无 JSX、无构建框架）
  web/generated/       前端构建产物（默认导出字符串的模块，会被内联进 exe）
  state/store.ts       已推送记录（跨轮去重，仅自动追番使用）
  notify/              Server 酱 / Telegram 通知
  util/                bencode、种子解析、磁力、缓存、文本、日志
tests/                 单元测试（含 mock qBittorrent 的整链路集成测试）
packaging/windows/     Windows 中文启动脚本
scripts/               打包脚本（build-client / build-exe / build-portable）
```

`dependencies` 为空 —— 运行时只用 Node 内置模块，这是能做到单文件 exe 的前提。
前端用的 preact + htm 都打进 bundle，目标机器不需要任何额外东西。
外部包（esbuild、postject、vitest、eslint、typescript、preact、htm）只在构建期使用。

### 前端是怎么嵌进 exe 的

1. `scripts/build-client.mjs` 用 esbuild 把 `src/web/client/` 打成一个 IIFE bundle
2. 产出的 JS/CSS 写成 `src/web/generated/client-bundle.ts`（一个默认导出字符串的模块）
3. `scripts/build-exe.mjs` 打包服务端时，esbuild 把这两个模块直接内联进 bundle
4. 运行时 `src/web/server.ts` 把 CSS 和 JS 内联进 HTML 返回

所以 exe 里没有任何外部静态资源文件，运行目录只需要 `config.json`。

## 许可

MIT
