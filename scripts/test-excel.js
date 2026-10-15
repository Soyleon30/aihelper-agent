const fs = require('fs');
const path = require('path');
const os = require('os');
const { createExcelTools } = require('../src/tools/excel');

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihelper-excel-'));
  const tools = createExcelTools({
    config: { workspace: dir, allowedRoots: [dir] },
    workspace: dir
  });

  const p1 = path.join(dir, 'a.xlsx');
  const p2 = path.join(dir, 'b.xlsx');
  const out = path.join(dir, 'merged.xlsx');

  await tools.write_excel({
    path: p1,
    data: [
      { 部门: '销售', 金额: 100, 数量: 2 },
      { 部门: '销售', 金额: 50, 数量: 1 },
      { 部门: '研发', 金额: 200, 数量: 3 }
    ]
  });
  await tools.write_excel({
    path: p2,
    data: [
      { 部门: '销售', 金额: 30, 数量: 1 },
      { 部门: '运营', 金额: 80, 数量: 4 }
    ]
  });

  const sheets = await tools.list_sheets({ path: p1 });
  if (!sheets.sheets.length) throw new Error('list_sheets empty');

  const read = await tools.read_excel({ path: p1 });
  if (read.rowCount !== 3) throw new Error('read rowCount ' + read.rowCount);

  const sum = await tools.excel_summary({
    path: p1,
    groupBy: ['部门'],
    metrics: [{ column: '金额', op: 'sum', as: '总金额' }]
  });
  if (!sum.groups || sum.groups.length !== 2) throw new Error('groups fail');
  const sales = sum.groups.find((g) => g['部门'] === '销售');
  if (!sales || sales['总金额'] !== 150) throw new Error('sum fail ' + JSON.stringify(sales));

  const merged = await tools.excel_merge({ paths: [p1, p2], output: out });
  if (merged.rows !== 5) throw new Error('merge rows ' + merged.rows);

  console.log('excel ok', { dir, sheets: sheets.count, groups: sum.groups.length, merged: merged.rows });
  fs.rmSync(dir, { recursive: true, force: true });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
