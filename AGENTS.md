# Agent 约定

## Git（必须遵守）

- **每次完成功能/修复/配置改动后，主动 `git add` + `git commit`，不要等用户提醒。**
- 提交信息用中文简短说明「做了什么」。
- 不提交：`node_modules/`、`dist/`、`dist-offline/`、密钥、本地 `config` 用户数据。
- 不 `push`，除非用户明确要求。
- 不改 git config；不 force push；不提交无关文件。

## 版本号（必须遵守）

- **每次有实质改动并 commit 前，更新 `package.json` 的 `version`（semver）。**
- 规则（默认）：
  - **patch** `x.y.Z`：修复、文案、小调整、日志/配置项微调
  - **minor** `x.Y.0`：新功能、新工具、行为增强（如邮件/下载/反幻觉加强）
  - **major** `X.0.0`：不兼容的重大变更（少用，需说明）
- 同步：在 `CHANGELOG.md` 顶部追加该版本条目（日期 + 要点）。
- 离线包文件名随 `package.json` version，勿写死旧版本号。

## 项目要点

- Electron 桌面 Agent：本地/API 模型、文件/HTTP/下载/浏览器/Coremail 只读邮件。
- 离线包：`npx electron-builder --win --dir` + `node scripts/assemble-offline.js`。
- 用户配置在 `%APPDATA%` 下，勿把真实密码写进仓库。

## 里程碑

- **首次可用**：`1.6.24`（2026-10-28），tag `v1.6.24` / `first-usable`。下载定名与同名避让可用后再标此基线。
