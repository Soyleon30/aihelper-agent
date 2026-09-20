/**
 * 将 node_modules、Playwright 浏览器缓存、electron 等整理到 offline-cache，
 * 供无网环境或二次打包使用。
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const out = path.join(root, 'offline-cache');

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return false;
  ensureDir(dest);
  fs.cpSync(src, dest, { recursive: true });
  return true;
}

function main() {
  console.log('准备离线缓存目录…');
  ensureDir(out);

  const home = process.env.USERPROFILE || process.env.HOME || '';
  const pwCacheCandidates = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(home, 'AppData', 'Local', 'ms-playwright'),
    path.join(home, '.cache', 'ms-playwright')
  ].filter(Boolean);

  let copiedPw = false;
  for (const c of pwCacheCandidates) {
    if (c && fs.existsSync(c)) {
      console.log('复制 Playwright 浏览器:', c);
      copyDir(c, path.join(out, 'ms-playwright'));
      copiedPw = true;
      break;
    }
  }
  if (!copiedPw) {
    console.warn('未找到 Playwright 浏览器缓存。请先: npx playwright install chromium');
  }

  // 记录版本信息
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const meta = {
    name: pkg.name,
    version: pkg.version,
    preparedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    playwrightBrowsers: copiedPw
  };
  fs.writeFileSync(path.join(out, 'meta.json'), JSON.stringify(meta, null, 2));

  // 生成离线安装说明
  const readme = `# 离线缓存说明

本目录由 npm run pack:offline 生成。

## 内容
- ms-playwright/: Playwright Chromium 浏览器（若已下载）

## 在有网机器完整打包离线安装程序
1. npm ci  或  npm install
2. npx playwright install chromium
3. npm run build:offline

## 在无网机器使用已生成的安装包
将 dist-offline/ 拷贝到目标机即可，无需本缓存目录。
`;
  fs.writeFileSync(path.join(out, 'README.txt'), readme, 'utf8');
  console.log('完成:', out);
}

main();
