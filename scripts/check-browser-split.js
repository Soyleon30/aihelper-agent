const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'src', 'tools', 'browser');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && !f.startsWith('_'));
const bad = [];
for (const f of files) {
  // 去掉注释再扫 require，避免把说明文字当成依赖
  const s = fs
    .readFileSync(path.join(dir, f), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  const reqs = [...s.matchAll(/require\(['"](\.[^'"]+)['"]\)/g)].map((m) => m[1]);
  for (const r of reqs) {
    if (r === './paths' || r === './stealth' || r.startsWith('../')) continue;
    if (f === 'index.js') continue;
    if (
      ['./click', './download', './flow', './launch', './tools', './util', './page-text'].includes(
        r
      )
    ) {
      // tools.js 可依赖 page-text；其它业务模块互引用仍算坏依赖
      if (!(f === 'tools.js' && r === './page-text')) bad.push(`${f}->${r}`);
    }
  }
}
console.log(bad.length ? 'BAD deps: ' + bad.join('; ') : 'deps OK');

const { TOOL_DEFINITIONS } = require('../src/tools/definitions');
const names = TOOL_DEFINITIONS.map((t) => t.function.name).filter(
  (n) => n.startsWith('browser_') || n === 'get_screenshot_dir'
);
const { createBrowserTools } = require('../src/tools/browser');
const t = createBrowserTools({ config: {}, userDataPath: process.cwd() });
const missing = names.filter((n) => typeof t[n] !== 'function');
const extra = Object.keys(t).filter((k) => !k.startsWith('_') && !names.includes(k));
console.log('missing', missing);
console.log('extra', extra);
console.log('handlers', Object.keys(t).filter((k) => !k.startsWith('_')).length);

// download 内应走 getRobustClick，不应裸调 robustClick(
const dl = fs.readFileSync(path.join(dir, 'download.js'), 'utf8');
const bare = (dl.match(/[^t] robustClick\(/g) || []).length;
const via = (dl.match(/getRobustClick\(\)\(/g) || []).length;
console.log('download bare robustClick', bare, 'via getRobustClick', via);

const fl = fs.readFileSync(path.join(dir, 'flow.js'), 'utf8');
console.log(
  'flow bare robustClick',
  (fl.match(/[^t] robustClick\(/g) || []).length,
  'via getRobustClick',
  (fl.match(/getRobustClick\(\)\(/g) || []).length
);
