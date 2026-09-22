/**
 * 全局浏览器会话：跨对话、跨配置热重载保持同一 page，
 * 便于用户手动操作后由 Agent 在当前页面继续。
 */
const path = require('path');
const fs = require('fs');

let shared = {
  playwright: null,
  browser: null,
  context: null,
  page: null,
  listenersBound: false,
  sessionId: null,
  stepSeq: 0,
  logger: null,
  cfg: {},
  userDataPath: '',
  launchedAt: null,
  recording: null
};

function setLogger(logger) {
  shared.logger = logger;
}

function setConfig(cfg, userDataPath) {
  shared.cfg = cfg || shared.cfg || {};
  if (userDataPath) shared.userDataPath = userDataPath;
}

function getShared() {
  return shared;
}

function logAction(event, data) {
  if (!shared.logger || typeof shared.logger.action !== 'function') return;
  try {
    shared.logger.action('browser', event, {
      sessionId: shared.sessionId,
      step: ++shared.stepSeq,
      ...data
    });
  } catch (_) {}
}

function isPageAlive() {
  return !!(shared.page && !shared.page.isClosed());
}

async function getState() {
  if (!isPageAlive()) {
    return {
      open: false,
      sessionId: shared.sessionId,
      message: '浏览器未打开或已关闭'
    };
  }
  try {
    const p = shared.page;
    const url = p.url();
    const title = await p.title().catch(() => '');
    let textPreview = '';
    try {
      textPreview = (await p.locator('body').innerText({ timeout: 3000 })).slice(0, 500);
    } catch (_) {}
    return {
      open: true,
      sessionId: shared.sessionId,
      url,
      title,
      textPreview,
      launchedAt: shared.launchedAt,
      hint: '可在此页面基础上继续 click/type，无需重新 navigate（除非要换站）'
    };
  } catch (err) {
    return { open: false, error: err.message || String(err) };
  }
}

async function closeAll() {
  try {
    if (shared.page) await shared.page.close().catch(() => {});
  } catch (_) {}
  try {
    if (shared.context) await shared.context.close().catch(() => {});
  } catch (_) {}
  try {
    if (shared.browser) await shared.browser.close().catch(() => {});
  } catch (_) {}
  shared.page = null;
  shared.context = null;
  shared.browser = null;
  shared.listenersBound = false;
  logAction('browser.session_closed', {});
  return { closed: true };
}

function walkFindChrome(dir, depth = 0) {
  if (!dir || depth > 6) return null;
  let st;
  try {
    st = fs.statSync(dir);
  } catch (_) {
    return null;
  }
  if (!st.isDirectory()) return null;
  const chromeWin = path.join(dir, 'chrome-win64', 'chrome.exe');
  if (fs.existsSync(chromeWin)) return chromeWin;
  const chromeWinOld = path.join(dir, 'chrome-win', 'chrome.exe');
  if (fs.existsSync(chromeWinOld)) return chromeWinOld;
  const direct = path.join(dir, 'chrome.exe');
  if (fs.existsSync(direct)) return direct;
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch (_) {
    return null;
  }
  const preferred = names
    .filter((n) => /^chromium/i.test(n))
    .sort()
    .reverse();
  for (const n of preferred) {
    const hit = walkFindChrome(path.join(dir, n), depth + 1);
    if (hit) return hit;
  }
  for (const n of names) {
    if (/^chromium/i.test(n)) continue;
    if (n === 'chromium_headless_shell' || /headless/i.test(n)) continue;
    const full = path.join(dir, n);
    try {
      if (fs.statSync(full).isDirectory()) {
        const hit = walkFindChrome(full, depth + 1);
        if (hit) return hit;
      }
    } catch (_) {}
  }
  return null;
}

function browserSearchRoots() {
  const roots = [];
  const push = (p) => {
    if (p && !roots.includes(p)) roots.push(p);
  };
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) push(process.env.PLAYWRIGHT_BROWSERS_PATH);
  if (process.resourcesPath) {
    push(path.join(process.resourcesPath, 'playwright-browsers'));
    push(path.join(process.resourcesPath, 'browsers', 'ms-playwright'));
    push(path.join(process.resourcesPath, 'ms-playwright'));
  }
  try {
    const exeDir = path.dirname(process.execPath || '');
    push(path.join(exeDir, 'resources', 'playwright-browsers'));
    push(path.join(exeDir, 'playwright-browsers'));
    push(path.join(exeDir, 'browsers', 'ms-playwright'));
    push(path.join(exeDir, '..', 'browsers', 'ms-playwright'));
    push(path.join(exeDir, '..', '..', 'browsers', 'ms-playwright'));
  } catch (_) {}
  try {
    push(path.join(__dirname, '..', '..', 'dist-offline', 'browsers', 'ms-playwright'));
    push(path.join(__dirname, '..', '..', 'offline-cache', 'ms-playwright'));
    push(path.join(__dirname, '..', '..', 'offline-assets', 'ms-playwright'));
  } catch (_) {}
  const localApp =
    process.env.LOCALAPPDATA ||
    (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local') : '');
  if (localApp) push(path.join(localApp, 'ms-playwright'));
  return roots;
}

function findBundledChromium() {
  for (const root of browserSearchRoots()) {
    try {
      if (!fs.existsSync(root)) continue;
      const hit = walkFindChrome(root);
      if (hit) return hit;
    } catch (_) {}
  }
  return null;
}

function resolvePlaywrightBrowsersPath() {
  for (const root of browserSearchRoots()) {
    try {
      if (!root || !fs.existsSync(root)) continue;
      const names = fs.readdirSync(root);
      if (names.some((n) => /chromium/i.test(n))) return root;
      const nested = path.join(root, 'ms-playwright');
      if (fs.existsSync(nested)) {
        const n2 = fs.readdirSync(nested);
        if (n2.some((n) => /chromium/i.test(n))) return nested;
      }
    } catch (_) {}
  }
  return null;
}

function ensurePlaywrightBrowsersEnv() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH;
  const found = resolvePlaywrightBrowsersPath();
  if (found) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = found;
    return found;
  }
  return null;
}

function findSystemBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) {}
  }
  return null;
}

function findLocalBrowser(opts = {}) {
  const preferSystem = opts.preferSystem !== false;
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
    const e = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    try {
      if (fs.existsSync(e)) return e;
    } catch (_) {}
  }
  const bundled = findBundledChromium();
  if (!preferSystem && bundled) return bundled;
  const system = findSystemBrowser();
  if (preferSystem && system) return system;
  if (bundled) return bundled;
  if (system) return system;
  return null;
}

module.exports = {
  getShared,
  setLogger,
  setConfig,
  logAction,
  isPageAlive,
  getState,
  closeAll,
  findLocalBrowser,
  findBundledChromium,
  findSystemBrowser,
  ensurePlaywrightBrowsersEnv,
  resolvePlaywrightBrowsersPath,
  path,
  fs
};
