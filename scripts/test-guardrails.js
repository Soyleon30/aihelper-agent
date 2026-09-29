/**
 * 护栏纯函数冒烟测试（无 Electron / 无网络）。
 * 运行：node scripts/test-guardrails.js  或  npm test
 */
const assert = require('assert');
const g = require('../src/agent/guardrails');

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed += 1;
  console.log('  ok', name);
}

console.log('guardrails');

ok(
  'taskLikelyNeedsTools: 读文件',
  g.taskLikelyNeedsTools('请读取 D:\\a.txt 并总结')
);
ok(
  'taskLikelyNeedsTools: 闲聊否',
  !g.taskLikelyNeedsTools('你好，今天天气怎么样')
);

ok(
  'looksLikeFabricatedResult: 成功话术',
  g.looksLikeFabricatedResult('我已经帮你登录成功了')
);
ok(
  'looksLikeFabricatedResult: 短句否',
  !g.looksLikeFabricatedResult('好的')
);
ok(
  'looksLikeSuccessWithoutEvidence: 无工具却成功',
  g.looksLikeSuccessWithoutEvidence('文件内容如下：hello', 0)
);
ok(
  'looksLikeSuccessWithoutEvidence: 有工具则放行',
  !g.looksLikeSuccessWithoutEvidence('文件内容如下：hello', 1)
);

ok(
  'checkSpuriousBrowserClick: 拦日志',
  g.checkSpuriousBrowserClick('browser_click', { text: '日志' }, '帮我下载报告') !=
    null
);
ok(
  'checkSpuriousBrowserClick: 用户点名则放行',
  g.checkSpuriousBrowserClick('browser_click', { text: '日志' }, '请点击日志菜单') ==
    null
);
ok(
  'checkSpuriousBrowserClick: 非 click 放行',
  g.checkSpuriousBrowserClick('browser_type', { text: '日志' }, '随便') == null
);
ok(
  'checkSpuriousBrowserClick: 长文本放行',
  g.checkSpuriousBrowserClick(
    'browser_click',
    { text: '这是一个很长的按钮文案超过十二字' },
    '点一下'
  ) == null
);
ok(
  'checkSpuriousBrowserClick: 裸收件箱拦截',
  g.checkSpuriousBrowserClick('browser_click', { text: '收件箱' }, '打开维护管理邮件') !=
    null
);
ok(
  'checkSpuriousBrowserClick: fid=1@1 放行',
  g.checkSpuriousBrowserClick(
    'browser_click',
    { fid: '1@1', text: '收件箱' },
    '打开收件箱'
  ) == null
);
ok(
  'checkSpuriousBrowserClick: a[fid] 放行',
  g.checkSpuriousBrowserClick(
    'browser_click',
    { selector: 'a[fid="1@1"]' },
    '打开收件箱'
  ) == null
);

ok(
  'isDuplicateToolCall: 重复',
  g.isDuplicateToolCall(
    [{ name: 'read_file', args: { path: 'a' } }],
    'read_file',
    { path: 'a' }
  )
);
ok(
  'isDuplicateToolCall: 不同参数',
  !g.isDuplicateToolCall(
    [{ name: 'read_file', args: { path: 'a' } }],
    'read_file',
    { path: 'b' }
  )
);

const prompt = g.buildSystemPrompt('基座', { antiHallucination: true }, { model: 'Qwen3-30B-A3B' });
ok('buildSystemPrompt: 含强制规则', /必须先调用工具/.test(prompt));
ok('buildSystemPrompt: 30B 含备忘', /工具调用备忘|fid:"1@1"|搜索框输入/.test(prompt));
ok(
  'buildSystemPrompt: 效率默认关',
  !/减少轮次/.test(g.buildSystemPrompt('基座', { antiHallucination: true }))
);
ok(
  'buildSystemPrompt: 效率显式开',
  /减少轮次/.test(
    g.buildSystemPrompt('基座', { antiHallucination: true, efficiencyMode: true })
  )
);
ok('isWeakModel: 30B', g.isWeakModel('Qwen3-30B-A3B') === true);
ok('isWeakModel: 122B', g.isWeakModel('Qwen3.5-122B-A10B') === false);
ok(
  'buildTaskHint: coremail',
  /1@1/.test(g.buildTaskHint('打开北京维护管理收件箱 fid=1@1'))
);
ok(
  'buildSystemPrompt: 任务提示注入',
  /本轮任务提示|PAASIVU/.test(
    g.buildSystemPrompt(
      '基座',
      { antiHallucination: true },
      { model: 'Qwen3-30B-A3B', userMessage: '按手册查 PAASIVU 日志' }
    )
  )
);

const compact = g.compactToolResult(
  'browser_get_text',
  { ok: true, text: 'x'.repeat(10000) },
  500
);
ok('compactToolResult: 截断 text', String(compact.text || '').length < 10000);

const honest = g.buildHonestNoToolReply('读邮件');
ok('buildHonestNoToolReply: 非空', honest.length > 20);

const wrapped = g.wrapFinalContent('结论', {
  toolCount: 0,
  unverified: true,
  userMessage: '读取文件'
});
ok('wrapFinalContent: 带提示', /系统提示|未调用工具/.test(wrapped));

console.log(`\n${passed} passed`);
