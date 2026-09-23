/**
 * 可靠 ZIP：优先 tar -a，其次 7z，最后 Compress-Archive。
 * Compress-Archive 打大目录（含 Chromium）时，部分解压工具会报「头部错误」。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync, execSync, spawnSync } = require('child_process');

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function which(cmd) {
  try {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], {
      encoding: 'utf8',
      windowsHide: true
    });
    if (r.status === 0 && r.stdout) {
      return String(r.stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || null;
    }
  } catch (_) {}
  return null;
}

function readHeader(file, n = 4) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, 0);
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

/** 校验本地 zip：PK 头 + 能列出至少一个条目 */
function validateZip(zipPath) {
  if (!fs.existsSync(zipPath)) {
    return { ok: false, error: '文件不存在' };
  }
  const st = fs.statSync(zipPath);
  if (st.size < 22) {
    return { ok: false, error: `文件过小 (${st.size} bytes)` };
  }
  const head = readHeader(zipPath, 4);
  const isPk = head[0] === 0x50 && head[1] === 0x4b;
  if (!isPk) {
    return {
      ok: false,
      error: `非 ZIP 头: ${head.toString('hex')}（若是 .exe 请直接运行，勿当 zip 解压）`
    };
  }
  // 用 tar 列目录（Windows 10+ 自带）
  try {
    const out = execFileSync('tar', ['-tf', zipPath], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true
    });
    const lines = String(out || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!lines.length) {
      return { ok: false, error: 'ZIP 内无条目' };
    }
    return { ok: true, entries: lines.length, size: st.size, method: 'tar-tf' };
  } catch (e) {
    // tar 失败再试 PowerShell
    try {
      const ps = `
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $z = [IO.Compression.ZipFile]::OpenRead('${zipPath.replace(/'/g, "''")}')
        $n = $z.Entries.Count
        $z.Dispose()
        if ($n -lt 1) { throw 'empty' }
        Write-Output $n
      `;
      const n = String(
        execSync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, {
          encoding: 'utf8',
          windowsHide: true
        })
      ).trim();
      const count = parseInt(n, 10);
      if (!count) return { ok: false, error: 'ZIP 内无条目 (dotnet)' };
      return { ok: true, entries: count, size: st.size, method: 'dotnet' };
    } catch (e2) {
      return {
        ok: false,
        error: `无法读取 ZIP 目录: ${(e && e.message) || e}; ${(e2 && e2.message) || e2}`
      };
    }
  }
}

/**
 * @param {string} srcDir 要打进 zip 的目录（内容，不含外层文件夹名时由 storeRoot 控制）
 * @param {string} zipPath 目标 zip
 * @param {{ storeAsRoot?: boolean }} opts storeAsRoot=true 时 zip 内为 srcDir 内文件（与旧行为一致）
 */
function zipDir(srcDir, zipPath, opts = {}) {
  if (!fs.existsSync(srcDir)) {
    throw new Error('源目录不存在: ' + srcDir);
  }
  ensureDir(path.dirname(zipPath));
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

  const absSrc = path.resolve(srcDir);
  const absZip = path.resolve(zipPath);
  const errors = [];

  // 1) tar -a（Windows 自带 bsdtar，兼容性通常好于 Compress-Archive）
  try {
    execFileSync('tar', ['-a', '-c', '-f', absZip, '-C', absSrc, '.'], {
      stdio: 'inherit',
      windowsHide: true
    });
    const v = validateZip(absZip);
    if (v.ok) {
      console.log(`ZIP OK (tar -a): ${path.basename(absZip)} entries=${v.entries} size=${v.size}`);
      return { ok: true, method: 'tar', ...v };
    }
    errors.push('tar validate: ' + v.error);
    try {
      fs.unlinkSync(absZip);
    } catch (_) {}
  } catch (e) {
    errors.push('tar: ' + (e.message || e));
    try {
      if (fs.existsSync(absZip)) fs.unlinkSync(absZip);
    } catch (_) {}
  }

  // 2) 7-Zip
  const seven =
    which('7z') ||
    which('7za') ||
    [
      process.env['ProgramFiles'] && path.join(process.env['ProgramFiles'], '7-Zip', '7z.exe'),
      process.env['ProgramFiles(x86)'] &&
        path.join(process.env['ProgramFiles(x86)'], '7-Zip', '7z.exe')
    ]
      .filter(Boolean)
      .find((p) => fs.existsSync(p));

  if (seven) {
    try {
      // a = add archive; -tzip; 内容为 src\*
      execFileSync(seven, ['a', '-tzip', '-mx=5', absZip, path.join(absSrc, '*')], {
        stdio: 'inherit',
        windowsHide: true
      });
      const v = validateZip(absZip);
      if (v.ok) {
        console.log(`ZIP OK (7z): ${path.basename(absZip)} entries=${v.entries}`);
        return { ok: true, method: '7z', ...v };
      }
      errors.push('7z validate: ' + v.error);
      try {
        fs.unlinkSync(absZip);
      } catch (_) {}
    } catch (e) {
      errors.push('7z: ' + (e.message || e));
      try {
        if (fs.existsSync(absZip)) fs.unlinkSync(absZip);
      } catch (_) {}
    }
  }

  // 3) Compress-Archive（最后手段；大包可能被部分工具报头部错误）
  try {
    const psPath = absSrc.replace(/'/g, "''");
    const zipPs = absZip.replace(/'/g, "''");
    execSync(
      `powershell -NoProfile -Command "Compress-Archive -Path '${psPath}\\*' -DestinationPath '${zipPs}' -CompressionLevel Optimal -Force"`,
      { stdio: 'inherit', windowsHide: true }
    );
    const v = validateZip(absZip);
    if (v.ok) {
      console.warn(
        'ZIP 使用 Compress-Archive 生成；若解压报「头部错误」，请改用 7-Zip 解压，或直接拷贝 win-unpacked 目录。'
      );
      console.log(`ZIP OK (Compress-Archive): ${path.basename(absZip)} entries=${v.entries}`);
      return { ok: true, method: 'Compress-Archive', ...v };
    }
    errors.push('Compress-Archive validate: ' + v.error);
  } catch (e) {
    errors.push('Compress-Archive: ' + (e.message || e));
  }

  throw new Error('ZIP 创建失败:\n- ' + errors.join('\n- '));
}

module.exports = { zipDir, validateZip, readHeader };
