# 浏览器笔记（Browser Note）

本地优先 + 本机唯一副本 + 七牛云同步的 Chrome / Edge 扩展（Manifest V3，零构建原生 ESM，无任何第三方依赖）。

## 安装位置

本项目当前安装在 **`C:\ProgramData\BrowserNote-QA\browser-note`**，加载扩展时选择该目录
（即包含 `manifest.json` 的那一层）。

`manifest.json` 中带有 `key` 字段（RSA 公钥），因此**扩展 ID 固定为
`iegbjdleibikahhppjcdkefbonldfpap`，与所在目录无关** —— 以后无论把项目挪到哪里，
浏览器里的扩展身份、笔记数据、同步配置都不会变。未打包扩展的 ID 默认为加载路径的
SHA-256 派生值，挪目录就会换一个身份；`key` 字段就是为了消除这个隐患。

> 换机器或重装时，请保留 `manifest.json` 里的 `key` 字段，否则会生成新的扩展 ID，
> 浏览器会把它当成另一个扩展（本地数据读不到，需从云端重新拉取）。

### 从旧目录迁移过来的浏览器配置（2026-11-27）

旧目录 `C:\Users\Administrator\WorkBuddy\2026-10-15-21-22-04` 加载时，扩展 ID 是
**按加载路径派生的** `glmjdndlabcdicfkadfccmmihfdonbbh`；加 `key` 字段后 ID 变成
`iegbjdleibikahhppjcdkefbonldfpap`。ID 变了，浏览器就把它当成**另一个扩展**，
`chrome.storage.local` 里的笔记、七牛同步状态、GitHub 备份配置（含 PAT）全都读不到。

已做的搬迁（四个浏览器 profile 全覆盖：Chrome / Chrome Beta / Chrome Dev / Edge）：

| 内容 | 位置 | 处理 |
|---|---|---|
| 笔记与配置 | `<profile>/Default/Local Extension Settings/<旧ID>/` | 复制为同名 `<新ID>/` 目录 |
| 原始备份 | `C:\ProgramData\BrowserNote-QA\migration-backup\` | 迁移前逐 profile 留档 |
| 七牛 AK/SK | `lib/config.js` | 随代码迁移（本来就没写进浏览器存储） |
| 扩展 ID 私钥 | `C:\ProgramData\BrowserNote-QA\extid-secrets\`（**扩展目录之外**） | 不入库；公钥已在 `manifest.json` |

原理：Chrome 的扩展存储 LevelDB **不在键里带扩展 ID**（已逐字节核对过），所以整目录
改名即可被新 ID 的扩展直接读取；迁移脚本 `.workbuddy/qa-2026-10-16/probe-id-migration.mjs`
用两个临时扩展做了 A→B 的实证，`probe-id-migration-real.mjs` 用四个真实 profile 复验，
结果均为「笔记与配置完整读出」。

> ⚠️ 手动删旧扩展会连同旧 ID 的存储目录一起删掉。**先加载新目录的扩展，确认笔记与设置
> 都在，再去删除旧的那个**；备份在 `migration-backup`，删错了也能还原。

## 功能特性

- **独立大窗口**：点击工具栏图标打开可自由拖拽、缩放的窗口（非系统弹窗），位置与尺寸自动记忆，可一键重置
- **本地优先笔记**：多笔记管理、停输自动保存、实时搜索；数据存浏览器本地，断网可用
- **本机唯一副本**（可选）：同一台电脑上的 Chrome / Beta / Dev / Edge 共用同一份数据，断网也能互通
- **七牛云同步**（可选）：停输 800ms 防抖批量推送、以本地为权威的索引覆盖、删除墓碑、每日自动备份（近 7 天）、云端变更记录
- **图片缩略图 + 原图灯箱**：粘贴图片在文档中以 200px 缩略图展示，点击弹层查看原图；启动时自动回收不再引用的图片数据
- **代码 / JSON 块**：选中文字一键转代码块；直接粘贴 JSON 自动美化 + 语法高亮
- **云端文章阅读**：从七牛空间列举并阅读 Markdown 文章
- **☰ 菜单**：重置窗口 / 刷新 / 变更记录 / 最近更新时间；打开后点击页面任意处自动收回

## 安装步骤

1. **获取代码**：Clone 本仓库，或下载 ZIP 解压到本地
2. **创建本地配置**（必须，否则扩展无法加载）：
   复制 `lib/config.example.js` 为 `lib/config.js`
   - 想先跑起来：保持模板原样（留空）即可，扩展进入「仅本地」模式
   - 要开启云同步：填入七牛 AK / SK / Bucket / 域名，或装好后在设置页补填
3. **加载扩展**：
   - Chrome 打开 `chrome://extensions`（Edge 打开 `edge://extensions`）
   - 打开右上角「**开发者模式**」开关
   - 点击「**加载已解压的扩展程序**」，选择本项目**根目录**（即包含 `manifest.json` 的那一层）
4. 点击浏览器工具栏的扩展图标打开笔记窗口；右键图标 →「选项」进入七牛同步设置页

> **修改代码后**：先关闭笔记窗口，再到扩展管理页点击该扩展的 ↻ 刷新按钮（窗口开着时刷新不生效）。页面右上角版本号可用于确认是否加载成功。

## 使用方式

### 笔记

- 左侧为笔记列表，点「+」新建；标题与正文停输 500ms 自动保存
- 右上角搜索框实时过滤；工具栏状态灯显示同步状态：`本地` / `同步中` / `已同步` / `失败`

### 图片

- 在编辑区直接 `Ctrl+V` 粘贴截图或图片：文档中显示 200px 缩略图，**点击图片**弹出灯箱查看原图

### 代码 / JSON 块

- 工具栏 `</>` 按钮：选中文字 → 转为代码块；未选中 → 插入空代码块（光标自动落入）
- 直接粘贴 JSON 文本：自动格式化为缩进 2 空格并语法高亮（键 / 字符串 / 数字 / 布尔 / null 分色）

### 云同步（七牛）

设置页字段：AccessKey、SecretKey、Bucket、Domain、Region。

- 同步语义：**本地权威**——本地索引直接覆盖云端索引，本地删除/清空能真正生效
- 私有空间下载需签名 token；七牛测试域名（clouddn.com）HTTPS 证书与域名不匹配，代码内固定走 http
- `manifest.json` 中 `host_permissions` 的 clouddn 域名需与你的空间域名一致（换空间时按需修改）

### 本地数据服务（同机唯一副本）

同一台电脑上，Chrome / Chrome Beta / Chrome Dev / Edge 各自都会存一份笔记副本（每个浏览器
profile 一份），彼此靠七牛云同步。启用**本地数据服务**后，这四个浏览器改为**共用同一份**数据：
断网也能互通，同步是毫秒级。

#### 为什么不能直接让四个浏览器共用一份存储

浏览器的扩展存储 `chrome.storage.local` 落在

```
<user-data-dir>/Default/Local Extension Settings/<扩展ID>/
```

那是一个 **LevelDB** 目录，有**单写者锁**（`LOCK` 文件 + Windows `LockFileEx` OS 级文件锁）。
实测（`.workbuddy/qa-2026-10-16/probe-shared-store.mjs`，两个 Chromium 实例 A/B 对照）：

| 步骤 | 结果 |
|---|---|
| A 写入数据并保持开启 | ✅ `hello=written-by-A`，目录含 `LOCK` |
| B 用 junction 指向 A 的存储目录（A 仍开着） | ❌ **`IO error: .../LOCK: Access denied. (LockFile::5)`** |
| 关掉 A，B 再打开同一份 | ✅ 读到 A 的数据 |
| A 重新打开 | ✅ 数据完好 |

⇒ **多个浏览器「同时开着」共用同一份物理存储，物理上不可行**（第二个打开的直接报
`Access denied`，扩展存储功能整个失效）。「轮流用同一份」虽然可行，但毫无意义。

把存储收拢到一个本机常驻进程后，锁的问题自然消失：四个浏览器都只是 HTTP 客户端，
真正的写入由服务端单点串行完成。

#### 使用方法

1. **启动服务**（在扩展目录的 `data-service` 下）：

   ```bash
   node server.mjs
   ```

   默认监听 `http://127.0.0.1:8787`，只绑 127.0.0.1（局域网内其它机器访问不到）。
   数据文件：`data-service\data\notes.json`（原子写：先写 `.tmp` 再 `rename`）。

2. **开机自启**（可选）：

   ```powershell
   powershell -ExecutionPolicy Bypass -File data-service\install-autostart.ps1
   ```

   会在「启动」文件夹放一个快捷方式，用 `wscript` 隐藏启动（不弹黑色控制台窗口）。
   卸载：`data-service\uninstall-autostart.ps1`。

3. **扩展侧启用**：设置页 →「本地数据服务」卡片 → 填地址（默认 `http://127.0.0.1:8787`）
   → 勾选「启用」→ 点「保存并测试连接」。状态行会显示服务是否在跑、服务里有几篇笔记。

#### 与七牛云的分工

| 通道 | 职责 | 断网时 |
|---|---|---|
| **本地数据服务** | 同机多浏览器的唯一一份物理副本 | ✅ 照常工作 |
| **七牛云** | 跨设备同步 + 远端备份 | ❌ 不可用（自动降级，不影响本地服务） |
| **GitHub** | 灾难兜底备份 | ❌ 不可用 |

两条同步通道的**合并语义完全一致**（LWW 按 `updatedAt` 大者胜、墓碑按同一套时间戳裁决、
不删本地独有笔记），所以两个通道同时存在不会打架。

#### 关键实现约束

- **云端推送闸门只看云端**：`ensurePulled` 必须用云端专用的拉取路径。本地服务成功
  **不得**放行云端推送——七牛是「本地权威覆盖索引」语义，一个「只拉过本地、没拉过云端」的
  浏览器若拿本地子集去覆写云端权威索引，其余笔记文件会沦为孤儿（同步再也拉不回来）。
  本地服务用的是 LWW 合并不存在这个风险，所以本地推送**不经过**该闸门。
- **清空必须一并写墓碑**：清空流程会给本地服务里的**全部**笔记（不只是本浏览器本地有的，
  还包括别的浏览器推来的）写墓碑条目，否则那些笔记会在别的浏览器下次拉取时原样回来——
  数据复活。
- **云端下载低频化**：本地服务可用时它就是本机唯一副本，同机同步在本地通道已完成，
  云端下载降为 5 分钟一次的低频兜底（跨设备）。手动刷新会强制拉一次云端。
  推送侧不受影响，改动照样实时上云。

### ☰ 菜单

| 菜单项 | 作用 |
|---|---|
| 重置窗口 | 恢复 600×400 默认尺寸并回到默认打开位置 |
| 刷新 | 确保已保存后重载页面 |
| 变更记录 | 展示云端最近 10 条变更 |
| 最近更新时间 | 当前笔记最后修改时间 |

打开菜单后，点击页面任意位置（编辑区、标题、笔记列表）菜单自动收回。

## 开发说明

- **零构建**：原生 ESM + Chrome 扩展 API，没有任何打包 / 转译步骤，改完刷新扩展即生效
- **目录结构**：

  ```
  manifest.json     MV3 清单（service worker = background.js，module 类型）
  background.js     后台：窗口管理、消息路由、每日备份调度、一次性清空
  lib/              storage 存储层 / sync 同步引擎 / qiniu 签名直传 /
                    local 本地数据服务客户端 / live 实时快照通道 /
                    github-backup GitHub 兜底备份 /
                    editor 编辑器与内容清洗 / articles 文章阅读 / codeblock 代码块 / config 配置
  pages/            main 主界面（action 入口 + ?mode=window 大窗）/ settings 设置页
  styles/           全部样式（app.css）
  data-service/     本地数据服务（Node 零依赖 server.mjs + 开机自启脚本 + 自测）
  ```

- **缓存刷新约定**：HTML 引用的页面资源带 `?v=` 参数（如 `main.js?v=0.5.8.2`），改动后必须 bump，否则浏览器会 Serve 旧缓存
- ⚠️ **一次性清空版本戳**：`lib/sync.js` 中的 `WIPE_STAMP` 是数据清空开关——**改动它会触发一次本地 + 云端全量清空**（这是防止旧版本脏数据复活的设计，清空执行权收口在 service worker，in-flight 串行）。日常迭代不要动它；升级 manifest `version` 不会触发清空

## 隐私与安全

- 笔记数据默认只存浏览器本地；开启同步后仅流经**你自己配置**的七牛空间
- `lib/config.js`（含 AK/SK）已被 `.gitignore` 排除，永远不会入库；请勿把真实密钥提交到任何地方
- 建议为七牛密钥使用独立子账号并只开对象存储读写权限

## License

MIT（详见 [LICENSE](LICENSE)）
