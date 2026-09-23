/**
 * 对外工具方法。所有能力来自 ctx，不直接 require 兄弟业务模块。
 */
const path = require('path');
const fsp = require('fs').promises;
const bs = require('../browser-session');
const { resolveScreenshotDir, resolveBrowserDownloadDir } = require('./paths');

function createBrowserToolHandlers(ctx) {
  const {
    cfg,
    userDataPath,
    keepSession,
    withStep,
    maskText,
    ensurePage,
    robustClick,
    looksLikeFileUrl,
    resolveDownloadUrl,
    clickAndCaptureDownload,
    httpDownloadToDir,
    flowsDir,
    suggestVariables,
    runFlowSteps
  } = ctx;

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
          bs.setPendingDownloadSave({
            filename: args.filename,
            path: args.path,
            dir: args.dir || args.saveDir,
            skipIfExists: args.skipIfExists !== false,
            force: args.force === true
          });
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
  
        const saveOpts = {
          filename: a.filename,
          path: a.path,
          dir: a.dir || a.saveDir,
          skipIfExists: a.skipIfExists !== false,
          force: a.force === true,
          timeoutMs: a.timeoutMs,
          headers: a.headers
        };
  
        // 已知 URL：HTTP / page.goto-body
        if (a.url && /^https?:\/\//i.test(String(a.url))) {
          const saved = await httpDownloadToDir(String(a.url).trim(), saveOpts);
          return {
            ...saved,
            resolveMethod: 'given-url',
            message: saved.skipped
              ? saved.message || `已存在，跳过: ${saved.path}`
              : `已保存到 ${saved.path}`
          };
        }
  
        if (!a.selector && !a.text) {
          return {
            ok: false,
            error: '请提供 selector、text 或 url；可选 filename/path/dir 指定保存位置与名称',
            downloadDir: dlRoot
          };
        }
  
        // 主路径：点一次，等 download 事件并 saveAs（修复此前 cancel 导致无效）
        bs.setPendingDownloadSave(saveOpts);
        const cap = await clickAndCaptureDownload(p, {
          selector: a.selector,
          text: a.text,
          ...saveOpts,
          timeoutMs: a.timeoutMs || 60000
        });
  
        if (cap.saved && cap.saved.ok) {
          return {
            ...cap.saved,
            resolveMethod: cap.method,
            message: cap.saved.skipped
              ? cap.saved.message || `已存在，跳过: ${cap.saved.path}`
              : `已保存到 ${cap.saved.path}`
          };
        }
  
        // 拦到了 http(s) 文件 URL：再 HTTP 拉一次
        if (cap.needHttp && cap.url && /^https?:\/\//i.test(cap.url)) {
          try {
            const saved = await httpDownloadToDir(cap.url, saveOpts);
            return {
              ...saved,
              resolveMethod: cap.method,
              message: saved.skipped
                ? saved.message || `已存在，跳过: ${saved.path}`
                : `已保存到 ${saved.path}`
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
  
  tools._abortRunning = () => {
    bs.requestAbort();
  };

  return tools;
}

module.exports = { createBrowserToolHandlers };
