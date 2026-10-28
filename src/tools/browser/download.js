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
    return 12000;
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

  /** 仅 overwrite/downloadForce/forceDownload 才覆盖；禁止把点击 force 当下载覆盖 */
  function downloadOverwrite(pending) {
    const p = pending || {};
    return (
      p.overwrite === true ||
      p.downloadForce === true ||
      p.forceDownload === true
    );
  }

  /** 列 staging 成品（跳过未写完临时后缀） */
  function listStageFiles(fsSync, stageRoot, sinceMs) {
    let names = [];
    try {
      names = fsSync.readdirSync(stageRoot);
    } catch (_) {
      return [];
    }
    const out = [];
    for (const name of names) {
      if (!name || name.startsWith('.')) continue;
      if (/\.(crdownload|tmp|partial|download)$/i.test(name)) continue;
      const full = path.join(stageRoot, name);
      let st;
      try {
        st = fsSync.statSync(full);
      } catch (_) {
        continue;
      }
      if (!st.isFile() || st.size <= 0) continue;
      if (sinceMs && (st.mtimeMs || 0) < sinceMs - 500) continue;
      out.push({ full, name, size: st.size, mtime: st.mtimeMs || 0 });
    }
    out.sort((a, b) => b.mtime - a.mtime);
    return out;
  }

  /**
   * 等下载完成：Playwright 记录 OR staging 文件大小稳定。
   * 解决「文件已落盘却报等待超时」。
   */
  async function waitDownloadSettled(opts = {}) {
    const fsSync = require('fs');
    const dlRoot = resolveBrowserDownloadDir(cfg, userDataPath);
    const stageRoot = incomingDir(dlRoot);
    const timeoutMs = Math.max(800, Number(opts.timeoutMs) || defaultDlWaitMs());
    const pending = opts.pending || bs.peekPendingDownloadSave() || {};
    const preferredName = opts.preferredName || pending.filename || '';
    const t0 = Date.now();
    const sinceMs = t0 - 2000;

    const waiterPromise = bs.waitNextDownload(timeoutMs).catch((err) => ({
      ok: false,
      timeout: true,
      error: err && err.message ? err.message : String(err)
    }));

    let waited = null;
    let waiterDone = false;
    waiterPromise.then((r) => {
      waiterDone = true;
      waited = r;
    });

    // size 连续两轮不变视为写完
    const stable = new Map(); // full -> { size, hits }

    while (Date.now() - t0 < timeoutMs) {
      if (waiterDone && waited && (waited.ok || waited.skipped) && waited.path) {
        return { ok: true, saved: waited, via: 'playwright-record' };
      }

      const files = listStageFiles(fsSync, stageRoot, sinceMs);
      for (const f of files) {
        const prev = stable.get(f.full);
        if (prev && prev.size === f.size) {
          prev.hits += 1;
        } else {
          stable.set(f.full, { size: f.size, hits: 1 });
        }
      }

      const ready = files.find((f) => {
        const s = stable.get(f.full);
        return s && s.hits >= 2 && s.size > 0;
      });
      if (ready) {
        // 若 Playwright 还在 saveAs，再给一点点时间；否则直接 promote
        await new Promise((r) => setTimeout(r, 250));
        if (waiterDone && waited && (waited.ok || waited.skipped) && waited.path) {
          return { ok: true, saved: waited, via: 'playwright-record' };
        }
        // 文件可能已被 onDownload promote 走；再扫一次
        if (!fsSync.existsSync(ready.full)) {
          const recent = (bs.getShared().recentDownloads || []).slice(-3).reverse();
          const hit = recent.find((r) => r && r.path && (r.ok || r.skipped));
          if (hit) return { ok: true, saved: hit, via: 'recent-after-promote' };
          continue;
        }
        const orphan = promoteOrphanStaging(
          fsSync,
          stageRoot,
          dlRoot,
          preferredName || ready.name,
          pending
        );
        if (orphan && orphan.path) {
          const rec = { ...orphan, at: new Date().toISOString() };
          bs.pushDownloadRecord(rec);
          bs.logAction(orphan.skipped ? 'browser.download.skip' : 'browser.download', rec);
          return { ok: true, saved: rec, via: 'staging-stable' };
        }
      }

      await new Promise((r) => setTimeout(r, 200));
    }

    if (waiterDone && waited && (waited.ok || waited.skipped) && waited.path) {
      return { ok: true, saved: waited, via: 'playwright-record-late' };
    }

    // 超时兜底：staging 里只要有成品就 promote，不再硬失败
    const orphan = promoteOrphanStaging(
      fsSync,
      stageRoot,
      dlRoot,
      preferredName,
      pending
    );
    if (orphan && orphan.path) {
      const rec = { ...orphan, at: new Date().toISOString() };
      bs.pushDownloadRecord(rec);
      bs.logAction(orphan.skipped ? 'browser.download.skip' : 'browser.download', rec);
      return { ok: true, saved: rec, via: 'staging-timeout-promote' };
    }

    const recent = (bs.getShared().recentDownloads || []).slice(-5).reverse();
    const hit = recent.find(
      (r) => r && r.path && (r.ok || r.skipped) && Date.parse(r.at || 0) >= sinceMs
    );
    if (hit) return { ok: true, saved: hit, via: 'recent-timeout' };

    return {
      ok: false,
      error:
        (waited && waited.error) ||
        `等待下载超时（${timeoutMs}ms）：未捕获到 Playwright 下载，staging 也无成品`,
      recentDownloads: recent,
      downloadDir: dlRoot,
      stagingDir: stageRoot
    };
  }

  function planSaveTarget(pending, suggestedRaw, url, dlRoot, extraReserved) {
    const p = pending || {};
    // 默认改名避让；仅显式 skipIfExists=true 才跳过
    const skip =
      p.skipIfExists === true ||
      (p.skipIfExists == null && cfg.skipIfExists === true);
    const reserved = [
      ...(bs.getReservedFinalPaths() || []),
      ...(Array.isArray(extraReserved) ? extraReserved : [])
    ];
    return resolveSaveTarget({
      path: p.path,
      dir: p.dir || p.saveDir,
      filename: p.filename,
      suggested: suggestedRaw,
      url,
      defaultDir: dlRoot,
      userDataPath,
      skipIfExists: skip,
      force: downloadOverwrite(p),
      reserved
    });
  }

  /**
   * 完成后再定最终名：plan → reserve（占位）→ promote 时再核一次。
   * 返回 { target, reservedPath }；调用方 promote 后必须 release。
   */
  function claimSaveTarget(pending, suggestedRaw, url, dlRoot) {
    const target = planSaveTarget(pending, suggestedRaw, url, dlRoot);
    if (target.skipped) return { target, reservedPath: null };
    bs.reserveFinalPath(target.path);
    return { target, reservedPath: target.path };
  }

  /**
   * CDP 直写时先做同名检查，避免出现 UUID 文件
   */
  async function checkAndSaveToStage(download, url, suggestedRaw, dlRoot) {
    const pending = bs.takePendingDownloadSave() || {};
    const stageRoot = incomingDir(dlRoot);
    // 先落到 staging 唯一名；最终名在 promote 前 claim
    const stageTmp = path.join(
      stageRoot,
      `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-dl`
    );
    ensureDir(stageRoot);
    await download.saveAs(stageTmp);
    const { target, reservedPath } = claimSaveTarget(pending, suggestedRaw, url, dlRoot);
    if (target.skipped) {
      safeUnlink(require('fs'), stageTmp);
      if (reservedPath) bs.releaseFinalPath(reservedPath);
      return { skipped: true, reason: 'file_exists', path: target.path, target };
    }
    return { skipped: false, path: stageTmp, target, reservedPath };
  }

  /**
   * staging → 最终目录。
   * - force=false：目标已有有效文件或撞车 → 再 uniquePath，禁止 unlink 覆盖
   * - force=true：才允许覆盖
   * 返回实际落盘路径（可能已改名）
   */
  function promoteStagedFile(fsSync, artifactPath, finalDest, opts = {}) {
    ensureDir(path.dirname(finalDest));
    const absArt = path.resolve(artifactPath);
    let absDest = path.resolve(finalDest);
    if (absArt === absDest) return absDest;

    const force = opts.force === true;
    const reserved = [
      ...(bs.getReservedFinalPaths() || []),
      ...(Array.isArray(opts.reserved) ? opts.reserved : [])
    ].filter((p) => path.resolve(String(p)) !== absDest);

    if (!force) {
      try {
        if (fsSync.existsSync(absDest)) {
          let size = 0;
          try {
            size = fsSync.statSync(absDest).size;
          } catch (_) {}
          if (size > 0) {
            absDest = uniquePath(path.dirname(absDest), path.basename(absDest), reserved);
          }
        }
      } catch (_) {}
    }

    const tryMove = (dest) => {
      ensureDir(path.dirname(dest));
      if (force) {
        try {
          if (fsSync.existsSync(dest) && path.resolve(dest) !== absArt) {
            fsSync.unlinkSync(dest);
          }
        } catch (_) {}
      } else {
        // 非 force：目标若已有有效文件，再避让一次（并发 promote）
        try {
          if (fsSync.existsSync(dest) && path.resolve(dest) !== absArt) {
            let size = 0;
            try {
              size = fsSync.statSync(dest).size;
            } catch (_) {}
            if (size > 0) {
              return tryMove(uniquePath(path.dirname(dest), path.basename(dest), reserved));
            }
            try {
              fsSync.unlinkSync(dest);
            } catch (_) {}
          }
        } catch (_) {}
      }
      try {
        fsSync.renameSync(absArt, dest);
        return dest;
      } catch (_) {
        try {
          fsSync.copyFileSync(absArt, dest);
          safeUnlink(fsSync, absArt);
          return dest;
        } catch (e2) {
          // 目标被并发占住：改名再试一次
          if (!force) {
            const alt = uniquePath(path.dirname(dest), path.basename(dest), [
              ...reserved,
              dest
            ]);
            if (path.resolve(alt) !== path.resolve(dest)) {
              fsSync.copyFileSync(absArt, alt);
              safeUnlink(fsSync, absArt);
              return alt;
            }
          }
          throw e2;
        }
      }
    };

    return tryMove(absDest);
  }

  function cleanStageDebris(fsSync, stageRoot) {
    try {
      for (const name of fsSync.readdirSync(stageRoot)) {
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(name)) {
          safeUnlink(fsSync, path.join(stageRoot, name));
        }
      }
    } catch (_) {}
  }

  /**
   * 扫 staging：CDP 直写后若 Playwright saveAs 未跑，把成品搬到下载根目录并改名避让。
   */
  function promoteOrphanStaging(fsSync, stageRoot, dlRoot, preferredName, pending) {
    let names = [];
    try {
      names = fsSync.readdirSync(stageRoot);
    } catch (_) {
      return null;
    }
    const candidates = [];
    for (const name of names) {
      if (!name || name.startsWith('.')) continue;
      const full = path.join(stageRoot, name);
      let st;
      try {
        st = fsSync.statSync(full);
      } catch (_) {
        continue;
      }
      if (!st.isFile() || st.size <= 0) continue;
      // 跳过未写完的 .crdownload / .tmp
      if (/\.(crdownload|tmp|partial|download)$/i.test(name)) continue;
      candidates.push({ full, name, size: st.size, mtime: st.mtimeMs || 0 });
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.mtime - a.mtime);
    const pick =
      (preferredName &&
        candidates.find(
          (c) => c.name.toLowerCase() === String(preferredName).toLowerCase()
        )) ||
      candidates[0];
    // 成品已在 staging：完成后再 claim 最终名
    const { target, reservedPath } = claimSaveTarget(
      { ...(pending || {}), filename: pending?.filename || preferredName || pick.name },
      preferredName || pick.name,
      '',
      dlRoot
    );
    if (target.skipped) {
      safeUnlink(fsSync, pick.full);
      if (reservedPath) bs.releaseFinalPath(reservedPath);
      return {
        ok: true,
        skipped: true,
        reason: target.reason || 'file_exists',
        path: target.path,
        filename: target.filename,
        size: target.size || 0,
        downloadDir: target.dir || dlRoot,
        via: 'staging-orphan-skip',
        message: target.message || '目标文件已存在，跳过下载'
      };
    }
    let finalPath;
    try {
      finalPath = promoteStagedFile(fsSync, pick.full, target.path, {
        force: downloadOverwrite(pending || {})
      });
    } finally {
      if (reservedPath) bs.releaseFinalPath(reservedPath);
      // promote 可能改名：释放实际路径以外的占位已在 reservedPath；若改名需登记新路径无必要（已落盘）
    }
    let size = 0;
    try {
      size = fsSync.statSync(finalPath).size;
    } catch (_) {}
    return {
      ok: true,
      skipped: false,
      path: finalPath,
      filename: path.basename(finalPath),
      size,
      downloadDir: path.dirname(finalPath),
      via: 'staging-orphan-promote',
      promotedFrom: pick.full,
      renamed: path.basename(finalPath) !== path.basename(target.path)
    };
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
      let reservedPath = null;

      // 仅 skipIfExists 且最终目录已有有效同名时提前 cancel（省流量）
      // 注意：不在此处 reserve；连续下载的避让在 saveAs 完成后再 claim
      try {
        const early = planSaveTarget(pending, suggestedRaw, url, dlRoot);
        if (early.skipped) {
          try {
            await download.cancel();
          } catch (_) {}
          try {
            const maybe = path.join(
              stageRoot,
              path.basename(early.filename || suggestedRaw || '')
            );
            safeUnlink(fsSync, maybe);
          } catch (_) {}
          const rec = {
            ok: true,
            skipped: true,
            reason: early.reason || 'file_exists',
            path: early.path,
            filename: early.filename,
            url,
            suggestedRaw,
            size: early.size || 0,
            downloadDir: early.dir || dlRoot,
            via: 'skip-exists',
            message: early.message || '目标文件已存在，跳过下载',
            at: new Date().toISOString()
          };
          bs.pushDownloadRecord(rec);
          bs.logAction('browser.download.skip', rec);
          return;
        }
      } catch (_) {}

      try {
        // 1) 先落到 staging 唯一临时名（与最终名无关）
        const stageTmp = path.join(
          stageRoot,
          `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-dl`
        );
        ensureDir(stageRoot);
        await download.saveAs(stageTmp);
        let size = 0;
        try {
          size = fsSync.statSync(stageTmp).size;
        } catch (_) {}
        if (!size) throw new Error('saveAs 后文件为空或不存在: ' + stageTmp);

        // 2) 完成后再定最终名并占位（此时 inflight 可见，连续同名会改名）
        const claimed = claimSaveTarget(pending, suggestedRaw, url, dlRoot);
        reservedPath = claimed.reservedPath;
        const target = claimed.target;
        if (target.skipped) {
          safeUnlink(fsSync, stageTmp);
          if (reservedPath) {
            bs.releaseFinalPath(reservedPath);
            reservedPath = null;
          }
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
            via: 'skip-exists-after-stage',
            message: target.message || '目标文件已存在，跳过下载',
            at: new Date().toISOString()
          };
          bs.pushDownloadRecord(rec);
          bs.logAction('browser.download.skip', rec);
          return;
        }

        // 3) promote：非 force 禁止静默覆盖，撞车再 uniquePath
        const promoted = promoteStagedFile(fsSync, stageTmp, target.path, {
          force: downloadOverwrite(pending)
        });
        if (reservedPath) {
          bs.releaseFinalPath(reservedPath);
          reservedPath = null;
        }
        cleanStageDebris(fsSync, stageRoot);
        try {
          const cdpLeftover = path.join(stageRoot, path.basename(suggestedRaw || target.path));
          if (path.resolve(cdpLeftover) !== path.resolve(promoted)) {
            safeUnlink(fsSync, cdpLeftover);
          }
        } catch (_) {}
        try {
          size = fsSync.statSync(promoted).size;
        } catch (_) {}
        const rec = {
          ok: true,
          skipped: false,
          path: promoted,
          filename: path.basename(promoted),
          url,
          suggestedRaw,
          size,
          downloadDir: path.dirname(promoted),
          via: 'saveAs-promote',
          renamed: path.basename(promoted) !== path.basename(target.path),
          at: new Date().toISOString()
        };
        bs.pushDownloadRecord(rec);
        bs.logAction('browser.download', rec);
      } catch (err) {
        if (reservedPath) {
          try {
            bs.releaseFinalPath(reservedPath);
          } catch (_) {}
          reservedPath = null;
        }
        // 失败：path() 或扫 staging 孤儿文件，promote 到最终目录
        let recovered = '';
        let artifactPath = '';
        try {
          artifactPath = (await Promise.race([
            download.path().catch(() => ''),
            new Promise((r) => setTimeout(() => r(''), 1500))
          ])) || '';
        } catch (_) {
          artifactPath = '';
        }
        try {
          if (artifactPath && fsSync.existsSync(artifactPath)) {
            const claimed2 = claimSaveTarget(
              pending,
              suggestedRaw || path.basename(artifactPath),
              url,
              dlRoot
            );
            const t2 = claimed2.target;
            const res2 = claimed2.reservedPath;
            try {
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
              recovered = promoteStagedFile(fsSync, artifactPath, t2.path, {
                force: downloadOverwrite(pending)
              });
            } finally {
              if (res2) bs.releaseFinalPath(res2);
            }
          }
        } catch (_) {
          recovered = '';
        }
        if (!recovered) {
          try {
            const orphan = promoteOrphanStaging(
              fsSync,
              stageRoot,
              dlRoot,
              suggestedRaw || pending.filename,
              pending
            );
            if (orphan && orphan.path) {
              const rec = {
                ...orphan,
                url,
                suggestedRaw,
                at: new Date().toISOString()
              };
              bs.pushDownloadRecord(rec);
              bs.logAction(
                orphan.skipped ? 'browser.download.skip' : 'browser.download',
                rec
              );
              return;
            }
          } catch (_) {}
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
            via: 'recover-promote',
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

    // skip 可提前 cancel；否则先 stage 再 claim
    const early = resolveSaveTarget({
      path: opts.path,
      dir: opts.dir || opts.saveDir,
      filename: opts.filename,
      suggested: suggestedRaw,
      url,
      defaultDir: dlRoot,
      userDataPath,
      skipIfExists: opts.skipIfExists === true,
      force: downloadOverwrite(opts),
      reserved: bs.getReservedFinalPaths()
    });
    if (early.skipped) {
      try {
        await download.cancel();
      } catch (_) {}
      const rec = {
        ok: true,
        skipped: true,
        reason: early.reason || 'file_exists',
        path: early.path,
        filename: early.filename,
        url,
        suggestedRaw,
        size: early.size || 0,
        downloadDir: early.dir || dlRoot,
        via: 'skip-exists',
        message: early.message || '目标文件已存在，跳过下载',
        at: new Date().toISOString()
      };
      bs.pushDownloadRecord(rec);
      bs.logAction('browser.download.skip', rec);
      return rec;
    }

    const stageRoot = incomingDir(dlRoot);
    const stageTmp = path.join(
      stageRoot,
      `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-dl`
    );
    ensureDir(stageRoot);
    await download.saveAs(stageTmp);
    let size = 0;
    try {
      size = fsSync.statSync(stageTmp).size;
    } catch (_) {}
    if (!size) throw new Error('saveAs 后文件为空: ' + stageTmp);

    const { target, reservedPath } = claimSaveTarget(opts, suggestedRaw, url, dlRoot);
    if (target.skipped) {
      safeUnlink(fsSync, stageTmp);
      if (reservedPath) bs.releaseFinalPath(reservedPath);
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
        via: 'skip-exists-after-stage',
        message: target.message || '目标文件已存在，跳过下载',
        at: new Date().toISOString()
      };
      bs.pushDownloadRecord(rec);
      bs.logAction('browser.download.skip', rec);
      return rec;
    }

    let finalPath;
    try {
      finalPath = promoteStagedFile(fsSync, stageTmp, target.path, {
        force: downloadOverwrite(opts)
      });
    } finally {
      if (reservedPath) bs.releaseFinalPath(reservedPath);
    }

    if (!opts.filename && !opts.path) {
      try {
        const buf = fsSync.readFileSync(finalPath);
        const kind = sniffBinaryKind(buf);
        if (kind && kind !== 'html') {
          const want = kind === 'jpg' ? ['.jpg', '.jpeg', '.jfif'] : ['.' + kind];
          const cur = path.extname(finalPath).toLowerCase();
          if (!want.includes(cur)) {
            const next =
              finalPath.replace(/\.[^.]+$/, '') + (kind === 'jpg' ? '.jpg' : '.' + kind);
            const nextTarget = resolveSaveTarget({
              path: next,
              defaultDir: path.dirname(next),
              userDataPath,
              skipIfExists: opts.skipIfExists === true,
              force: downloadOverwrite(opts),
              reserved: bs.getReservedFinalPaths()
            });
            if (!nextTarget.skipped) {
              try {
                if (
                  !downloadOverwrite(opts) &&
                  fsSync.existsSync(nextTarget.path) &&
                  fsSync.statSync(nextTarget.path).size > 0
                ) {
                  // resolve 已 unique；仍在则保留原路径
                } else {
                  bs.reserveFinalPath(nextTarget.path);
                  try {
                    if (fsSync.existsSync(nextTarget.path) && downloadOverwrite(opts)) {
                      fsSync.unlinkSync(nextTarget.path);
                    }
                    fsSync.renameSync(finalPath, nextTarget.path);
                    finalPath = nextTarget.path;
                  } finally {
                    bs.releaseFinalPath(nextTarget.path);
                  }
                }
              } catch (_) {}
            }
          }
        }
      } catch (_) {}
    }
    cleanStageDebris(fsSync, stageRoot);
    try {
      const cdpLeftover = path.join(stageRoot, path.basename(suggestedRaw || finalPath));
      if (path.resolve(cdpLeftover) !== path.resolve(finalPath)) {
        safeUnlink(fsSync, cdpLeftover);
      }
    } catch (_) {}
    const rec = {
      ok: true,
      skipped: false,
      path: finalPath,
      filename: path.basename(finalPath),
      url,
      suggestedRaw,
      size: fsSync.statSync(finalPath).size,
      downloadDir: path.dirname(finalPath),
      via: 'playwright-saveAs-promote',
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

    try {
      if (args.selector || args.text) {
        await getRobustClick()(p, args);
      } else {
        return { ok: false, error: '需要 selector 或 text' };
      }

      // 边等 Playwright 记录，边扫 staging 稳定文件；有网络 URL 也可提前走 HTTP
      const pending = bs.peekPendingDownloadSave() || args || {};
      const settledPromise = waitDownloadSettled({
        timeoutMs,
        pending,
        preferredName: pending.filename || ''
      });

      // 有明确文件 URL 时：最多再等 800ms 给 blob/download 事件，否则走 HTTP
      const t0 = Date.now();
      let netSeenAt = 0;
      let settled = null;
      let settledDone = false;
      settledPromise.then((r) => {
        settledDone = true;
        settled = r;
      });

      while (Date.now() - t0 < timeoutMs) {
        if (settledDone) break;
        if (netUrl && /^https?:\/\//i.test(netUrl)) {
          if (!netSeenAt) netSeenAt = Date.now();
          // 给 download/staging 一点时间；超时则用 HTTP
          if (Date.now() - netSeenAt >= 800) break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }

      if (!settledDone) {
        settled = await Promise.race([
          settledPromise,
          new Promise((r) => setTimeout(() => r(null), netUrl ? 200 : Math.min(timeoutMs, 3000)))
        ]);
      } else if (settled == null) {
        settled = await settledPromise;
      }

      if (settled && settled.ok && settled.saved && settled.saved.path) {
        return {
          ok: true,
          method: settled.via || 'download-settled',
          saved: settled.saved
        };
      }
      if (netUrl && /^https?:\/\//i.test(netUrl)) {
        return { ok: true, url: netUrl, method: netMethod || 'network', needHttp: true };
      }
      // 最后再扫一次 staging
      try {
        const fsSync = require('fs');
        const dlRoot = resolveBrowserDownloadDir(cfg, userDataPath);
        const stageRoot = incomingDir(dlRoot);
        const orphan = promoteOrphanStaging(
          fsSync,
          stageRoot,
          dlRoot,
          pending.filename || '',
          pending
        );
        if (orphan && orphan.path) {
          const rec = { ...orphan, at: new Date().toISOString() };
          bs.pushDownloadRecord(rec);
          bs.logAction(orphan.skipped ? 'browser.download.skip' : 'browser.download', rec);
          return { ok: true, method: 'staging-final', saved: rec };
        }
      } catch (_) {}
      return {
        ok: false,
        error:
          (settled && settled.error) ||
          '点击后未出现下载事件，staging 无成品，也未拦截到文件 URL。请确认按钮会触发文件下载，或提供更精确的 selector',
        method: 'none',
        downloadDir: resolveBrowserDownloadDir(cfg, userDataPath)
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
      timeout: opts.timeoutMs || cfg.timeoutMs || 20000,
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
    const timeoutMs = opts.timeoutMs || cfg.timeoutMs || 20000;
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
    const timeout = opts.timeoutMs || cfg.timeoutMs || 20000;
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
    // 单路径短超时，避免 4 路串行空等
    const perTry = Math.min(
      Math.max(3000, Number(opts.timeoutMs) || cfg.timeoutMs || 15000),
      20000
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
      skipIfExists: opts.skipIfExists === true,
      force: downloadOverwrite(opts),
      reserved: bs.getReservedFinalPaths()
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
    let dest = target.path;
    bs.reserveFinalPath(dest);
    try {
      // 写入前再核一次：非 force 且目标已有有效文件 → 改名
      if (!downloadOverwrite(opts)) {
        try {
          if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
            dest = uniquePath(path.dirname(dest), path.basename(dest), bs.getReservedFinalPaths());
            bs.reserveFinalPath(dest);
          }
        } catch (_) {}
      }
      ensureDir(path.dirname(dest));
      await fsp.writeFile(dest, buf);
    } finally {
      bs.releaseFinalPath(target.path);
      if (dest !== target.path) bs.releaseFinalPath(dest);
    }
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
      renamed: path.basename(dest) !== path.basename(target.path),
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
    waitDownloadSettled,
    promoteOrphanStaging,
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
