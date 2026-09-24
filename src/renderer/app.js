(() => {
  const state = {
    config: null,
    history: [],
    busy: false,
    activeProviderKey: 'local',
    session: null,
    autosaveTimer: null,
    dirty: false,
    lastSavedAt: null
  };

  const $ = (id) => document.getElementById(id);
  const messagesEl = $('messages');
  const inputEl = $('input');
  const btnSend = $('btnSend');
  const btnAbort = $('btnAbort');
  const btnClear = $('btnClear');
  const tracePanel = $('tracePanel');
  const testResult = $('testResult');

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  async function copyText(text) {
    const t = String(text ?? '');
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(t);
        return true;
      }
    } catch (_) {}
    try {
      const ta = document.createElement('textarea');
      ta.value = t;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (_) {
      return false;
    }
  }

  function flashCopyBtn(btn) {
    if (!btn) return;
    const old = btn.textContent;
    btn.textContent = '已复制';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = old;
      btn.classList.remove('copied');
    }, 1200);
  }

  function addMessage(role, content, extraClass = '', opts = {}) {
    const div = document.createElement('div');
    div.className = `msg ${role} ${extraClass}`.trim();
    div.dataset.role = role;
    div.dataset.raw = String(content ?? '');

    const head = document.createElement('div');
    head.className = 'msg-head';
    const roleEl = document.createElement('div');
    roleEl.className = 'role';
    roleEl.textContent = role;
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'btn-copy';
    copyBtn.textContent = '复制';
    copyBtn.title = '复制本条内容';
    copyBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const ok = await copyText(div.dataset.raw || '');
      if (ok) flashCopyBtn(copyBtn);
    });
    head.appendChild(roleEl);
    if (role === 'user' || role === 'assistant' || role === 'tool') {
      head.appendChild(copyBtn);
    }

    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = String(content ?? '');

    div.appendChild(head);
    div.appendChild(body);
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    if (!opts.skipPersist && (role === 'user' || role === 'assistant' || role === 'tool')) {
      state.dirty = true;
      setSaveHint('有未保存更改…');
    }
    return div;
  }

  async function copyAllChat() {
    const parts = [];
    messagesEl.querySelectorAll('.msg').forEach((m) => {
      const role = m.dataset.role || '';
      if (role === 'system') return;
      const raw = m.dataset.raw || m.querySelector('.body')?.textContent || '';
      if (!raw) return;
      parts.push(`[${role}]\n${raw}`);
    });
    const text = parts.join('\n\n');
    if (!text) return;
    const ok = await copyText(text);
    if (ok) flashCopyBtn($('btnCopyAll'));
  }

  function setBusy(busy) {
    state.busy = busy;
    btnSend.disabled = busy;
    btnAbort.disabled = !busy;
    inputEl.disabled = busy;
  }

  function switchView(name) {
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
    $(`view-${name}`).classList.add('active');
    document.querySelector(`.nav-btn[data-view="${name}"]`).classList.add('active');
  }

  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  function getProviderFormKey() {
    return $('cfgActiveProvider').value;
  }

  function fillProviderFields(key) {
    const p = state.config.providers[key];
    if (!p) return;
    $('cfgBaseUrl').value = p.baseUrl || '';
    $('cfgApiPath').value = p.apiPath || '/chat/completions';
    $('cfgApiKey').value = p.apiKey || '';
    $('cfgModel').value = p.model || '';
    $('cfgTemperature').value = p.temperature ?? 0.3;
    $('cfgMaxTokens').value = p.maxTokens ?? 4096;
    $('cfgTimeout').value = p.timeoutMs ?? 120000;
  }

  function readProviderFieldsIntoConfig() {
    const key = getProviderFormKey();
    const p = state.config.providers[key] || {};
    p.baseUrl = $('cfgBaseUrl').value.trim();
    p.apiPath = ($('cfgApiPath').value || '/chat/completions').trim();
    p.apiKey = $('cfgApiKey').value;
    p.model = $('cfgModel').value.trim();
    p.temperature = Number($('cfgTemperature').value);
    p.maxTokens = Number($('cfgMaxTokens').value);
    p.timeoutMs = Number($('cfgTimeout').value);
    state.config.providers[key] = p;
    state.config.providers.active = key;
  }

  function fillConfigForm() {
    const c = state.config;
    $('cfgActiveProvider').value = c.providers.active || 'local';
    fillProviderFields($('cfgActiveProvider').value);
    $('cfgSystemPrompt').value = c.agent?.systemPrompt || '';
    $('cfgMaxRounds').value =
      c.agent?.maxToolRounds === undefined || c.agent?.maxToolRounds === null
        ? 0
        : c.agent.maxToolRounds;
    $('cfgMaxHistory').value =
      c.agent?.maxHistoryTurns === undefined || c.agent?.maxHistoryTurns === null
        ? 0
        : c.agent.maxHistoryTurns;
    $('cfgToolResultMax').value = c.agent?.toolResultMaxLen ?? 6000;
    $('cfgConfirmDanger').checked = !!c.agent?.confirmDangerousOps;
    $('cfgAntiHallucination').checked = c.agent?.antiHallucination !== false;
    $('cfgForceTools').checked = c.agent?.forceToolsForActions !== false;
    $('cfgRequireToolChoice').checked = c.agent?.requireToolChoice !== false;
    $('cfgRejectUnverified').checked = c.agent?.rejectUnverifiedAnswers !== false;
    $('cfgMaxNudges').value = c.agent?.maxToolNudges ?? 2;
    $('cfgVerifyFinal').checked = c.agent?.verifyFinal !== false;
    $('cfgMaxRechecks').value = c.agent?.maxRechecks ?? 1;
    $('cfgEfficiency').checked = !!c.agent?.efficiencyMode;
    $('cfgForceFinalLast').checked = !!c.agent?.forceFinalOnLastRound;
    $('cfgRoundBudget').checked = !!c.agent?.roundBudgetHints;
    $('cfgParallelTools').checked = !!c.agent?.parallelTools;
    $('cfgSkipDupTools').checked = !!c.agent?.skipDuplicateTools;
    $('cfgTrimHistory').checked = !!c.agent?.trimHistory;
    $('cfgCompactResults').checked = !!c.agent?.compactToolResults;
    $('cfgFileEnabled').checked = c.tools?.file?.enabled !== false;
    $('cfgHttpEnabled').checked = c.tools?.http?.enabled !== false;
    $('cfgDownloadEnabled').checked = c.tools?.download?.enabled !== false;
    $('cfgDownloadDir').value =
      c.tools?.download?.dir || c.paths?.downloadDir || '';
    $('cfgScreenshotDir').value =
      c.tools?.browser?.screenshotDir || c.paths?.screenshotDir || '';
    $('cfgDownloadSkip').checked = c.tools?.download?.skipIfExists === true;
    $('cfgDownloadDedupeHash').checked = c.tools?.download?.dedupeByHash !== false;
    const mail = c.tools?.mail || {};
    $('cfgMailEnabled').checked = mail.enabled !== false;
    $('cfgMailBaseUrl').value = mail.baseUrl || mail.webmailUrl || '';
    $('cfgMailExe').value = mail.exePath || '';
    $('cfgMailFolder').value = mail.folder || '收件箱';
    $('cfgBrowserEnabled').checked = c.tools?.browser?.enabled !== false;
    $('cfgBrowserHeadless').checked = !!c.tools?.browser?.headless;
    $('cfgBrowserStealth').checked = c.tools?.browser?.stealth !== false;
    $('cfgBrowserSystem').checked = c.tools?.browser?.preferSystemBrowser !== false;
    $('cfgBrowserKeep').checked = c.tools?.browser?.keepSession !== false;
    if ($('cfgBrowserExe')) {
      $('cfgBrowserExe').value =
        c.tools?.browser?.executablePath || c.tools?.browser?.chromePath || '';
    }
    if ($('cfgBrowserUserData')) {
      $('cfgBrowserUserData').value = c.tools?.browser?.userDataDir || '';
    }
    if ($('cfgBrowserEphemeral')) {
      $('cfgBrowserEphemeral').checked =
        c.tools?.browser?.ephemeral === true || c.tools?.browser?.incognito === true;
    }
    $('cfgAllowedRoots').value = (c.tools?.file?.allowedRoots || []).join('\n');
    const lg = c.logging || {};
    $('cfgLogEnabled').checked = lg.enabled !== false;
    $('cfgLogLevel').value = lg.level || 'info';
    $('cfgLogDir').value = lg.dir || '';
    $('cfgLogChatContent').checked =
      lg.logChatContent !== false && lg.logConversations !== false;
    $('cfgLogToolArgs').checked = lg.logToolArgs !== false;
    $('cfgLogToolResult').checked = lg.logToolResult !== false;
    $('cfgLogUiClicks').checked = lg.logUiClicks !== false;
    $('cfgLogBrowserActions').checked = lg.logBrowserActions !== false;
    $('cfgLogRedact').checked = lg.redact !== false;
    $('cfgLogRedactEmail').checked = lg.redactEmails !== false;
    $('cfgLogRedactPhone').checked = lg.redactPhones !== false;
    $('cfgLogRedactId').checked = lg.redactIds === true;
    updateProviderLabel();
  }

  function collectConfigFromForm() {
    readProviderFieldsIntoConfig();
    state.config.agent = state.config.agent || {};
    state.config.agent.systemPrompt = $('cfgSystemPrompt').value;
    const mr = Number($('cfgMaxRounds').value);
    state.config.agent.maxToolRounds = Number.isFinite(mr) ? mr : 0;
    const mh = Number($('cfgMaxHistory').value);
    state.config.agent.maxHistoryTurns = Number.isFinite(mh) ? mh : 0;
    const tr = Number($('cfgToolResultMax').value);
    state.config.agent.toolResultMaxLen = Number.isFinite(tr) && tr > 0 ? tr : 6000;
    state.config.agent.confirmDangerousOps = $('cfgConfirmDanger').checked;
    state.config.agent.antiHallucination = $('cfgAntiHallucination').checked;
    state.config.agent.forceToolsForActions = $('cfgForceTools').checked;
    state.config.agent.requireToolChoice = $('cfgRequireToolChoice').checked;
    state.config.agent.rejectUnverifiedAnswers = $('cfgRejectUnverified').checked;
    state.config.agent.maxToolNudges = Number($('cfgMaxNudges').value) || 0;
    state.config.agent.verifyFinal = $('cfgVerifyFinal').checked;
    state.config.agent.maxRechecks = Number($('cfgMaxRechecks').value) || 0;
    state.config.agent.efficiencyMode = $('cfgEfficiency').checked;
    state.config.agent.forceFinalOnLastRound = $('cfgForceFinalLast').checked;
    state.config.agent.roundBudgetHints = $('cfgRoundBudget').checked;
    state.config.agent.parallelTools = $('cfgParallelTools').checked;
    state.config.agent.skipDuplicateTools = $('cfgSkipDupTools').checked;
    state.config.agent.trimHistory = $('cfgTrimHistory').checked;
    state.config.agent.compactToolResults = $('cfgCompactResults').checked;
    state.config.tools = state.config.tools || {};
    state.config.tools.file = state.config.tools.file || {};
    state.config.tools.http = state.config.tools.http || {};
    state.config.tools.browser = state.config.tools.browser || {};
    state.config.tools.file.enabled = $('cfgFileEnabled').checked;
    state.config.tools.http.enabled = $('cfgHttpEnabled').checked;
    state.config.tools.download = state.config.tools.download || {};
    state.config.tools.download.enabled = $('cfgDownloadEnabled').checked;
    state.config.tools.download.dir = ($('cfgDownloadDir').value || '').trim();
    state.config.tools.download.skipIfExists = $('cfgDownloadSkip').checked;
    state.config.tools.download.dedupeByHash = $('cfgDownloadDedupeHash').checked;
    state.config.paths = state.config.paths || {};
    state.config.paths.downloadDir = state.config.tools.download.dir;
    state.config.tools.browser = state.config.tools.browser || {};
    state.config.tools.browser.screenshotDir = (
      $('cfgScreenshotDir').value || ''
    ).trim();
    state.config.paths.screenshotDir = state.config.tools.browser.screenshotDir;
    state.config.tools.mail = state.config.tools.mail || {};
    state.config.tools.mail.enabled = $('cfgMailEnabled').checked;
    state.config.tools.mail.mode = 'client';
    state.config.tools.mail.baseUrl = ($('cfgMailBaseUrl').value || '').trim();
    state.config.tools.mail.exePath = ($('cfgMailExe').value || '').trim();
    state.config.tools.mail.folder =
      ($('cfgMailFolder').value || '收件箱').trim() || '收件箱';
    // 清除旧 IMAP 字段，避免误用
    delete state.config.tools.mail.host;
    delete state.config.tools.mail.port;
    delete state.config.tools.mail.user;
    delete state.config.tools.mail.password;
    delete state.config.tools.mail.secure;
    delete state.config.tools.mail.rejectUnauthorized;
    state.config.tools.browser.enabled = $('cfgBrowserEnabled').checked;
    state.config.tools.browser.downloadDir = state.config.tools.download.dir;
    state.config.tools.browser.headless = $('cfgBrowserHeadless').checked;
    state.config.tools.browser.stealth = $('cfgBrowserStealth').checked;
    state.config.tools.browser.preferSystemBrowser = $('cfgBrowserSystem').checked;
    state.config.tools.browser.keepSession = $('cfgBrowserKeep').checked;
    if ($('cfgBrowserExe')) {
      state.config.tools.browser.executablePath = ($('cfgBrowserExe').value || '').trim();
    }
    if ($('cfgBrowserUserData')) {
      state.config.tools.browser.userDataDir = ($('cfgBrowserUserData').value || '').trim();
    }
    if ($('cfgBrowserEphemeral')) {
      state.config.tools.browser.ephemeral = $('cfgBrowserEphemeral').checked;
    }
    state.config.tools.file.allowedRoots = $('cfgAllowedRoots').value
      .split(/\r?\n/)
      .map((s) => {
        let t = s.trim();
        if (
          (t.startsWith('"') && t.endsWith('"')) ||
          (t.startsWith("'") && t.endsWith("'"))
        ) {
          t = t.slice(1, -1).trim();
        }
        // 去掉用户误写的双反斜杠 D:\\work → D:\work
        t = t.replace(/\\{2,}/g, '\\').replace(/\//g, '\\');
        return t.trim();
      })
      .filter(Boolean);
    state.config.logging = state.config.logging || {};
    state.config.logging.enabled = $('cfgLogEnabled').checked;
    state.config.logging.level = $('cfgLogLevel').value || 'info';
    state.config.logging.dir = ($('cfgLogDir').value || '').trim();
    state.config.logging.logChatContent = $('cfgLogChatContent').checked;
    state.config.logging.logConversations = $('cfgLogChatContent').checked;
    state.config.logging.logToolArgs = $('cfgLogToolArgs').checked;
    state.config.logging.logToolResult = $('cfgLogToolResult').checked;
    state.config.logging.logUiClicks = $('cfgLogUiClicks').checked;
    state.config.logging.logBrowserActions = $('cfgLogBrowserActions').checked;
    state.config.logging.redact = $('cfgLogRedact').checked;
    state.config.logging.redactEmails = $('cfgLogRedactEmail').checked;
    state.config.logging.redactPhones = $('cfgLogRedactPhone').checked;
    state.config.logging.redactIds = $('cfgLogRedactId').checked;
    return state.config;
  }

  function logUi(event, data) {
    try {
      if (window.aihelper && window.aihelper.logUi) {
        window.aihelper.logUi(event, data);
      }
    } catch (_) {}
  }

  function describeEl(el) {
    if (!el || !el.tagName) return {};
    const id = el.id ? `#${el.id}` : '';
    const cls =
      el.className && typeof el.className === 'string'
        ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
        : '';
    const text = (el.innerText || el.value || el.getAttribute?.('aria-label') || '')
      .toString()
      .trim()
      .slice(0, 60);
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      name: el.getAttribute?.('name') || undefined,
      text: text || undefined,
      path: `${el.tagName.toLowerCase()}${id}${cls}`
    };
  }

  // 应用内点击：事件委托，低频、异步，不阻塞 UI
  document.addEventListener(
    'click',
    (e) => {
      const t = e.target;
      if (!t) return;
      const btn = t.closest ? t.closest('button, a, .nav-btn, input[type="checkbox"], input[type="submit"]') : t;
      if (!btn) return;
      logUi('ui.click', {
        view: document.querySelector('.view.active')?.id || null,
        target: describeEl(btn)
      });
    },
    true
  );

  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      logUi('ui.nav', { view: btn.dataset.view });
    });
  });

  function updateProviderLabel() {
    const key = state.config?.providers?.active || 'local';
    const p = state.config?.providers?.[key];
    $('providerLabel').textContent = p?.name || key;
    state.activeProviderKey = key;
  }

  function setSaveHint(text) {
    const el = $('sessionSaveHint');
    if (el) el.textContent = text || '';
  }

  function updateSessionTitle() {
    const el = $('sessionTitle');
    if (!el) return;
    if (!state.session) {
      el.textContent = '无会话';
      return;
    }
    const n = (state.session.messages || []).length;
    el.textContent = `${state.session.title || state.session.id} · ${n} 条消息 · 多轮`;
  }

  async function refreshSessionList() {
    const sel = $('sessionSelect');
    if (!sel) return;
    const list = (await window.aihelper.listSessions()) || [];
    const cur = state.session?.id;
    sel.innerHTML = '';
    if (!list.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '（无历史会话）';
      sel.appendChild(opt);
      return;
    }
    for (const s of list) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = `${s.title || s.id}`.slice(0, 36);
      if (s.id === cur) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  function renderSessionMessages(sess) {
    messagesEl.innerHTML = '';
    const ui = sess?.uiMessages;
    if (Array.isArray(ui) && ui.length) {
      for (const m of ui) {
        addMessage(m.role || 'system', m.content || '', m.extraClass || '', {
          skipPersist: true
        });
      }
    } else if (Array.isArray(sess?.messages) && sess.messages.length) {
      for (const m of sess.messages) {
        if (m.role === 'user' || m.role === 'assistant') {
          addMessage(m.role, m.content || '', '', { skipPersist: true });
        }
      }
    } else {
      addMessage('system', '新对话已就绪。可连续多轮提问；关闭应用后仍会从文件恢复。', '', {
        skipPersist: true
      });
    }
  }

  function collectUiMessages() {
    const out = [];
    messagesEl.querySelectorAll('.msg').forEach((m) => {
      const role = m.dataset.role || 'system';
      const content = m.dataset.raw || m.querySelector('.body')?.textContent || '';
      out.push({ role, content });
    });
    return out;
  }

  async function persistSession(reason) {
    if (!state.session) return;
    state.session.messages = state.history.slice();
    state.session.uiMessages = collectUiMessages();
    const r = await window.aihelper.saveSession(state.session);
    if (r?.ok) {
      state.dirty = false;
      state.lastSavedAt = r.updatedAt || new Date().toISOString();
      setSaveHint(`已存盘 ${new Date(state.lastSavedAt).toLocaleTimeString()} (${reason || 'auto'})`);
      await refreshSessionList();
    } else {
      setSaveHint(`存盘失败: ${r?.error || 'unknown'}`);
    }
  }

  function scheduleAutosave() {
    if (state.autosaveTimer) clearInterval(state.autosaveTimer);
    const ms = Math.max(5000, state.config?.session?.autosaveMs || 15000);
    state.autosaveTimer = setInterval(() => {
      if (state.dirty && state.session && !state.busy) {
        persistSession('定时');
      }
    }, ms);
  }

  async function loadSessionIntoUi(sess) {
    state.session = sess;
    state.history = Array.isArray(sess.messages)
      ? sess.messages.filter((m) => m.role === 'user' || m.role === 'assistant')
      : [];
    state.dirty = false;
    renderSessionMessages(sess);
    updateSessionTitle();
    setSaveHint(sess.updatedAt ? `上次保存 ${new Date(sess.updatedAt).toLocaleString()}` : '');
    await refreshSessionList();
  }

  async function loadConfig() {
    state.config = await window.aihelper.getConfig();
    fillConfigForm();
    const paths = await window.aihelper.getPaths();
    $('pathInfo').textContent = JSON.stringify(paths, null, 2);
    if (paths.logs) {
      const custom = (state.config?.logging?.dir || '').trim();
      $('logPathHint').textContent = custom
        ? `当前日志目录(自定义): ${paths.logs}`
        : `当前日志目录(默认): ${paths.logs}`;
    }
    if (paths.sessions) {
      const hint = $('logPathHint');
      if (hint) {
        hint.textContent += ` | 会话目录: ${paths.sessions}`;
      }
    }
    if ($('screenshotPathHint')) {
      $('screenshotPathHint').textContent = paths.screenshots
        ? `当前截图目录: ${paths.screenshots}`
        : '';
    }
    const ver = await window.aihelper.getVersion();
    $('appVersion').textContent = `v${ver}`;
    scheduleAutosave();
  }

  $('btnPickLogDir').addEventListener('click', async () => {
    const dir = await window.aihelper.selectDirectory();
    if (dir) $('cfgLogDir').value = dir;
  });

  $('btnClearLogDir').addEventListener('click', () => {
    $('cfgLogDir').value = '';
  });

  $('btnOpenLogs').addEventListener('click', async () => {
    await window.aihelper.openLogDir();
  });

  $('btnMailPickExe')?.addEventListener('click', async () => {
    const p = await window.aihelper.selectFile([
      { name: 'Executable', extensions: ['exe'] },
      { name: 'All', extensions: ['*'] }
    ]);
    if (p) $('cfgMailExe').value = p;
  });

  $('btnMailTest').addEventListener('click', async () => {
    const el = $('mailTestResult');
    el.textContent = '检测中…';
    el.style.color = 'var(--muted)';
    try {
      collectConfigFromForm();
      await window.aihelper.saveConfig(state.config);
      const r = await window.aihelper.mailTest();
      if (r.ok) {
        const bits = [r.message || '可用'];
        if (r.exePath) bits.push('客户端');
        if (r.browser?.open) bits.push('网页会话');
        if (r.baseUrl) bits.push(r.baseUrl);
        el.textContent = bits.join(' · ').slice(0, 160);
        el.style.color = 'var(--ok)';
      } else {
        el.textContent = `不可用: ${r.error || r.message || 'unknown'}`;
        el.style.color = 'var(--danger)';
      }
    } catch (err) {
      el.textContent = err.message || String(err);
      el.style.color = 'var(--danger)';
    }
  });

  $('btnPickDownloadDir').addEventListener('click', async () => {
    const dir = await window.aihelper.selectDirectory();
    if (dir) $('cfgDownloadDir').value = dir;
  });

  $('btnOpenDownloadDir').addEventListener('click', async () => {
    let dir = ($('cfgDownloadDir').value || '').trim();
    if (!dir) {
      const paths = await window.aihelper.getPaths();
      dir = paths.downloadsApp || paths.downloads || '';
    }
    if (dir) await window.aihelper.openPath(dir);
  });

  $('btnPickScreenshotDir').addEventListener('click', async () => {
    const dir = await window.aihelper.selectDirectory();
    if (dir) $('cfgScreenshotDir').value = dir;
  });

  $('btnOpenScreenshotDir').addEventListener('click', async () => {
    let dir = ($('cfgScreenshotDir').value || '').trim();
    if (!dir) {
      const paths = await window.aihelper.getPaths();
      dir = paths.screenshots || '';
    }
    if (dir) {
      await window.aihelper.openPath(dir);
    }
  });

  $('cfgActiveProvider').addEventListener('change', () => {
    readProviderFieldsIntoConfig();
    fillProviderFields(getProviderFormKey());
  });

  $('btnSaveConfig').addEventListener('click', async () => {
    const cfg = collectConfigFromForm();
    await window.aihelper.saveConfig(cfg);
    updateProviderLabel();
    testResult.textContent = '已保存';
    testResult.style.color = 'var(--ok)';
    try {
      const paths = await window.aihelper.getPaths();
      if (paths.logs) {
        const custom = (cfg.logging?.dir || '').trim();
        $('logPathHint').textContent = custom
          ? `当前日志目录(自定义): ${paths.logs}`
          : `当前日志目录(默认): ${paths.logs}`;
      }
    } catch (_) {}
  });

  $('btnResetConfig').addEventListener('click', async () => {
    state.config = await window.aihelper.resetConfig();
    fillConfigForm();
    testResult.textContent = '已恢复默认';
  });

  $('btnTestProvider').addEventListener('click', async () => {
    collectConfigFromForm();
    await window.aihelper.saveConfig(state.config);
    testResult.textContent = '测试中…';
    testResult.style.color = 'var(--muted)';
    const key = state.config.providers.active;
    const r = await window.aihelper.testProvider(key);
    if (r.ok) {
      testResult.textContent = `成功 · ${r.model} · ${r.sample || ''}`.slice(0, 120);
      testResult.style.color = 'var(--ok)';
      $('providerStatus').className = 'status-dot ok';
    } else {
      testResult.textContent = `失败: ${r.error}`;
      testResult.style.color = 'var(--danger)';
      $('providerStatus').className = 'status-dot err';
    }
  });

  $('btnAddRoot').addEventListener('click', async () => {
    const dir = await window.aihelper.selectDirectory();
    if (!dir) return;
    const cur = $('cfgAllowedRoots').value.trim();
    $('cfgAllowedRoots').value = cur ? `${cur}\n${dir}` : dir;
  });

  $('btnCopyAll').addEventListener('click', () => {
    copyAllChat();
  });

  btnClear.addEventListener('click', async () => {
    state.history = [];
    messagesEl.innerHTML = '';
    tracePanel.classList.add('hidden');
    tracePanel.textContent = '';
    addMessage('system', '本对话已清空（会话文件仍保留，可点「保存」覆盖）');
    if (state.session) {
      state.session.messages = [];
      state.session.uiMessages = collectUiMessages();
      state.dirty = true;
      updateSessionTitle();
    }
  });

  let aborting = false;
  btnAbort.addEventListener('click', async () => {
    if (aborting) return;
    aborting = true;
    // 立即解锁 UI（后台仍会尽快中断；Playwright 最长约 1 步会结束）
    setBusy(false);
    addMessage('system', '正在停止…');
    try {
      const r = await window.aihelper.abort();
      if (r && r.ok === false) {
        addMessage('system', r.error || '当前没有进行中的任务');
      }
    } catch (e) {
      addMessage('system', '停止请求已发送');
    } finally {
      aborting = false;
    }
  });

  $('btnNewSession').addEventListener('click', async () => {
    if (state.dirty) await persistSession('换新对话前');
    const sess = await window.aihelper.createSession({ title: '新对话' });
    await loadSessionIntoUi(sess);
    addMessage('system', '已新建多轮对话。浏览器页面仍保持（如已打开）。');
  });

  $('btnSaveSession').addEventListener('click', async () => {
    await persistSession('手动');
  });

  $('sessionSelect').addEventListener('change', async () => {
    const id = $('sessionSelect').value;
    if (!id || id === state.session?.id) return;
    if (state.dirty) await persistSession('切换前');
    const sess = await window.aihelper.loadSession(id);
    if (sess) await loadSessionIntoUi(sess);
  });

  async function send() {
    const text = inputEl.value.trim();
    if (!text || state.busy) return;
    if (!state.session) {
      state.session = await window.aihelper.createSession({});
    }
    inputEl.value = '';
    logUi('ui.chat_send', { msgLen: text.length, sessionId: state.session?.id });
    addMessage('user', text);
    setBusy(true);
    tracePanel.classList.remove('hidden');
    tracePanel.textContent = '执行中…';

    // 多轮：把已有 history 传给模型（不含本条，本条在 message）
    const historyForModel = state.history.slice();

    const result = await window.aihelper.chat({
      message: text,
      history: historyForModel,
      sessionId: state.session?.id
    });

    setBusy(false);

    if (result.ok) {
      addMessage('assistant', result.content || '(空回复)');
      state.history.push({ role: 'user', content: text });
      state.history.push({ role: 'assistant', content: result.content || '' });
      // 前端内存历史：仅当开启裁剪且轮数>0 时限制，否则不截
      const trim = !!state.config?.agent?.trimHistory;
      const mhKeep = Number(state.config?.agent?.maxHistoryTurns);
      if (trim && mhKeep > 0 && state.history.length > mhKeep * 2) {
        state.history = state.history.slice(-(mhKeep * 2));
      }
    } else if (result.cancelled || /已取消/.test(String(result.error || ''))) {
      // 停止按钮已提示「任务已停止」，勿再刷一条错误
      state.history.push({ role: 'user', content: text });
      state.history.push({ role: 'assistant', content: '（已停止）' });
    } else {
      addMessage('assistant', `错误: ${result.error}`, 'error');
      state.history.push({ role: 'user', content: text });
      state.history.push({ role: 'assistant', content: `错误: ${result.error}` });
    }

    if (state.session) {
      state.session.messages = state.history.slice();
      state.session.uiMessages = collectUiMessages();
      state.dirty = true;
      updateSessionTitle();
      // 每轮结束后立即落盘，避免关闭丢失
      await persistSession('回合结束');
    }

    if (result.trace?.length) {
      tracePanel.textContent = result.trace
        .map((t, i) => `#${i + 1} ${t.name}(${JSON.stringify(t.args)}) => ${JSON.stringify(t.result).slice(0, 300)}`)
        .join('\n');
    } else {
      tracePanel.textContent = result.error || '无工具调用';
    }
  }

  btnSend.addEventListener('click', send);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  window.aihelper.onAgentEvent((ev) => {
    if (ev.type === 'tool_start') {
      addMessage('tool', `→ ${ev.name} ${JSON.stringify(ev.args)}`);
    } else if (ev.type === 'tool_end') {
      const preview = JSON.stringify(ev.error ? { error: ev.error } : ev.result).slice(0, 500);
      addMessage('tool', `← ${ev.name}: ${preview}`);
    } else if (ev.type === 'aborted') {
      addMessage('system', '任务已停止');
      setBusy(false);
      if (state.dirty) persistSession('中止');
    }
  });

  // 关闭/刷新前尽量保存
  window.addEventListener('beforeunload', () => {
    if (state.session && state.dirty) {
      try {
        state.session.messages = state.history.slice();
        state.session.uiMessages = collectUiMessages();
        window.aihelper.saveSession(state.session);
      } catch (_) {}
    }
  });

  loadConfig()
    .then(async () => {
      const sess = await window.aihelper.getCurrentSession();
      if (sess) {
        await loadSessionIntoUi(sess);
        if (!(sess.messages && sess.messages.length) && !(sess.uiMessages && sess.uiMessages.length)) {
          addMessage(
            'system',
            '就绪。支持多轮对话；会话会定时/每轮自动写入文件。浏览器页面可保持，你可手动操作后再让助手继续。',
            '',
            { skipPersist: true }
          );
        }
      } else {
        addMessage('system', '就绪。请先在「配置」中设置模型。');
      }
    })
    .catch((err) => {
      addMessage('system', `启动异常: ${err.message || err}`);
    });
})();
