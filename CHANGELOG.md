# 变更日志

本文件记录 AIHelper Agent 从立项到当前的功能与行为变更（按时间大致倒序，同一版本内按主题归类）。

版本号规则见 `AGENTS.md`：每次实质改动 commit 前 bump `package.json` version，并在此追加条目。

---

## [1.6.16] — 2026-09-24

### 下载完成检测 + 同名自动改名
- **根因**：CDP 已把文件写进 `.aihelper-incoming`，代码只等 Playwright download 事件 → 误报「等待下载超时」
- 新增 `waitDownloadSettled`：边等 Playwright 记录，边扫 staging；文件大小连续稳定即视为完成并 promote
- `browser_click(waitDownload)` / `browser_wait_download` / `browser_download` / navigate 下载均走该检测
- 默认同名策略改为 **改名 `file(1).ext`**（不再默认跳过/覆盖）；`skipIfExists=true` 才跳过，`overwrite` 才覆盖
- staging → 下载根目录自动搬出；超时兜底仍会 promote 已落盘文件，避免「文件在但报失败」

## [1.6.15] — 2026-09-23

### Coremail 正文：mail-content 内 iframe 的 p 段
- 根因：命中 `.mail-content` 后只读外壳文字就 break，未进入内部 iframe
- `collectMailBody`：容器优先子 iframe → 抽取 body 内 `p` 段；`#rc_from` / blockquote 解析收发件人
- `mail_read` 返回 `from` / `to` / `paragraphs` / `text`（真正文）

## [1.6.14] — 2026-09-23

### 浏览器/邮件读正文含 iframe
- `browser_get_text` / `browser_get_html` 默认合并主页面 + 全部子 iframe 文本（Coremail 正文常在 iframe）
- 新增 `src/tools/browser/page-text.js`：`collectPageText` / `collectPageHtml` / `collectMailBody`
- `mail_read` 用 Playwright frame 取最长 iframe 正文，点开后等待读信区
- `browser_state` 的 textPreview 同样含 iframe 预览

## [1.6.13] — 2026-09-23

### 下载等待再缩短
- 默认 `downloadWaitMs` **12s**；HTTP 单路最多 ~15–20s；goto 兜底最后
- 有网络文件 URL 后仅再等 **400ms** 给 blob 事件，不再干等满超时
- 落盘不再先 `await download.path()`（大文件会白等整包）；失败抢救 path 限 1.5s

## [1.6.12] — 2026-09-23

### 配置合并
- 启动时为旧用户 config 补齐 `downloadWaitMs`、`skipIfExists` 等缺省字段

## [1.6.11] — 2026-09-23

### 下载同名不再覆盖 + 缩短等待
- CDP/`downloadsPath` 改为 `.aihelper-incoming` 暂存，最终再 `saveAs`（根因：浏览器原生直写最终目录会覆盖同名）
- 同名：默认跳过；`skipIfExists=false` 改名 `file(1).ext`；`force=true` 才覆盖
- Windows 大小写不敏感判重；空文件不视为有效同名
- 恢复/改扩展名路径也走同名策略，禁止静默覆盖
- 下载等待默认 **20s**（可配 `tools.browser.downloadWaitMs`）；download 事件与网络 URL 竞速
- HTTP 补下：优先 context.request，单路最多 ~45s，goto 放最后

## [1.6.10] — 2026-09-23

### 离线 ZIP 解压「头部错误」
- 统一 `scripts/zip-dir.js`：优先 `tar -a`，其次 7-Zip，最后才 Compress-Archive
- 打完包校验 PK 头 + 可列出条目；失败则提示改用 win-unpacked 目录拷贝
- 部署说明：优先拷贝 win-unpacked；.exe 安装包勿当 zip 解压

## [1.6.9] — 2026-09-23

### 浏览器内部模块拆分（行为不变）
- `browser.js` 改为薄入口，实现迁至 `src/tools/browser/*`
- 子模块单向依赖 + `ctx` 注入，禁止 click/download/flow/launch 互 require，降低升级牵连
- `npm test` 增加 `check-browser-split`：导出工具名与 definitions 对齐、依赖方向检查
- 对外 API 不变：`createBrowserTools` / `resolveScreenshotDir`；registry、mail 路径不变

## [1.6.8] — 2026-09-23

### 文档对齐 + 无行为加固（不影响功能/性能）
- README 与应用内「工具说明」补全：下载 / Coremail / 浏览器下载与录制回放
- 会话 store：去掉无效的 dirty 定时器与 no-op `flushSync`（实际落盘仍由前端 `saveSession`）
- 新增 `npm test`：护栏纯函数冒烟（乱点拦截、反幻觉启发式等）
- `.gitignore` 补 zip/密钥/本地配置等

## [1.6.7] — 2026-09-22

### 下载同名检查 + 指定路径/文件名 + 拦乱点
- 统一 `resolveSaveTarget`：`download_file` / `browser_download` / Playwright 落盘支持 `path` / `dir` / `filename`
- 同名文件默认 **跳过**（`skipIfExists`，`force` 可覆盖），不再静默改成 `file(1).ext`
- 浏览器全局 download 监听吃 `pendingDownloadSave`，可指定保存位置与名称
- 护栏：禁止把任务词当菜单乱点；`browser_click(text:"日志"|"查询"|…)` 若用户原话未出现则拦截
- 工具描述与 system 规则同步：先 get_text 再点用户点名的控件

## [1.6.6] — 2026-09-22

### 停止为何有时无效 + 加强
- **原因**：停止只能取消 HTTP/模型请求；卡在 Playwright `click`/`goto`（最长数秒～30s）时，旧逻辑要等超时才退出
- 所有工具 `raceAbort`：停止后约 120ms 内抛「已取消」，不必等 Playwright 自然超时
- 停止时 `window.stop` + 临时缩短 page 超时，加速打断
- 模型 fetch 用户 abort 统一为 AbortError「已取消」

## [1.6.5] — 2026-09-22

### Element modal 点击 + 停止对话
- modal 内优先点击；停止置位 + UI 立即解锁

## [1.6.4] — 2026-09-22

### 打包：exe 被占用
- build-offline 打包前释放占用；assemble 校验 asar 版本

## [1.6.3] — 2026-09-22

### 浏览器登录可保留（非无痕）
- 默认持久配置档 `browser-profile`；设置可无痕 / 自定义 userDataDir

## [1.6.2] — 2026-09-22

### 修复点击下载被 cancel
- 不再 cancel Playwright download；以 saveAs 为主路径

## [1.6.1] — 2026-09-22

### 下载识别加强（tar/excel 等）
- URL/Content-Type 覆盖 tar/xlsx/octet-stream；文件头嗅探 gzip/tar/zip

## [1.6.0] — 2026-09-22

### 页面下载新链路（推荐）
- `browser_resolve_download_url` / `browser_download`：解析 URL + HTTP 落盘
- blob 无 URL 时回退 Playwright

## [1.5.8] — 2026-09-22

### 去掉 reg.exe 污染日志
- 删除 `reg query` 查 Chrome/Edge（避免 stderr「锟斤拷」）
- 仍用固定路径 + `CHROME_PATH` / `EDGE_PATH` / executablePath

## [1.5.7] — 2026-09-22

### downloadsPath 生效
- `PWTEST_UNDER_TEST=1` 使 Playwright 接受 downloadsPath（否则强制 E:\\Temp\\playwright-artifacts）

## [1.5.6] — 2026-09-22

### downloadsPath 放到 launch
- 从 newContext 改到 launch（仍不够，见 1.5.7 Playwright 丢弃逻辑）

## [1.5.5] — 2026-09-22

### 下载与 Chrome/Edge
- 本机无 Chrome 时用 Edge；设置可填 `executablePath`
- `browser_state` 带 `browserName` / `executablePath`

## [1.5.4] — 2026-09-22

### 下载路径
- CDP `behavior: allow`；saveAs 到配置目录；勿把 Temp/artifacts 当最终路径

## [1.5.3] — 2026-09-22

### 浏览器下载捕获加固
- 下载监听改为 **context 级**（所有标签页），不再只绑首页
- CDP `setDownloadBehavior` 强制下载目录
- 新开 page 同步绑监听 + CDP

## [1.5.2] — 2026-09-22

### 修复 thinking 模型 tool_choice（彻底）
- 默认**不再**无故附带 `tool_choice: auto`（仅显式 required 时才带）
- 若 API 仍因 tool_choice 400，自动**去掉该字段**重试
- `deepseek-flash` 等 thinking 模型名首轮跳过 `required`

## [1.5.1] — 2026-09-22

### 修复 thinking 模型 + tool_choice
- 初版：required 失败时降为 auto（仍可能被 thinking 拒绝，见 1.5.2）

---

## [1.5.0] — 2026-09-22

### 浏览器下载路径与中文文件名
- 默认下载目录改为 `%USERPROFILE%\Downloads\AIHelper`（不再藏在 AppData）
- 浏览器/HTTP 下载共用文件名解码：`filename*=UTF-8''`、URL 编码、Latin-1 乱码修复
- Playwright `downloadsPath` + `saveAs` 统一落盘；会话内记录 `recentDownloads`

### 可见本机 Chrome + 下载可追踪
- 默认仍为有界面 + 优先本机 Chrome；感知以 DOM（get_text/state）为主，非截图循环
- 新增 `browser_wait_download` / `browser_list_downloads`
- `browser_click` 支持 `waitDownload: true`，点击下载后直接返回 path/filename
- `browser_state` 附带 `downloadDir` 与近期下载列表

---

## [1.4.0] — 2026-09-22

### 浏览器点击鲁棒
- `browser_click`：优先可见节点 → force → 页面内 JS 点击回退
- 缓解 Element UI 双表/隐藏列导致「详情」等按钮超时与乱回退

### 操作录制与回放
- `browser_record_start` / `browser_record_stop` / `browser_record_status`
- 人工点击/输入写入流程 JSON（`userData/flows`）
- 输入自动变量化 `{{变量}}`；`browser_flow_run` + `vars` 回放
- `browser_flow_list` 查看已存流程

### 离线自带 Chromium
- 启动时查找：exe 旁 `resources/playwright-browsers`、上级 `browsers/ms-playwright`、本地缓存
- `build:offline` / `assemble:offline` 把已有 chromium 打进绿色包（侧车 + resources）

---

## [1.3.0] — 2026-09-20

### 日志脱敏
- 新增可配置脱敏（默认开）：密码/Token/apiKey/Bearer/JWT 等
- 可选：邮箱、手机号、身份证
- 支持 `redactExtraKeys` / `redactExtraPatterns` 扩展
- 配置页可开关；对话/工具/操作日志统一走脱敏后再落盘

---

## [1.2.1] — 2026-09-20

### 截图
- 默认目录改为更易找：`%USERPROFILE%\Pictures\AIHelper-Screenshots`
- 配置页可指定截图目录，支持浏览/打开
- `browser_screenshot` 返回绝对路径；新增 `get_screenshot_dir`
- 「路径信息」中显示当前截图目录

### 邮件（1.2.0）
- **改为本机 Coremail 客户端/网页会话查看**，不再使用 IMAP/POP3
- 工具：`mail_test` / `mail_launch_client` / `mail_list` / `mail_search` / `mail_read` / `mail_list_folders`
- 配置：`baseUrl`（网页）、`exePath`（客户端）、可选 `selectors`
- 移除 `imapflow`

---

## [1.2.0] — 2026-09-20

（并入 1.2.1 说明）

---

## [1.1.0] — 2026-09-20

### 约定与工程
- `AGENTS.md`：每次改完主动 git commit；**每次实质改动 bump 版本号（semver）并更新本 CHANGELOG**
- 离线包 ZIP 名随 `package.json` version（`AIHelper-Agent-{version}-win-x64-green.zip`），不再写死 1.0.0
- 汇总历史能力与路径说明（本文件）

### 相对 1.0.0 基线已包含的能力（回顾）
- 多轮会话持久化、下载目录/去重、Coremail 只读 IMAP
- 反幻觉/反偷懒（tool_choice、打回、拒绝无证据结论）
- 工具轮次/历史长度可配（0=不限制）、日志目录可配、文件白名单路径规范化
- 浏览器会话保持、隐蔽模式等

---

## [1.0.0] — 2026-09-20

### 项目骨架
- 新建 Electron 桌面应用 `aihelper-agent`
- 主进程 / preload / 渲染层（对话 + 配置 + 工具说明）
- 默认配置 `config/default.json`
- 离线打包脚本：`build:offline`、`assemble:offline`、`pack:offline`
- 绿色版产物：`dist-offline/win-unpacked`、ZIP、启动 bat
- 关闭 Windows 代码签名依赖（`signAndEditExecutable: false`），避免 GitHub 拉 winCodeSign 失败
- 初始化 Git 仓库；`AGENTS.md` 约定：**每次功能/修复后主动 commit，无需用户提醒**

### 模型连接
- 支持本地 / OpenAI 兼容 / 自定义 API（`baseUrl` + `apiKey` + `model`）
- 请求路径：`baseUrl` + 可配置 **`apiPath`**（默认 `/chat/completions`，不自动加 `/v1`）
- 配置页：切换提供商、测试连接、保存/恢复默认

### Agent 循环与工具
- 多轮 tool-call 循环编排（`src/agent/service.js`）
- 工具注册表：文件、HTTP、下载、浏览器、邮件（只读）
- **最大工具轮次** `maxToolRounds`：`0` = 不限制（可配）
- **历史对话轮数** `maxHistoryTurns`：`0` = 不限制；裁剪需显式开启 `trimHistory`
- 工具结果压缩、并行工具、跳过重复调用等为**独立开关**，互不强制关闭

### 反幻觉 / 反偷懒
- 系统强制规则 + 操作类任务强制先调工具
- 可疑成功结论复核（`verifyFinal` / `maxRechecks`）
- 首轮可选 `tool_choice=required`（`requireToolChoice`）
- 偷懒打回次数（`maxToolNudges`）
- 拒绝无工具证据的虚假结论（`rejectUnverifiedAnswers`），改为诚实说明
- 效率提示词、最后一轮强制收尾、轮次预算提示均为可选，默认不关可靠性能力

### 多轮对话与会话持久化
- 前端 `history` 传给模型，支持连续多轮
- 会话文件：`userData/sessions/*.json`
- 每轮结束落盘 + 定时自动保存（默认约 15s）
- 顶栏：会话列表 / 新对话 / 保存 / 清空本对话
- 关闭应用后可从文件恢复会话

### 日志
- 操作日志：`logs/aihelper-*.log`（异步队列批量写）
- 使用统计：`usage-*.jsonl`
- 操作过程：`actions-*.jsonl`（应用内点击 + 浏览器页面操作）
- 对话正文：`chats-*.jsonl`（可开关）
- **日志目录可配置**（配置页浏览/默认/打开目录）
- 脱敏、字段截断、按日滚动

### 对话 UI
- 消息可选中复制；单条「复制」；「复制全部」
- 工具调用过程在对话中展示；可停止任务

### 本地文件工具
- `list_dir` / `read_file` / `write_file` / `append_file` / `delete_path`
- **白名单 `allowedRoots`**：空=不限制；填父目录则子路径自动允许
- 路径规范化：无需双斜杠；误写 `\\` 会折叠；大小写不敏感（Windows）

### HTTP / 下载
- `http_request`：GET/POST 等
- **`download_file`**：保存到可配置下载目录
- **`download_from_markdown`**：从 md 抽链接批量下载
- **`list_downloads` / `get_download_dir`**
- 相同 URL 跳过、相同内容 hash 去重（`.download-index.json`）
- 配置页：下载目录、打开目录、去重开关
- 浏览器触发的下载也写入同一下载目录

### 浏览器自动化
- Playwright：navigate / click / type / fill / get_text / html / screenshot / wait / evaluate / close
- **`browser_state`**：查看当前会话 URL/标题，便于人工操作后继续
- **全局保持会话** `keepSession`（默认开）：换对话/重载配置不关浏览器
- 隐蔽模式 `stealth`、优先本机 Chrome/Edge、降自动化/DevTools 特征
- 页面真实点击/输入可记入 actions 日志（密码字段脱敏）

### Coremail 邮件（仅查看）
- IMAP 只读：`mail_test` / `mail_list_folders` / `mail_list` / `mail_search` / `mail_read`
- **无发送、无删除**
- 配置页：主机/端口/账号/密码/SSL/证书校验/测试连接
- 依赖：`imapflow`

### 配置与部署
- 用户配置：`%APPDATA%` 下 `config.json`（缺字段启动时合并默认）
- 离线包路径：`dist-offline/`
- README：开发启动与 `build:offline` 说明

### 已知说明
- 「已达到最大工具调用轮次」仅在配置了有限 `maxToolRounds` 时出现；`0` 表示不限制
- 模型是否支持 function call 影响工具强制效果；弱模型依赖护栏打回/拒绝
- 打包机需能下载 Electron；目标机可无网运行（模型需自备本地或内网 API）

---

## 文件与目录（源码）

| 路径 | 说明 |
|------|------|
| `electron/` | 主进程、preload、IPC（配置/会话/日志/邮件测试） |
| `src/agent/` | Agent 循环、护栏 |
| `src/tools/` | 文件/HTTP/下载/浏览器/邮件 |
| `src/session/` | 多轮会话持久化 |
| `src/logger/` | 异步日志 |
| `src/renderer/` | UI |
| `config/default.json` | 默认配置 |
| `scripts/` | 离线构建与组装 |
| `AGENTS.md` | 协作约定（含强制 git commit） |

---

## Git

| Commit | 说明 |
|--------|------|
| `4d7ab18` | 初始化完整功能基线 |
| （本提交） | 增加本变更日志 CHANGELOG.md |
