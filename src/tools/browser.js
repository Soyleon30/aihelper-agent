const path = require('path');
const fsp = require('fs').promises;
const bs = require('./browser-session');
const {
  resolveDownloadRoot,
  pickDownloadFilename,
  uniquePath,
  ensureDir
} = require('./download-path');

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

function resolveBrowserDownloadDir(cfg, userDataPath) {
  return resolveDownloadRoot(cfg && cfg.downloadDir, userDataPath);
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

  function flowsDir() {
    return path.join(userDataPath || process.cwd(), 'flows');
  }

  function appendRecordFromPage(event, data, url) {
    const shared = bs.getShared();
    const rec = shared.recording;
    if (!rec || !rec.active) return;
    const now = Date.now();
    const waitMs = rec.lastAt ? Math.min(Math.max(now - rec.lastAt, 0), 15000) : 0;
    rec.lastAt = now;
    const target = (data && data.target) || {};
    if (event === 'page.click') {
      const text = target.text || '';
      const selector = target.selector || '';
      const step = {
        action: 'click',
        text: text || undefined,
        selector: selector || undefined,
        url,
        waitBeforeMs: waitMs > 300 ? waitMs : undefined,
        t: new Date(now).toISOString()
      };
      if (!step.text && !step.selector) return;
      const last = rec.steps[rec.steps.length - 1];
      if (
        last &&
        last.action === 'click' &&
        last.selector === step.selector &&
        last.text === step.text &&
        now - new Date(last.t).getTime() < 400
      ) {
        return;
      }
      rec.steps.push(step);
      return;
    }
    if (event === 'page.input') {
      const selector = target.selector || '';
      const value = data.rawValue != null ? String(data.rawValue) : String(data.value || '');
      if (!selector) return;
      const step = {
        action: 'type',
        selector,
        text: value,
        clear: true,
        url,
        placeholder: target.placeholder,
        waitBeforeMs: waitMs > 300 ? waitMs : undefined,
        t: new Date(now).toISOString()
      };
      const last = rec.steps[rec.steps.length - 1];
      if (last && last.action === 'type' && last.selector === selector) {
        last.text = value;
        last.t = step.t;
        return;
      }
      rec.steps.push(step);
      return;
    }
    if (event === 'page.key' && data.key === 'Enter') {
      const last = rec.steps[rec.steps.length - 1];
      if (last && last.action === 'type') last.pressEnter = true;
      return;
    }
    if (event === 'page.navigate' || event === 'page.loaded') {
      const u = (data && (data.url || data)) || url;
      if (!u || typeof u !== 'string') return;
      const last = rec.steps[rec.steps.length - 1];
      if (last && last.action === 'navigate' && last.url === u) return;
      if (rec.steps.length === 0 || (last && last.action !== 'navigate')) {
        rec.steps.push({
          action: 'navigate',
          url: u,
          t: new Date(now).toISOString()
        });
      }
    }
  }

  function suggestVariables(steps) {
    const vars = {};
    let i = 1;
    for (const s of steps) {
      if (s.action !== 'type' || s.text == null || s.text === '') continue;
      const keyBase =
        (s.placeholder && String(s.placeholder).replace(/[^\w\u4e00-\u9fff]+/g, '_').slice(0, 24)) ||
        `input_${i}`;
      let key = keyBase || `var_${i}`;
      if (vars[key] != null && vars[key] !== s.text) key = `${keyBase}_${i}`;
      vars[key] = s.text;
      s.text = `{{${key}}}`;
      s.var = key;
      i += 1;
    }
    return vars;
  }

  function applyVars(val, vars) {
    if (val == null) return val;
    let s = String(val);
    const map = vars || {};
    s = s.replace(/\{\{\s*([\w.\u4e00-\u9fff-]+)\s*\}\}/g, (_, k) =>
      map[k] != null ? String(map[k]) : `{{${k}}}`
    );
    return s;
  }

  async function runFlowSteps(p, steps, vars) {
    const results = [];
    for (let idx = 0; idx < steps.length; idx++) {
      const raw = steps[idx] || {};
      const step = {
        ...raw,
        text: applyVars(raw.text, vars),
        selector: applyVars(raw.selector, vars),
        url: applyVars(raw.url, vars)
      };
      const waitMs = step.waitBeforeMs || step.waitMs || (step.action === 'navigate' ? 0 : 400);
      if (waitMs > 0) {
        try {
          await p.waitForTimeout(Math.min(waitMs, 20000));
        } catch (_) {}
      }
      try {
        if (step.action === 'navigate' && step.url) {
          await p.goto(step.url, {
            waitUntil: step.waitUntil || 'domcontentloaded',
            timeout: cfg.timeoutMs || 30000
          });
          results.push({ i: idx, action: 'navigate', ok: true, url: p.url() });
        } else if (step.action === 'click') {
          const r = await robustClick(p, {
            selector: step.selector,
            text: step.text,
            timeoutMs: step.timeoutMs || cfg.timeoutMs || 30000,
            force: step.force
          });
          results.push({ i: idx, action: 'click', ok: true, method: r.method, url: p.url() });
        } else if (step.action === 'type') {
          const loc = p.locator(step.selector).first();
          if (step.clear !== false) await loc.fill('');
          await loc.fill(String(step.text ?? ''));
          if (step.pressEnter) await loc.press('Enter');
          results.push({ i: idx, action: 'type', ok: true, url: p.url() });
        } else if (step.action === 'wait') {
          if (step.selector) {
            await p.waitForSelector(step.selector, {
              timeout: step.timeoutMs || cfg.timeoutMs || 30000
            });
          } else {
            await p.waitForTimeout(step.ms || 1000);
          }
          results.push({ i: idx, action: 'wait', ok: true });
        } else if (step.action === 'screenshot') {
          const dir = resolveScreenshotDir(cfg, userDataPath);
          await fsp.mkdir(dir, { recursive: true });
          const file = path.join(dir, step.path || `flow-${Date.now()}-${idx}.png`);
          await p.screenshot({ path: file, fullPage: !!step.fullPage });
          results.push({ i: idx, action: 'screenshot', ok: true, path: file });
        } else {
          results.push({ i: idx, action: step.action || 'unknown', ok: false, error: 'unknown action' });
        }
      } catch (err) {
        results.push({
          i: idx,
          action: step.action,
          ok: false,
          error: err.message || String(err),
          url: p.url()
        });
        if (step.continueOnError) continue;
        return { ok: false, stoppedAt: idx, results, url: p.url() };
      }
    }
    return { ok: true, results, url: p.url() };
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
    const launchOpts = {
      headless,
      args: buildLaunchArgs(),
      ignoreDefaultArgs: stealthEnabled() ? ['--enable-automation'] : undefined
    };

    const preferSystem = cfg.preferSystemBrowser !== false;
    bs.ensurePlaywrightBrowsersEnv();
    const localChrome = bs.findLocalBrowser({ preferSystem });
    if (localChrome) launchOpts.executablePath = localChrome;
    else if (cfg.channel) launchOpts.channel = cfg.channel;

    const ua =
      cfg.userAgent ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

    const dlRoot = resolveBrowserDownloadDir(cfg, userDataPath);
    try {
      ensureDir(dlRoot);
    } catch (_) {}
    shared.downloadDir = dlRoot;
    if (!Array.isArray(shared.recentDownloads)) shared.recentDownloads = [];
    if (!Array.isArray(shared.downloadWaiters)) shared.downloadWaiters = [];

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
      // Playwright 将浏览器下载落到此目录；再 saveAs 到最终文件名（修复中文）
      downloadsPath: dlRoot,
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

    // 所有标签页的下载：context 级挂接（新开页也能捕获）
    bindContextDownloads(shared.context, dlRoot);

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
      stealth: stealthEnabled(),
      keepSession,
      downloadDir: dlRoot,
      executablePath: launchOpts.executablePath || launchOpts.channel || 'bundled'
    });
    return shared.page;
  }

  function bindContextDownloads(context, dlRoot) {
    if (!context || context.__aihelperDlBound) return;
    context.__aihelperDlBound = true;

    const onDownload = async (download) => {
      const url = (() => {
        try {
          return download.url();
        } catch {
          return '';
        }
      })();
      const suggestedRaw = (() => {
        try {
          return download.suggestedFilename() || '';
        } catch {
          return '';
        }
      })();
      try {
        ensureDir(dlRoot);
        const safe =
          pickDownloadFilename({ suggested: suggestedRaw, url }) ||
          `download-${Date.now()}`;
        const dest = uniquePath(dlRoot, safe);
        await download.saveAs(dest);
        let size = 0;
        try {
          size = require('fs').statSync(dest).size;
        } catch (_) {}
        const rec = {
          ok: true,
          path: dest,
          filename: path.basename(dest),
          url,
          suggestedRaw,
          size,
          at: new Date().toISOString()
        };
        bs.pushDownloadRecord(rec);
        bs.logAction('browser.download', rec);
      } catch (err) {
        const rec = {
          ok: false,
          path: '',
          filename: suggestedRaw || '',
          url,
          suggestedRaw,
          error: err.message || String(err),
          at: new Date().toISOString()
        };
        bs.pushDownloadRecord(rec);
        bs.logAction('browser.download_error', rec);
      }
    };

    const attachPage = (pg) => {
      if (!pg || pg.__aihelperDlPage) return;
      pg.__aihelperDlPage = true;
      pg.on('download', onDownload);
    };

    try {
      for (const pg of context.pages()) attachPage(pg);
    } catch (_) {}
    context.on('page', attachPage);
  }

  async function applyCdpDownloadBehavior(context, page, dlRoot) {
    try {
      ensureDir(dlRoot);
      const client = await context.newCDPSession(page);
      // Chromium/Edge：允许下载并指定路径（Playwright 仍会再 saveAs）
      await client.send('Browser.setDownloadBehavior', {
        behavior: 'allowAndName',
        downloadPath: dlRoot,
        eventsEnabled: true
      }).catch(async () => {
        await client.send('Page.setDownloadBehavior', {
          behavior: 'allow',
          downloadPath: dlRoot
        });
      });
    } catch (err) {
      bs.logAction('browser.cdp_download_warn', {
        error: (err && err.message) || String(err),
        downloadDir: dlRoot
      });
    }
  }

  async function resolveLocator(p, args) {
    if (args.selector) return p.locator(args.selector).first();
    if (args.text) return p.getByText(args.text, { exact: false }).first();
    throw new Error('需要提供 selector 或 text');
  }

  async function pickVisibleLocator(p, args) {
    const text = args.text != null ? String(args.text) : '';
    const selector = args.selector != null ? String(args.selector) : '';
    const candidates = [];

    if (selector) {
      candidates.push(p.locator(selector));
    }
    if (text) {
      candidates.push(p.getByRole('button', { name: text, exact: false }));
      candidates.push(p.getByRole('link', { name: text, exact: false }));
      candidates.push(p.locator('button, a, [role="button"]').filter({ hasText: text }));
      candidates.push(p.getByText(text, { exact: true }));
      candidates.push(p.getByText(text, { exact: false }));
    }
    if (!candidates.length) throw new Error('需要提供 selector 或 text');

    for (const base of candidates) {
      let count = 0;
      try {
        count = await base.count();
      } catch (_) {
        continue;
      }
      const limit = Math.min(count, 30);
      for (let i = 0; i < limit; i++) {
        const item = base.nth(i);
        try {
          if (await item.isVisible()) return item;
        } catch (_) {}
      }
    }
    return resolveLocator(p, args);
  }

  async function jsClickFallback(p, args) {
    const text = args.text != null ? String(args.text) : '';
    const selector = args.selector != null ? String(args.selector) : '';
    return p.evaluate(
      ({ selector: sel, text: txt }) => {
        function isVisible(el) {
          if (!el || !(el instanceof Element)) return false;
          const st = window.getComputedStyle(el);
          if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) {
            return false;
          }
          const r = el.getBoundingClientRect();
          if (r.width < 1 || r.height < 1) return false;
          if (el.closest && el.closest('.is-hidden, [aria-hidden="true"]')) {
            const hid = el.closest('.is-hidden, [aria-hidden="true"]');
            if (hid && hid !== el) {
              const hs = window.getComputedStyle(hid);
              if (hs.display === 'none' || hid.classList.contains('is-hidden')) return false;
            }
          }
          return true;
        }
        function clickEl(el) {
          if (!el) return false;
          const target =
            (el.closest && (el.closest('button, a, [role="button"]') || el)) || el;
          try {
            target.scrollIntoView({ block: 'center', inline: 'nearest' });
          } catch (_) {}
          try {
            target.click();
            return true;
          } catch (_) {
            try {
              target.dispatchEvent(
                new MouseEvent('click', { bubbles: true, cancelable: true, view: window })
              );
              return true;
            } catch (__) {
              return false;
            }
          }
        }
        if (sel) {
          const list = Array.from(document.querySelectorAll(sel));
          const vis = list.find(isVisible) || list[0];
          if (clickEl(vis)) return { ok: true, via: 'selector' };
        }
        if (txt) {
          const nodes = Array.from(
            document.querySelectorAll('button, a, [role="button"], span, div, li, em')
          );
          const matched = nodes.filter((el) => (el.textContent || '').trim() === txt);
          const loose = nodes.filter((el) => (el.textContent || '').trim().includes(txt));
          for (const pool of [matched, loose]) {
            const vis = pool.filter(isVisible);
            if (vis.length && clickEl(vis[0])) return { ok: true, via: 'text-visible' };
            if (pool.length && clickEl(pool[pool.length - 1])) {
              return { ok: true, via: 'text-last' };
            }
          }
        }
        return { ok: false, error: 'jsClick: element not found' };
      },
      { selector, text }
    );
  }

  async function robustClick(p, args) {
    const timeout = args.timeoutMs || cfg.timeoutMs || 30000;
    const force = args.force === true;
    const noForce = args.force === false;
    let lastErr = null;

    try {
      const loc = await pickVisibleLocator(p, args);
      await loc.click({ timeout: Math.min(timeout, 8000), force: force || false });
      return { ok: true, method: force ? 'visible-force' : 'visible' };
    } catch (err) {
      lastErr = err;
    }

    if (!noForce) {
      try {
        const loc = await resolveLocator(p, args);
        await loc.click({ timeout: Math.min(timeout, 5000), force: true });
        return { ok: true, method: 'force' };
      } catch (err) {
        lastErr = err;
      }
    }

    try {
      const js = await jsClickFallback(p, args);
      if (js && js.ok) return { ok: true, method: 'js', via: js.via };
      lastErr = new Error((js && js.error) || 'js click failed');
    } catch (err) {
      lastErr = err;
    }

    throw lastErr || new Error('click failed');
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
      return withStep('browser_state', {}, async () => {
        const shared = bs.getShared();
        shared.downloadDir = resolveBrowserDownloadDir(cfg, userDataPath);
        return bs.getState();
      });
    },

    async browser_navigate(args) {
      return withStep('browser_navigate', args, async () => {
        const p = await ensurePage();
        const waitUntil = args.waitUntil || 'domcontentloaded';
        await p.goto(args.url, { waitUntil, timeout: cfg.timeoutMs || 30000 });
        const out = {
          url: p.url(),
          title: await p.title(),
          keptSession: true,
          downloadDir: bs.getShared().downloadDir || '',
          visible: cfg.headless !== true
        };
        bs.logAction('page.loaded', out);
        return out;
      });
    },

    async browser_click(args) {
      return withStep('browser_click', args, async () => {
        const p = await ensurePage();
        const waitDl = args.waitDownload === true;
        const dlTimeout = args.downloadTimeoutMs || 60000;
        let dlPromise = null;
        if (waitDl) {
          dlPromise = bs.waitNextDownload(dlTimeout);
        }
        const r = await robustClick(p, args);
        const out = {
          ok: true,
          method: r.method,
          via: r.via,
          url: p.url(),
          title: await p.title().catch(() => '')
        };
        if (waitDl && dlPromise) {
          try {
            out.download = await dlPromise;
          } catch (err) {
            out.download = { ok: false, error: err.message || String(err) };
          }
        }
        bs.logAction('page.click.agent', {
          selector: args.selector,
          text: args.text,
          method: r.method,
          url: out.url,
          download: out.download || null
        });
        return out;
      });
    },

    async browser_wait_download(args) {
      return withStep('browser_wait_download', args, async () => {
        await ensurePage();
        const timeoutMs = args.timeoutMs || 60000;
        try {
          const rec = await bs.waitNextDownload(timeoutMs);
          return { ok: !!rec.ok, ...rec, downloadDir: bs.getShared().downloadDir || '' };
        } catch (err) {
          return {
            ok: false,
            error: err.message || String(err),
            downloadDir: bs.getShared().downloadDir || '',
            recentDownloads: (bs.getShared().recentDownloads || []).slice(-5)
          };
        }
      });
    },

    async browser_list_downloads(args) {
      return withStep('browser_list_downloads', args, async () => {
        const shared = bs.getShared();
        const limit = Math.min(50, Math.max(1, Number(args.limit) || 20));
        const list = (shared.recentDownloads || []).slice(-limit).reverse();
        return {
          ok: true,
          downloadDir: shared.downloadDir || resolveBrowserDownloadDir(cfg, userDataPath),
          count: list.length,
          downloads: list
        };
      });
    },

    async browser_record_start(args) {
      return withStep('browser_record_start', args, async () => {
        const p = await ensurePage();
        const shared = bs.getShared();
        const name = String((args && args.name) || `flow-${Date.now()}`).replace(
          /[<>:"/\\|?*\x00-\x1f]/g,
          '_'
        );
        shared.recording = {
          active: true,
          name,
          startedAt: new Date().toISOString(),
          lastAt: Date.now(),
          startUrl: p.url(),
          steps: []
        };
        if (p.url() && p.url() !== 'about:blank') {
          shared.recording.steps.push({
            action: 'navigate',
            url: p.url(),
            t: shared.recording.startedAt
          });
        }
        bs.logAction('record.start', { name, url: p.url() });
        return {
          ok: true,
          recording: true,
          name,
          url: p.url(),
          message:
            '已开始录制：请在浏览器中手动点击/输入；完成后调用 browser_record_stop。可变内容会标成 {{变量}}。'
        };
      });
    },

    async browser_record_stop(args) {
      return withStep('browser_record_stop', args, async () => {
        const shared = bs.getShared();
        const rec = shared.recording;
        if (!rec || !rec.active) {
          return { ok: false, error: '当前没有进行中的录制，请先 browser_record_start' };
        }
        rec.active = false;
        const steps = rec.steps.slice();
        const autoVars = args && args.detectVariables === false ? {} : suggestVariables(steps);
        const userVars = (args && args.variables) || {};
        const variables = { ...autoVars, ...userVars };
        for (const s of steps) {
          if (s.action === 'type' && s.var && userVars[s.var] != null) {
            s.text = `{{${s.var}}}`;
          }
        }
        const dir = flowsDir();
        await fsp.mkdir(dir, { recursive: true });
        const fileName = `${rec.name}.json`;
        const filePath = args && args.path
          ? path.isAbsolute(args.path)
            ? args.path
            : path.join(dir, args.path)
          : path.join(dir, fileName);
        await fsp.mkdir(path.dirname(filePath), { recursive: true });
        const flow = {
          name: rec.name,
          version: 1,
          recordedAt: rec.startedAt,
          stoppedAt: new Date().toISOString(),
          startUrl: rec.startUrl,
          variables,
          variableHints: Object.keys(variables).map((k) => ({
            name: k,
            example: variables[k],
            description: '回放时传入 vars 覆盖'
          })),
          steps
        };
        await fsp.writeFile(filePath, JSON.stringify(flow, null, 2), 'utf8');
        shared.recording = null;
        bs.logAction('record.stop', { name: rec.name, path: filePath, steps: steps.length });
        return {
          ok: true,
          path: path.resolve(filePath),
          name: rec.name,
          steps: steps.length,
          variables,
          message: `录制已保存: ${path.resolve(filePath)}。回放: browser_flow_run path/name + vars`
        };
      });
    },

    async browser_record_status() {
      return withStep('browser_record_status', {}, async () => {
        const rec = bs.getShared().recording;
        if (!rec) return { recording: false };
        return {
          recording: !!rec.active,
          name: rec.name,
          steps: (rec.steps || []).length,
          startedAt: rec.startedAt,
          startUrl: rec.startUrl,
          lastSteps: (rec.steps || []).slice(-5)
        };
      });
    },

    async browser_flow_list() {
      return withStep('browser_flow_list', {}, async () => {
        const dir = flowsDir();
        await fsp.mkdir(dir, { recursive: true });
        const names = await fsp.readdir(dir);
        const items = [];
        for (const n of names) {
          if (!/\.json$/i.test(n)) continue;
          const full = path.join(dir, n);
          try {
            const raw = JSON.parse(await fsp.readFile(full, 'utf8'));
            items.push({
              name: raw.name || n.replace(/\.json$/i, ''),
              path: full,
              steps: Array.isArray(raw.steps) ? raw.steps.length : 0,
              variables: raw.variables ? Object.keys(raw.variables) : [],
              recordedAt: raw.recordedAt
            });
          } catch (_) {
            items.push({ name: n, path: full, error: 'invalid json' });
          }
        }
        return { dir, count: items.length, items };
      });
    },

    async browser_flow_run(args) {
      return withStep('browser_flow_run', args, async () => {
        const p = await ensurePage();
        let filePath = args && args.path ? String(args.path) : '';
        const name = args && args.name ? String(args.name) : '';
        if (!filePath && name) {
          filePath = path.join(flowsDir(), name.endsWith('.json') ? name : `${name}.json`);
        }
        if (!filePath) throw new Error('需要 path 或 name 指定流程文件');
        if (!path.isAbsolute(filePath)) filePath = path.join(flowsDir(), filePath);
        const raw = JSON.parse(await fsp.readFile(filePath, 'utf8'));
        const steps = Array.isArray(raw.steps) ? raw.steps : [];
        const vars = { ...(raw.variables || {}), ...((args && args.vars) || {}) };
        bs.logAction('flow.run', { path: filePath, steps: steps.length, vars: Object.keys(vars) });
        const out = await runFlowSteps(p, steps, vars);
        return {
          ...out,
          path: path.resolve(filePath),
          name: raw.name,
          varsUsed: vars,
          message: out.ok
            ? `流程回放完成: ${raw.name || filePath}`
            : `流程在第 ${out.stoppedAt} 步失败`
        };
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
