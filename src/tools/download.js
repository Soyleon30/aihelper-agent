/**
 * 文件下载：固定到可配置目录，按 URL 去重，避免按 md 反复下同一文件。
 */
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch');
const { URL } = require('url');
const {
  resolveDownloadRoot,
  pickDownloadFilename,
  uniquePath,
  resolveSaveTarget,
  ensureDir
} = require('./download-path');

function createDownloadTools(options = {}) {
  const cfg = options.config || {};
  const pathsCfg = options.pathsConfig || {};
  const userDataPath = options.userDataPath || process.cwd();
  const logger = options.logger || null;

  function downloadRoot() {
    return resolveDownloadRoot(cfg.dir || pathsCfg.downloadDir || '', userDataPath);
  }

  function indexPath() {
    return path.join(downloadRoot(), '.download-index.json');
  }

  function ensureRoot() {
    return ensureDir(downloadRoot());
  }

  function readIndex() {
    try {
      const p = indexPath();
      if (!fs.existsSync(p)) return { byUrl: {}, byHash: {} };
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      return {
        byUrl: j.byUrl || {},
        byHash: j.byHash || {}
      };
    } catch {
      return { byUrl: {}, byHash: {} };
    }
  }

  function writeIndex(idx) {
    ensureRoot();
    fs.writeFileSync(indexPath(), JSON.stringify(idx, null, 2), 'utf8');
  }

  function normalizeUrl(u) {
    try {
      const x = new URL(String(u).trim());
      x.hash = '';
      return x.toString();
    } catch {
      return String(u || '').trim();
    }
  }

  function safeNameFromUrl(url, contentDisposition) {
    return (
      pickDownloadFilename({ url, contentDisposition }) || `download-${Date.now()}`
    );
  }

  function fileMeta(filePath) {
    try {
      const st = fs.statSync(filePath);
      return { exists: true, size: st.size, mtime: st.mtime.toISOString() };
    } catch {
      return { exists: false };
    }
  }

  async function sha256File(filePath) {
    return new Promise((resolve, reject) => {
      const h = crypto.createHash('sha256');
      const s = fs.createReadStream(filePath);
      s.on('data', (c) => h.update(c));
      s.on('error', reject);
      s.on('end', () => resolve(h.digest('hex')));
    });
  }

  /**
   * 从 markdown 文本提取 http(s) 链接（去重）
   */
  function extractUrlsFromMarkdown(md) {
    const text = String(md || '');
    const set = new Set();
    const reMd = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/gi;
    const reBare = /https?:\/\/[^\s<>"'`)\]}]+/gi;
    let m;
    while ((m = reMd.exec(text))) set.add(normalizeUrl(m[2]));
    while ((m = reBare.exec(text))) {
      let u = m[0].replace(/[.,;:!?)]+$/, '');
      set.add(normalizeUrl(u));
    }
    return [...set];
  }

  return {
    async get_download_dir() {
      const root = ensureRoot();
      return { dir: root, index: indexPath() };
    },

    async download_file(args) {
      const url = normalizeUrl(args.url);
      if (!url) throw new Error('需要 url');
      const root = ensureRoot();
      // 默认改名；仅显式 true / 配置 true 才跳过
      const skipExisting =
        args.skipIfExists === true ||
        (args.skipIfExists == null && cfg.skipIfExists === true);
      const force = args.force === true;
      const idx = readIndex();

      // URL 去重
      if (!force && skipExisting && idx.byUrl[url]) {
        const prev = idx.byUrl[url];
        const meta = fileMeta(prev.path);
        if (meta.exists) {
          if (logger) {
            logger.info('download.skip_url', { url, path: prev.path });
          }
          return {
            ok: true,
            skipped: true,
            reason: 'url_already_downloaded',
            url,
            path: prev.path,
            size: meta.size,
            downloadedAt: prev.downloadedAt,
            message: '该 URL 已下载过，跳过重复下载'
          };
        }
      }

      // 用户指定 path/dir/filename 时先按同名策略落盘；未指定则等响应头再定名
      const userNamed = !!(args.path || args.filename || args.dir || args.saveDir);
      let dest = null;
      if (userNamed) {
        const target = resolveSaveTarget({
          path: args.path,
          dir: args.dir || args.saveDir,
          filename: args.filename,
          url,
          defaultDir: root,
          userDataPath,
          skipIfExists: skipExisting,
          force
        });
        if (target.skipped) {
          return {
            ok: true,
            skipped: true,
            reason: target.reason || 'file_exists',
            url,
            path: target.path,
            filename: target.filename,
            size: target.size,
            message: target.message || '目标文件已存在，跳过下载'
          };
        }
        dest = target.path;
      }

      const timeoutMs = args.timeoutMs || cfg.timeoutMs || 120000;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const headers = { ...(args.headers || {}) };
        const res = await fetch(url, {
          method: 'GET',
          headers,
          signal: controller.signal,
          redirect: 'follow'
        });
        if (!res.ok) {
          throw new Error(`下载失败 HTTP ${res.status} ${res.statusText}`);
        }

        const cd = res.headers.get('content-disposition') || '';
        if (!userNamed) {
          const target = resolveSaveTarget({
            url: res.url || url,
            contentDisposition: cd,
            defaultDir: root,
            userDataPath,
            skipIfExists: skipExisting,
            force
          });
          if (target.skipped) {
            return {
              ok: true,
              skipped: true,
              reason: target.reason || 'file_exists',
              url,
              path: target.path,
              filename: target.filename,
              size: target.size,
              message: target.message || '目标文件已存在，跳过下载'
            };
          }
          dest = target.path;
        }

        await fsp.mkdir(path.dirname(dest), { recursive: true });
        const buf = await res.buffer();
        await fsp.writeFile(dest, buf);

        const hash = crypto.createHash('sha256').update(buf).digest('hex');
        // 内容去重：相同 hash 已有文件则可选删除新文件指向旧文件
        if (!force && cfg.dedupeByHash !== false && idx.byHash[hash]) {
          const old = idx.byHash[hash];
          if (old.path && fs.existsSync(old.path) && path.resolve(old.path) !== path.resolve(dest)) {
            try {
              await fsp.unlink(dest);
            } catch (_) {}
            dest = old.path;
            idx.byUrl[url] = {
              path: dest,
              hash,
              size: buf.length,
              downloadedAt: old.downloadedAt || new Date().toISOString()
            };
            writeIndex(idx);
            return {
              ok: true,
              skipped: true,
              reason: 'same_content_hash',
              url,
              path: dest,
              size: buf.length,
              sha256: hash,
              message: '内容与已有文件相同，复用已有文件'
            };
          }
        }

        const now = new Date().toISOString();
        idx.byUrl[url] = { path: dest, hash, size: buf.length, downloadedAt: now };
        idx.byHash[hash] = { path: dest, url, size: buf.length, downloadedAt: now };
        writeIndex(idx);

        if (logger) {
          logger.info('download.ok', { url, path: dest, size: buf.length });
          logger.action('download', 'file.saved', { url, path: dest, size: buf.length });
        }

        return {
          ok: true,
          skipped: false,
          url: res.url || url,
          path: dest,
          size: buf.length,
          sha256: hash,
          contentType: res.headers.get('content-type') || undefined,
          message: `已保存到 ${dest}`
        };
      } finally {
        clearTimeout(timer);
      }
    },

    async download_from_markdown(args) {
      let md = args.markdown || args.content || '';
      if (args.path) {
        md = await fsp.readFile(args.path, 'utf8');
      }
      if (!md) throw new Error('需要 markdown 文本或 path');

      const urls = extractUrlsFromMarkdown(md);
      // 可选过滤扩展名
      let list = urls;
      if (Array.isArray(args.extensions) && args.extensions.length) {
        const exts = args.extensions.map((e) =>
          String(e).startsWith('.') ? String(e).toLowerCase() : `.${String(e).toLowerCase()}`
        );
        list = urls.filter((u) => {
          try {
            const p = new URL(u).pathname.toLowerCase();
            return exts.some((e) => p.endsWith(e));
          } catch {
            return false;
          }
        });
      }
      if (args.filter) {
        const re = new RegExp(args.filter, 'i');
        list = list.filter((u) => re.test(u));
      }

      const results = [];
      for (const url of list) {
        try {
          const r = await this.download_file({
            url,
            skipIfExists:
              args.skipIfExists === true ||
              (args.skipIfExists == null && cfg.skipIfExists === true),
            force: args.force === true,
            timeoutMs: args.timeoutMs
          });
          results.push(r);
        } catch (err) {
          results.push({
            ok: false,
            url,
            error: err.message || String(err)
          });
        }
      }

      const downloaded = results.filter((r) => r.ok && !r.skipped).length;
      const skipped = results.filter((r) => r.ok && r.skipped).length;
      const failed = results.filter((r) => !r.ok).length;

      return {
        ok: true,
        dir: downloadRoot(),
        totalUrls: list.length,
        downloaded,
        skipped,
        failed,
        results,
        message: `共 ${list.length} 个链接：新下载 ${downloaded}，跳过 ${skipped}，失败 ${failed}`
      };
    },

    async list_downloads(args) {
      const root = ensureRoot();
      const idx = readIndex();
      const files = [];
      try {
        const names = await fsp.readdir(root);
        for (const name of names) {
          if (name.startsWith('.')) continue;
          const full = path.join(root, name);
          try {
            const st = await fsp.stat(full);
            if (st.isFile()) {
              files.push({ name, path: full, size: st.size, mtime: st.mtime.toISOString() });
            }
          } catch (_) {}
        }
      } catch (_) {}
      return {
        dir: root,
        count: files.length,
        files: files.slice(0, args?.limit || 200),
        indexCount: Object.keys(idx.byUrl || {}).length
      };
    }
  };
}

module.exports = { createDownloadTools };
