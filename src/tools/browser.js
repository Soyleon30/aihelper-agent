const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const crypto = require('crypto');
const fetch = require('node-fetch');
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

    const dlRoot = resolveBrowserDownloadDir(cfg, userDataPath);
    try {
      ensureDir(dlRoot);
    } catch (_) {}
    shared.downloadDir = dlRoot;
    if (!Array.isArray(shared.recentDownloads)) shared.recentDownloads = [];
    if (!Array.isArray(shared.downloadWaiters)) shared.downloadWaiters = [];

    // downloadsPath 必须在 launch / launchPersistentContext 上（写在 newContext 无效 → 会落到 %TEMP%/playwright-artifacts）
    const launchOpts = {
      headless,
      args: buildLaunchArgs(),
      ignoreDefaultArgs: stealthEnabled() ? ['--enable-automation'] : undefined,
      downloadsPath: dlRoot
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
      userDataDir: shared.userDataDir || '',
      ephemeral: !!shared.ephemeral,
      browserName: shared.browserName,
      executablePath: launchOpts.executablePath || launchOpts.channel || 'bundled',
      chromeInstalled: !!bs.findSystemChrome(),
      edgeInstalled: !!bs.findSystemEdge()
    });
    return shared.page;
  }

  function bindContextDownloads(context, dlRoot) {
    if (!context || context.__aihelperDlBound) return;
    context.__aihelperDlBound = true;
    const fsSync = require('fs');

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
      // 勿 unlink Playwright artifact：Edge/Chrome 下载栏仍指向临时路径，删了会显示「已删除」
      // 最终文件以 saveAs 到 dlRoot 为准
      let artifactPath = '';
      try {
        artifactPath = (await download.path()) || '';
      } catch (_) {
        artifactPath = '';
      }
      try {
        ensureDir(dlRoot);
        const safe =
          pickDownloadFilename({ suggested: suggestedRaw, url }) ||
          `download-${Date.now()}`;
        const dest = uniquePath(dlRoot, safe);
        await download.saveAs(dest);
        // 中间可能是 UUID 文件名：删掉与 dest 不同的 artifact，只保留真实文件名
        if (artifactPath && path.resolve(artifactPath) !== path.resolve(dest)) {
          try {
            if (fsSync.existsSync(artifactPath)) fsSync.unlinkSync(artifactPath);
          } catch (_) {}
        }
        // 清掉下载目录里残留的纯 UUID 文件（无扩展名）
        try {
          for (const name of fsSync.readdirSync(dlRoot)) {
            if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name)) {
              const p = path.join(dlRoot, name);
              if (path.resolve(p) !== path.resolve(dest)) {
                try {
                  fsSync.unlinkSync(p);
                } catch (_) {}
              }
            }
          }
        } catch (_) {}
        let size = 0;
        try {
          size = fsSync.statSync(dest).size;
        } catch (_) {}
        if (!size) throw new Error('saveAs 后文件为空或不存在: ' + dest);
        const rec = {
          ok: true,
          path: dest,
          filename: path.basename(dest),
          url,
          suggestedRaw,
          size,
          downloadDir: dlRoot,
          at: new Date().toISOString()
        };
        bs.pushDownloadRecord(rec);
        bs.logAction('browser.download', rec);
      } catch (err) {
        let recovered = '';
        try {
          if (artifactPath && fsSync.existsSync(artifactPath)) {
            ensureDir(dlRoot);
            const safe =
              pickDownloadFilename({ suggested: suggestedRaw, url }) ||
              `download-${Date.now()}`;
            recovered = uniquePath(dlRoot, safe);
            fsSync.copyFileSync(artifactPath, recovered);
          }
        } catch (_) {
          recovered = '';
        }
        if (recovered) {
          let size = 0;
          try {
            size = fsSync.statSync(recovered).size;
          } catch (_) {}
          const rec = {
            ok: true,
            path: recovered,
            filename: path.basename(recovered),
            url,
            suggestedRaw,
            size,
            recoveredFrom: artifactPath || '',
            downloadDir: dlRoot,
            at: new Date().toISOString()
          };
          bs.pushDownloadRecord(rec);
          bs.logAction('browser.download', rec);
          return;
        }
        const rec = {
          ok: false,
          path: '',
          filename: suggestedRaw || '',
          url,
          suggestedRaw,
          error: err.message || String(err),
          artifactPath: artifactPath || '',
          downloadDir: dlRoot,
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
      // allow：落到 downloadPath；不要用 allowAndName（会变成 UUID 文件名，像 playwright-artifacts）
      const tryCdp = async (method, params) => client.send(method, params);
      try {
        await tryCdp('Browser.setDownloadBehavior', {
          behavior: 'allow',
          downloadPath: dlRoot,
          eventsEnabled: true
        });
      } catch (_) {
        await tryCdp('Page.setDownloadBehavior', {
          behavior: 'allow',
          downloadPath: dlRoot
        });
      }
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

  function looksLikeFileUrl(u) {
    const s = String(u || '');
    if (!/^https?:\/\//i.test(s)) return false;
    // 业务常见：导出/附件/下载接口（路径无扩展名也算）
    if (
      /\/th\/id\/|\/download\/|\/file\/|\/export\/|\/attach|attachment|getfile|downloadfile|exportfile|downfile|filedownload/i.test(
        s
      )
    ) {
      return true;
    }
    try {
      const p = new URL(s).pathname.toLowerCase();
      return /\.(pdf|zip|rar|7z|tar|tgz|gz|bz2|xz|doc|docx|xls|xlsx|xlsm|ppt|pptx|csv|tsv|txt|json|xml|jpe?g|jfif|png|gif|webp|bmp|svg|mp[34]|wav|avi|mkv|exe|msi|dmg|iso|apk|log|sql|dat)(\?|$)/i.test(
        p
      );
    } catch {
      return false;
    }
  }

  function isDownloadResponse(res) {
    try {
      const headers = res.headers();
      const cd = String(headers['content-disposition'] || headers['Content-Disposition'] || '');
      // 标准文件下载：Content-Disposition: attachment; filename=...
      if (/attachment|filename\s*=/i.test(cd)) return true;
      const ct = String(headers['content-type'] || headers['Content-Type'] || '').toLowerCase();
      if (!ct) return looksLikeFileUrl(res.url());
      if (
        ct.includes('text/html') ||
        ct.includes('text/css') ||
        ct.includes('javascript') ||
        ct.includes('application/json') && !/attachment|filename/i.test(cd)
      ) {
        // json 接口体一般不是文件；除非带 attachment
        if (ct.includes('application/json') && !/attachment|filename/i.test(cd)) return false;
        if (ct.includes('text/html') || ct.includes('text/css') || ct.includes('javascript')) {
          return false;
        }
      }
      if (
        ct.startsWith('image/') ||
        ct.startsWith('audio/') ||
        ct.startsWith('video/') ||
        ct.includes('application/pdf') ||
        ct.includes('application/zip') ||
        ct.includes('application/x-zip') ||
        ct.includes('application/gzip') ||
        ct.includes('application/x-gzip') ||
        ct.includes('application/x-tar') ||
        ct.includes('application/x-gtar') ||
        ct.includes('application/x-bzip') ||
        ct.includes('application/x-xz') ||
        ct.includes('application/octet-stream') ||
        ct.includes('application/force-download') ||
        ct.includes('application/msword') ||
        ct.includes('application/vnd.ms-excel') ||
        ct.includes('spreadsheet') ||
        ct.includes('officedocument') ||
        ct.includes('application/vnd.openxmlformats')
      ) {
        return true;
      }
      return looksLikeFileUrl(res.url());
    } catch {
      return false;
    }
  }

  async function extractHrefFromTarget(p, args) {
    return p.evaluate(
      ({ selector: sel, text: txt }) => {
        function abs(u) {
          try {
            return new URL(u, location.href).href;
          } catch {
            return '';
          }
        }
        function pickFrom(el) {
          if (!el) return null;
          const a =
            el.closest &&
            (el.closest('a[href]') ||
              el.closest('[data-url]') ||
              el.closest('[data-href]') ||
              el.closest('[data-src]') ||
              el.closest('[download]'));
          const node = a || el;
          const attrs = [
            'href',
            'data-url',
            'data-href',
            'data-src',
            'data-downloadurl',
            'data-file',
            'download'
          ];
          for (const k of attrs) {
            const v = node.getAttribute && node.getAttribute(k);
            if (v && /^(https?:|\/)/i.test(v)) return { url: abs(v), via: 'attr:' + k };
          }
          if (node.src && /^(https?:|\/)/i.test(node.src)) {
            return { url: abs(node.src), via: 'src' };
          }
          if (node.currentSrc) return { url: abs(node.currentSrc), via: 'currentSrc' };
          return null;
        }
        if (sel) {
          const el = document.querySelector(sel);
          const hit = pickFrom(el);
          if (hit) return hit;
        }
        if (txt) {
          const nodes = Array.from(
            document.querySelectorAll('a, button, img, [role="button"], [data-url], [href]')
          );
          const exact = nodes.filter((el) => (el.textContent || '').trim() === txt);
          const loose = nodes.filter((el) => (el.textContent || '').trim().includes(txt));
          for (const pool of [exact, loose]) {
            for (const el of pool) {
              const hit = pickFrom(el);
              if (hit) return hit;
            }
          }
        }
        return null;
      },
      { selector: args.selector || '', text: args.text || '' }
    );
  }

  async function savePlaywrightDownload(download, opts = {}) {
    const dlRoot = resolveBrowserDownloadDir(cfg, userDataPath);
    ensureDir(dlRoot);
    const fsSync = require('fs');
    let url = '';
    let suggestedRaw = '';
    try {
      url = download.url() || '';
    } catch (_) {}
    try {
      suggestedRaw = download.suggestedFilename() || '';
    } catch (_) {}
    const safe =
      opts.filename ||
      pickDownloadFilename({ suggested: suggestedRaw, url }) ||
      `download-${Date.now()}`;
    const dest = uniquePath(dlRoot, safe);
    await download.saveAs(dest);
    let size = 0;
    try {
      size = fsSync.statSync(dest).size;
    } catch (_) {}
    if (!size) throw new Error('saveAs 后文件为空: ' + dest);
    // 按内容补扩展名
    let finalPath = dest;
    try {
      const buf = fsSync.readFileSync(dest);
      const kind = sniffBinaryKind(buf);
      if (kind && kind !== 'html') {
        const want = kind === 'jpg' ? ['.jpg', '.jpeg', '.jfif'] : ['.' + kind];
        const cur = path.extname(dest).toLowerCase();
        if (!want.includes(cur)) {
          const next =
            dest.replace(/\.[^.]+$/, '') + (kind === 'jpg' ? '.jpg' : '.' + kind);
          const nextUnique = uniquePath(path.dirname(next), path.basename(next));
          fsSync.renameSync(dest, nextUnique);
          finalPath = nextUnique;
        }
      }
    } catch (_) {}
    const rec = {
      ok: true,
      path: finalPath,
      filename: path.basename(finalPath),
      url,
      suggestedRaw,
      size: fsSync.statSync(finalPath).size,
      downloadDir: dlRoot,
      via: 'playwright-saveAs',
      at: new Date().toISOString()
    };
    bs.pushDownloadRecord(rec);
    bs.logAction('browser.download', rec);
    return rec;
  }

  /**
   * 点击并捕获下载：优先 Playwright download 事件 saveAs（不 cancel！）
   * 同时记录网络里出现的文件 URL，供 HTTP 补下。
   */
  async function clickAndCaptureDownload(p, args = {}) {
    const timeoutMs = Math.max(5000, Number(args.timeoutMs) || 60000);
    const shared = bs.getShared();
    const context = shared.context;
    if (!context) return { ok: false, error: '浏览器未就绪' };

    // 先试 DOM href，无需点击
    if (args.selector || args.text) {
      const hrefHit = await extractHrefFromTarget(p, args).catch(() => null);
      if (hrefHit && hrefHit.url && /^https?:\/\//i.test(hrefHit.url)) {
        return {
          ok: true,
          url: hrefHit.url,
          method: 'dom-' + (hrefHit.via || 'href'),
          needHttp: true
        };
      }
    }

    let netUrl = '';
    let netMethod = '';
    const onRequest = (req) => {
      try {
        const u = req.url();
        if (looksLikeFileUrl(u) && !netUrl) {
          netUrl = u;
          netMethod = 'request';
        }
      } catch (_) {}
    };
    const onResponse = (res) => {
      try {
        if (isDownloadResponse(res) && !netUrl) {
          netUrl = res.url();
          netMethod = 'response';
        }
      } catch (_) {}
    };
    context.on('request', onRequest);
    context.on('response', onResponse);

    // 只等全局 page.on('download')→saveAs（bindContextDownloads），勿再 waitForEvent+saveAs 以免二次 saveAs 失败
    // 绝不能 cancel download
    const waiterPromise = bs.waitNextDownload(timeoutMs).catch(() => null);

    try {
      if (args.selector || args.text) {
        await robustClick(p, args);
      } else {
        return { ok: false, error: '需要 selector 或 text' };
      }

      const waited = await waiterPromise;
      if (waited && waited.ok && waited.path) {
        // 可选：用户指定了 filename 且与结果不同时不强制改名（已落盘）
        return { ok: true, method: 'playwright-download', saved: waited };
      }
      if (waited && waited.ok === false && netUrl && /^https?:\/\//i.test(netUrl)) {
        return { ok: true, url: netUrl, method: netMethod || 'network', needHttp: true };
      }
      if (netUrl && /^https?:\/\//i.test(netUrl)) {
        return { ok: true, url: netUrl, method: netMethod || 'network', needHttp: true };
      }
      return {
        ok: false,
        error:
          (waited && waited.error) ||
          '点击后未出现下载事件，也未拦截到文件 URL。请确认按钮会触发文件下载，或提供更精确的 selector',
        method: 'none'
      };
    } finally {
      try {
        context.off('request', onRequest);
        context.off('response', onResponse);
      } catch (_) {}
    }
  }

  async function resolveDownloadUrl(p, args = {}) {
    if (args.url && /^https?:\/\//i.test(String(args.url))) {
      return { url: String(args.url).trim(), method: 'given-url' };
    }
    if (args.selector || args.text) {
      const hrefHit = await extractHrefFromTarget(p, args).catch(() => null);
      if (hrefHit && hrefHit.url && /^https?:\/\//i.test(hrefHit.url)) {
        return { url: hrefHit.url, method: 'dom-' + (hrefHit.via || 'href') };
      }
    }
    if (args.click === false) {
      return { url: '', method: 'none', error: '未找到可下载链接（click=false）' };
    }
    const cap = await clickAndCaptureDownload(p, args);
    if (cap.saved && cap.saved.ok) {
      return {
        url: cap.saved.url || '',
        method: cap.method,
        saved: cap.saved,
        alreadySaved: true
      };
    }
    if (cap.url) return { url: cap.url, method: cap.method };
    return { url: '', method: 'none', error: cap.error || '未能解析下载地址' };
  }

  async function cookieHeaderForUrl(targetUrl) {
    const shared = bs.getShared();
    if (!shared.context) return '';
    try {
      const all = await shared.context.cookies(targetUrl);
      if (!all || !all.length) {
        const any = await shared.context.cookies();
        return (any || []).map((c) => `${c.name}=${c.value}`).join('; ');
      }
      return all.map((c) => `${c.name}=${c.value}`).join('; ');
    } catch {
      return '';
    }
  }

  function sniffBinaryKind(buf) {
    if (!buf || buf.length < 4) return '';
    if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
    if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';
    if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') {
      return 'webp';
    }
    if (buf.slice(0, 4).toString() === '%PDF') return 'pdf';
    // zip/xlsx/docx 都是 PK
    if (buf[0] === 0x50 && buf[1] === 0x4b) return 'zip';
    // gzip
    if (buf[0] === 0x1f && buf[1] === 0x8b) return 'gz';
    // ustar tar
    if (buf.length > 265 && buf.slice(257, 262).toString() === 'ustar') return 'tar';
    if (buf.slice(0, 5).toString() === 'GIF89' || buf.slice(0, 5).toString() === 'GIF87') {
      return 'gif';
    }
    const head = buf.slice(0, 64).toString('utf8').toLowerCase();
    if (head.includes('<!doctype') || head.includes('<html')) return 'html';
    return '';
  }

  async function fetchBytesViaContext(fileUrl, opts = {}) {
    const shared = bs.getShared();
    const context = shared.context;
    if (!context || !context.request) throw new Error('无 browser context.request');
    let pageUrl = '';
    try {
      pageUrl = (shared.page && shared.page.url()) || '';
    } catch (_) {}
    const headers = {
      Accept: 'image/avif,image/webp,image/apng,image/*,application/octet-stream,*/*;q=0.8',
      ...(opts.headers || {})
    };
    if (pageUrl && /^https?:/i.test(pageUrl) && pageUrl !== 'about:blank') {
      headers.Referer = pageUrl;
    } else if (/bing\.com|msn\.com/i.test(fileUrl)) {
      headers.Referer = 'https://www.bing.com/images/';
    }
    const res = await context.request.get(fileUrl, {
      headers,
      timeout: opts.timeoutMs || cfg.timeoutMs || 120000,
      maxRedirects: 10,
      failOnStatusCode: false
    });
    const status = res.status();
    if (status < 200 || status >= 300) {
      throw new Error(`context.request HTTP ${status}`);
    }
    const buf = Buffer.from(await res.body());
    const headersObj = res.headers();
    return {
      buf,
      ct: headersObj['content-type'] || headersObj['Content-Type'] || '',
      cd: headersObj['content-disposition'] || headersObj['Content-Disposition'] || '',
      finalUrl: res.url() || fileUrl
    };
  }

  async function fetchBytesInPage(p, fileUrl) {
    const data = await p.evaluate(async (u) => {
      const r = await fetch(u, {
        credentials: 'include',
        redirect: 'follow',
        headers: { Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' }
      });
      if (!r.ok) return { ok: false, status: r.status, statusText: r.statusText };
      const ct = r.headers.get('content-type') || '';
      const cd = r.headers.get('content-disposition') || '';
      const ab = await r.arrayBuffer();
      const bytes = Array.from(new Uint8Array(ab));
      return { ok: true, status: r.status, url: r.url, ct, cd, bytes };
    }, fileUrl);
    if (!data || !data.ok) {
      throw new Error(
        `页面内 fetch 失败 HTTP ${data && data.status} ${data && data.statusText}`
      );
    }
    return {
      buf: Buffer.from(data.bytes),
      ct: data.ct || '',
      cd: data.cd || '',
      finalUrl: data.url || fileUrl
    };
  }

  async function fetchBytesNode(fileUrl, opts = {}) {
    const timeoutMs = opts.timeoutMs || cfg.timeoutMs || 120000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let pageUrl = '';
      try {
        pageUrl = (bs.getShared().page && bs.getShared().page.url()) || '';
      } catch (_) {}
      const headers = {
        'User-Agent':
          cfg.userAgent ||
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'Accept-Language': cfg.acceptLanguage || 'zh-CN,zh;q=0.9,en;q=0.8',
        ...(opts.headers || {})
      };
      const cookie = await cookieHeaderForUrl(fileUrl);
      if (cookie) headers.Cookie = cookie;
      if (pageUrl && /^https?:/i.test(pageUrl)) headers.Referer = pageUrl;
      else if (/bing\.com|msn\.com/i.test(fileUrl)) headers.Referer = 'https://www.bing.com/images/';

      const res = await fetch(fileUrl, {
        method: 'GET',
        headers,
        signal: controller.signal,
        redirect: 'follow'
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const buf = await res.buffer();
      return {
        buf,
        ct: res.headers.get('content-type') || '',
        cd: res.headers.get('content-disposition') || '',
        finalUrl: res.url || fileUrl
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchBytesViaNavigation(fileUrl, opts = {}) {
    // 浏览器直接打开资源 URL（图片/pdf 等），取导航响应体——最接近「地址栏打开再保存」
    const page = bs.getShared().page;
    if (!page || page.isClosed()) throw new Error('无 page');
    const timeout = opts.timeoutMs || cfg.timeoutMs || 60000;
    const res = await page.goto(fileUrl, {
      waitUntil: 'commit',
      timeout
    });
    if (!res) throw new Error('navigation 无 response');
    const status = res.status();
    if (status < 200 || status >= 400) throw new Error(`navigation HTTP ${status}`);
    const buf = Buffer.from(await res.body());
    const headers = res.headers();
    return {
      buf,
      ct: headers['content-type'] || '',
      cd: headers['content-disposition'] || '',
      finalUrl: res.url() || fileUrl
    };
  }

  async function httpDownloadToDir(fileUrl, opts = {}) {
    const dlRoot = resolveBrowserDownloadDir(cfg, userDataPath);
    ensureDir(dlRoot);
    const errors = [];
    let got = null;
    let via = '';

    // 1) 浏览器导航到资源 URL 取 body（对 Bing 缩略图等直链最稳）
    try {
      got = await fetchBytesViaNavigation(fileUrl, opts);
      via = 'page.goto-body';
      if (sniffBinaryKind(got.buf) === 'html') {
        errors.push('page.goto→html');
        got = null;
      }
    } catch (err) {
      errors.push('page.goto:' + (err.message || err));
    }

    // 2) Playwright context.request
    if (!got) {
      try {
        got = await fetchBytesViaContext(fileUrl, opts);
        via = 'context.request';
        if (sniffBinaryKind(got.buf) === 'html') {
          errors.push('context.request→html');
          got = null;
        }
      } catch (err) {
        errors.push('context.request:' + (err.message || err));
      }
    }

    // 3) 页面内 fetch
    if (!got) {
      const page = bs.getShared().page;
      if (page && !page.isClosed()) {
        try {
          got = await fetchBytesInPage(page, fileUrl);
          via = 'page-fetch';
          if (sniffBinaryKind(got.buf) === 'html') {
            errors.push('page-fetch→html');
            got = null;
          }
        } catch (err) {
          errors.push('page-fetch:' + (err.message || err));
        }
      }
    }

    // 4) Node fetch + Cookie
    if (!got) {
      try {
        got = await fetchBytesNode(fileUrl, opts);
        via = 'http+cookies';
        if (sniffBinaryKind(got.buf) === 'html') {
          errors.push('node-fetch→html');
          got = null;
        }
      } catch (err) {
        errors.push('node-fetch:' + (err.message || err));
      }
    }

    if (!got) {
      throw new Error(
        `无法下载有效文件（均得到 HTML 或失败）: ${(errors || []).join(' | ')} url=${fileUrl}`
      );
    }

    const buf = got.buf;
    const ct = got.ct || '';
    const cd = got.cd || '';
    const kind = sniffBinaryKind(buf);
    if (kind === 'html' || (/text\/html/i.test(ct) && !kind)) {
      throw new Error(
        `下载到的是 HTML 而非文件（防盗链/跳转）。finalUrl=${got.finalUrl || fileUrl}`
      );
    }
    let name =
      opts.filename ||
      pickDownloadFilename({
        url: got.finalUrl || fileUrl,
        contentDisposition: cd
      }) ||
      `download-${Date.now()}`;
    const ext = path.extname(name);
      if (!ext && kind) name += `.${kind === 'jpg' ? 'jpg' : kind}`;
    else if (!ext) {
      if (/jpeg|jpg/i.test(ct)) name += '.jpg';
      else if (/png/i.test(ct)) name += '.png';
      else if (/webp/i.test(ct)) name += '.webp';
      else if (/gif/i.test(ct)) name += '.gif';
      else if (/pdf/i.test(ct)) name += '.pdf';
      else if (/zip/i.test(ct)) name += '.zip';
      else if (/x-tar|tar/i.test(ct)) name += '.tar';
      else if (/gzip|x-gzip/i.test(ct)) name += '.gz';
      else if (/spreadsheet|excel|sheet/i.test(ct)) name += '.xlsx';
      else if (/msword|wordprocessing/i.test(ct)) name += '.docx';
      else if (/octet-stream|force-download/i.test(ct)) name += '.bin';
    }
    // 按实际内容纠正扩展名（如 Bing 常返回 webp 却起名 .jpg）
    if (kind && kind !== 'html') {
      const want =
        kind === 'jpg' ? ['.jpg', '.jpeg', '.jfif'] : ['.' + kind];
      const cur = path.extname(name).toLowerCase();
      if (!want.includes(cur)) {
        const stem = cur ? name.slice(0, -cur.length) : name;
        name = stem + (kind === 'jpg' ? '.jpg' : '.' + kind);
      }
    }
    const dest = uniquePath(dlRoot, name);
    await fsp.writeFile(dest, buf);
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    const rec = {
      ok: true,
      path: dest,
      filename: path.basename(dest),
      url: got.finalUrl || fileUrl,
      size: buf.length,
      sha256: hash,
      contentType: ct || undefined,
      kind: kind || undefined,
      downloadDir: dlRoot,
      via,
      at: new Date().toISOString()
    };
    bs.pushDownloadRecord(rec);
    bs.logAction('browser.download_http', rec);
    return rec;
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
        const target = String(args.url || '');
        // 直接打开会触发下载的 URL：捕获 download，不要当成导航失败
        const mayDownload =
          looksLikeFileUrl(target) ||
          /\.(zip|tar|tgz|gz|xlsx?|pdf|rar|7z)(\?|$)/i.test(target);
        if (mayDownload) {
          const waiter = bs.waitNextDownload(args.timeoutMs || cfg.timeoutMs || 60000);
          try {
            await p.goto(target, {
              waitUntil: 'commit',
              timeout: args.timeoutMs || cfg.timeoutMs || 60000
            });
          } catch (err) {
            const msg = String(err && err.message ? err.message : err);
            if (!/Download is starting/i.test(msg)) {
              // 仍可能已触发 download
            }
          }
          try {
            const rec = await waiter;
            if (rec && rec.ok) {
              return {
                ok: true,
                navigatedAsDownload: true,
                ...rec,
                message: `URL 触发下载，已保存: ${rec.path}`
              };
            }
          } catch (_) {}
        } else {
          await p.goto(target, {
            waitUntil,
            timeout: args.timeoutMs || cfg.timeoutMs || 30000
          });
        }
        const sh = bs.getShared();
        const out = {
          url: p.url(),
          title: await p.title(),
          keptSession: true,
          downloadDir: sh.downloadDir || '',
          browserName: sh.browserName || bs.detectBrowserName(sh.executablePath),
          executablePath: sh.executablePath || '',
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

    /**
     * 从当前页解析真实下载 URL（读 href / 点击拦网络），不落盘。
     */
    async browser_resolve_download_url(args) {
      return withStep('browser_resolve_download_url', args, async () => {
        const p = await ensurePage();
        const hit = await resolveDownloadUrl(p, args || {});
        return {
          ok: !!hit.url,
          url: hit.url || '',
          method: hit.method,
          error: hit.error,
          pageUrl: p.url(),
          downloadDir: resolveBrowserDownloadDir(cfg, userDataPath),
          hint: hit.url
            ? '可用 download_file 或 browser_download 保存到配置下载目录'
            : '可改 selector/text，或对 blob 下载改用 browser_click(waitDownload:true)'
        };
      });
    },

    /**
     * 推荐：点下载按钮 → Playwright download saveAs（主路径，不 cancel）
     * 或已有 href/url → HTTP 落盘。最终在配置下载目录。
     */
    async browser_download(args) {
      return withStep('browser_download', args, async () => {
        const p = await ensurePage();
        const a = args || {};
        const dlRoot = resolveBrowserDownloadDir(cfg, userDataPath);

        // 已知 URL：HTTP / page.goto-body
        if (a.url && /^https?:\/\//i.test(String(a.url))) {
          const saved = await httpDownloadToDir(String(a.url).trim(), {
            filename: a.filename,
            timeoutMs: a.timeoutMs,
            headers: a.headers
          });
          return {
            ...saved,
            resolveMethod: 'given-url',
            message: `已保存到 ${saved.path}`
          };
        }

        if (!a.selector && !a.text) {
          return {
            ok: false,
            error: '请提供 selector、text 或 url',
            downloadDir: dlRoot
          };
        }

        // 主路径：点一次，等 download 事件并 saveAs（修复此前 cancel 导致无效）
        const cap = await clickAndCaptureDownload(p, {
          selector: a.selector,
          text: a.text,
          filename: a.filename,
          timeoutMs: a.timeoutMs || 60000
        });

        if (cap.saved && cap.saved.ok) {
          return {
            ...cap.saved,
            resolveMethod: cap.method,
            message: `已保存到 ${cap.saved.path}`
          };
        }

        // 拦到了 http(s) 文件 URL：再 HTTP 拉一次
        if (cap.needHttp && cap.url && /^https?:\/\//i.test(cap.url)) {
          try {
            const saved = await httpDownloadToDir(cap.url, {
              filename: a.filename,
              timeoutMs: a.timeoutMs,
              headers: a.headers
            });
            return {
              ...saved,
              resolveMethod: cap.method,
              message: `已保存到 ${saved.path}`
            };
          } catch (err) {
            return {
              ok: false,
              error: err.message || String(err),
              url: cap.url,
              resolveMethod: cap.method,
              downloadDir: dlRoot
            };
          }
        }

        return {
          ok: false,
          error: cap.error || '点击下载失败：未捕获到文件',
          resolveMethod: cap.method || 'none',
          downloadDir: dlRoot,
          hint:
            '请确认按钮会触发浏览器下载；可 browser_record 手点一次，或把按钮 selector 发我'
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
