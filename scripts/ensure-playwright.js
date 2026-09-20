/**
 * 有网环境安装依赖后，尽量准备好 Chromium。
 * 无浏览器可执行文件时不失败，仅提示。
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function log(msg) {
  console.log(`[playwright] ${msg}`);
}

try {
  const pw = path.dirname(require.resolve('playwright/package.json'));
  log(`playwright at ${pw}`);
  if (process.env.SKIP_PLAYWRIGHT_DOWNLOAD === '1') {
    log('SKIP_PLAYWRIGHT_DOWNLOAD=1，跳过浏览器下载');
    process.exit(0);
  }
  log('尝试安装 chromium（离线打包前请在有网机器执行）…');
  execSync('npx playwright install chromium', {
    stdio: 'inherit',
    env: process.env
  });
  log('chromium 就绪');
} catch (err) {
  log(`警告: ${err.message}`);
  log('若目标机有 Chrome/Edge，Agent 仍可使用系统浏览器。');
}
