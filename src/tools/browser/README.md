# browser 子模块（内部）

对外仍通过 `src/tools/browser.js` → `index.js` 导出 `createBrowserTools`。  
`registry.js` / `mail.js` **不要**直接 require 本目录下的 click/download 等文件。

## 依赖方向（禁止环）

```
paths / stealth / util / click
        ↑ 仅公共依赖（browser-session、download-path）
download / flow     ← 经 ctx.robustClick 注入，禁止 require('./click')
launch              ← 经 ctx 拿 bindContextDownloads / appendRecordFromPage
tools               ← 经 ctx 拿全部能力
index               ← 唯一组装点
```

升级某一块时：

1. 只改对应文件，不在子模块里 `require` 其它业务兄弟模块。
2. 交叉能力挂到 `ctx`（见 `index.js`）。
3. 跑 `node scripts/check-browser-split.js` 与 `npm test`。

## 文件

| 文件 | 职责 |
|------|------|
| `paths.js` | 截图/下载目录解析 |
| `stealth.js` | 启动参数与反自动化脚本 |
| `click.js` | 可见定位 / JS 回退 / robustClick |
| `download.js` | 下载监听、URL 解析、HTTP 落盘 |
| `flow.js` | 录制与流程回放 |
| `launch.js` | Playwright 启动与页面监听 |
| `util.js` | withStep / 脱敏 |
| `tools.js` | 对外 tool handlers |
| `index.js` | 组装入口 |
