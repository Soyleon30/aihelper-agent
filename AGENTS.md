# Agent 约定

## Git（必须遵守）

- **每次完成功能/修复/配置改动后，主动 `git add` + `git commit`，不要等用户提醒。**
- 提交信息用中文简短说明「做了什么」。
- 不提交：`node_modules/`、`dist/`、`dist-offline/`、密钥、本地 `config` 用户数据。
- 不 `push`，除非用户明确要求。
- 不改 git config；不 force push；不提交无关文件。

## 项目要点

- Electron 桌面 Agent：本地/API 模型、文件/HTTP/下载/浏览器/Coremail 只读邮件。
- 离线包：`npx electron-builder --win --dir` + `node scripts/assemble-offline.js`。
- 用户配置在 `%APPDATA%` 下，勿把真实密码写进仓库。
