const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const Store = require('electron-store');
const { createAgentService } = require('../src/agent/service');
const { loadDefaultConfig } = require('../src/config/loader');
const { createLogger } = require('../src/logger');
const { createSessionStore } = require('../src/session/store');
const browserSession = require('../src/tools/browser-session');

const isDev = process.argv.includes('--dev');
let mainWindow = null;
let agentService = null;
let logger = null;
let sessionStore = null;
const store = new Store({ name: 'aihelper-settings' });

function getConfigPath() {
  const userConfig = path.join(app.getPath('userData'), 'config.json');
  if (fs.existsSync(userConfig)) return userConfig;
  const res = process.resourcesPath
    ? path.join(process.resourcesPath, 'config', 'default.json')
    : path.join(__dirname, '..', 'config', 'default.json');
  return res;
}

function ensureUserConfig() {
  const userConfig = path.join(app.getPath('userData'), 'config.json');
  const def = loadDefaultConfig(__dirname);
  if (!fs.existsSync(userConfig)) {
    fs.writeFileSync(userConfig, JSON.stringify(def, null, 2), 'utf8');
  } else {
    try {
      const cur = JSON.parse(fs.readFileSync(userConfig, 'utf8'));
      let changed = false;
      if (!cur.logging && def.logging) {
        cur.logging = def.logging;
        changed = true;
      } else if (cur.logging && def.logging) {
        for (const k of [
          'dir',
          'logUiClicks',
          'logBrowserActions',
          'logChatContent',
          'logConversations',
          'maxChatContentLen'
        ]) {
          if (cur.logging[k] === undefined && def.logging[k] !== undefined) {
            cur.logging[k] = def.logging[k];
            changed = true;
          }
        }
      }
      if (cur.agent && def.agent) {
        for (const k of [
          'antiHallucination',
          'forceToolsForActions',
          'requireToolChoice',
          'rejectUnverifiedAnswers',
          'maxToolNudges',
          'verifyFinal',
          'maxRechecks',
          'alwaysGroundFinal',
          'efficiencyMode',
          'parallelTools',
          'skipDuplicateTools',
          'trimHistory',
          'compactToolResults',
          'forceFinalOnLastRound',
          'roundBudgetHints',
          'maxHistoryTurns',
          'toolResultMaxLen',
          'maxToolRounds'
        ]) {
          if (cur.agent[k] === undefined && def.agent[k] !== undefined) {
            cur.agent[k] = def.agent[k];
            changed = true;
          }
        }
        // 旧默认 12/24 轮：不自动改用户已有数字；仅缺省字段补 0=不限制
      }
      if (!cur.session && def.session) {
        cur.session = def.session;
        changed = true;
      }
      if (cur.tools?.browser && def.tools?.browser) {
        if (cur.tools.browser.keepSession === undefined) {
          cur.tools.browser.keepSession = def.tools.browser.keepSession;
          changed = true;
        }
      }
      if (changed) {
        fs.writeFileSync(userConfig, JSON.stringify(cur, null, 2), 'utf8');
      }
    } catch (_) {}
  }
  return userConfig;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: 'AIHelper Agent',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerIpc() {
  ipcMain.handle('config:get', async () => {
    const p = ensureUserConfig();
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw);
  });

  ipcMain.handle('config:save', async (_e, cfg) => {
    const p = path.join(app.getPath('userData'), 'config.json');
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf8');
    if (logger && cfg.logging) logger.configure(cfg.logging);
    if (sessionStore && cfg.session) sessionStore.configure(cfg.session);
    if (logger) logger.info('config.saved', { active: cfg.providers?.active });
    if (agentService) {
      await agentService.reloadConfig(cfg);
    }
    return { ok: true };
  });

  ipcMain.handle('config:reset', async () => {
    const def = loadDefaultConfig(__dirname);
    const p = path.join(app.getPath('userData'), 'config.json');
    fs.writeFileSync(p, JSON.stringify(def, null, 2), 'utf8');
    if (logger && def.logging) logger.configure(def.logging);
    if (sessionStore && def.session) sessionStore.configure(def.session);
    if (logger) logger.info('config.reset', {});
    if (agentService) await agentService.reloadConfig(def);
    return def;
  });

  ipcMain.handle('agent:chat', async (_e, payload) => {
    return agentService.chat(payload);
  });

  ipcMain.handle('agent:abort', async () => {
    return agentService.abort();
  });

  ipcMain.handle('agent:testProvider', async (_e, providerKey) => {
    return agentService.testProvider(providerKey);
  });

  ipcMain.handle('dialog:selectDirectory', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory']
    });
    if (r.canceled || !r.filePaths.length) return null;
    return r.filePaths[0];
  });

  ipcMain.handle('dialog:selectFile', async (_e, filters) => {
    const r = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: filters || [{ name: 'All', extensions: ['*'] }]
    });
    if (r.canceled || !r.filePaths.length) return null;
    return r.filePaths[0];
  });

  ipcMain.handle('shell:openPath', async (_e, target) => {
    return shell.openPath(target);
  });

  ipcMain.handle('shell:openExternal', async (_e, url) => {
    await shell.openExternal(url);
    return { ok: true };
  });

  ipcMain.handle('app:getPaths', async () => {
    const st = logger?.getStatus?.() || {};
    const logs = st.dir || path.join(app.getPath('userData'), 'logs');
    return {
      userData: app.getPath('userData'),
      documents: app.getPath('documents'),
      downloads: app.getPath('downloads'),
      home: app.getPath('home'),
      exe: app.getPath('exe'),
      resources: process.resourcesPath || path.join(__dirname, '..'),
      logs,
      logFile: st.file || null,
      actionFile: st.actionFile || null,
      sessions: sessionStore
        ? sessionStore.getDir()
        : path.join(app.getPath('userData'), 'sessions'),
      downloadsApp: (() => {
        try {
          const cfgPath = path.join(app.getPath('userData'), 'config.json');
          if (fs.existsSync(cfgPath)) {
            const c = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
            const d =
              (c.tools && c.tools.download && c.tools.download.dir) ||
              (c.paths && c.paths.downloadDir) ||
              '';
            if (d && String(d).trim()) return path.resolve(String(d).trim());
          }
        } catch (_) {}
        return path.join(app.getPath('userData'), 'downloads');
      })()
    };
  });

  ipcMain.handle('app:getVersion', async () => app.getVersion());

  ipcMain.handle('logs:status', async () => (logger ? logger.getStatus() : null));

  ipcMain.handle('logs:openDir', async () => {
    const dir =
      logger?.getStatus?.()?.dir || path.join(app.getPath('userData'), 'logs');
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      return err.message || String(err);
    }
    return shell.openPath(dir);
  });

  ipcMain.on('logs:ui', (_e, payload) => {
    if (!logger || !payload) return;
    try {
      logger.action('ui', payload.event || 'ui.event', payload.data || {});
    } catch (_) {}
  });

  // —— 多轮对话会话 ——
  ipcMain.handle('session:list', async () => {
    if (!sessionStore) return [];
    return sessionStore.listSessions();
  });

  ipcMain.handle('session:current', async () => {
    if (!sessionStore) return null;
    return sessionStore.getCurrent();
  });

  ipcMain.handle('session:create', async (_e, meta) => {
    if (!sessionStore) return null;
    return sessionStore.createSession(meta || {});
  });

  ipcMain.handle('session:load', async (_e, id) => {
    if (!sessionStore) return null;
    return sessionStore.loadSession(id);
  });

  ipcMain.handle('session:save', async (_e, sess) => {
    if (!sessionStore) return { ok: false, error: 'no_store' };
    const r = sessionStore.saveSession(sess, { force: true });
    if (logger && r.ok) {
      logger.info('session.saved', {
        id: sess?.id,
        messages: sess?.messages?.length || 0
      });
      // 同步一份可读对话到 chats 日志（按会话快照，便于检索）
      if (sess?.messages?.length) {
        const last = sess.messages[sess.messages.length - 1];
        logger.chat({
          sessionId: sess.id,
          role: 'session_snapshot',
          content: `title=${sess.title || ''} turns=${sess.messages.length} last=${String(last?.content || '').slice(0, 200)}`,
          meta: { path: r.path, updatedAt: r.updatedAt }
        });
      }
    }
    return r;
  });

  ipcMain.handle('session:delete', async (_e, id) => {
    if (!sessionStore) return { ok: false };
    return sessionStore.deleteSession(id);
  });

  ipcMain.handle('session:openDir', async () => {
    const dir = sessionStore
      ? sessionStore.getDir()
      : path.join(app.getPath('userData'), 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    return shell.openPath(dir);
  });

  ipcMain.handle('browser:state', async () => browserSession.getState());

  ipcMain.handle('mail:test', async () => {
    try {
      const cfgPath = path.join(app.getPath('userData'), 'config.json');
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      const { createMailTools } = require('../src/tools/mail');
      const mail = createMailTools({
        config: cfg.tools?.mail || {},
        logger
      });
      return await mail.mail_test();
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
}

app.whenReady().then(async () => {
  ensureUserConfig();
  const cfg = JSON.parse(fs.readFileSync(ensureUserConfig(), 'utf8'));
  logger = createLogger({
    userDataPath: app.getPath('userData'),
    config: cfg.logging || {}
  });
  sessionStore = createSessionStore({
    userDataPath: app.getPath('userData'),
    config: cfg.session || {}
  });
  browserSession.setLogger(logger);
  logger.info('app.start', {
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch
  });
  agentService = createAgentService({
    config: cfg,
    getMainWindow: () => mainWindow,
    userDataPath: app.getPath('userData'),
    logger
  });
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

let quitting = false;
async function gracefulQuit() {
  if (quitting) return;
  quitting = true;
  if (agentService) await agentService.shutdown({ force: true });
  if (sessionStore) sessionStore.shutdown();
  try {
    await browserSession.closeAll();
  } catch (_) {}
  if (logger) {
    logger.info('app.quit', {});
    await logger.shutdown();
  }
}

app.on('window-all-closed', async () => {
  await gracefulQuit();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  await gracefulQuit();
});
