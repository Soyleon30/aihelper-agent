/**
 * 离线包构建（兼容 GitHub 受限网络）：
 * 1. electron-builder --dir 生成 win-unpacked（关闭签名，避免 winCodeSign）
 * 2. 若 NSIS/portable 可用则额外生成；失败则仅输出绿色版 ZIP
 * 3. 汇总到 dist-offline/
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const outDir = path.join(root, 'dist-offline');

function run(cmd, opts = {}) {
  console.log('>', cmd);
  execSync(cmd, {
    stdio: 'inherit',
    cwd: root,
    env: {
      ...process.env,
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
      // 避免部分环境下强制拉签名工具
      WIN_CSC_LINK: '',
      SKIP_NOTARIZATION: 'true'
    },
    ...opts
  });
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyFile(src, dest) {
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.cpSync(src, dest, { recursive: true });
}

function zipDir(srcDir, zipPath) {
  ensureDir(path.dirname(zipPath));
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
  // PowerShell Compress-Archive（Windows 自带）
  const ps = `Compress-Archive -Path '${srcDir.replace(/'/g, "''")}\\*' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`;
  execSync(`powershell -NoProfile -Command "${ps}"`, { stdio: 'inherit', cwd: root });
}

function main() {
  console.log('=== AIHelper Agent 离线包构建 ===');

  if (!fs.existsSync(path.join(root, 'node_modules', 'electron'))) {
    console.log('安装依赖…');
    run('npm.cmd install');
  }

  try {
    run('npx.cmd playwright install chromium');
  } catch (e) {
    console.warn('Playwright chromium 安装失败，将依赖目标机系统 Chrome/Edge');
  }

  // 仅 dir 目标（package.json 已 signAndEditExecutable:false），不依赖 winCodeSign
  let packed = false;
  try {
    run('npx.cmd electron-builder --win --dir');
    packed = true;
  } catch (e) {
    console.warn('electron-builder --dir 失败:', e.message);
  }

  // 可选 NSIS / portable（需能下载 nsis 工具；失败则仅绿色版）
  try {
    run('npx.cmd electron-builder --win nsis');
  } catch (e) {
    console.warn('NSIS 安装包生成跳过（常见原因：无法下载 nsis/winCodeSign）');
  }

  try {
    run('npx.cmd electron-builder --win portable');
  } catch (e) {
    console.warn('Portable 生成跳过');
  }

  const winUnpacked = path.join(dist, 'win-unpacked');
  if (!fs.existsSync(path.join(winUnpacked, 'AIHelper Agent.exe'))) {
    console.error('未找到 dist/win-unpacked/AIHelper Agent.exe，构建失败');
    process.exit(1);
  }

  if (fs.existsSync(outDir)) {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  ensureDir(outDir);

  // 复制 exe / yml
  if (fs.existsSync(dist)) {
    for (const name of fs.readdirSync(dist)) {
      const full = path.join(dist, name);
      const st = fs.statSync(full);
      if (st.isFile() && /\.(exe|yml|yaml|blockmap)$/i.test(name)) {
        copyFile(full, path.join(outDir, name));
      }
    }
  }

  console.log('复制绿色版 win-unpacked …');
  copyDir(winUnpacked, path.join(outDir, 'win-unpacked'));

  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const ver = pkg.version || '0.0.0';
  const zipName = `AIHelper-Agent-${ver}-win-x64-green.zip`;
  const zipPath = path.join(outDir, zipName);
  console.log('压缩绿色版 ZIP …', zipName);
  try {
    zipDir(path.join(outDir, 'win-unpacked'), zipPath);
  } catch (e) {
    try {
      execSync(`tar -a -c -f "${zipPath}" -C "${path.join(outDir, 'win-unpacked')}" .`, {
        stdio: 'inherit'
      });
    } catch (e2) {
      console.warn('ZIP 压缩失败，仍可直接拷贝 win-unpacked 目录:', e2.message);
    }
  }

  function hasChromium(dir) {
    if (!dir || !fs.existsSync(dir)) return false;
    try {
      return fs.readdirSync(dir).some((n) => /chromium/i.test(n));
    } catch (_) {
      return false;
    }
  }

  const home = process.env.USERPROFILE || process.env.HOME || '';
  const pwDirs = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(root, 'offline-cache', 'ms-playwright'),
    path.join(root, 'offline-assets', 'ms-playwright'),
    path.join(dist, 'win-unpacked', 'resources', 'playwright-browsers'),
    path.join(outDir, 'browsers', 'ms-playwright'),
    path.join(home, 'AppData', 'Local', 'ms-playwright')
  ].filter(Boolean);

  let browserSrc = null;
  for (const d of pwDirs) {
    if (hasChromium(d)) {
      browserSrc = d;
      break;
    }
  }
  if (browserSrc) {
    console.log('附带浏览器缓存:', browserSrc);
    copyDir(browserSrc, path.join(outDir, 'browsers', 'ms-playwright'));
    copyDir(browserSrc, path.join(outDir, 'win-unpacked', 'resources', 'playwright-browsers'));
  } else {
    console.warn('未找到 Chromium，绿色版将依赖系统 Chrome/Edge 或安装浏览器缓存.bat');
  }

  copyDir(path.join(root, 'config'), path.join(outDir, 'config-sample'));

  const guide = `# AIHelper Agent 离线部署指南 (v${ver})

## 推荐方式（绿色版，无需安装）
1. 解压 ${zipName}
   或直接复制 win-unpacked 整个文件夹
2. 运行 "AIHelper Agent.exe"
3. 打开「配置」设置本地模型或内网 API

也可用: 启动绿色版.bat

## 若存在安装包
- AIHelper Agent-*-x64.exe  NSIS 安装程序
- AIHelper Agent-*-portable.exe  便携单文件

## 目标机要求
- Windows 10/11 x64
- 无需互联网
- 自备本地模型（Ollama 等）或内网 OpenAI 兼容 API
- 浏览器：系统 Chrome/Edge，或运行「安装浏览器缓存.bat」

## 本地模型（Ollama）
- Base URL: http://127.0.0.1:11434/v1
- API Key: ollama
- 模型名: 与 ollama list 一致

## 内网 API
- Base URL: http://服务器:端口/v1
- API Key / 模型名 按服务端填写

## 功能
文件读写、HTTP POST、网页点击登录、截图等

构建时间: ${new Date().toISOString()}
网络受限时已关闭代码签名(winCodeSign)，不影响运行。
`;
  fs.writeFileSync(path.join(outDir, '离线部署说明.txt'), guide, 'utf8');

  const bat = `@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist "win-unpacked\\AIHelper Agent.exe" (
  start "" "win-unpacked\\AIHelper Agent.exe"
) else (
  echo 未找到 win-unpacked\\AIHelper Agent.exe
  pause
)
`;
  fs.writeFileSync(path.join(outDir, '启动绿色版.bat'), bat, 'utf8');

  const setupBrowsers = `@echo off
chcp 65001 >nul
set SRC=%~dp0browsers\\ms-playwright
set DEST=%LOCALAPPDATA%\\ms-playwright
if not exist "%SRC%" (
  echo 未找到 browsers\\ms-playwright
  echo 目标机可安装 Chrome 或 Edge，Agent 会自动使用。
  pause
  exit /b 1
)
echo 复制浏览器到 %DEST%
xcopy /E /I /Y "%SRC%" "%DEST%"
echo 完成
pause
`;
  fs.writeFileSync(path.join(outDir, '安装浏览器缓存.bat'), setupBrowsers, 'utf8');

  console.log('=== 完成 ===');
  console.log('离线包目录:', outDir);
  console.log('可直接使用: dist-offline\\win-unpacked\\AIHelper Agent.exe');
  console.log('或拷贝整个 dist-offline 到无网环境。');
  if (!packed) process.exitCode = 1;
}

main();
