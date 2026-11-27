# 浏览器笔记（Browser Note）

本地优先 + 七牛云同步的 Chrome / Edge 扩展（Manifest V3，零构建原生 ESM，无任何第三方依赖）。

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
                    editor 编辑器与内容清洗 / articles 文章阅读 / codeblock 代码块 / config 配置
  pages/            main 主界面（action 入口 + ?mode=window 大窗）/ settings 设置页
  styles/           全部样式（app.css）
  ```

- **缓存刷新约定**：HTML 引用的页面资源带 `?v=` 参数（如 `main.js?v=0.5.8.2`），改动后必须 bump，否则浏览器会 Serve 旧缓存
- ⚠️ **一次性清空版本戳**：`lib/sync.js` 中的 `WIPE_STAMP` 是数据清空开关——**改动它会触发一次本地 + 云端全量清空**（这是防止旧版本脏数据复活的设计，清空执行权收口在 service worker，in-flight 串行）。日常迭代不要动它；升级 manifest `version` 不会触发清空

## 隐私与安全

- 笔记数据默认只存浏览器本地；开启同步后仅流经**你自己配置**的七牛空间
- `lib/config.js`（含 AK/SK）已被 `.gitignore` 排除，永远不会入库；请勿把真实密钥提交到任何地方
- 建议为七牛密钥使用独立子账号并只开对象存储读写权限

## License

MIT（详见 [LICENSE](LICENSE)）
