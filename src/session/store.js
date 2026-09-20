/**
 * 对话会话持久化：多轮 history 落盘，定时/即时保存，关闭后可恢复。
 */
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

function createSessionStore(options = {}) {
  const userDataPath = options.userDataPath || process.cwd();
  let cfg = {
    enabled: true,
    autosaveMs: 15000,
    maxSessions: 50,
    maxMessagesPerSession: 200,
    dir: '',
    ...(options.config || {})
  };

  let timer = null;
  let dirty = false;
  let currentId = null;

  function baseDir() {
    if (cfg.dir) return cfg.dir;
    return path.join(userDataPath, 'sessions');
  }

  function ensureDir() {
    fs.mkdirSync(baseDir(), { recursive: true });
  }

  function sessionPath(id) {
    return path.join(baseDir(), `${id}.json`);
  }

  function indexPath() {
    return path.join(baseDir(), 'index.json');
  }

  function readIndex() {
    try {
      ensureDir();
      const p = indexPath();
      if (!fs.existsSync(p)) return { currentId: null, sessions: [] };
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      return { currentId: null, sessions: [] };
    }
  }

  function writeIndex(idx) {
    ensureDir();
    fs.writeFileSync(indexPath(), JSON.stringify(idx, null, 2), 'utf8');
  }

  function configure(next) {
    cfg = { ...cfg, ...(next || {}) };
    if (cfg.dir) cfg.dir = String(cfg.dir).trim();
    schedule();
  }

  function schedule() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (!cfg.enabled) return;
    const ms = Math.max(5000, cfg.autosaveMs || 15000);
    timer = setInterval(() => {
      if (dirty) flushSync();
    }, ms);
    if (timer.unref) timer.unref();
  }

  function createSession(meta = {}) {
    const id = `sess_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const sess = {
      id,
      title: meta.title || '新对话',
      createdAt: now,
      updatedAt: now,
      messages: [],
      uiMessages: []
    };
    ensureDir();
    fs.writeFileSync(sessionPath(id), JSON.stringify(sess, null, 2), 'utf8');
    const idx = readIndex();
    idx.sessions = idx.sessions || [];
    idx.sessions.unshift({
      id,
      title: sess.title,
      updatedAt: now,
      createdAt: now
    });
    idx.currentId = id;
    pruneIndex(idx);
    writeIndex(idx);
    currentId = id;
    dirty = false;
    return sess;
  }

  function pruneIndex(idx) {
    const max = cfg.maxSessions || 50;
    if (idx.sessions.length <= max) return;
    const drop = idx.sessions.slice(max);
    idx.sessions = idx.sessions.slice(0, max);
    for (const s of drop) {
      try {
        fs.unlinkSync(sessionPath(s.id));
      } catch (_) {}
    }
  }

  function loadSession(id) {
    if (!id) return null;
    try {
      const p = sessionPath(id);
      if (!fs.existsSync(p)) return null;
      const sess = JSON.parse(fs.readFileSync(p, 'utf8'));
      currentId = sess.id;
      const idx = readIndex();
      idx.currentId = sess.id;
      writeIndex(idx);
      dirty = false;
      return sess;
    } catch {
      return null;
    }
  }

  function getCurrent() {
    if (currentId) {
      const s = loadSession(currentId);
      if (s) return s;
    }
    const idx = readIndex();
    if (idx.currentId) {
      const s = loadSession(idx.currentId);
      if (s) return s;
    }
    if (idx.sessions?.[0]?.id) {
      const s = loadSession(idx.sessions[0].id);
      if (s) return s;
    }
    return createSession();
  }

  function listSessions() {
    return readIndex().sessions || [];
  }

  function saveSession(sess, opts = {}) {
    if (!cfg.enabled && !opts.force) return { ok: false, reason: 'disabled' };
    if (!sess || !sess.id) return { ok: false, reason: 'no_session' };
    try {
      ensureDir();
      const maxMsg = cfg.maxMessagesPerSession || 200;
      if (Array.isArray(sess.messages) && sess.messages.length > maxMsg) {
        sess.messages = sess.messages.slice(-maxMsg);
      }
      if (Array.isArray(sess.uiMessages) && sess.uiMessages.length > maxMsg * 2) {
        sess.uiMessages = sess.uiMessages.slice(-(maxMsg * 2));
      }
      sess.updatedAt = new Date().toISOString();
      if (!sess.title || sess.title === '新对话') {
        const firstUser = (sess.messages || []).find((m) => m.role === 'user');
        if (firstUser?.content) {
          sess.title = String(firstUser.content).replace(/\s+/g, ' ').slice(0, 40);
        }
      }
      fs.writeFileSync(sessionPath(sess.id), JSON.stringify(sess, null, 2), 'utf8');
      const idx = readIndex();
      idx.currentId = sess.id;
      const item = {
        id: sess.id,
        title: sess.title || '对话',
        updatedAt: sess.updatedAt,
        createdAt: sess.createdAt
      };
      idx.sessions = (idx.sessions || []).filter((s) => s.id !== sess.id);
      idx.sessions.unshift(item);
      pruneIndex(idx);
      writeIndex(idx);
      currentId = sess.id;
      dirty = false;
      return { ok: true, path: sessionPath(sess.id), updatedAt: sess.updatedAt };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  }

  function markDirty() {
    dirty = true;
  }

  function flushSync() {
    // 由外部传入当前会话内容；此处仅作 no-op 占位
    dirty = false;
  }

  /** 导出可读文本 */
  function exportText(sess) {
    if (!sess) return '';
    const lines = [`# ${sess.title || sess.id}`, `更新: ${sess.updatedAt || ''}`, ''];
    for (const m of sess.messages || []) {
      lines.push(`[${m.role}]`);
      lines.push(m.content || '');
      lines.push('');
    }
    return lines.join('\n');
  }

  function deleteSession(id) {
    try {
      const p = sessionPath(id);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (_) {}
    const idx = readIndex();
    idx.sessions = (idx.sessions || []).filter((s) => s.id !== id);
    if (idx.currentId === id) idx.currentId = idx.sessions[0]?.id || null;
    writeIndex(idx);
    if (currentId === id) currentId = idx.currentId;
    return { ok: true };
  }

  function getDir() {
    return baseDir();
  }

  function shutdown() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  schedule();

  return {
    configure,
    createSession,
    loadSession,
    getCurrent,
    listSessions,
    saveSession,
    markDirty,
    deleteSession,
    exportText,
    getDir,
    shutdown,
    get config() {
      return { ...cfg };
    }
  };
}

module.exports = { createSessionStore };
