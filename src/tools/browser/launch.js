/**
 * 启动浏览器 / 绑定页面监听。
 * 依赖 ctx：appendRecordFromPage、bindContextDownloads、applyCdpDownloadBehavior。
 * 不 require download/flow 文件。
 */
const path = require('path');
const bs = require('../browser-session');
const { ensureDir, resolveIncomingDir } = require('../download-path');
const { resolveBrowserDownloadDir } = require('./paths');
const { stealthEnabled, buildLaunchArgs, stealthInitScript } = require('./stealth');

function createLaunchHelpers(ctx) {
  const { cfg, userDataPath, keepSession } = ctx;

  function appendRecordFromPage(event, data, url) {
    return ctx.appendRecordFromPage(event, data, url);
  }
  function bindContextDownloads(context, dlRoot) {
    return ctx.bindContextDownloads(context, dlRoot);
  }
  async function applyCdpDownloadBehavior(context, page, dlRoot) {
    return ctx.applyCdpDownloadBehavior(context, page, dlRoot);
  }

  async function ensurePlaywright() {
    const shared = bs.getShared();
    if (shared.playwright) return shared.playwright;
    try {
      // Playwright 普通模式会丢弃 launch.downloadsPath，强制 %TEMP%/playwright-artifacts + UUID。
      // 必须在 require 之前打开 PWTEST_UNDER_TEST，downloadsPath 才会生效。
      if (process.env.PWTEST_UNDER_TEST == null || process.env.PWTEST_UNDER_TEST === '') {
        process.env.PWTEST_UNDER_TEST = '1';
      }
      bs.ensurePlaywrightBrowsersEnv();
      shared.playwright = require('playwright');
      return shared.playwright;
    } catch {
      throw new Error(
        'Playwright 未安装。请在有网络的环境执行 npm install 并运行 npx playwright install chromium，再打离线包。'
      );
    }
  }

  async function bindPageListeners(p) {
    const shared = bs.getShared();
    if (shared.listenersBound || !p) return;
    shared.listenersBound = true;
  
    p.on('framenavigated', (frame) => {
      if (frame !== p.mainFrame()) return;
      const u = frame.url();
      bs.logAction('page.navigate', { url: u });
      appendRecordFromPage('page.navigate', { url: u }, u);
    });
  
    p.on('close', () => {
      bs.logAction('page.close', {});
      shared.listenersBound = false;
      shared.page = null;
    });
  
    try {
      await p.exposeBinding('__aihelperLog', (_source, payload) => {
        if (!payload || typeof payload !== 'object') return;
        const ev = payload.event || 'page.user';
        const data = payload.data || {};
        bs.logAction(ev, { url: p.url(), ...data });
        appendRecordFromPage(ev, data, p.url());
      });
    } catch (_) {}
  
    const hookSource = () => {
      if (window.__aihelperActionHooked) return;
      window.__aihelperActionHooked = true;
      function cssPath(el) {
        if (!el || el.nodeType !== 1) return '';
        if (el.id) return `#${CSS.escape ? CSS.escape(el.id) : el.id}`;
        const parts = [];
        let cur = el;
        let depth = 0;
        while (cur && cur.nodeType === 1 && depth < 5) {
          let part = cur.nodeName.toLowerCase();
          if (cur.classList && cur.classList.length) {
            const cls = Array.from(cur.classList)
              .filter((c) => !/^(is-|el-table_|ivu-)/.test(c) || /btn|button|primary|link/.test(c))
              .slice(0, 3);
            if (cls.length) part += '.' + cls.join('.');
          }
          parts.unshift(part);
          cur = cur.parentElement;
          depth += 1;
        }
        return parts.join(' > ');
      }
      function stableSelector(el) {
        if (!el || el.nodeType !== 1) return '';
        const act =
          (el.closest && el.closest('button, a, [role="button"], input, textarea, select')) || el;
        if (act.id) return `#${CSS.escape ? CSS.escape(act.id) : act.id}`;
        const ph = act.getAttribute && act.getAttribute('placeholder');
        if (ph) {
          const tag = act.tagName.toLowerCase();
          return `${tag}[placeholder="${ph.replace(/"/g, '\\"')}"]`;
        }
        const name = act.getAttribute && act.getAttribute('name');
        if (name) {
          const tag = act.tagName.toLowerCase();
          return `${tag}[name="${name.replace(/"/g, '\\"')}"]`;
        }
        const aria = act.getAttribute && act.getAttribute('aria-label');
        if (aria) return `[aria-label="${aria.replace(/"/g, '\\"')}"]`;
        return cssPath(act);
      }
      function brief(el) {
        if (!el) return {};
        const act =
          (el.closest && el.closest('button, a, [role="button"], input, textarea, select')) || el;
        const text = (act.innerText || act.value || act.getAttribute?.('aria-label') || '')
          .toString()
          .trim()
          .slice(0, 80);
        return {
          tag: act.tagName ? act.tagName.toLowerCase() : '',
          id: act.id || undefined,
          name: act.getAttribute?.('name') || undefined,
          type: act.getAttribute?.('type') || undefined,
          placeholder: act.getAttribute?.('placeholder') || undefined,
          role: act.getAttribute?.('role') || undefined,
          text: text || undefined,
          selector: stableSelector(act)
        };
      }
      document.addEventListener(
        'click',
        (e) => {
          try {
            if (typeof window.__aihelperLog === 'function') {
              window.__aihelperLog({
                event: 'page.click',
                data: { button: e.button, x: e.clientX, y: e.clientY, target: brief(e.target) }
              });
            }
          } catch (_) {}
        },
        true
      );
      document.addEventListener(
        'change',
        (e) => {
          try {
            const t = e.target;
            if (!t) return;
            const type = (t.getAttribute && t.getAttribute('type')) || '';
            let value = t.value;
            const isPass =
              /pass/i.test(type) || /pass/i.test(t.name || '') || /pass/i.test(t.id || '');
            if (isPass) value = '***';
            else if (typeof value === 'string' && value.length > 200) value = value.slice(0, 200) + '…';
            if (typeof window.__aihelperLog === 'function') {
              window.__aihelperLog({
                event: 'page.input',
                data: {
                  target: brief(t),
                  value,
                  rawValue: isPass ? undefined : t.value
                }
              });
            }
          } catch (_) {}
        },
        true
      );
      document.addEventListener(
        'keydown',
        (e) => {
          try {
            if (e.key !== 'Enter') return;
            const t = e.target;
            if (!t || !/INPUT|TEXTAREA/i.test(t.tagName || '')) return;
            if (typeof window.__aihelperLog === 'function') {
              window.__aihelperLog({
                event: 'page.key',
                data: { key: 'Enter', target: brief(t) }
              });
            }
          } catch (_) {}
        },
        true
      );
      document.addEventListener(
        'submit',
        (e) => {
          try {
            if (typeof window.__aihelperLog === 'function') {
              window.__aihelperLog({
                event: 'page.submit',
                data: { target: brief(e.target) }
              });
            }
          } catch (_) {}
        },
        true
      );
    };
  
    await p.addInitScript(hookSource);
    try {
      await p.evaluate(hookSource);
    } catch (_) {}
  }

  async function ensurePage() {
    const shared = bs.getShared();
    bs.setConfig(cfg, userDataPath);
    shared.downloadDir = resolveBrowserDownloadDir(cfg, userDataPath);
  
    if (bs.isPageAlive()) {
      await bindPageListeners(shared.page);
      return shared.page;
    }
  
    shared.listenersBound = false;
    shared.sessionId = `b${Date.now().toString(36)}`;
    shared.stepSeq = 0;
    shared.launchedAt = new Date().toISOString();
  
    const pw = await ensurePlaywright();
    const headless = cfg.headless === true;
  
    const dlRoot = resolveBrowserDownloadDir(cfg, userDataPath);
    const stageRoot = resolveIncomingDir(dlRoot);
    try {
      ensureDir(dlRoot);
      ensureDir(stageRoot);
    } catch (_) {}
    shared.downloadDir = dlRoot;
    if (!Array.isArray(shared.recentDownloads)) shared.recentDownloads = [];
    if (!Array.isArray(shared.downloadWaiters)) shared.downloadWaiters = [];
  
    // downloadsPath / CDP 必须用 staging，禁止直接写最终目录（否则同名文件被浏览器原生覆盖）
    const launchOpts = {
      headless,
      args: buildLaunchArgs(cfg),
      ignoreDefaultArgs: stealthEnabled(cfg) ? ['--enable-automation'] : undefined,
      downloadsPath: stageRoot
    };
  
    const preferSystem = cfg.preferSystemBrowser !== false;
    bs.ensurePlaywrightBrowsersEnv();
    const exeFromCfg = String(cfg.executablePath || cfg.chromePath || '').trim();
    const localChrome = bs.findLocalBrowser({
      preferSystem,
      preferChrome: cfg.preferChrome !== false,
      chromeOnly: cfg.chromeOnly === true,
      executablePath: exeFromCfg || undefined
    });
    if (localChrome) launchOpts.executablePath = localChrome;
    else if (cfg.channel) launchOpts.channel = cfg.channel;
    shared.executablePath = launchOpts.executablePath || '';
    shared.browserName = bs.detectBrowserName(shared.executablePath);
  
    const ua =
      cfg.userAgent ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
  
    const contextOpts = {
      viewport: cfg.defaultViewport || { width: 1366, height: 768 },
      ignoreHTTPSErrors: cfg.ignoreHTTPSErrors !== false,
      locale: cfg.locale || 'zh-CN',
      timezoneId: cfg.timezoneId || 'Asia/Shanghai',
      userAgent: stealthEnabled(cfg) ? ua : undefined,
      colorScheme: 'light',
      deviceScaleFactor: 1,
      hasTouch: false,
      isMobile: false,
      javaScriptEnabled: true,
      acceptDownloads: true,
      extraHTTPHeaders: {
        'Accept-Language': cfg.acceptLanguage || 'zh-CN,zh;q=0.9,en;q=0.8',
        ...(cfg.extraHeaders || {})
      }
    };
  
    // 持久配置档：登录态/Cookie 可保留。默认 userData/browser-profile（非系统日常 Chrome 目录，避免冲突）
    // 设 tools.browser.userDataDir="" 且 ephemeral=true 才每次无痕
    const ephemeral = cfg.ephemeral === true || cfg.incognito === true;
    let profileDir = String(cfg.userDataDir || '').trim();
    if (!ephemeral && !profileDir) {
      profileDir = path.join(userDataPath || process.cwd(), 'browser-profile');
    }
    shared.userDataDir = profileDir || '';
    shared.ephemeral = !!ephemeral;
  
    if (profileDir && !ephemeral) {
      try {
        ensureDir(profileDir);
        shared.context = await pw.chromium.launchPersistentContext(profileDir, {
          ...launchOpts,
          ...contextOpts
        });
        shared.browser = shared.context.browser ? shared.context.browser() : null;
        shared.page = shared.context.pages()[0] || (await shared.context.newPage());
      } catch (err) {
        // 常见：配置档被另一 Chrome/上次残留进程占用
        shared.browser = await pw.chromium.launch(launchOpts);
        shared.context = await shared.browser.newContext(contextOpts);
        shared.page = await shared.context.newPage();
        bs.logAction('browser.userdata_fallback', {
          error: err.message,
          profileDir,
          hint: '请关闭占用该配置档的浏览器后重试；或换 userDataDir'
        });
      }
    } else {
      shared.browser = await pw.chromium.launch(launchOpts);
      shared.context = await shared.browser.newContext(contextOpts);
      shared.page = await shared.context.newPage();
    }
  
    shared.page.setDefaultTimeout(cfg.timeoutMs || 30000);
  
    // 所有标签页的下载：context 级挂接（新开页也能捕获）
    bindContextDownloads(shared.context, dlRoot);
  
    if (stealthEnabled(cfg)) {
      try {
        await shared.context.addInitScript(stealthInitScript());
      } catch (_) {
        try {
          await shared.page.addInitScript(stealthInitScript());
        } catch (__) {}
      }
      try {
        const client = await shared.context.newCDPSession(shared.page);
        await client.send('Page.addScriptToEvaluateOnNewDocument', {
          source: `(${stealthInitScript().toString()})();`
        });
      } catch (_) {}
    }
  
    // CDP：强制浏览器下载行为落到我们的目录（比仅 page.on 更稳）
    await applyCdpDownloadBehavior(shared.context, shared.page, dlRoot);
  
    await bindPageListeners(shared.page);
    // 已有/后续 page 也绑操作监听
    try {
      shared.context.on('page', (pg) => {
        bindPageListeners(pg).catch(() => {});
        pg.setDefaultTimeout(cfg.timeoutMs || 30000);
        applyCdpDownloadBehavior(shared.context, pg, dlRoot).catch(() => {});
      });
    } catch (_) {}
  
    bs.logAction('browser.launch', {
      headless,
      stealth: stealthEnabled(cfg),
      keepSession,
      downloadDir: dlRoot,
      userDataDir: shared.userDataDir || '',
      ephemeral: !!shared.ephemeral,
      browserName: shared.browserName,
      executablePath: launchOpts.executablePath || launchOpts.channel || 'bundled',
      chromeInstalled: !!bs.findSystemChrome(),
      edgeInstalled: !!bs.findSystemEdge()
    });
    return shared.page;
  }

  return { ensurePlaywright, bindPageListeners, ensurePage };
}

module.exports = { createLaunchHelpers };
