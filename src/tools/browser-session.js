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
  launchedAt: null
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

function findLocalBrowser() {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
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

module.exports = {
  getShared,
  setLogger,
  setConfig,
  logAction,
  isPageAlive,
  getState,
  closeAll,
  findLocalBrowser,
  path,
  fs
};
