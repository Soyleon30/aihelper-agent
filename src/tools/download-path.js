/**
 * 下载目录与文件名：浏览器下载 / HTTP 下载共用，避免 AppData 难找与中文乱码。
 */
const fs = require('fs');
const path = require('path');

function resolveDownloadRoot(configuredDir, userDataPath) {
  const d = String(configuredDir || '').trim();
  if (d) return path.resolve(d);
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (home) return path.join(home, 'Downloads', 'AIHelper');
  return path.join(userDataPath || process.cwd(), 'downloads');
}

function tryDecodeURIComponent(s) {
  const raw = String(s || '').trim();
  if (!raw) return '';
  try {
    return decodeURIComponent(raw.replace(/\+/g, '%20'));
  } catch {
    try {
      return decodeURIComponent(raw.replace(/%(?![0-9A-Fa-f]{2})/g, '%25'));
    } catch {
      return raw;
    }
  }
}

function stripQuotes(s) {
  let t = String(s || '').trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    t = t.slice(1, -1);
  }
  return t.trim();
}

function hasCjk(s) {
  return /[\u4e00-\u9fff\u3400-\u4dbf]/.test(String(s || ''));
}

function looksLikeMojibake(s) {
  const t = String(s || '');
  if (!t) return false;
  if (hasCjk(t)) return false;
  // UTF-8 被当成 Latin-1 读出的典型碎片
  if (/Ã.|Â.|Ä.|Å.|Æ.|Ç.|È.|É.|Ê.|Ë.|å.|æ.|ç.|è.|é.|ä¸|å\x8D|æ\x96/.test(t)) {
    return true;
  }
  const hi = (t.match(/[\u00C0-\u00FF]/g) || []).length;
  return hi >= 2 && hi / t.length >= 0.2;
}

function fixMojibake(s) {
  const t = String(s || '');
  if (!t || !looksLikeMojibake(t)) return t;
  try {
    const utf8 = Buffer.from(t, 'latin1').toString('utf8');
    if (utf8 && !utf8.includes('\uFFFD') && (hasCjk(utf8) || !looksLikeMojibake(utf8))) {
      return utf8;
    }
  } catch (_) {}
  return t;
}

/**
 * 从 Content-Disposition 解析文件名（优先 filename*=UTF-8''）
 */
function parseContentDisposition(cd) {
  const header = String(cd || '');
  if (!header) return '';

  const starUtf =
    /filename\*\s*=\s*(?:UTF-8|utf-8)''\s*([^;]+)/i.exec(header) ||
    /filename\*\s*=\s*([^;]+)/i.exec(header);
  if (starUtf) {
    let v = stripQuotes(starUtf[1]);
    // 可能是 UTF-8''xxx 整段
    const m2 = /^(?:UTF-8|utf-8)''(.+)$/i.exec(v);
    if (m2) v = m2[1];
    return decodeDownloadFilename(v);
  }

  const plain =
    /filename\s*=\s*"((?:\\.|[^"\\])*)"/i.exec(header) ||
    /filename\s*=\s*([^;]+)/i.exec(header);
  if (plain) {
    const v = stripQuotes((plain[1] || plain[2] || '').replace(/\\"/g, '"'));
    return decodeDownloadFilename(v);
  }
  return '';
}

/**
 * 解码并清洗下载文件名（URL 编码 / 引号 / UTF-8 乱码）
 */
function decodeDownloadFilename(name) {
  let n = stripQuotes(name);
  if (!n) return '';

  // 多次 %XX 解码（最多 2 层）
  for (let i = 0; i < 2; i++) {
    if (!/%[0-9A-Fa-f]{2}/.test(n)) break;
    const d = tryDecodeURIComponent(n);
    if (d === n) break;
    n = d;
  }

  n = fixMojibake(n);
  n = n.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim();
  // Windows 保留名
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(n)) n = `_${n}`;
  n = n.slice(0, 180);
  if (!n || n === '.' || n === '..') return '';
  return n;
}

function filenameFromUrl(url) {
  try {
    const u = new URL(String(url));
    let base = path.basename(u.pathname || '');
    base = decodeDownloadFilename(base);
    if (base) return base;
  } catch (_) {}
  return '';
}

/**
 * 综合 suggested / Content-Disposition / URL 选最佳文件名
 */
function pickDownloadFilename(opts = {}) {
  const candidates = [];
  const push = (v, src) => {
    const n = decodeDownloadFilename(v);
    if (n) candidates.push({ name: n, src, cjk: hasCjk(n), mojibake: looksLikeMojibake(n) });
  };
  if (opts.contentDisposition) {
    const fromCd = parseContentDisposition(opts.contentDisposition);
    if (fromCd) candidates.push({ name: fromCd, src: 'cd', cjk: hasCjk(fromCd), mojibake: false });
  }
  push(opts.suggested, 'suggested');
  push(filenameFromUrl(opts.url), 'url');

  if (!candidates.length) {
    return `download-${Date.now()}`;
  }
  // 优先：有中文且非乱码 > 非乱码 > 其它
  candidates.sort((a, b) => {
    const score = (x) => (x.cjk ? 4 : 0) + (x.mojibake ? -3 : 2) + (x.src === 'cd' ? 1 : 0);
    return score(b) - score(a);
  });
  return candidates[0].name;
}

function pathKey(p) {
  const s = path.resolve(String(p || ''));
  if (!s) return '';
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

/** Windows 下大小写不敏感的存在判断；返回实际路径（保留已有文件的真实大小写） */
function existingPath(p) {
  const want = path.resolve(String(p || ''));
  if (!want) return null;
  try {
    if (fs.existsSync(want)) return want;
  } catch (_) {}
  if (process.platform !== 'win32') return null;
  try {
    const dir = path.dirname(want);
    const base = path.basename(want);
    if (!fs.existsSync(dir)) return null;
    const hit = fs.readdirSync(dir).find((n) => n.toLowerCase() === base.toLowerCase());
    if (!hit) return null;
    return path.join(dir, hit);
  } catch (_) {
    return null;
  }
}

/**
 * 路径是否「已占用」：磁盘上有有效文件，或 reserved 集合中（正在写入、尚未 promote）。
 * 空文件（size=0）不视为占用，允许重下覆盖空壳。
 */
function isPathTaken(p, reserved) {
  const want = path.resolve(String(p || ''));
  if (!want) return false;
  const key = pathKey(want);
  const list = Array.isArray(reserved) ? reserved : [];
  for (const r of list) {
    if (pathKey(r) === key) return true;
  }
  const hit = existingPath(want);
  if (!hit) return false;
  try {
    const size = fs.statSync(hit).size;
    return size > 0;
  } catch (_) {
    return true;
  }
}

/**
 * 同名避让。reserved：其它下载正在写入的最终路径，也算占用。
 */
function uniquePath(dir, base, reserved) {
  let p = path.join(dir, base);
  if (!isPathTaken(p, reserved)) return p;
  const ext = path.extname(base);
  const stem = path.basename(base, ext);
  for (let i = 1; i < 1000; i++) {
    p = path.join(dir, `${stem}(${i})${ext}`);
    if (!isPathTaken(p, reserved)) return p;
  }
  return path.join(dir, `${stem}_${Date.now()}${ext}`);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 浏览器原生下载 staging 目录（避免 CDP 直接覆盖最终同名文件） */
function resolveIncomingDir(downloadRoot) {
  const root = path.resolve(String(downloadRoot || ''));
  return path.join(root, '.aihelper-incoming');
}

/**
 * 解析保存目标：支持 path / dir+filename / 默认下载目录。
 * 默认同名 → uniquePath 改名避让（file(1).ext），不覆盖。
 * skipIfExists=true 且同名已存在 → skipped。
 * force=true 覆盖同名（仍写原路径，不改名）。
 * 空文件（size=0）不视为有效同名，允许重下覆盖空壳。
 */
function resolveSaveTarget(opts = {}) {
  const defaultRoot = resolveDownloadRoot(opts.defaultDir || '', opts.userDataPath);
  let dir = defaultRoot;
  let base = '';
  let explicitPath = false;

  if (opts.path) {
    const raw = String(opts.path).trim();
    if (raw) {
      explicitPath = true;
      const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(defaultRoot, raw);
      dir = path.dirname(abs);
      base = path.basename(abs);
    }
  }
  if (!base && opts.dir) {
    const d = String(opts.dir).trim();
    if (d) dir = path.isAbsolute(d) ? path.resolve(d) : path.resolve(defaultRoot, d);
  }
  if (!base && opts.filename) {
    base = decodeDownloadFilename(opts.filename) || String(opts.filename).trim();
  }
  if (!base) {
    base =
      pickDownloadFilename({
        suggested: opts.suggested,
        url: opts.url,
        contentDisposition: opts.contentDisposition
      }) || `download-${Date.now()}`;
  }
  base = decodeDownloadFilename(base) || base.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
  if (!base) base = `download-${Date.now()}`;

  ensureDir(dir);
  let dest = path.join(dir, base);
  const force = opts.force === true;
  // 默认 false：同名改名，不跳过、不覆盖
  const skipIfExists = opts.skipIfExists === true;
  // 其它下载正在写入的最终路径（尚未落盘也算占用）
  const reserved = Array.isArray(opts.reserved) ? opts.reserved : [];
  const existed = existingPath(dest);
  const reservedHit = isPathTaken(dest, reserved) && !existed;

  if (!force && (existed || reservedHit)) {
    let size = 0;
    let occupiedPath = existed || dest;
    if (existed) {
      try {
        size = fs.statSync(existed).size;
      } catch (_) {}
    }
    // 0 字节空壳且无 inflight：不跳过，允许覆盖写
    const effectivelyTaken = reservedHit || size > 0;
    if (effectivelyTaken) {
      if (skipIfExists && !reservedHit) {
        return {
          ok: true,
          skipped: true,
          reason: 'file_exists',
          dir: path.dirname(occupiedPath),
          filename: path.basename(occupiedPath),
          path: occupiedPath,
          size,
          message: '目标文件已存在，跳过下载',
          explicitPath
        };
      }
      if (skipIfExists && reservedHit) {
        // 最终目录尚无文件，但是同名正在写入 → 仍应改名，不能 skip 成「已有」
        dest = uniquePath(dir, base, reserved);
      } else {
        // 默认同名改名避让（force 才覆盖）；含 inflight 占用
        dest = uniquePath(dir, base, reserved);
      }
    } else if (existed) {
      dest = existed;
    }
  }

  return {
    ok: true,
    skipped: false,
    renamed: path.basename(dest) !== base,
    dir: path.dirname(dest),
    filename: path.basename(dest),
    path: dest,
    explicitPath
  };
}

module.exports = {
  resolveDownloadRoot,
  decodeDownloadFilename,
  parseContentDisposition,
  pickDownloadFilename,
  filenameFromUrl,
  uniquePath,
  existingPath,
  isPathTaken,
  pathKey,
  resolveSaveTarget,
  resolveIncomingDir,
  ensureDir,
  hasCjk,
  looksLikeMojibake
};
