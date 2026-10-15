# AIHelper Agent

可离线部署的桌面 AI Agent：连接**本地模型**或 **OpenAI 兼容 API**，在配置页管理参数，并能操作**本地文件**、**HTTP POST**、**网页点击/登录**等。

## 功能

| 能力 | 说明 |
|------|------|
| 本地模型 | Ollama / vLLM / LocalAI 等 OpenAI 兼容接口 |
| 远程/内网 API | 任意 `*/v1/chat/completions` 服务 |
| 配置页面 | 提供商、模型、工具开关、文件根目录 |
| 本地文件 | 列目录、读写、追加、删除 |
| HTTP | GET/POST/PUT/DELETE，JSON / 表单 |
| 浏览器 | 打开页面、点击、输入、填表、截图、取文本 |
| 离线包 | NSIS 安装包 + Portable + 绿色目录 |

## 环境要求

- 开发/打包机：Windows x64、Node.js 18+、可访问 npm（首次）
- 运行机：Windows 10/11 x64，**无需互联网**
- 模型：本机 Ollama 或内网 API（需自行离线准备）

## 快速开始（开发）

```bash
cd aihelper_grok
npm install
npx playwright install chromium
npm start
```

1. 打开应用 → **配置**
2. 选择「本地模型」，Base URL 填 `http://127.0.0.1:11434/v1`
3. 模型名与 Ollama 中一致 → **测试连接** → **保存**
4. 在 **对话** 中下达任务

## 打离线包（在有网机器）

```bash
npm install
npx playwright install chromium
npm run build:offline
```

产物目录：`dist-offline/`

| 文件/目录 | 用途 |
|-----------|------|
| `AIHelper Agent-*-x64.exe` | NSIS 安装程序 |
| `AIHelper Agent-*-portable.exe` | 便携版 |
| `win-unpacked/` | 绿色免安装 |
| `browsers/` | Playwright 浏览器缓存（可选） |
| `启动绿色版.bat` | 一键启动绿色版 |
| `安装浏览器缓存.bat` | 把浏览器拷到用户目录 |
| `离线部署说明.txt` | 中文说明 |

将**整个** `dist-offline` 拷到 U 盘/内网，在目标机安装或运行即可。

### 仅 electron-builder

```bash
npm run build           # 安装包 + portable → dist/
npm run build:portable  # 仅便携版
npm run build:dir       # 仅解压目录
```

### 预缓存 Playwright

```bash
npm run pack:offline    # → offline-cache/
```

## 配置说明

配置保存在用户目录：`%APPDATA%/aihelper-agent/config.json`（以实际 `userData` 为准）。

### 本地 Ollama

```json
{
  "baseUrl": "http://127.0.0.1:11434/v1",
  "apiKey": "ollama",
  "model": "qwen2.5:7b"
}
```

### 内网 OpenAI 兼容

```json
{
  "baseUrl": "http://10.0.0.8:8000/v1",
  "apiKey": "sk-xxx",
  "model": "your-model-id"
}
```

## 工具列表（供模型调用）

- **文件**: `list_dir` `read_file` `write_file` `append_file` `delete_path`
- **HTTP**: `http_request`
- **下载**: `download_file` `download_from_markdown` `list_downloads` `get_download_dir`
- **邮件（Coremail 只读）**: `mail_test` `mail_launch_client` `mail_list_folders` `mail_list` `mail_search` `mail_read`
- **浏览器**: `browser_state` `browser_navigate` `browser_click` `browser_type` `browser_fill_form` `browser_get_text` `browser_get_html` `browser_screenshot` `get_screenshot_dir` `browser_wait` `browser_evaluate` `browser_close`
- **浏览器下载**: `browser_resolve_download_url` `browser_download` `browser_wait_download` `browser_list_downloads`
- **录制回放**: `browser_record_start` `browser_record_stop` `browser_record_status` `browser_flow_list` `browser_flow_run`
- **Excel**: `read_excel` `write_excel` `list_sheets`

可在配置中关闭某类工具，或限制文件允许根目录。完整参数见应用内「工具说明」与 `src/tools/definitions.js`。

## 示例任务

- 「读取 `D:\data\report.txt` 并总结」
- 「POST `http://127.0.0.1:8080/api/login`，body 为 JSON …」
- 「打开 https://example.com/login，输入用户名密码并点击登录，然后截图」

## 目录结构

```
aihelper_grok/
├── electron/           # Electron 主进程
├── src/
│   ├── agent/          # Agent 循环与工具编排
│   ├── llm/            # 模型提供商
│   ├── tools/          # 文件 / HTTP / 浏览器
│   ├── config/
│   └── renderer/       # 配置页 + 对话 UI
├── config/default.json
├── scripts/            # 离线打包脚本
├── offline-assets/
└── package.json
```

## 注意事项

1. **无网环境不能在线拉模型**，请事先用 Ollama 离线导入或部署内网推理服务。
2. 浏览器自动化优先用本机 **Chrome/Edge**；否则使用打包的 Chromium（需执行 `安装浏览器缓存.bat` 或构建时附带 `browsers`）。
3. 文件删除、写入有风险，建议在配置中设置 **允许根目录**。
4. 首次打包需在有网机器下载 Electron 与 Chromium；之后 `dist-offline` 可完全离线传播。

## License

MIT
