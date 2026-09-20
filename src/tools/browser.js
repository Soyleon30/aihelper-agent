const path = require('path');
const fsp = require('fs').promises;
const bs = require('./browser-session');

function resolveScreenshotDir(cfg, userDataPath) {
  const d = String(
    (cfg && (cfg.screenshotDir || cfg.pathsScreenshotDir)) || ''
  ).trim();
  if (d) return path.resolve(d);
  // 默认放到用户「图片」下，比 AppData 更好找
  const pictures =
    process.env.USERPROFILE
      ? path.join(process.env.USERPROFILE, 'Pictures', 'AIHelper-Screenshots')
      : path.join(userDataPath, 'screenshots');
  return pictures;
}

function createBrowserTools(options = {}) {
  const cfg = options.config || {};
  const userDataPath = options.userDataPath || process.cwd();
  const logger = options.logger || null;

  bs.setLogger(logger);
  bs.setConfig(cfg, userDataPath);

  // keepSession=true（默认）：配置重载/对话切换不关浏览器，便于人工操作后继续
  const keepSession = cfg.keepSession !== false;

  function maskText(text, selector) {
    const s = String(text ?? '');
    const sel = String(selector || '');
    if (/pass|pwd|secret|token|credential/i.test(sel)) return '***';
    if (s.length > 120) return s.slice(0, 120) + '…';
    return s;
  }

  function stealthEnabled() {
    return cfg.stealth !== false;
  }

  function buildLaunchArgs() {
    const args = [
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--no-default-browser-check',
      '--no-first-run',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-features=IsolateOrigins,site-per-process,AutomationControlled'
    ];
    if (cfg.noSandbox) {
      args.push('--no-sandbox', '--disable-setuid-sandbox');
    }
    if (Array.isArray(cfg.extraArgs)) args.push(...cfg.extraArgs);
    return args;
  }

  function stealthInitScript() {
    return () => {
      try {
        Object.defineProperty(navigator, 'webdriver', {
          get: () => undefined,
          configurable: true
        });
      } catch (_) {}
      try {
        if (!window.chrome) {
          window.chrome = { runtime: {}, loadTimes: function () {}, csi: function () {} };
        }
      } catch (_) {}
      try {
        const originalQuery = window.navigator.permissions && window.navigator.permissions.query;
        if (originalQuery) {
          window.navigator.permissions.query = (parameters) =>
            parameters && parameters.name === 'notifications'
              ? Promise.resolve({ state: Notification.permission })
              : originalQuery(parameters);
        }
      } catch (_) {}
      try {
        Object.defineProperty(navigator, 'plugins', {
          get: () => [1, 2, 3, 4, 5],
          configurable: true
        });
      } catch (_) {}
      try {
        Object.defineProperty(navigator, 'languages', {
          get: () => ['zh-CN', 'zh', 'en-US', 'en'],
          configurable: true
        });
      } catch (_) {}
    };
  }

  async function ensurePlaywright() {
    const shared = bs.getShared();
    if (shared.playwright) return shared.playwright;
    try {
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
      bs.logAction('page.navigate', { url: frame.url() });
    });

    p.on('close', () => {
      bs.logAction('page.close', {});
      shared.listenersBound = false;
      shared.page = null;
    });

    try {
      await p.exposeBinding('__aihelperLog', (_source, payload) => {
        if (!payload || typeof payload !== 'object') return;
        bs.logAction(payload.event || 'page.user', {
          url: p.url(),
          ...payload.data
        });
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
            part += '.' + Array.from(cur.classList).slice(0, 2).join('.');
          }
          parts.unshift(part);
          cur = cur.parentElement;
          depth += 1;
        }
        return parts.join(' > ');
      }
      function brief(el) {
        if (!el) return {};
        return {
          tag: el.tagName ? el.tagName.toLowerCase() : '',
          id: el.id || undefined,
          name: el.getAttribute?.('name') || undefined,
          type: el.getAttribute?.('type') || undefined,
          text: (el.innerText || el.value || el.getAttribute?.('aria-label') || '')
            .toString()
            .trim()
            .slice(0, 80) || undefined,
          selector: cssPath(el)
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
            if (/pass/i.test(type) || /pass/i.test(t.name || '') || /pass/i.test(t.id || '')) {
              value = '***';
            } else if (typeof value === 'string' && value.length > 80) {
              value = value.slice(0, 80) + '…';
            }
            if (typeof window.__aihelperLog === 'function') {
              window.__aihelperLog({
                event: 'page.input',
                data: { target: brief(t), value }
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
    const launchOpts = {
      headless,
      args: buildLaunchArgs(),
      ignoreDefaultArgs: stealthEnabled() ? ['--enable-automation'] : undefined
    };

    const preferSystem = cfg.preferSystemBrowser !== false;
    const localChrome = preferSystem ? bs.findLocalBrowser() : null;
    if (localChrome) launchOpts.executablePath = localChrome;
    else if (cfg.channel) launchOpts.channel = cfg.channel;

    const ua =
      cfg.userAgent ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

    const dlRoot = (() => {
      const d = (cfg.downloadDir || '').trim();
      if (d) return path.resolve(d);
      return path.join(userDataPath, 'downloads');
    })();
    try {
      require('fs').mkdirSync(dlRoot, { recursive: true });
    } catch (_) {}

    const contextOpts = {
      viewport: cfg.defaultViewport || { width: 1366, height: 768 },
      ignoreHTTPSErrors: cfg.ignoreHTTPSErrors !== false,
      locale: cfg.locale || 'zh-CN',
      timezoneId: cfg.timezoneId || 'Asia/Shanghai',
      userAgent: stealthEnabled() ? ua : undefined,
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

    if (cfg.userDataDir) {
      try {
        shared.context = await pw.chromium.launchPersistentContext(cfg.userDataDir, {
          ...launchOpts,
          ...contextOpts
        });
        shared.browser = shared.context.browser ? shared.context.browser() : null;
        shared.page = shared.context.pages()[0] || (await shared.context.newPage());
      } catch (err) {
        shared.browser = await pw.chromium.launch(launchOpts);
        shared.context = await shared.browser.newContext(contextOpts);
        shared.page = await shared.context.newPage();
        bs.logAction('browser.userdata_fallback', { error: err.message });
      }
    } else {
      shared.browser = await pw.chromium.launch(launchOpts);
      shared.context = await shared.browser.newContext(contextOpts);
      shared.page = await shared.context.newPage();
    }

    shared.page.setDefaultTimeout(cfg.timeoutMs || 30000);

    // 页面触发的浏览器下载 → 统一进下载目录
    shared.page.on('download', async (download) => {
      try {
        const suggested = download.suggestedFilename() || `download-${Date.now()}`;
        const safe = String(suggested).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
        let dest = path.join(dlRoot, safe);
        if (require('fs').existsSync(dest)) {
          const ext = path.extname(safe);
          const stem = path.basename(safe, ext);
          dest = path.join(dlRoot, `${stem}_${Date.now()}${ext}`);
        }
        await download.saveAs(dest);
        bs.logAction('browser.download', {
          path: dest,
          url: download.url(),
          filename: safe
        });
      } catch (err) {
        bs.logAction('browser.download_error', {
          error: err.message || String(err)
        });
      }
    });

    if (stealthEnabled()) {
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

    await bindPageListeners(shared.page);
    bs.logAction('browser.launch', {
      headless,
      stealth: stealthEnabled(),
      keepSession,
      executablePath: launchOpts.executablePath || launchOpts.channel || 'bundled'
    });
    return shared.page;
  }

  async function resolveLocator(p, args) {
    if (args.selector) return p.locator(args.selector).first();
    if (args.text) return p.getByText(args.text, { exact: false }).first();
    throw new Error('需要提供 selector 或 text');
  }

  async function withStep(name, args, fn) {
    const t0 = Date.now();
    bs.logAction('tool.start', { name, args: sanitizeArgs(name, args) });
    try {
      const result = await fn();
      bs.logAction('tool.end', {
        name,
        ok: true,
        ms: Date.now() - t0,
        result: sanitizeResult(name, result)
      });
      return result;
    } catch (err) {
      bs.logAction('tool.end', {
        name,
        ok: false,
        ms: Date.now() - t0,
        error: err.message || String(err)
      });
      throw err;
    }
  }

  function sanitizeArgs(name, args) {
    const a = { ...(args || {}) };
    if (name === 'browser_type' || name === 'browser_fill_form') {
      if (a.text != null) a.text = maskText(a.text, a.selector);
      if (Array.isArray(a.fields)) {
        a.fields = a.fields.map((f) => ({
          selector: f.selector,
          value: maskText(f.value, f.selector)
        }));
      }
    }
    return a;
  }

  function sanitizeResult(name, result) {
    if (!result || typeof result !== 'object') return result;
    const r = { ...result };
    if (typeof r.text === 'string' && r.text.length > 200) r.text = r.text.slice(0, 200) + '…';
    if (typeof r.html === 'string' && r.html.length > 200) r.html = r.html.slice(0, 200) + '…';
    return r;
  }

  const tools = {
    async browser_state() {
      return withStep('browser_state', {}, async () => bs.getState());
    },

    async browser_navigate(args) {
      return withStep('browser_navigate', args, async () => {
        const p = await ensurePage();
        const waitUntil = args.waitUntil || 'domcontentloaded';
        await p.goto(args.url, { waitUntil, timeout: cfg.timeoutMs || 30000 });
        const out = { url: p.url(), title: await p.title(), keptSession: true };
        bs.logAction('page.loaded', out);
        return out;
      });
    },

    async browser_click(args) {
      return withStep('browser_click', args, async () => {
        const p = await ensurePage();
        const loc = await resolveLocator(p, args);
        await loc.click({ timeout: args.timeoutMs || cfg.timeoutMs || 30000 });
        const out = { ok: true, url: p.url() };
        bs.logAction('page.click.agent', {
          selector: args.selector,
          text: args.text,
          url: out.url
        });
        return out;
      });
    },

    async browser_type(args) {
      return withStep('browser_type', args, async () => {
        const p = await ensurePage();
        const loc = p.locator(args.selector).first();
        if (args.clear) await loc.fill('');
        await loc.fill(args.text);
        if (args.pressEnter) await loc.press('Enter');
        bs.logAction('page.type.agent', {
          selector: args.selector,
          text: maskText(args.text, args.selector),
          pressEnter: !!args.pressEnter
        });
        return { ok: true, url: p.url() };
      });
    },

    async browser_fill_form(args) {
      return withStep('browser_fill_form', args, async () => {
        const p = await ensurePage();
        const results = [];
        for (const field of args.fields || []) {
          await p.locator(field.selector).first().fill(String(field.value));
          results.push({ selector: field.selector, ok: true });
          bs.logAction('page.fill.agent', {
            selector: field.selector,
            value: maskText(field.value, field.selector)
          });
        }
        return { filled: results.length, results, url: p.url() };
      });
    },

    async browser_get_text(args) {
      return withStep('browser_get_text', args, async () => {
        const p = await ensurePage();
        if (args.selector) {
          const text = await p.locator(args.selector).first().innerText();
          return { text: text.slice(0, 100000), url: p.url() };
        }
        const text = await p.locator('body').innerText();
        return { text: text.slice(0, 100000), url: p.url(), title: await p.title() };
      });
    },

    async browser_get_html(args) {
      return withStep('browser_get_html', args, async () => {
        const p = await ensurePage();
        if (args.selector) {
          const html = await p.locator(args.selector).first().innerHTML();
          return { html: html.slice(0, 200000), url: p.url() };
        }
        const html = await p.content();
        return { html: html.slice(0, 200000), url: p.url() };
      });
    },

    async get_screenshot_dir() {
      const dir = resolveScreenshotDir(cfg, userDataPath);
      await fsp.mkdir(dir, { recursive: true });
      return { dir, message: `截图目录: ${dir}` };
    },

    async browser_screenshot(args) {
      return withStep('browser_screenshot', args, async () => {
        const p = await ensurePage();
        const dir = resolveScreenshotDir(cfg, userDataPath);
        await fsp.mkdir(dir, { recursive: true });
        const file = args.path
          ? path.isAbsolute(args.path)
            ? args.path
            : path.join(dir, args.path)
          : path.join(dir, `shot-${Date.now()}.png`);
        await fsp.mkdir(path.dirname(path.resolve(file)), { recursive: true });
        await p.screenshot({ path: file, fullPage: !!args.fullPage });
        const abs = path.resolve(file);
        const out = {
          ok: true,
          path: abs,
          dir,
          url: p.url(),
          message: `截图已保存: ${abs}`
        };
        bs.logAction('page.screenshot', out);
        return out;
      });
    },

    async browser_wait(args) {
      return withStep('browser_wait', args, async () => {
        const p = await ensurePage();
        if (args.selector) {
          await p.waitForSelector(args.selector, {
            timeout: args.timeoutMs || cfg.timeoutMs || 30000
          });
          return { ok: true, waited: 'selector', selector: args.selector, url: p.url() };
        }
        const ms = args.ms || 1000;
        await p.waitForTimeout(ms);
        return { ok: true, waited: 'ms', ms, url: p.url() };
      });
    },

    async browser_evaluate(args) {
      return withStep('browser_evaluate', args, async () => {
        const p = await ensurePage();
        const result = await p.evaluate((expr) => {
          // eslint-disable-next-line no-eval
          return eval(expr);
        }, args.expression);
        let out = result;
        try {
          out = JSON.parse(JSON.stringify(result));
        } catch (_) {
          out = String(result);
        }
        return { result: out, url: p.url() };
      });
    },

    async browser_close() {
      return withStep('browser_close', {}, async () => bs.closeAll());
    }
  };

  // 配置重载时：默认不关浏览器（keepSession）
  tools._shutdown = async () => {
    if (!keepSession) await bs.closeAll();
  };

  tools._forceShutdown = async () => {
    await bs.closeAll();
  };

  return tools;
}

module.exports = { createBrowserTools, resolveScreenshotDir };
