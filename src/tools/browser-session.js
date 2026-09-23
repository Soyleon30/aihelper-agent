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
  recording: null,
  /** @type {Array<{path:string,filename:string,url:string,at:string,ok:boolean,error?:string}>} */
  recentDownloads: [],
  downloadWaiters: [],
  downloadDir: '',
  executablePath: '',
  browserName: '',
  /** 对话点「停止」时置 true，工具轮询后抛错 */
  aborted: false,
  /** 下一次浏览器 download 事件落盘选项（filename/path/dir/skipIfExists） */
  pendingDownloadSave: null
};

function requestAbort() {
  shared.aborted = true;
  // 打断等待下载的 Promise
  const waiters = shared.downloadWaiters || [];
  shared.downloadWaiters = [];
  for (const w of waiters) {
    try {
      w.reject(Object.assign(new Error('已取消'), { name: 'AbortError' }));
    } catch (_) {}
  }
  // 尽量打断卡在 Playwright 上的操作（不关 browser，keepSession 仍可用）
  try {
    const p = shared.page;
    if (p && !p.isClosed()) {
      try {
        p.setDefaultTimeout(1);
      } catch (_) {}
      p.evaluate(() => {
        try {
          if (typeof window.stop === 'function') window.stop();
        } catch (_) {}
      }).catch(() => {});
    }
  } catch (_) {}
}

/** 与长时间 Playwright/IO 竞态：一点停止就立刻抛 AbortError，不必等 click 超时 */
function raceAbort(promise) {
  if (shared.aborted) {
    const err = new Error('已取消');
    err.name = 'AbortError';
    return Promise.reject(err);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setInterval(() => {
      if (shared.aborted && !settled) {
        settled = true;
        clearInterval(timer);
        const err = new Error('已取消');
        err.name = 'AbortError';
        reject(err);
      }
    }, 120);
    Promise.resolve(promise).then(
      (v) => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        if (shared.aborted) {
          const err = new Error('已取消');
          err.name = 'AbortError';
          reject(err);
        } else resolve(v);
      },
      (e) => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        reject(e);
      }
    );
  });
}

function clearAbort() {
  shared.aborted = false;
}

function isAborted() {
  return !!shared.aborted;
}

function throwIfAborted() {
  if (shared.aborted) {
    const err = new Error('已取消');
    err.name = 'AbortError';
    throw err;
  }
}

function detectBrowserName(exePath) {
  const p = String(exePath || '').toLowerCase();
  if (!p) return 'unknown';
  if (p.includes('msedge') || p.includes('\\edge\\')) return 'Edge';
  if (p.includes('chrome.exe') && p.includes('chromium')) return 'Chromium';
  if (p.includes('chrome')) return 'Chrome';
  if (p.includes('chromium')) return 'Chromium';
  return path.basename(exePath || '') || 'browser';
}

function setPendingDownloadSave(opts) {
  shared.pendingDownloadSave = opts && typeof opts === 'object' ? { ...opts } : null;
}

function takePendingDownloadSave() {
  const o = shared.pendingDownloadSave;
  shared.pendingDownloadSave = null;
  return o;
}

function peekPendingDownloadSave() {
  return shared.pendingDownloadSave;
}

function pushDownloadRecord(rec) {
  if (!Array.isArray(shared.recentDownloads)) shared.recentDownloads = [];
  shared.recentDownloads.push(rec);
  if (shared.recentDownloads.length > 50) {
    shared.recentDownloads = shared.recentDownloads.slice(-50);
  }
  const waiters = shared.downloadWaiters || [];
  shared.downloadWaiters = [];
  for (const w of waiters) {
    try {
      w.resolve(rec);
    } catch (_) {}
  }
}

function waitNextDownload(timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const ms = Math.max(800, Number(timeoutMs) || 12000);
    const timer = setTimeout(() => {
      shared.downloadWaiters = (shared.downloadWaiters || []).filter((x) => x !== entry);
      reject(new Error(`等待下载超时（${ms}ms）`));
    }, ms);
    const entry = {
      resolve: (rec) => {
        clearTimeout(timer);
        resolve(rec);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      }
    };
    if (!Array.isArray(shared.downloadWaiters)) shared.downloadWaiters = [];
    shared.downloadWaiters.push(entry);
  });
}

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
  const recent = (shared.recentDownloads || []).slice(-5);
  const browserMeta = {
    browserName: shared.browserName || detectBrowserName(shared.executablePath),
    executablePath: shared.executablePath || ''
  };
  if (!isPageAlive()) {
    return {
      open: false,
      sessionId: shared.sessionId,
      downloadDir: shared.downloadDir || '',
      recentDownloads: recent,
      ...browserMeta,
      message: '浏览器未打开或已关闭'
    };
  }
  try {
    const p = shared.page;
    const url = p.url();
    const title = await p.title().catch(() => '');
    let textPreview = '';
    let frameCount = 1;
    try {
      const { collectPageText } = require('./browser/page-text');
      const collected = await collectPageText(p, { maxChars: 500, includeFrames: true });
      textPreview = (collected.text || '').slice(0, 500);
      frameCount = collected.frameCount || 1;
    } catch (_) {
      try {
        textPreview = (await p.locator('body').innerText({ timeout: 3000 })).slice(0, 500);
      } catch (_) {}
    }
    const name = browserMeta.browserName || '浏览器';
    return {
      open: true,
      sessionId: shared.sessionId,
      url,
      title,
      textPreview,
      frameCount,
      launchedAt: shared.launchedAt,
      downloadDir: shared.downloadDir || '',
      userDataDir: shared.userDataDir || '',
      ephemeral: !!shared.ephemeral,
      recentDownloads: recent,
      ...browserMeta,
      hint: shared.ephemeral
        ? `当前 ${name} 为临时配置（无痕）。要保留登录：设置里配置浏览器用户数据目录，或关闭「每次无痕」。`
        : `当前 ${name} 使用持久配置档（登录可保留）。下载看 downloadDir。`
    };
  } catch (err) {
    return {
      open: false,
      error: err.message || String(err),
      recentDownloads: recent,
      ...browserMeta
    };
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

function findChromeCandidates() {
  // 只查常见路径 + 环境变量，不调 reg.exe（中文错误会污染 stderr 成「锟斤拷」）
  const local =
    process.env.LOCALAPPDATA ||
    (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local') : '');
  return [
    process.env.CHROME_PATH,
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    local ? path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe') : ''
  ].filter(Boolean);
}

function findEdgeCandidates() {
  return [
    process.env.EDGE_PATH,
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  ].filter(Boolean);
}

function firstExisting(paths) {
  for (const p of paths) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch (_) {}
  }
  return null;
}

/** 只找 Google Chrome（不含 Edge） */
function findSystemChrome() {
  return firstExisting(findChromeCandidates());
}

/** Edge */
function findSystemEdge() {
  return firstExisting(findEdgeCandidates());
}

/**
 * preferChrome: true 时优先 Chrome，没有再 Edge
 * executablePath 显式指定最高优先
 */
function findSystemBrowser(opts = {}) {
  if (opts.executablePath) {
    try {
      if (fs.existsSync(opts.executablePath)) return opts.executablePath;
    } catch (_) {}
  }
  const chrome = findSystemChrome();
  if (opts.chromeOnly) return chrome;
  if (opts.preferChrome !== false && chrome) return chrome;
  const edge = findSystemEdge();
  if (edge) return edge;
  return chrome;
}

function findLocalBrowser(opts = {}) {
  const preferSystem = opts.preferSystem !== false;
  if (opts.executablePath) {
    try {
      if (fs.existsSync(opts.executablePath)) return opts.executablePath;
    } catch (_) {}
  }
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
    const e = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    try {
      if (fs.existsSync(e)) return e;
    } catch (_) {}
  }
  const bundled = findBundledChromium();
  if (!preferSystem && bundled) return bundled;
  const system = findSystemBrowser({
    preferChrome: opts.preferChrome !== false,
    chromeOnly: opts.chromeOnly === true,
    executablePath: opts.executablePath
  });
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
  pushDownloadRecord,
  setPendingDownloadSave,
  takePendingDownloadSave,
  peekPendingDownloadSave,
  waitNextDownload,
  requestAbort,
  clearAbort,
  isAborted,
  throwIfAborted,
  raceAbort,
  findLocalBrowser,
  findBundledChromium,
  findSystemBrowser,
  findSystemChrome,
  findSystemEdge,
  detectBrowserName,
  ensurePlaywrightBrowsersEnv,
  resolvePlaywrightBrowsersPath,
  path,
  fs
};
