/**
 * 弱模型反幻觉护栏：检测“空口成功/伪造结果”，必要时强制复核。
 */

const DEFAULT_ANTI_HALLUCINATION_RULES = `
【强制规则 - 必须遵守】
1. 涉及本地文件、HTTP、网页、登录、点击、读写时：必须先调用工具，禁止凭想象描述结果。
2. 禁止编造：文件内容、目录列表、HTTP 状态码/响应体、网页标题/正文、登录是否成功、截图路径。
3. 工具返回 error 或失败时：必须如实告知失败原因，禁止改口说成功。
4. 没有工具结果时：只能说「尚未执行/无法确认」，并说明下一步要调哪个工具；禁止假装已完成。
5. 最终回答只能基于本轮工具返回的真实数据；可引用工具 JSON 中的字段，不可补充未出现的数据。
6. 不确定就说不确定；做不到就明确说做不到，并给出可执行的替代方案（换路径/检查服务/缩小任务）。
7. 用中文简短回复；先结论后证据（引用工具结果要点）。
8. 浏览器会话会保持（本机可见 Chrome，非无头/非纯截图）：用户可能已手操页面。继续网页任务时先 browser_state，再在当前页 click/type/get_text；不要无故 browser_close 或重复 navigate。
9. 复杂页面可先 browser_record_start，让用户手操一遍，再 browser_record_stop；之后用 browser_flow_run 并传入 vars 替换 {{变量}}。
10. 点击「详情」等表格按钮若超时，继续用 browser_click（可见优先/JS 回退），勿反复盲目 navigate。
11. 这是多轮对话：结合历史理解意图，不要把每条消息当全新任务（除非用户说重新开始）。
12. 下载优先：已知 URL 用 download_file；页面里点下载用 browser_download（可传 filename/path/dir；同名默认跳过）。仅 blob/无 http 链接时才 browser_click(waitDownload:true)。
13. 邮件仅支持本机 Coremail 客户端/已登录网页（非 IMAP/POP3）：mail_list / mail_search / mail_read 等。禁止声称已发送或删除邮件。
14. 【禁止乱点】browser_click 的 text/selector 必须对应：用户原话里点名的控件，或本轮 browser_get_text/state 已确认存在的目标按钮。禁止把用户任务词（如「日志」「查询」「搜索」「下载」）当成导航菜单去点，除非用户明确说点该菜单。不确定先 browser_get_text，不要试探性乱点。
15. 下载落盘：用户指定了文件名/目录时必须传 filename 或 path/dir；同名已存在应跳过并告知路径，不要 silent 改名成 file(1).ext（除非用户要求强制覆盖 force=true）。
16. 【搜索/输入不可跳过】手册或用户写「搜索框输入 xxx / 在输入框填 xxx」时：必须调用 browser_type（text=xxx，clear 默认清空，列表搜索加 pressEnter:true 或 submitSearch:true）。禁止只 click「详情」而跳过 type。type 返回 matched:false 或 value 对不上时必须换 selector/placeholder 重试，禁止当成功继续。
17. 【点击别犹豫】目标已在 get_text/state 中确认存在时，直接 browser_click(text 或 selector)，不要反复 get_text/evaluate 探路。下拉（如 Element el-dropdown）先 click 触发器文本，等菜单出现再 click 选项文本（如「500」），不要用未展开的 .el-select-dropdown__item:nth-child。
18. PAASIVU 类流程：进入应用运行管理 → type 应用名+回车 → click 详情 → **再 type 模板名（如 oa-sp-auth）+回车** → click 详情 → Pod/容器。模板搜索与应用搜索是两步，缺一不可。
19. 【Coremail 共享收件箱】手册目标 fid 为 **1@1**（北京维护管理等共享邮箱），不是个人收件箱 fid=1。
    - **禁止** browser_click(text:"收件箱") / text 仅「收件箱」——会命中 #mltree_1_a（个人箱）。
    - **必须** browser_click({ fid:"1@1" }) 或 selector:'a[fid="1@1"]' 或 #mltree_15_a（以当前 DOM 为准）；可先 within 父邮箱节点再点。
    - 点后用 browser_state 看 URL 是否含 "fid":"1@1"（编码为 1%401）。若是 "fid":1 则点错，立即按 fid 重点。
    - 读信优先 mail_list / mail_read；必须先确保已在 fid=1@1 列表。
`.trim();

const DEFAULT_EFFICIENCY_RULES = `
【效率规则 - 减少轮次】
1. 能一次完成的事不要拆成多轮：同一轮可并行调用多个工具。
2. 拿到足够结果后立刻给出最终中文结论，不要再空转或重复调用相同工具。
3. 浏览器流程尽量连贯：navigate →（必要时 wait）→ type/click → get_text/screenshot，少废话。
4. 工具已返回 ok 的数据直接用，不要为了“再确认”重复读同一文件/同一页面。但 **type 之后** 若下一步依赖筛选结果，可一次 get_text 确认列表已变，不可用“列表里好像已有”为由跳过 type。
5. 失败一次后换参数或换思路；同一操作连续失败 2 次就停止并汇报。
6. 最终回复要短：结论 + 关键证据字段即可。
7. 手册逐步执行：编号步骤（含「搜索框输入」）按序做；不要合并/跳过输入步。
`.trim();

/**
 * 弱模型（Qwen3-30B-A3B 等）操作备忘：短、可执行、禁止跳步。
 * 大模型（122B 等）也注入，因现场以 30B 为主；保持短以免挤占上下文。
 */
const WEAK_MODEL_PLAYBOOK = `
【工具调用备忘 - 逐条照做，禁止跳步】
A. 读手册：用户说按 md/手册 → 先 read_file 手册，再按编号步骤顺序执行；写「搜索框输入」的步骤必须 browser_type，禁止跳过。
B. 输入：browser_type({ selector 或 placeholder, text, pressEnter:true })；看返回 matched/value；不对就换选择器重试。
C. 点击：能写 selector/fid 就不要只用短 text。目标已确认则直接 click，少 evaluate 探路。
D. Coremail 共享收件箱：browser_click({ fid:"1@1" }) 或 a[fid="1@1"]；禁止 text:"收件箱"。点后 URL 须含 1@1（不是 fid:1）。列表/读信优先 mail_list → mail_read。
E. PAASIVU：应用运行管理 → type 应用名+回车 → 详情 → type 模板名(如 oa-sp-auth)+回车 → 详情 → Pod。两步搜索都要做。
F. 失败：工具 error / FID_MISMATCH / CLICK_AMBIGUOUS / 输入未生效 → 换参数再试，最多 2 次，然后如实汇报；禁止说已成功。
G. 回复：中文短句；只引用本轮工具 JSON 字段。
`.trim();

/** 模型名像小/中 MoE 时视为弱模型（默认收紧） */
function isWeakModel(modelName) {
  const m = String(modelName || '').toLowerCase();
  if (!m) return true; // 未知则按弱模型
  if (/122b|72b|70b|65b|67b|qwen3\.5-122|qwen2\.5-72|qwen2\.5-32/i.test(m)) {
    return false;
  }
  if (/30b|32b|14b|7b|8b|9b|3b|4b|1\.5b|a3b|a14b|tiny|mini|small/i.test(m)) {
    return true;
  }
  // Qwen3-30B-A3B 常见写法
  if (/qwen3-30|qwen3\.5-30|qwen2\.5-14|qwen2\.5-7/i.test(m)) return true;
  return true;
}

function buildTaskHint(userMessage) {
  const s = String(userMessage || '');
  const tips = [];
  if (/PAASIVU|paasivu|取日志|查日志|oa-sp|bjfhoamsp|应用运行/i.test(s)) {
    tips.push(
      '本任务含 PAASIVU：严格 type 应用名 → 详情 → type 模板名 → 详情；搜索步不可省。'
    );
  }
  if (/coremail|邮箱|收件箱|维护管理|邮件|fid\s*=?\s*1@1|1@1/i.test(s)) {
    tips.push(
      '本任务含 Coremail：共享箱只能 click fid:"1@1" 或 a[fid="1@1"]，禁止 text 收件箱；确认 URL 含 1@1。'
    );
  }
  if (/手册|\.md|步骤/i.test(s)) {
    tips.push('先 read_file 手册全文，再逐步工具执行，禁止凭记忆跳步。');
  }
  if (!tips.length) return '';
  return '【本轮任务提示】\n' + tips.map((t, i) => `${i + 1}. ${t}`).join('\n');
}

const SUCCESS_CLAIM =
  /(已(经)?(成功|完成|打开|写入|删除|登录|提交|发送|读取|保存|创建|修改|下载|查看|列出)|成功(地)?(完成|打开|写入|登录|提交|读取)|文件内容[如下为是：:]|目录(如下|列表|包含)|邮件(如下|列表|内容)|发件人|收件人|主题[：:]|状态码\s*\d{3}|HTTP\s*\d{3}|登录成功|请求成功|根据我(的)?(检查|查看|了解)|我(已经|已)(帮你|为你)?(打开|读取|下载|发送|登录))/i;

const ACTION_NEED_TOOL =
  /(文件|目录|路径|读写|写入|删除|打开网页|浏览器|登录|点击|输入|表单|POST|GET|请求|接口|http|https|截图|页面|邮件|邮箱|inbox|下载|md\b|markdown)/i;

/** 无工具时仍像在汇报“真实环境结果” */
function looksLikeFabricatedResult(content) {
  if (!content || content.length < 6) return false;
  if (SUCCESS_CLAIM.test(content)) return true;
  // 大段结构化“伪数据”
  if (/(第\s*\d+\s*封|uid\s*[=:：]\s*\d+|从.*收件箱|共\s*\d+\s*封邮件)/i.test(content)) {
    return true;
  }
  if (/(路径[：:]\s*[A-Za-z]:\\|\/home\/|\/Users\/)/.test(content)) return true;
  return false;
}

function looksLikeSuccessWithoutEvidence(content, toolCount) {
  if (!content || toolCount > 0) return false;
  return looksLikeFabricatedResult(content) || SUCCESS_CLAIM.test(content);
}

function taskLikelyNeedsTools(userMessage) {
  if (!userMessage) return false;
  return /(读取|打开|写入|删除|列出|列表|目录|文件|网页|登录|点击|POST|GET|请求|访问|http|https|截图|浏览器|表单|提交|邮件|邮箱|收件箱|未读|下载|查看.*信|搜.*邮|mail|imap|coremail|保存到|执行|运行|检查.*是否|帮我看|去看看)/i.test(
    userMessage
  );
}

function inferPreferredTools(userMessage) {
  const s = String(userMessage || '');
  const tips = [];
  if (/邮件|邮箱|收件箱|未读|imap|coremail|mail|维护管理|fid/i.test(s)) {
    tips.push(
      'Coremail 共享箱：browser_click({fid:"1@1"}) 或 a[fid="1@1"]，禁止 text=收件箱；mail_list/mail_read；点后确认 URL 含 fid 1@1'
    );
  }
  if (/下载|md\b|markdown|\.pdf|\.zip/i.test(s)) {
    tips.push(
      'browser_download(filename/path/dir) / download_file / download_from_markdown / get_download_dir；勿乱点无关菜单'
    );
  }
  if (/文件|目录|读取|写入|删除|列表/i.test(s)) {
    tips.push('list_dir / read_file / write_file');
  }
  if (/网页|浏览器|登录|点击|截图|打开.*http|PAASIVU|搜索框|输入/i.test(s)) {
    tips.push(
      'browser_state → 手册含「搜索框输入」必须 browser_type(text, pressEnter:true) 且校验 matched → browser_click；禁止跳过 type 直接点详情'
    );
  }
  if (/http|api|POST|GET|接口|请求/i.test(s)) {
    tips.push('http_request');
  }
  return tips.length ? tips.join('；') : '与任务匹配的工具';
}

function buildWorkspaceRules(workspace) {
  const ws = String(workspace || '').trim();
  if (!ws) {
    return [
      '【工作区】未配置 paths.workspace。',
      '写文件时必须使用用户给出的绝对路径；禁止把相对路径落到安装目录/程序目录。',
      '请提示用户在设置中配置「默认工作区」。'
    ].join('\n');
  }
  return [
    '【工作区 - 每轮对话生效，必须遵守】',
    `1. 当前默认工作区（workspace）= ${ws}`,
    '2. 所有相对路径（如 notes.txt、./out/a.md、subdir/x）一律相对上述工作区解析，禁止写到安装目录、exe 旁、process.cwd。',
    '3. 用户未指定路径时：list_dir/read/write/append 默认使用工作区；写新文件用「工作区内相对路径」或「工作区绝对路径」。',
    '4. 仅当用户明确给出其他盘符/绝对路径时才离开工作区。',
    '5. 回复中引用路径时尽量给出解析后的绝对路径，便于用户核对。',
    '6. 可用 get_workspace 确认当前工作区。'
  ].join('\n');
}

function buildSystemPrompt(base, agentCfg = {}, runtime = {}) {
  const parts = [];
  if (base) parts.push(base.trim());
  // 工作区规则置顶，每轮对话强制注入
  parts.push(buildWorkspaceRules(runtime.workspace || agentCfg.workspace || ''));
  if (agentCfg.antiHallucination !== false) {
    parts.push(agentCfg.antiHallucinationRules || DEFAULT_ANTI_HALLUCINATION_RULES);
  }
  // 弱模型备忘：默认开；agent.weakModelPlaybook=false 可关；大模型也可 weakModelPlaybook=true 强制开
  const model = runtime.model || agentCfg.model || '';
  const playbookOpt = agentCfg.weakModelPlaybook;
  const usePlaybook =
    playbookOpt === true ||
    (playbookOpt !== false && (isWeakModel(model) || !model));
  if (usePlaybook) {
    parts.push(agentCfg.weakModelPlaybookText || WEAK_MODEL_PLAYBOOK);
  }
  const taskHint = buildTaskHint(runtime.userMessage || '');
  if (taskHint) parts.push(taskHint);
  // 仅在显式打开效率模式时附加，不替代反幻觉规则
  if (agentCfg.efficiencyMode === true) {
    parts.push(agentCfg.efficiencyRules || DEFAULT_EFFICIENCY_RULES);
  }
  if (agentCfg.extraRules) parts.push(String(agentCfg.extraRules).trim());
  return parts.filter(Boolean).join('\n\n');
}

/** 压缩工具结果，减少上下文膨胀与后续无效轮次 */
function compactToolResult(name, result, maxLen = 6000) {
  if (result == null) return { ok: true };
  if (typeof result !== 'object') {
    const s = String(result);
    return { ok: true, value: s.length > maxLen ? s.slice(0, maxLen) + '…' : s };
  }
  const out = { ...result };
  if (out.ok === undefined && !out.error) out.ok = true;

  const trimStr = (v, n) =>
    typeof v === 'string' && v.length > n ? v.slice(0, n) + `…(+${v.length - n})` : v;

  if (name === 'browser_get_html' || out.html) {
    out.html = trimStr(out.html, Math.min(maxLen, 4000));
  }
  if (name === 'browser_get_text' || out.text) {
    out.text = trimStr(out.text, Math.min(maxLen, 5000));
  }
  if (out.content && typeof out.content === 'string') {
    out.content = trimStr(out.content, maxLen);
  }
  if (out.body && typeof out.body === 'string') {
    out.body = trimStr(out.body, Math.min(maxLen, 4000));
  }
  if (Array.isArray(out.items) && out.items.length > 40) {
    out.items = out.items.slice(0, 40);
    out.truncated = true;
    out.itemCount = result.items?.length ?? out.items.length;
  }
  if (out.headers && typeof out.headers === 'object') {
    const keep = ['content-type', 'content-length', 'location', 'set-cookie'];
    const h = {};
    for (const k of Object.keys(out.headers)) {
      if (keep.includes(String(k).toLowerCase())) h[k] = out.headers[k];
    }
    out.headers = h;
  }

  let s = JSON.stringify(out);
  if (s.length > maxLen + 200) {
    return {
      ok: out.ok !== false && !out.error,
      error: out.error,
      summary: s.slice(0, maxLen) + '…',
      truncated: true
    };
  }
  return out;
}

function buildRoundBudgetHint(round, maxRounds, toolCount) {
  const left = maxRounds - round - 1;
  if (left <= 0) {
    return '【轮次耗尽】禁止再调用工具。请仅根据已有工具结果用中文给出最终结论；若不足则明确说未完成原因。';
  }
  if (left === 1) {
    return `【仅剩 1 轮】若还需工具，请在本轮一次性并行调用全部必要工具；下一轮必须直接给最终结论，不要再调工具。已执行工具数=${toolCount}`;
  }
  if (left <= 3) {
    return `【轮次紧张：剩余约 ${left} 轮】请合并步骤、并行工具，尽快收尾。已执行工具数=${toolCount}`;
  }
  return null;
}

function buildForceFinalMessage(trace) {
  const evidence = buildEvidenceBlock(trace);
  return (
    `【系统强制收尾】轮次已用尽或接近上限。禁止再调用任何工具。\n` +
    `请仅根据下列工具结果，用中文给出最终答复（结论 + 关键证据）。若任务未完成，明确列出已完成与未完成项。\n\n` +
    `【工具真实结果】\n${evidence}`
  );
}

function isDuplicateToolCall(trace, name, args) {
  if (!trace || !trace.length) return false;
  let key;
  try {
    key = name + ':' + JSON.stringify(args || {});
  } catch {
    key = name;
  }
  for (let i = trace.length - 1; i >= Math.max(0, trace.length - 8); i--) {
    const t = trace[i];
    let k;
    try {
      k = t.name + ':' + JSON.stringify(t.args || {});
    } catch {
      k = t.name;
    }
    if (k === key) return true;
  }
  return false;
}

/** 常见侧栏/顶栏导航词：用户未点名时禁止 browser_click(text=这些) */
const SPURIOUS_CLICK_TEXTS = [
  '日志',
  '查询',
  '搜索',
  '首页',
  '主页',
  '帮助',
  '设置',
  '关于',
  '退出',
  '登录',
  '注册',
  '消息',
  '通知',
  '工作台',
  '控制台',
  '仪表盘',
  'dashboard',
  'home',
  'log',
  'logs',
  'query',
  'search',
  'settings',
  'help'
];

/**
 * 拦截模型瞎点导航：click text 是常见菜单词，且用户原话未包含该词。
 * 返回 null 表示放行；否则返回要喂给模型的错误结果。
 */
function checkSpuriousBrowserClick(name, args, userMessage) {
  if (name !== 'browser_click' && name !== 'browser_download') return null;
  const text = String((args && args.text) || '').trim();
  const selector = String((args && args.selector) || '').trim();
  const fid = args && (args.fid != null ? String(args.fid) : args.attr && args.attr.fid);
  const msg = String(userMessage || '');

  // Coremail：裸点「收件箱」且无 fid/精确 selector → 拦截（日志里反复点到 mltree_1_a / fid=1）
  const inboxBare =
    text === '收件箱' ||
    text === '草稿箱' ||
    /^收件箱\s*$/.test(text);
  const hasFidHint =
    (fid != null && String(fid).trim() !== '') ||
    /fid\s*=/.test(selector) ||
    /#mltree_\d+_a/i.test(selector) ||
    (args && args.within);
  if (name === 'browser_click' && inboxBare && !hasFidHint) {
    return {
      ok: false,
      error: 'coremail_inbox_ambiguous',
      blockedText: text || selector,
      hint:
        '已拦截：禁止只用 text「收件箱」。共享邮箱收件箱请 browser_click({ fid:"1@1" }) 或 selector:\'a[fid="1@1"]\'（见手册 fid=1@1）。' +
        '点后 browser_state 确认 URL 含 "fid":"1@1"，不是 "fid":1。'
    };
  }

  if (!text) return null;
  // 只拦短、像菜单的纯文本；长文案（用户可能复制的按钮全文）放行
  if (text.length > 12) return null;
  const lower = text.toLowerCase();
  const hit = SPURIOUS_CLICK_TEXTS.find(
    (t) => t === text || t.toLowerCase() === lower
  );
  if (!hit) return null;
  // 用户原话包含该词（或明显点名）则放行
  if (msg.includes(text) || msg.toLowerCase().includes(lower)) return null;
  return {
    ok: false,
    error: 'spurious_click_blocked',
    blockedText: text,
    hint:
      `已拦截：用户指令未要求点击「${text}」。禁止把任务关键词当成导航菜单乱点。` +
      `请先 browser_get_text / browser_state 确认真实控件，再对用户点名的按钮 click；` +
      `下载请用 browser_download 并传 filename/path/dir。`
  };
}

function buildEvidenceBlock(trace) {
  if (!trace || !trace.length) return '（本轮无工具调用记录）';
  return trace
    .map((t, i) => {
      const r = t.result;
      const err = r && r.error;
      const summary = err
        ? { error: err }
        : typeof r === 'object'
          ? r
          : { value: r };
      let s = '';
      try {
        s = JSON.stringify(summary);
      } catch {
        s = String(summary);
      }
      if (s.length > 1200) s = s.slice(0, 1200) + '…';
      return `#${i + 1} ${t.name} => ${s}`;
    })
    .join('\n');
}

function buildGroundingReminder(trace, reason) {
  const evidence = buildEvidenceBlock(trace);
  return (
    `系统复核（${reason}）：你的上一段回复可能包含未经验证的结论。\n` +
    `请严格根据下列【工具真实结果】重新作答；禁止编造。若结果不足，明确说「无法确认/失败」，不要假装成功。\n\n` +
    `【工具真实结果】\n${evidence}\n\n` +
    `请用中文给出最终答复：先结论，再引用上述结果中的关键字段。`
  );
}

function buildNoToolNudge(userMessage, attempt) {
  const preferred = inferPreferredTools(userMessage);
  return (
    `【系统拦截 · 第 ${attempt} 次】你没有调用任何工具就回答了。这在本系统中不允许。\n` +
    `你必须立刻通过 function/tool call 调用工具，禁止只用文字假装已完成。\n` +
    `建议工具：${preferred}\n` +
    `若确实无法调用，只能回复「无法调用工具：原因…」，禁止编造文件/邮件/网页内容。\n` +
    `用户原话：${String(userMessage || '').slice(0, 500)}`
  );
}

function buildRejectUnverifiedMessage(userMessage, fakeReply) {
  return (
    `【系统拒绝虚假回答】下列回复在未调用工具时给出了不可核实的结论，已作废：\n` +
    `---\n${String(fakeReply || '').slice(0, 800)}\n---\n` +
    `请立即调用工具（${inferPreferredTools(userMessage)}）获取真实数据后再答；` +
    `或明确说做不到。禁止再次编造。`
  );
}

function buildHonestNoToolReply(userMessage) {
  return (
    `未能完成：需要访问真实环境（文件/网页/邮件/下载等），但模型未成功调用工具，系统已拦截可能的虚假回答。\n` +
    `建议：1) 确认配置中「操作类强制先调工具 / 拒绝无证据结论」已开启；` +
    `2) 换用更支持 function call 的模型；3) 把任务写得更具体（例如「调用 mail_list 列出最近 5 封」）。\n` +
    `用户需求摘要：${String(userMessage || '').slice(0, 200)}`
  );
}

function wrapFinalContent(content, opts = {}) {
  const { toolCount, hadToolErrors, unverified, rejectedFake } = opts;
  let out = content || '';
  const notes = [];
  if (rejectedFake) {
    notes.push('系统已拦截无工具证据的回答，以下为诚实说明而非模型编造内容。');
  }
  if (unverified) {
    notes.push('系统提示：该回答在缺少工具证据时生成，请谨慎采信。');
  }
  if (hadToolErrors) {
    notes.push('注意：本轮部分工具调用失败，请以下方工具结果为准。');
  }
  if (toolCount === 0 && taskLikelyNeedsTools(opts.userMessage || '')) {
    notes.push('本轮未调用工具，涉及环境状态的结论可能不准确。');
  }
  if (notes.length) {
    out = `${out}\n\n---\n${notes.map((n) => `⚠ ${n}`).join('\n')}`;
  }
  return out;
}

module.exports = {
  DEFAULT_ANTI_HALLUCINATION_RULES,
  DEFAULT_EFFICIENCY_RULES,
  WEAK_MODEL_PLAYBOOK,
  buildWorkspaceRules,
  buildSystemPrompt,
  isWeakModel,
  buildTaskHint,
  looksLikeSuccessWithoutEvidence,
  looksLikeFabricatedResult,
  taskLikelyNeedsTools,
  inferPreferredTools,
  buildGroundingReminder,
  buildNoToolNudge,
  buildRejectUnverifiedMessage,
  buildHonestNoToolReply,
  wrapFinalContent,
  buildEvidenceBlock,
  compactToolResult,
  buildRoundBudgetHint,
  buildForceFinalMessage,
  isDuplicateToolCall,
  checkSpuriousBrowserClick
};
