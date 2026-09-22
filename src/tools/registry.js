const { TOOL_DEFINITIONS } = require('./definitions');
const { createFileTools } = require('./file');
const { createHttpTools } = require('./http');
const { createBrowserTools } = require('./browser');
const { createDownloadTools } = require('./download');
const { createMailTools } = require('./mail');
const browserSession = require('./browser-session');

function createToolRegistry(options = {}) {
  const config = options.config || {};
  const toolsCfg = config.tools || {};
  const handlers = {};
  const pathsConfig = config.paths || {};
  const dlCfg = {
    ...(toolsCfg.download || {}),
    dir: (toolsCfg.download && toolsCfg.download.dir) || pathsConfig.downloadDir || ''
  };

  if (toolsCfg.file?.enabled !== false) {
    Object.assign(handlers, createFileTools({ config: toolsCfg.file || {} }));
  }
  if (toolsCfg.http?.enabled !== false) {
    Object.assign(handlers, createHttpTools({ config: toolsCfg.http || {} }));
  }
  if (toolsCfg.download?.enabled !== false) {
    Object.assign(
      handlers,
      createDownloadTools({
        config: dlCfg,
        pathsConfig,
        userDataPath: options.userDataPath,
        logger: options.logger || null
      })
    );
  }
  if (toolsCfg.mail?.enabled !== false) {
    Object.assign(
      handlers,
      createMailTools({
        config: toolsCfg.mail || {},
        userDataPath: options.userDataPath,
        logger: options.logger || null
      })
    );
  }
  if (toolsCfg.browser?.enabled !== false) {
    Object.assign(
      handlers,
      createBrowserTools({
        config: {
          ...(toolsCfg.browser || {}),
          downloadDir: dlCfg.dir || pathsConfig.downloadDir || '',
          screenshotDir:
            (toolsCfg.browser && toolsCfg.browser.screenshotDir) ||
            pathsConfig.screenshotDir ||
            ''
        },
        userDataPath: options.userDataPath,
        logger: options.logger || null
      })
    );
  }

  function getDefinitions() {
    const names = new Set(Object.keys(handlers).filter((k) => !k.startsWith('_')));
    return TOOL_DEFINITIONS.filter((t) => names.has(t.function.name));
  }

  async function execute(name, args) {
    if (browserSession.isAborted()) {
      const err = new Error('已取消');
      err.name = 'AbortError';
      throw err;
    }
    const fn = handlers[name];
    if (!fn) throw new Error(`未知工具: ${name}`);
    return fn(args || {});
  }

  function abortRunning() {
    browserSession.requestAbort();
    if (typeof handlers._abortRunning === 'function') {
      try {
        handlers._abortRunning();
      } catch (_) {}
    }
  }

  function clearAbort() {
    browserSession.clearAbort();
  }

  async function shutdown(opts = {}) {
    // 默认 keep browser session；仅 force 时真正关闭
    if (opts.force && handlers._forceShutdown) {
      await handlers._forceShutdown();
      return;
    }
    if (handlers._shutdown) await handlers._shutdown();
  }

  return {
    getDefinitions,
    execute,
    shutdown,
    abortRunning,
    clearAbort,
    handlers
  };
}

module.exports = { createToolRegistry };
