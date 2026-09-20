/**
 * 轻量异步日志：内存队列 + 定时批量写盘，避免阻塞主路径。
 * - 单行 JSON（NDJSON），按日滚动
 * - 自动脱敏 / 截断大字段
 * - 可开关、可限级
 */
const fs = require('fs');
const path = require('path');

const SENSITIVE_KEYS = /^(apiKey|api_key|authorization|password|passwd|token|secret|cookie)$/i;
const DEFAULTS = {
  enabled: true,
  level: 'info',
  dir: '',
  maxFileBytes: 8 * 1024 * 1024,
  maxFiles: 14,
  flushIntervalMs: 2000,
  maxQueue: 500,
  maxFieldLen: 800,
  logChatContent: true,
  logConversations: true,
  maxChatContentLen: 8000,
  logToolArgs: true,
  logToolResult: true,
  logUiClicks: true,
  logBrowserActions: true,
  actionFlushIntervalMs: 1500,
  maxActionQueue: 300
};

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

function createLogger(options = {}) {
  let cfg = { ...DEFAULTS, ...(options.config || {}) };
  const userDataPath = options.userDataPath || process.cwd();
  let queue = [];
  let actionQueue = [];
  let writing = false;
  let actionWriting = false;
  let closed = false;
  let timer = null;
  let actionTimer = null;
  let currentDate = '';
  let currentFile = '';
  let currentSize = 0;
  let actionDate = '';
  let actionFile = '';
  let actionSize = 0;

  function logDir() {
    if (cfg.dir) return cfg.dir;
    return path.join(userDataPath, 'logs');
  }

  function ensureDir() {
    try {
      fs.mkdirSync(logDir(), { recursive: true });
    } catch (_) {}
  }

  function dayStamp(d = new Date()) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function resolveFile() {
    const day = dayStamp();
    if (day !== currentDate || !currentFile) {
      currentDate = day;
      currentFile = path.join(logDir(), `aihelper-${day}.log`);
      try {
        currentSize = fs.existsSync(currentFile) ? fs.statSync(currentFile).size : 0;
      } catch {
        currentSize = 0;
      }
    }
    return currentFile;
  }

  function truncate(v, max) {
    if (v == null) return v;
    if (typeof v === 'string') {
      return v.length > max ? v.slice(0, max) + `…(+${v.length - max})` : v;
    }
    if (typeof v === 'number' || typeof v === 'boolean') return v;
    if (Array.isArray(v)) {
      const out = v.slice(0, 20).map((x) => truncate(x, max));
      if (v.length > 20) out.push(`…(+${v.length - 20} items)`);
      return out;
    }
    if (typeof v === 'object') {
      const out = {};
      let n = 0;
      for (const [k, val] of Object.entries(v)) {
        if (n++ >= 30) {
          out._more = true;
          break;
        }
        if (SENSITIVE_KEYS.test(k)) {
          out[k] = '***';
          continue;
        }
        out[k] = truncate(val, max);
      }
      return out;
    }
    const s = String(v);
    return s.length > max ? s.slice(0, max) + '…' : s;
  }

  function shouldLog(level) {
    if (!cfg.enabled || closed) return false;
    const want = LEVELS[cfg.level] ?? LEVELS.info;
    const got = LEVELS[level] ?? LEVELS.info;
    return got <= want;
  }

  function push(level, event, data) {
    if (!shouldLog(level)) return;
    if (queue.length >= (cfg.maxQueue || 500)) {
      queue.shift();
      queue.push({
        t: new Date().toISOString(),
        level: 'warn',
        event: 'log.dropped',
        data: { reason: 'queue_full' }
      });
    }
    const max = cfg.maxFieldLen || 800;
    queue.push({
      t: new Date().toISOString(),
      level,
      event,
      data: data != null ? truncate(data, max) : undefined
    });
  }

  function rotateIfNeeded(file, chunkLen) {
    if (currentSize + chunkLen <= (cfg.maxFileBytes || 8 * 1024 * 1024)) return file;
    const rotated = file.replace(/\.log$/, `.${Date.now()}.log`);
    try {
      if (fs.existsSync(file)) fs.renameSync(file, rotated);
    } catch (_) {}
    currentSize = 0;
    pruneOldFiles();
    return file;
  }

  function pruneOldFiles() {
    try {
      const dir = logDir();
      const files = fs
        .readdirSync(dir)
        .filter(
          (f) =>
            (f.startsWith('aihelper-') && f.endsWith('.log')) ||
            (f.startsWith('actions-') && f.endsWith('.jsonl')) ||
            (f.startsWith('usage-') && f.endsWith('.jsonl')) ||
            (f.startsWith('chats-') && f.endsWith('.jsonl'))
        )
        .map((f) => {
          const full = path.join(dir, f);
          let mtime = 0;
          try {
            mtime = fs.statSync(full).mtimeMs;
          } catch (_) {}
          return { full, mtime };
        })
        .sort((a, b) => b.mtime - a.mtime);
      const keep = cfg.maxFiles || 14;
      for (let i = keep; i < files.length; i++) {
        try {
          fs.unlinkSync(files[i].full);
        } catch (_) {}
      }
    } catch (_) {}
  }

  function flushSync() {
    if (!queue.length || writing) return;
    writing = true;
    const batch = queue;
    queue = [];
    try {
      ensureDir();
      let file = resolveFile();
      const lines = batch.map((row) => JSON.stringify(row)).join('\n') + '\n';
      file = rotateIfNeeded(file, Buffer.byteLength(lines));
      fs.appendFileSync(file, lines, 'utf8');
      currentSize += Buffer.byteLength(lines);
    } catch (_) {
      // 写失败丢弃，不拖垮业务
    } finally {
      writing = false;
    }
  }

  function schedule() {
    if (timer) return;
    const ms = Math.max(500, cfg.flushIntervalMs || 2000);
    timer = setInterval(() => {
      flushSync();
    }, ms);
    if (timer.unref) timer.unref();
  }

  function info(event, data) {
    push('info', event, data);
  }
  function warn(event, data) {
    push('warn', event, data);
  }
  function error(event, data) {
    push('error', event, data);
  }
  function debug(event, data) {
    push('debug', event, data);
  }

  /** 使用统计：会话次数、工具次数等，写 usage-YYYY-MM-DD.jsonl */
  function usage(event, data) {
    if (!cfg.enabled || closed) return;
    try {
      ensureDir();
      const file = path.join(logDir(), `usage-${dayStamp()}.jsonl`);
      const row = JSON.stringify({
        t: new Date().toISOString(),
        event,
        data: data != null ? truncate(data, cfg.maxFieldLen || 800) : undefined
      });
      fs.appendFile(file, row + '\n', () => {});
    } catch (_) {}
  }

  /**
   * 对话正文：独立 chats-YYYY-MM-DD.jsonl，异步写入，不走主队列
   * role: user | assistant | system | tool_summary
   */
  function chat(entry) {
    if (!cfg.enabled || closed) return;
    if (cfg.logConversations === false && cfg.logChatContent === false) return;
    try {
      ensureDir();
      const file = path.join(logDir(), `chats-${dayStamp()}.jsonl`);
      const max = cfg.maxChatContentLen || 8000;
      let content = entry?.content;
      if (typeof content === 'string' && content.length > max) {
        content = content.slice(0, max) + `…(+${content.length - max})`;
      }
      const row = {
        t: new Date().toISOString(),
        sessionId: entry?.sessionId,
        role: entry?.role || 'unknown',
        content,
        meta:
          entry?.meta != null
            ? truncate(entry.meta, cfg.maxFieldLen || 800)
            : undefined
      };
      fs.appendFile(file, JSON.stringify(row) + '\n', () => {});
    } catch (_) {}
  }

  function resolveActionFile() {
    const day = dayStamp();
    if (day !== actionDate || !actionFile) {
      actionDate = day;
      actionFile = path.join(logDir(), `actions-${day}.jsonl`);
      try {
        actionSize = fs.existsSync(actionFile) ? fs.statSync(actionFile).size : 0;
      } catch {
        actionSize = 0;
      }
    }
    return actionFile;
  }

  /**
   * 操作过程日志（UI 点击 / 浏览器自动化步骤）
   * 独立文件，避免与主日志互相拖慢
   */
  function action(kind, event, data) {
    if (!cfg.enabled || closed) return;
    if (kind === 'ui' && cfg.logUiClicks === false) return;
    if (kind === 'browser' && cfg.logBrowserActions === false) return;

    if (actionQueue.length >= (cfg.maxActionQueue || 300)) {
      actionQueue.shift();
    }
    actionQueue.push({
      t: new Date().toISOString(),
      kind: kind || 'action',
      event,
      data: data != null ? truncate(data, cfg.maxFieldLen || 800) : undefined
    });
  }

  function flushActionsSync() {
    if (!actionQueue.length || actionWriting) return;
    actionWriting = true;
    const batch = actionQueue;
    actionQueue = [];
    try {
      ensureDir();
      let file = resolveActionFile();
      const lines = batch.map((row) => JSON.stringify(row)).join('\n') + '\n';
      const len = Buffer.byteLength(lines);
      if (actionSize + len > (cfg.maxFileBytes || 8 * 1024 * 1024)) {
        const rotated = file.replace(/\.jsonl$/, `.${Date.now()}.jsonl`);
        try {
          if (fs.existsSync(file)) fs.renameSync(file, rotated);
        } catch (_) {}
        actionSize = 0;
      }
      fs.appendFileSync(file, lines, 'utf8');
      actionSize += len;
    } catch (_) {
    } finally {
      actionWriting = false;
    }
  }

  function scheduleActions() {
    if (actionTimer) return;
    const ms = Math.max(400, cfg.actionFlushIntervalMs || 1500);
    actionTimer = setInterval(() => flushActionsSync(), ms);
    if (actionTimer.unref) actionTimer.unref();
  }

  function getStatus() {
    return {
      enabled: !!cfg.enabled,
      level: cfg.level,
      dir: logDir(),
      queue: queue.length,
      actionQueue: actionQueue.length,
      file: currentFile || resolveFile(),
      actionFile: actionFile || resolveActionFile(),
      logUiClicks: cfg.logUiClicks !== false,
      logBrowserActions: cfg.logBrowserActions !== false
    };
  }

  async function shutdown() {
    closed = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (actionTimer) {
      clearInterval(actionTimer);
      actionTimer = null;
    }
    flushSync();
    flushActionsSync();
  }

  function configure(next) {
    const prevDir = logDir();
    cfg = { ...cfg, ...(next || {}) };
    if (cfg.dir) cfg.dir = String(cfg.dir).trim();
    // 目录变更时切换文件句柄状态
    if (logDir() !== prevDir) {
      currentDate = '';
      currentFile = '';
      currentSize = 0;
      actionDate = '';
      actionFile = '';
      actionSize = 0;
      try {
        ensureDir();
      } catch (_) {}
    }
    if (cfg.enabled) {
      schedule();
      scheduleActions();
    }
  }

  if (cfg.enabled) {
    schedule();
    scheduleActions();
  }

  return {
    configure,
    info,
    warn,
    error,
    debug,
    usage,
    chat,
    action,
    flush: () => {
      flushSync();
      flushActionsSync();
    },
    getStatus,
    shutdown,
    get config() {
      return { ...cfg };
    }
  };
}

module.exports = { createLogger };
