/**
 * 下载同名策略冒烟（无网络）。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  resolveSaveTarget,
  uniquePath,
  existingPath,
  resolveIncomingDir
} = require('../src/tools/download-path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-dl-'));
let n = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  n += 1;
  console.log('  ok', name);
}

console.log('download-path');

const f1 = path.join(tmp, 'report.pdf');
fs.writeFileSync(f1, 'hello');

const skip = resolveSaveTarget({
  filename: 'report.pdf',
  defaultDir: tmp,
  skipIfExists: true,
  force: false
});
ok('skip when exists', skip.skipped === true && skip.path === f1);

// 默认（不传 skipIfExists）→ 改名避让
const def = resolveSaveTarget({
  filename: 'report.pdf',
  defaultDir: tmp,
  force: false
});
ok(
  'default renames',
  !def.skipped && def.path !== f1 && /report\(1\)\.pdf$/i.test(def.path) && def.renamed === true
);

const uniq = resolveSaveTarget({
  filename: 'report.pdf',
  defaultDir: tmp,
  skipIfExists: false,
  force: false
});
ok('unique when not skip', !uniq.skipped && uniq.path !== f1 && /report\(\d+\)\.pdf$/i.test(uniq.path));

const force = resolveSaveTarget({
  filename: 'report.pdf',
  defaultDir: tmp,
  skipIfExists: true,
  force: true
});
ok('force overwrites path', !force.skipped && force.path === f1);

const empty = path.join(tmp, 'empty.bin');
fs.writeFileSync(empty, '');
const reEmpty = resolveSaveTarget({
  filename: 'empty.bin',
  defaultDir: tmp,
  skipIfExists: true,
  force: false
});
ok('empty file not skipped', !reEmpty.skipped);

if (process.platform === 'win32') {
  const mixed = path.join(tmp, 'Case.TXT');
  fs.writeFileSync(mixed, 'x');
  const hit = existingPath(path.join(tmp, 'case.txt'));
  ok('win case-insensitive exists', !!hit);
}

const stage = resolveIncomingDir(tmp);
ok('incoming under root', stage === path.join(tmp, '.aihelper-incoming'));

const u = uniquePath(tmp, 'report.pdf');
ok('uniquePath increments', /report\(\d+\)\.pdf$/i.test(u));

// cleanup
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch (_) {}

console.log(`\n${n} passed`);
