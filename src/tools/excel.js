const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');

function read_excel(filePath, sheetName) {
  try {
    const workbook = xlsx.readFile(filePath);
    const sheets = workbook.SheetNames;
    let targetSheet = sheetName || sheets[0];
    if (!sheets.includes(targetSheet)) {
      throw new Error(`工作表 "${targetSheet}" 不存在，可用的工作表有：${sheets.join(', ')}`);
    }
    const worksheet = workbook.Sheets[targetSheet];
    const data = xlsx.utils.sheet_to_json(worksheet, { header: 1 });
    return { sheetName: targetSheet, data, rows: data.length };
  } catch (err) {
    throw new Error(`读取 Excel 失败: ${err.message}`);
  }
}

function write_excel(filePath, data, sheetName = 'Sheet1', options = {}) {
  try {
    let workbook;
    if (fs.existsSync(filePath)) {
      workbook = xlsx.readFile(filePath);
    } else {
      workbook = xlsx.utils.book_new();
    }
    const ws = xlsx.utils.aoa_to_sheet(data);
    xlsx.utils.book_append_sheet(workbook, ws, sheetName);
    xlsx.writeFile(workbook, filePath);
    return { success: true, path: filePath, sheet: sheetName };
  } catch (err) {
    throw new Error(`写入 Excel 失败: ${err.message}`);
  }
}

function list_sheets(filePath) {
  try {
    const workbook = xlsx.readFile(filePath);
    return workbook.SheetNames;
  } catch (err) {
    throw new Error(`列出工作表失败: ${err.message}`);
  }
}

module.exports = { read_excel, write_excel, list_sheets };