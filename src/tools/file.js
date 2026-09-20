const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

/** 规范化路径：去引号、统一分隔符、Windows 下小写盘符便于比较 */
function normalizePathInput(p) {
  let s = String(p || '').trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  // 用户从 JSON 复制时可能写成 D:\\work，折叠多余反斜杠
  if (process.platform === 'win32') {
    s = s.replace(/\//g, '\\').replace(/\\{2,}/g, '\\');
  }
  return s;
}

function normKey(p) {
  const r = path.resolve(normalizePathInput(p));
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

/**
 * 白名单规则：
 * - 空列表 = 不限制
 * - 填了父目录则其下所有子路径自动允许（不必再给子目录单独授权）
 * - 不必写双斜杠，D:\\work 与 D:\\work 均可
 */
function resolveSafePath(inputPath, allowedRoots) {
  const resolved = path.resolve(normalizePathInput(inputPath));
  if (!allowedRoots || !allowedRoots.length) return resolved;

  const target = normKey(resolved);
  const ok = allowedRoots.some((root) => {
    const r = normKey(root);
    if (!r) return false;
    return target === r || target.startsWith(r + path.sep.toLowerCase()) || target.startsWith(r + path.sep);
  });
  // Windows: path.sep is `\`, normKey lowercases so sep is still `\`
  if (!ok) {
    const roots = allowedRoots.map((x) => path.resolve(normalizePathInput(x))).join(' | ');
    throw new Error(
      `路径不在允许范围内: ${resolved}。白名单根目录（含子目录自动允许）: ${roots || '(空)'}`
    );
  }
  return resolved;
}

function normalizeAllowedRoots(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const n = normalizePathInput(item);
    if (!n) continue;
    const abs = path.resolve(n);
    const key = normKey(abs);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(abs);
  }
  return out;
}

function createFileTools(options = {}) {
  const cfg = options.config || {};
  const maxRead = cfg.maxReadBytes || 2 * 1024 * 1024;
  const allowedRoots = normalizeAllowedRoots(cfg.allowedRoots || []);

  return {
    async list_dir(args) {
      const dir = resolveSafePath(args.path, allowedRoots);
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      const items = await Promise.all(
        entries.map(async (e) => {
          const full = path.join(dir, e.name);
          let size = null;
          try {
            const st = await fsp.stat(full);
            size = st.size;
          } catch (_) {}
          return {
            name: e.name,
            type: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other',
            path: full,
            size
          };
        })
      );
      return { path: dir, count: items.length, items };
    },

    async read_file(args) {
      const file = resolveSafePath(args.path, allowedRoots);
      const st = await fsp.stat(file);
      if (!st.isFile()) throw new Error('不是文件');
      const limit = Math.min(args.maxBytes || maxRead, maxRead);
      if (st.size > limit) {
        const buf = Buffer.alloc(limit);
        const fh = await fsp.open(file, 'r');
        try {
          await fh.read(buf, 0, limit, 0);
        } finally {
          await fh.close();
        }
        const encoding = args.encoding || 'utf8';
        return {
          path: file,
          truncated: true,
          size: st.size,
          content: buf.toString(encoding)
        };
      }
      const content = await fsp.readFile(file, args.encoding || 'utf8');
      return { path: file, truncated: false, size: st.size, content };
    },

    async write_file(args) {
      const file = resolveSafePath(args.path, allowedRoots);
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, args.content ?? '', args.encoding || 'utf8');
      return { path: file, bytes: Buffer.byteLength(args.content ?? '', 'utf8') };
    },

    async append_file(args) {
      const file = resolveSafePath(args.path, allowedRoots);
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.appendFile(file, args.content ?? '', 'utf8');
      return { path: file, appended: Buffer.byteLength(args.content ?? '', 'utf8') };
    },

    async delete_path(args) {
      const target = resolveSafePath(args.path, allowedRoots);
      const st = await fsp.stat(target);
      if (st.isDirectory()) {
        await fsp.rmdir(target);
      } else {
        await fsp.unlink(target);
      }
      return { path: target, deleted: true };
    }
  };
}

module.exports = {
  createFileTools,
  resolveSafePath,
  normalizePathInput,
  normalizeAllowedRoots
};
