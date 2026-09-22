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
8. 浏览器会话会保持：用户可能已手动操作页面。继续网页任务时先 browser_state，再在当前页操作；不要无故 browser_close 或重复 navigate。
9. 复杂页面可先 browser_record_start，让用户手操一遍，再 browser_record_stop；之后用 browser_flow_run 并传入 vars 替换 {{变量}}（如应用名、日志路径）。
10. 点击「详情」等表格按钮若超时，继续用 browser_click（已自动可见优先/JS 回退），勿反复盲目 navigate 回退。
9. 这是多轮对话：结合历史上下文理解用户意图，不要把每条消息当成全新独立任务（除非用户明确说重新开始）。
10. 下载文件必须用 download_file / download_from_markdown，保存到配置的下载目录；同一 URL 不要重复下载（工具会自动跳过）。从 md 提取链接批量下时先 download_from_markdown 一次即可。
11. 邮件仅支持通过本机 Coremail 客户端/已登录网页查看（非 IMAP/POP3）：mail_list / mail_search / mail_read / mail_list_folders / mail_test / mail_launch_client。禁止声称已发送或删除邮件。读信前用户通常需已登录。
`.trim();

const DEFAULT_EFFICIENCY_RULES = `
【效率规则 - 减少轮次】
1. 能一次完成的事不要拆成多轮：同一轮可并行调用多个工具。
2. 拿到足够结果后立刻给出最终中文结论，不要再空转或重复调用相同工具。
3. 浏览器流程尽量连贯：navigate →（必要时 wait）→ type/click → get_text/screenshot，少废话。
4. 工具已返回 ok 的数据直接用，不要为了“再确认”重复读同一文件/同一页面。
5. 失败一次后换参数或换思路；同一操作连续失败 2 次就停止并汇报。
6. 最终回复要短：结论 + 关键证据字段即可。
`.trim();

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
  if (/邮件|邮箱|收件箱|未读|imap|coremail|mail/i.test(s)) {
    tips.push('mail_list / mail_search / mail_read / mail_test');
  }
  if (/下载|md\b|markdown|\.pdf|\.zip/i.test(s)) {
    tips.push('download_file / download_from_markdown / get_download_dir');
  }
  if (/文件|目录|读取|写入|删除|列表/i.test(s)) {
    tips.push('list_dir / read_file / write_file');
  }
  if (/网页|浏览器|登录|点击|截图|打开.*http/i.test(s)) {
    tips.push('browser_state / browser_navigate / browser_click / browser_get_text');
  }
  if (/http|api|POST|GET|接口|请求/i.test(s)) {
    tips.push('http_request');
  }
  return tips.length ? tips.join('；') : '与任务匹配的工具';
}

function buildSystemPrompt(base, agentCfg = {}) {
  const parts = [];
  if (base) parts.push(base.trim());
  if (agentCfg.antiHallucination !== false) {
    parts.push(agentCfg.antiHallucinationRules || DEFAULT_ANTI_HALLUCINATION_RULES);
  }
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
  buildSystemPrompt,
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
  isDuplicateToolCall
};
