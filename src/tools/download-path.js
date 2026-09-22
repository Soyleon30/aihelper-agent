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

function uniquePath(dir, base) {
  let p = path.join(dir, base);
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(base);
  const stem = path.basename(base, ext);
  for (let i = 1; i < 1000; i++) {
    p = path.join(dir, `${stem}(${i})${ext}`);
    if (!fs.existsSync(p)) return p;
  }
  return path.join(dir, `${stem}_${Date.now()}${ext}`);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = {
  resolveDownloadRoot,
  decodeDownloadFilename,
  parseContentDisposition,
  pickDownloadFilename,
  filenameFromUrl,
  uniquePath,
  ensureDir,
  hasCjk,
  looksLikeMojibake
};
