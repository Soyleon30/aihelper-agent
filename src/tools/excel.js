const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const xlsx = require('xlsx');
const { resolveSafePath, normalizePathInput } = require('./file');

const DEFAULT_MAX_ROWS = 5000;
const DEFAULT_MAX_CELLS = 200000;

function normalizeAllowedRoots(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const n = normalizePathInput(item);
    if (!n) continue;
    const abs = path.resolve(n);
    const key = process.platform === 'win32' ? abs.toLowerCase() : abs;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(abs);
  }
  return out;
}

function pickSheetName(workbook, sheet) {
  const names = workbook.SheetNames || [];
  if (!names.length) throw new Error('工作簿没有工作表');
  if (sheet == null || sheet === '') return names[0];
  if (typeof sheet === 'number' && Number.isFinite(sheet)) {
    const idx = Math.trunc(sheet);
    if (idx < 0 || idx >= names.length) {
      throw new Error(`工作表索引越界: ${idx}，共 ${names.length} 个: ${names.join(', ')}`);
    }
    return names[idx];
  }
  const name = String(sheet);
  if (!names.includes(name)) {
    throw new Error(`工作表不存在: ${name}，可用: ${names.join(', ')}`);
  }
  return name;
}

function loadWorkbook(file) {
  if (!fs.existsSync(file)) throw new Error(`文件不存在: ${file}`);
  return xlsx.readFile(file, { cellDates: true, dense: false });
}

function sheetToMatrix(worksheet, maxRows) {
  const rows = xlsx.utils.sheet_to_json(worksheet, {
    header: 1,
    defval: null,
    raw: true,
    blankrows: false
  });
  if (rows.length > maxRows) {
    return { rows: rows.slice(0, maxRows), truncated: true, totalRows: rows.length };
  }
  return { rows, truncated: false, totalRows: rows.length };
}

function matrixToObjects(matrix, headerRow = 0) {
  if (!matrix.length) return { headers: [], records: [] };
  const headers = (matrix[headerRow] || []).map((h, i) => {
    const s = h == null || h === '' ? `col_${i + 1}` : String(h).trim();
    return s || `col_${i + 1}`;
  });
  const records = [];
  for (let r = headerRow + 1; r < matrix.length; r++) {
    const row = matrix[r] || [];
    if (row.every((c) => c == null || c === '')) continue;
    const obj = {};
    for (let c = 0; c < headers.length; c++) {
      obj[headers[c]] = row[c] == null ? null : row[c];
    }
    records.push(obj);
  }
  return { headers, records };
}

function toNumber(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const s = String(v).replace(/,/g, '').replace(/%$/, '').trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function summarizeColumn(values) {
  const nums = [];
  let nonEmpty = 0;
  const unique = new Set();
  for (const v of values) {
    if (v == null || v === '') continue;
    nonEmpty += 1;
    unique.add(String(v));
    const n = toNumber(v);
    if (n != null) nums.push(n);
  }
  const out = {
    count: values.length,
    nonEmpty,
    empty: values.length - nonEmpty,
    unique: unique.size
  };
  if (nums.length) {
    let sum = 0;
    let min = nums[0];
    let max = nums[0];
    for (const n of nums) {
      sum += n;
      if (n < min) min = n;
      if (n > max) max = n;
    }
    out.numericCount = nums.length;
    out.sum = sum;
    out.avg = sum / nums.length;
    out.min = min;
    out.max = max;
  }
  return out;
}

function groupAndAggregate(records, groupBy, metrics) {
  const groups = new Map();
  for (const rec of records) {
    const keyParts = (groupBy || []).map((g) => {
      const v = rec[g];
      return v == null ? '' : String(v);
    });
    const key = keyParts.join('\u0001') || '(全部)';
    if (!groups.has(key)) {
      groups.set(key, { _key: keyParts, _rows: [] });
    }
    groups.get(key)._rows.push(rec);
  }

  const result = [];
  for (const g of groups.values()) {
    const row = {};
    (groupBy || []).forEach((name, i) => {
      row[name] = g._key[i] === '' ? null : g._key[i];
    });
    row._count = g._rows.length;
    for (const m of metrics || []) {
      const col = m.column || m.col || m.field;
      if (!col) continue;
      const op = String(m.op || m.agg || 'sum').toLowerCase();
      const vals = g._rows.map((r) => r[col]);
      const nums = vals.map(toNumber).filter((n) => n != null);
      const alias = m.as || `${op}_${col}`;
      if (op === 'count') {
        row[alias] = vals.filter((v) => v != null && v !== '').length;
      } else if (op === 'sum') {
        row[alias] = nums.reduce((a, b) => a + b, 0);
      } else if (op === 'avg' || op === 'mean') {
        row[alias] = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
      } else if (op === 'min') {
        row[alias] = nums.length ? Math.min(...nums) : null;
      } else if (op === 'max') {
        row[alias] = nums.length ? Math.max(...nums) : null;
      } else if (op === 'unique') {
        row[alias] = new Set(vals.filter((v) => v != null && v !== '').map(String)).size;
      } else {
        row[alias] = nums.reduce((a, b) => a + b, 0);
      }
    }
    result.push(row);
  }
  return result;
}

function createExcelTools(options = {}) {
  const cfg = options.config || {};
  const maxRows = cfg.maxRows || DEFAULT_MAX_ROWS;
  const maxCells = cfg.maxCells || DEFAULT_MAX_CELLS;
  let allowedRoots = normalizeAllowedRoots(cfg.allowedRoots || []);
  const workspaceRaw = String(cfg.workspace || options.workspace || '').trim();
  const workspace = workspaceRaw ? path.resolve(normalizePathInput(workspaceRaw)) : '';
  if (workspace && allowedRoots.length) {
    const wk = process.platform === 'win32' ? workspace.toLowerCase() : workspace;
    if (!allowedRoots.some((r) => (process.platform === 'win32' ? r.toLowerCase() : r) === wk)) {
      allowedRoots = [...allowedRoots, workspace];
    }
  }

  function safePath(p) {
    return resolveSafePath(p, allowedRoots, workspace);
  }

  return {
    async list_sheets(args = {}) {
      const file = safePath(args.path);
      const wb = loadWorkbook(file);
      return {
        path: file,
        sheets: wb.SheetNames.map((name, index) => ({ name, index })),
        count: wb.SheetNames.length
      };
    },

    async read_excel(args = {}) {
      const file = safePath(args.path);
      const wb = loadWorkbook(file);
      const sheetName = pickSheetName(wb, args.sheet != null ? args.sheet : args.sheetName);
      const ws = wb.Sheets[sheetName];
      const limit = Math.min(Number(args.maxRows) || maxRows, maxRows);
      const { rows, truncated, totalRows } = sheetToMatrix(ws, limit);
      const cells = rows.reduce((n, r) => n + (r ? r.length : 0), 0);
      if (cells > maxCells) {
        throw new Error(`单元格过多(${cells})，超过上限 ${maxCells}，请缩小范围或提高 maxRows 限制`);
      }
      const asObjects = args.asObjects !== false && args.header !== false;
      if (asObjects) {
        const headerRow = Number.isFinite(args.headerRow) ? Math.max(0, Math.trunc(args.headerRow)) : 0;
        const { headers, records } = matrixToObjects(rows, headerRow);
        return {
          path: file,
          sheet: sheetName,
          headers,
          rows: records,
          rowCount: records.length,
          totalRows,
          truncated,
          format: 'objects'
        };
      }
      return {
        path: file,
        sheet: sheetName,
        rows,
        rowCount: rows.length,
        totalRows,
        truncated,
        format: 'matrix'
      };
    },

    async write_excel(args = {}) {
      const file = safePath(args.path);
      const sheetName = String(args.sheet || args.sheetName || 'Sheet1').slice(0, 31) || 'Sheet1';
      let matrix;
      if (Array.isArray(args.data) && args.data.length && !Array.isArray(args.data[0]) && typeof args.data[0] === 'object') {
        const headers =
          Array.isArray(args.headers) && args.headers.length
            ? args.headers.map(String)
            : Object.keys(args.data[0]);
        matrix = [headers, ...args.data.map((obj) => headers.map((h) => (obj && obj[h] != null ? obj[h] : null)))];
      } else if (Array.isArray(args.data)) {
        matrix = args.data;
      } else {
        throw new Error('data 必须是二维数组，或对象数组（可配 headers）');
      }

      await fsp.mkdir(path.dirname(file), { recursive: true });
      let wb;
      if (fs.existsSync(file) && args.appendSheet) {
        wb = loadWorkbook(file);
        if (wb.SheetNames.includes(sheetName)) {
          if (args.overwriteSheet === false) {
            throw new Error(`工作表已存在: ${sheetName}，设置 overwriteSheet:true 可覆盖`);
          }
          const idx = wb.SheetNames.indexOf(sheetName);
          delete wb.Sheets[sheetName];
          wb.SheetNames.splice(idx, 1);
        }
      } else {
        wb = xlsx.utils.book_new();
      }
      const ws = xlsx.utils.aoa_to_sheet(matrix);
      xlsx.utils.book_append_sheet(wb, ws, sheetName);
      xlsx.writeFile(wb, file);
      return {
        path: file,
        sheet: sheetName,
        rows: matrix.length,
        cols: matrix[0] ? matrix[0].length : 0
      };
    },

    async excel_summary(args = {}) {
      const file = safePath(args.path);
      const wb = loadWorkbook(file);
      const sheetName = pickSheetName(wb, args.sheet != null ? args.sheet : args.sheetName);
      const ws = wb.Sheets[sheetName];
      const limit = Math.min(Number(args.maxRows) || maxRows, maxRows);
      const { rows, truncated, totalRows } = sheetToMatrix(ws, limit);
      const headerRow = Number.isFinite(args.headerRow) ? Math.max(0, Math.trunc(args.headerRow)) : 0;
      const { headers, records } = matrixToObjects(rows, headerRow);

      const columns = Array.isArray(args.columns) && args.columns.length ? args.columns.map(String) : headers;
      const columnStats = {};
      for (const col of columns) {
        columnStats[col] = summarizeColumn(records.map((r) => r[col]));
      }

      let groups = null;
      const groupBy = Array.isArray(args.groupBy)
        ? args.groupBy.map(String)
        : args.groupBy
          ? [String(args.groupBy)]
          : [];
      const metrics = Array.isArray(args.metrics) ? args.metrics : [];
      if (groupBy.length || metrics.length) {
        const defaultMetrics =
          metrics.length > 0
            ? metrics
            : columns
                .filter((c) => !groupBy.includes(c))
                .slice(0, 8)
                .map((c) => ({ column: c, op: 'sum', as: `sum_${c}` }));
        groups = groupAndAggregate(records, groupBy, defaultMetrics);
        if (args.sortBy) {
          const sb = String(args.sortBy);
          const desc = args.sortDesc !== false;
          groups.sort((a, b) => {
            const av = a[sb];
            const bv = b[sb];
            if (av == null && bv == null) return 0;
            if (av == null) return 1;
            if (bv == null) return -1;
            if (av < bv) return desc ? 1 : -1;
            if (av > bv) return desc ? -1 : 1;
            return 0;
          });
        }
        const top = Number(args.topN) || 0;
        if (top > 0) groups = groups.slice(0, top);
      }

      return {
        path: file,
        sheet: sheetName,
        headers,
        rowCount: records.length,
        totalRows,
        truncated,
        columnStats,
        groups,
        groupBy: groupBy.length ? groupBy : undefined
      };
    },

    async excel_merge(args = {}) {
      const paths = Array.isArray(args.paths) ? args.paths : args.path ? [args.path] : [];
      if (paths.length < 1) throw new Error('paths 至少需要 1 个 Excel 文件');
      const outPath = safePath(args.output || args.out || args.dest);
      const sheetName = String(args.sheet || '汇总').slice(0, 31) || '汇总';
      const headerRow = Number.isFinite(args.headerRow) ? Math.max(0, Math.trunc(args.headerRow)) : 0;
      const addSource = args.addSource !== false;

      let headers = null;
      const all = [];
      const sources = [];

      for (const p of paths) {
        const file = safePath(p);
        const wb = loadWorkbook(file);
        const sn = pickSheetName(wb, args.sourceSheet != null ? args.sourceSheet : args.sheetName);
        const { rows } = sheetToMatrix(wb.Sheets[sn], maxRows);
        const { headers: h, records } = matrixToObjects(rows, headerRow);
        if (!headers) headers = h.slice();
        else {
          for (const col of h) {
            if (!headers.includes(col)) headers.push(col);
          }
        }
        for (const rec of records) {
          if (addSource) rec._source = path.basename(file);
          all.push(rec);
        }
        sources.push({ path: file, sheet: sn, rows: records.length });
      }

      if (addSource && headers && !headers.includes('_source')) headers.push('_source');
      const matrix = [
        headers || [],
        ...all.map((obj) => (headers || []).map((h) => (obj && obj[h] != null ? obj[h] : null)))
      ];

      await fsp.mkdir(path.dirname(outPath), { recursive: true });
      const wb = xlsx.utils.book_new();
      xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(matrix), sheetName);
      xlsx.writeFile(wb, outPath);

      return {
        path: outPath,
        sheet: sheetName,
        rows: all.length,
        sources,
        headers
      };
    }
  };
}

module.exports = { createExcelTools };
