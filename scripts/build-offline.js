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

function killLockingProcesses() {
  // electron-builder 写 asar integrity 时会打开 AIHelper Agent.exe；若进程/资源管理器占用会 UNKNOWN open 失败
  console.log('释放可能占用 dist 的进程…');
  const killers = [
    `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'AIHelper|electron' -or ($_.ExecutablePath -and $_.ExecutablePath -like '*aihelper_grok*dist*') } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }"`,
    `taskkill /F /IM "AIHelper Agent.exe" /T`,
    `taskkill /F /IM electron.exe /T`
  ];
  for (const cmd of killers) {
    try {
      execSync(cmd, { stdio: 'ignore', cwd: root, windowsHide: true });
    } catch (_) {}
  }
}

function clearWinUnpacked() {
  const winUnpacked = path.join(dist, 'win-unpacked');
  if (!fs.existsSync(winUnpacked)) return;
  const bak = path.join(dist, `win-unpacked-old-${Date.now()}`);
  try {
    fs.renameSync(winUnpacked, bak);
    console.log('旧 dist/win-unpacked 已改名:', path.basename(bak));
  } catch (e) {
    console.warn('无法改名 win-unpacked（可能仍被占用）:', e.message);
    console.warn('请关闭所有 AIHelper / 从 dist 打开的 exe，关闭资源管理器中该文件夹后重试');
    try {
      fs.rmSync(winUnpacked, { recursive: true, force: true });
    } catch (e2) {
      console.error('无法删除 dist/win-unpacked:', e2.message);
      process.exit(1);
    }
  }
  // 清理过旧备份（保留最近 1 个即可）
  try {
    const olds = fs
      .readdirSync(dist)
      .filter((n) => /^win-unpacked-old-/.test(n))
      .map((n) => ({ n, t: fs.statSync(path.join(dist, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const o of olds.slice(2)) {
      try {
        fs.rmSync(path.join(dist, o.n), { recursive: true, force: true });
      } catch (_) {}
    }
  } catch (_) {}
}

function main() {
  const dirOnly = process.argv.includes('--dir-only');
  console.log('=== AIHelper Agent 离线包构建 ===', dirOnly ? '(仅 --dir)' : '');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  console.log('package.json version =', pkg.version);

  if (!fs.existsSync(path.join(root, 'node_modules', 'electron'))) {
    console.log('安装依赖…');
    run('npm.cmd install');
  }

  try {
    run('npx.cmd playwright install chromium');
  } catch (e) {
    console.warn('Playwright chromium 安装失败，将依赖目标机系统 Chrome/Edge');
  }

  killLockingProcesses();
  // 等文件句柄释放
  try {
    execSync('powershell -NoProfile -Command "Start-Sleep -Seconds 2"', {
      stdio: 'ignore',
      windowsHide: true
    });
  } catch (_) {}
  clearWinUnpacked();

  // 仅 dir 目标（package.json 已 signAndEditExecutable:false），不依赖 winCodeSign
  // 绿色版够用；NSIS/portable 常因网络下 nsis 失败，默认跳过（设 BUILD_NSIS=1 才打）
  let packed = false;
  try {
    run('npx.cmd electron-builder --win --dir');
    packed = true;
  } catch (e) {
    console.warn('electron-builder --dir 第一次失败，再释放进程后重试…');
    killLockingProcesses();
    try {
      execSync('powershell -NoProfile -Command "Start-Sleep -Seconds 3"', {
        stdio: 'ignore',
        windowsHide: true
      });
    } catch (_) {}
    clearWinUnpacked();
    try {
      run('npx.cmd electron-builder --win --dir');
      packed = true;
    } catch (e2) {
      console.error('electron-builder --dir 失败:', e2.message);
      console.error('请手动：1) 关掉所有 AIHelper Agent.exe  2) 关掉打开 dist\\win-unpacked 的资源管理器  3) 再 npm run build:offline');
      process.exit(1);
    }
  }

  if (!dirOnly && process.env.BUILD_NSIS === '1') {
    try {
      run('npx.cmd electron-builder --win nsis');
    } catch (e) {
      console.warn('NSIS 安装包生成跳过（常见原因：无法下载 nsis/winCodeSign）');
    }
  } else if (!dirOnly) {
    console.log('跳过 NSIS（需要时: set BUILD_NSIS=1&& npm run build:offline）');
  }

  if (!dirOnly && process.env.BUILD_PORTABLE === '1') {
    try {
      run('npx.cmd electron-builder --win portable');
    } catch (e) {
      console.warn('Portable 生成跳过');
    }
  } else if (!dirOnly) {
    console.log('跳过 portable（需要时: set BUILD_PORTABLE=1）');
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

  const ver = pkg.version || '0.0.0';
  const zipName = `AIHelper-Agent-${ver}-win-x64-green.zip`;
  const zipPath = path.join(outDir, zipName);
  try {
    for (const n of fs.readdirSync(outDir)) {
      if (
        /^AIHelper-Agent-.*-win-x64-green\.zip$/i.test(n) &&
        n !== zipName
      ) {
        console.log('删除旧离线包', n);
        fs.unlinkSync(path.join(outDir, n));
      }
    }
  } catch (_) {}
  console.log('压缩绿色版 ZIP …', zipName, '(version from package.json =', ver + ')');
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
