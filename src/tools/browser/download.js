/**
 * 浏览器下载：落盘 / 解析 URL / HTTP 补下。
 * 仅 require 公共模块；robustClick 由入口注入，禁止 require('./click')。
 */
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const crypto = require('crypto');
const fetch = require('node-fetch');
const bs = require('../browser-session');
const {
  pickDownloadFilename,
  resolveSaveTarget,
  resolveIncomingDir,
  ensureDir,
  uniquePath
} = require('../download-path');
const { resolveBrowserDownloadDir } = require('./paths');

function createDownloadHelpers(ctx) {
  const { cfg, userDataPath } = ctx;
  // 延迟取 robustClick，避免组装顺序问题
  const getRobustClick = () => ctx.robustClick;

  function defaultDlWaitMs() {
    const n = Number(cfg.downloadWaitMs);
    if (Number.isFinite(n) && n > 0) return Math.max(800, n);
    return 20000;
  }

  function incomingDir(dlRoot) {
    const d = resolveIncomingDir(dlRoot);
    ensureDir(d);
    return d;
  }

  function safeUnlink(fsSync, p) {
    try {
      if (p && fsSync.existsSync(p)) fsSync.unlinkSync(p);
    } catch (_) {}
  }

  function bindContextDownloads(context, dlRoot) {
    if (!context || context.__aihelperDlBound) return;
    context.__aihelperDlBound = true;
    const fsSync = require('fs');
    const stageRoot = incomingDir(dlRoot);

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
      const pending = bs.takePendingDownloadSave() || {};

      // 先定最终路径（同名跳过/改名），再 saveAs；CDP 只写 staging，不会直接覆盖最终文件
      let target;
      try {
        target = resolveSaveTarget({
          path: pending.path,
          dir: pending.dir || pending.saveDir,
          filename: pending.filename,
          suggested: suggestedRaw,
          url,
          defaultDir: dlRoot,
          userDataPath,
          skipIfExists: pending.skipIfExists !== false,
          force: pending.force === true
        });
      } catch (e) {
        target = {
          skipped: false,
          path: uniquePath(dlRoot, suggestedRaw || `download-${Date.now()}`),
          filename: suggestedRaw || '',
          dir: dlRoot
        };
      }

      if (target.skipped) {
        try {
          await download.cancel();
        } catch (_) {}
        // 若 staging 里已有同名/碎片，清掉
        try {
          const maybe = path.join(stageRoot, path.basename(target.filename || suggestedRaw || ''));
          safeUnlink(fsSync, maybe);
        } catch (_) {}
        const rec = {
          ok: true,
          skipped: true,
          reason: target.reason || 'file_exists',
          path: target.path,
          filename: target.filename,
          url,
          suggestedRaw,
          size: target.size || 0,
          downloadDir: target.dir || dlRoot,
          via: 'skip-exists',
          message: target.message || '目标文件已存在，跳过下载',
          at: new Date().toISOString()
        };
        bs.pushDownloadRecord(rec);
        bs.logAction('browser.download.skip', rec);
        return;
      }

      let artifactPath = '';
      try {
        // 仅在需要落盘时再等 path（skip 路径已 return，避免白等大文件下完）
        artifactPath = (await download.path()) || '';
      } catch (_) {
        artifactPath = '';
      }

      try {
        const dest = target.path;
        ensureDir(path.dirname(dest));
        // saveAs 前再查一次，防并发双写
        const again = resolveSaveTarget({
          path: dest,
          defaultDir: path.dirname(dest),
          userDataPath,
          skipIfExists: pending.skipIfExists !== false,
          force: pending.force === true
        });
        if (again.skipped) {
          try {
            await download.cancel();
          } catch (_) {}
          safeUnlink(fsSync, artifactPath);
          const rec = {
            ok: true,
            skipped: true,
            reason: again.reason || 'file_exists',
            path: again.path,
            filename: again.filename,
            url,
            suggestedRaw,
            size: again.size || 0,
            downloadDir: again.dir || dlRoot,
            via: 'skip-exists-race',
            message: again.message || '目标文件已存在，跳过下载',
            at: new Date().toISOString()
          };
          bs.pushDownloadRecord(rec);
          bs.logAction('browser.download.skip', rec);
          return;
        }
        const finalDest = again.path || dest;
        await download.saveAs(finalDest);
        if (artifactPath && path.resolve(artifactPath) !== path.resolve(finalDest)) {
          safeUnlink(fsSync, artifactPath);
        }
        // 清理 staging 里 UUID 碎片
        try {
          for (const name of fsSync.readdirSync(stageRoot)) {
            if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(name)) {
              safeUnlink(fsSync, path.join(stageRoot, name));
            }
          }
        } catch (_) {}
        let size = 0;
        try {
          size = fsSync.statSync(finalDest).size;
        } catch (_) {}
        if (!size) throw new Error('saveAs 后文件为空或不存在: ' + finalDest);
        const rec = {
          ok: true,
          skipped: false,
          path: finalDest,
          filename: path.basename(finalDest),
          url,
          suggestedRaw,
          size,
          downloadDir: path.dirname(finalDest),
          at: new Date().toISOString()
        };
        bs.pushDownloadRecord(rec);
        bs.logAction('browser.download', rec);
      } catch (err) {
        let recovered = '';
        try {
          if (artifactPath && fsSync.existsSync(artifactPath)) {
            const t2 = resolveSaveTarget({
              path: pending.path,
              dir: pending.dir || pending.saveDir,
              filename: pending.filename || suggestedRaw,
              suggested: suggestedRaw,
              url,
              defaultDir: dlRoot,
              userDataPath,
              skipIfExists: pending.skipIfExists !== false,
              force: pending.force === true
            });
            if (t2.skipped) {
              safeUnlink(fsSync, artifactPath);
              const rec = {
                ok: true,
                skipped: true,
                reason: t2.reason || 'file_exists',
                path: t2.path,
                filename: t2.filename,
                url,
                suggestedRaw,
                size: t2.size || 0,
                downloadDir: t2.dir || dlRoot,
                via: 'skip-exists-recover',
                message: t2.message || '目标文件已存在，跳过下载',
                at: new Date().toISOString()
              };
              bs.pushDownloadRecord(rec);
              bs.logAction('browser.download.skip', rec);
              return;
            }
            recovered = t2.path;
            ensureDir(path.dirname(recovered));
            fsSync.copyFileSync(artifactPath, recovered);
            safeUnlink(fsSync, artifactPath);
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
            downloadDir: path.dirname(recovered),
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
      // 必须落到 staging，禁止直接写最终目录（否则浏览器原生落盘会覆盖同名文件）
      const stage = incomingDir(dlRoot);
      const client = await context.newCDPSession(page);
      const tryCdp = async (method, params) => client.send(method, params);
      try {
        await tryCdp('Browser.setDownloadBehavior', {
          behavior: 'allow',
          downloadPath: stage,
          eventsEnabled: true
        });
      } catch (_) {
        await tryCdp('Page.setDownloadBehavior', {
          behavior: 'allow',
          downloadPath: stage
        });
      }
    } catch (err) {
      bs.logAction('browser.cdp_download_warn', {
        error: (err && err.message) || String(err),
        downloadDir: dlRoot
      });
    }
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
    const target = resolveSaveTarget({
      path: opts.path,
      dir: opts.dir || opts.saveDir,
      filename: opts.filename,
      suggested: suggestedRaw,
      url,
      defaultDir: dlRoot,
      userDataPath,
      skipIfExists: opts.skipIfExists !== false,
      force: opts.force === true
    });
    if (target.skipped) {
      try {
        await download.cancel();
      } catch (_) {}
      const rec = {
        ok: true,
        skipped: true,
        reason: target.reason || 'file_exists',
        path: target.path,
        filename: target.filename,
        url,
        suggestedRaw,
        size: target.size || 0,
        downloadDir: target.dir || dlRoot,
        via: 'skip-exists',
        message: target.message || '目标文件已存在，跳过下载',
        at: new Date().toISOString()
      };
      bs.pushDownloadRecord(rec);
      bs.logAction('browser.download.skip', rec);
      return rec;
    }
    const dest = target.path;
    await download.saveAs(dest);
    let size = 0;
    try {
      size = fsSync.statSync(dest).size;
    } catch (_) {}
    if (!size) throw new Error('saveAs 后文件为空: ' + dest);
    let finalPath = dest;
    if (!opts.filename && !opts.path) {
      try {
        const buf = fsSync.readFileSync(dest);
        const kind = sniffBinaryKind(buf);
        if (kind && kind !== 'html') {
          const want = kind === 'jpg' ? ['.jpg', '.jpeg', '.jfif'] : ['.' + kind];
          const cur = path.extname(dest).toLowerCase();
          if (!want.includes(cur)) {
            const next =
              dest.replace(/\.[^.]+$/, '') + (kind === 'jpg' ? '.jpg' : '.' + kind);
            // 改扩展名时也走同名策略，禁止覆盖已有 file.jpg
            const nextTarget = resolveSaveTarget({
              path: next,
              defaultDir: path.dirname(next),
              userDataPath,
              skipIfExists: opts.skipIfExists !== false,
              force: opts.force === true
            });
            if (nextTarget.skipped) {
              // 目标扩展名文件已存在：保留当前 dest，或 unique
              finalPath = dest;
            } else {
              fsSync.renameSync(dest, nextTarget.path);
              finalPath = nextTarget.path;
            }
          }
        }
      } catch (_) {}
    }
    const rec = {
      ok: true,
      skipped: false,
      path: finalPath,
      filename: path.basename(finalPath),
      url,
      suggestedRaw,
      size: fsSync.statSync(finalPath).size,
      downloadDir: path.dirname(finalPath),
      via: 'playwright-saveAs',
      at: new Date().toISOString()
    };
    bs.pushDownloadRecord(rec);
    bs.logAction('browser.download', rec);
    return rec;
  }

  /**
   * 点击并捕获下载：download 事件 与 网络文件 URL 竞速，谁先到用谁（缩短空等）。
   */
  async function clickAndCaptureDownload(p, args = {}) {
    const timeoutMs = Math.max(800, Number(args.timeoutMs) || defaultDlWaitMs());
    const shared = bs.getShared();
    const context = shared.context;
    if (!context) return { ok: false, error: '浏览器未就绪' };

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

    const waiterPromise = bs.waitNextDownload(timeoutMs).catch(() => null);

    try {
      if (args.selector || args.text) {
        await getRobustClick()(p, args);
      } else {
        return { ok: false, error: '需要 selector 或 text' };
      }

      // 竞速：download 记录 vs 网络 URL（每 150ms 看一次），避免干等满超时
      const t0 = Date.now();
      let waited = null;
      let waiterDone = false;
      waiterPromise.then((r) => {
        waiterDone = true;
        waited = r;
      });

      while (Date.now() - t0 < timeoutMs) {
        if (waiterDone) break;
        if (netUrl && /^https?:\/\//i.test(netUrl)) {
          // 给 download 事件一点余量（blob 可能稍晚）
          if (Date.now() - t0 >= 1200) break;
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      if (!waiterDone) {
        waited = await Promise.race([
          waiterPromise,
          new Promise((r) => setTimeout(() => r(null), 200))
        ]);
      } else {
        waited = waited || (await waiterPromise);
      }

      if (waited && waited.ok && waited.path) {
        return { ok: true, method: 'playwright-download', saved: waited };
      }
      if (waited && waited.skipped && waited.path) {
        return { ok: true, method: 'playwright-download', saved: waited };
      }
      if (netUrl && /^https?:\/\//i.test(netUrl)) {
        return { ok: true, url: netUrl, method: netMethod || 'network', needHttp: true };
      }
      if (waited && waited.ok === false && waited.error) {
        return {
          ok: false,
          error: waited.error,
          method: 'none'
        };
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
    // 单路径短超时，避免 4 路串行各等 120s
    const perTry = Math.min(
      Math.max(5000, Number(opts.timeoutMs) || cfg.timeoutMs || 45000),
      45000
    );
    const tryOpts = { ...opts, timeoutMs: perTry };

    // 1) context.request（带 Cookie，通常最快）
    try {
      got = await fetchBytesViaContext(fileUrl, tryOpts);
      via = 'context.request';
      if (sniffBinaryKind(got.buf) === 'html') {
        errors.push('context.request→html');
        got = null;
      }
    } catch (err) {
      errors.push('context.request:' + (err.message || err));
    }

    // 2) 页面内 fetch
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

    // 3) Node fetch + Cookie
    if (!got) {
      try {
        got = await fetchBytesNode(fileUrl, tryOpts);
        via = 'http+cookies';
        if (sniffBinaryKind(got.buf) === 'html') {
          errors.push('node-fetch→html');
          got = null;
        }
      } catch (err) {
        errors.push('node-fetch:' + (err.message || err));
      }
    }

    // 4) 导航取 body（最慢，最后兜底）
    if (!got) {
      try {
        got = await fetchBytesViaNavigation(fileUrl, tryOpts);
        via = 'page.goto-body';
        if (sniffBinaryKind(got.buf) === 'html') {
          errors.push('page.goto→html');
          got = null;
        }
      } catch (err) {
        errors.push('page.goto:' + (err.message || err));
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
    // 按实际内容纠正扩展名（用户未指定文件名时）
    if (!opts.filename && !opts.path && kind && kind !== 'html') {
      const want =
        kind === 'jpg' ? ['.jpg', '.jpeg', '.jfif'] : ['.' + kind];
      const cur = path.extname(name).toLowerCase();
      if (!want.includes(cur)) {
        const stem = cur ? name.slice(0, -cur.length) : name;
        name = stem + (kind === 'jpg' ? '.jpg' : '.' + kind);
      }
    }
    const target = resolveSaveTarget({
      path: opts.path,
      dir: opts.dir || opts.saveDir,
      filename: name,
      url: got.finalUrl || fileUrl,
      contentDisposition: cd,
      defaultDir: dlRoot,
      userDataPath,
      skipIfExists: opts.skipIfExists !== false,
      force: opts.force === true
    });
    if (target.skipped) {
      const rec = {
        ok: true,
        skipped: true,
        reason: target.reason || 'file_exists',
        path: target.path,
        filename: target.filename,
        url: got.finalUrl || fileUrl,
        size: target.size || 0,
        downloadDir: target.dir || dlRoot,
        via: 'skip-exists',
        message: target.message || '目标文件已存在，跳过下载',
        at: new Date().toISOString()
      };
      bs.pushDownloadRecord(rec);
      bs.logAction('browser.download_http.skip', rec);
      return rec;
    }
    const dest = target.path;
    await fsp.writeFile(dest, buf);
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    const rec = {
      ok: true,
      skipped: false,
      path: dest,
      filename: path.basename(dest),
      url: got.finalUrl || fileUrl,
      size: buf.length,
      sha256: hash,
      contentType: ct || undefined,
      kind: kind || undefined,
      downloadDir: path.dirname(dest),
      via,
      at: new Date().toISOString()
    };
    bs.pushDownloadRecord(rec);
    bs.logAction('browser.download_http', rec);
    return rec;
  }

  return {
    bindContextDownloads,
    applyCdpDownloadBehavior,
    looksLikeFileUrl,
    isDownloadResponse,
    extractHrefFromTarget,
    savePlaywrightDownload,
    clickAndCaptureDownload,
    resolveDownloadUrl,
    cookieHeaderForUrl,
    sniffBinaryKind,
    fetchBytesViaContext,
    fetchBytesInPage,
    fetchBytesNode,
    fetchBytesViaNavigation,
    httpDownloadToDir
  };
}

module.exports = { createDownloadHelpers };
