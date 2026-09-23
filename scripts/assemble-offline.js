/**
 * 仅从已有 dist/win-unpacked 组装 dist-offline（不重新 electron-builder）
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const outDir = path.join(root, 'dist-offline');
const winUnpacked = path.join(dist, 'win-unpacked');
const exeName = 'AIHelper Agent.exe';

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.cpSync(src, dest, { recursive: true });
}

function main() {
  if (!fs.existsSync(path.join(winUnpacked, exeName))) {
    console.error('缺少 dist/win-unpacked/' + exeName);
    console.error('请先: npx electron-builder --win --dir');
    process.exit(1);
  }

  // assemble 只复制已有 dist，不会更新 asar。版本必须与 package.json 一致，否则目标机仍显示旧版。
  const pkgCheck = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const wantVer = String(pkgCheck.version || '');
  const asarPath = path.join(winUnpacked, 'resources', 'app.asar');
  try {
    let asarVer = '';
    try {
      const asar = require('@electron/asar');
      asarVer = JSON.parse(asar.extractFile(asarPath, 'package.json').toString()).version;
    } catch (_) {
      try {
        const asar = require('asar');
        asarVer = JSON.parse(asar.extractFile(asarPath, 'package.json').toString()).version;
      } catch (__) {}
    }
    if (asarVer && wantVer && asarVer !== wantVer) {
      console.error('');
      console.error('【版本不一致】package.json=' + wantVer + '，但 dist/win-unpacked 内 asar=' + asarVer);
      console.error('assemble 不会重编译，只会打出「文件名新、内容旧」的 zip。');
      console.error('请先执行其一：');
      console.error('  npx electron-builder --win --dir');
      console.error('  npm run build:dir');
      console.error('  npm run build:offline');
      console.error('然后再: node scripts/assemble-offline.js');
      process.exit(1);
    }
    if (asarVer) console.log('校验 asar 版本 OK:', asarVer);
  } catch (e) {
    console.warn('无法读取 asar 版本（继续组装）:', e.message);
  }

  if (fs.existsSync(outDir)) {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  ensureDir(outDir);

  for (const name of fs.readdirSync(dist)) {
    const full = path.join(dist, name);
    if (fs.statSync(full).isFile() && /\.(exe|yml|yaml|blockmap)$/i.test(name)) {
      fs.copyFileSync(full, path.join(outDir, name));
    }
  }

  console.log('复制 win-unpacked …');
  copyDir(winUnpacked, path.join(outDir, 'win-unpacked'));

  function hasChromium(dir) {
    if (!dir || !fs.existsSync(dir)) return false;
    try {
      return fs.readdirSync(dir).some((n) => /chromium/i.test(n));
    } catch (_) {
      return false;
    }
  }

  function findChromeExe(dir, depth = 0) {
    if (!dir || depth > 6 || !fs.existsSync(dir)) return null;
    const direct = [
      path.join(dir, 'chrome-win64', 'chrome.exe'),
      path.join(dir, 'chrome-win', 'chrome.exe'),
      path.join(dir, 'chrome.exe')
    ];
    for (const p of direct) if (fs.existsSync(p)) return p;
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch (_) {
      return null;
    }
    for (const n of names) {
      if (!/chromium/i.test(n) || /headless/i.test(n)) continue;
      const hit = findChromeExe(path.join(dir, n), depth + 1);
      if (hit) return hit;
    }
    for (const n of names) {
      const full = path.join(dir, n);
      try {
        if (fs.statSync(full).isDirectory()) {
          const hit = findChromeExe(full, depth + 1);
          if (hit) return hit;
        }
      } catch (_) {}
    }
    return null;
  }

  const home = process.env.USERPROFILE || '';
  const browserCandidates = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(root, 'dist-offline', 'browsers', 'ms-playwright'),
    path.join(root, 'offline-cache', 'ms-playwright'),
    path.join(root, 'offline-assets', 'ms-playwright'),
    path.join(dist, 'win-unpacked', 'resources', 'playwright-browsers'),
    path.join(home, 'AppData', 'Local', 'ms-playwright')
  ].filter(Boolean);

  let browserSrc = null;
  for (const c of browserCandidates) {
    if (hasChromium(c) && findChromeExe(c)) {
      browserSrc = c;
      break;
    }
  }

  if (browserSrc) {
    console.log('附带 browsers …', browserSrc);
    const side = path.join(outDir, 'browsers', 'ms-playwright');
    copyDir(browserSrc, side);
    const resPw = path.join(outDir, 'win-unpacked', 'resources', 'playwright-browsers');
    console.log('写入 win-unpacked/resources/playwright-browsers …');
    copyDir(browserSrc, resPw);
  } else {
    console.warn('未找到 Chromium 缓存，绿色版将依赖系统 Chrome/Edge');
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const ver = pkg.version || '0.0.0';
  const zipName = `AIHelper-Agent-${ver}-win-x64-green.zip`;
  const zipPath = path.join(outDir, zipName);
  // 删掉其它版本的旧 green zip，避免误用 1.4.x
  try {
    for (const n of fs.readdirSync(outDir)) {
      if (
        /^AIHelper-Agent-.*-win-x64-green\.zip$/i.test(n) &&
        n !== zipName
      ) {
        const old = path.join(outDir, n);
        console.log('删除旧离线包', n);
        fs.unlinkSync(old);
      }
    }
  } catch (_) {}
  console.log('压缩 ZIP …', zipName, '(version from package.json)');
  try {
    const { zipDir, validateZip } = require('./zip-dir');
    zipDir(path.join(outDir, 'win-unpacked'), zipPath);
    const chk = validateZip(zipPath);
    if (!chk.ok) console.warn('ZIP 校验失败:', chk.error);
  } catch (e) {
    console.warn('ZIP 失败，可直接拷贝 win-unpacked:', e.message);
  }

  copyDir(path.join(root, 'config'), path.join(outDir, 'config-sample'));

  const guide = `AIHelper Agent 离线部署 (v${ver})

【推荐】绿色版
1. 解压 ${zipName} 或复制 win-unpacked
2. 运行 AIHelper Agent.exe
3. 配置 → 设置本地模型或内网 API

本地 Ollama:
  Base URL: http://127.0.0.1:11434/v1
  API Key: ollama
  模型名: qwen2.5:7b（按实际）

构建时间: ${new Date().toISOString()}
`;
  fs.writeFileSync(path.join(outDir, '离线部署说明.txt'), guide, 'utf8');

  fs.writeFileSync(
    path.join(outDir, '启动绿色版.bat'),
    [
      '@echo off',
      'chcp 65001 >nul',
      'cd /d "%~dp0"',
      'start "" "win-unpacked\\AIHelper Agent.exe"'
    ].join('\r\n'),
    'utf8'
  );

  fs.writeFileSync(
    path.join(outDir, '安装浏览器缓存.bat'),
    [
      '@echo off',
      'chcp 65001 >nul',
      'set SRC=%~dp0browsers\\ms-playwright',
      'set DEST=%LOCALAPPDATA%\\ms-playwright',
      'if not exist "%SRC%" (',
      '  echo 未找到 browsers，可改用系统 Chrome/Edge',
      '  pause',
      '  exit /b 1',
      ')',
      'xcopy /E /I /Y "%SRC%" "%DEST%"',
      'echo 完成',
      'pause'
    ].join('\r\n'),
    'utf8'
  );

  console.log('=== 完成 ===');
  console.log(outDir);
  console.log(fs.readdirSync(outDir).join('\n'));
}

main();
