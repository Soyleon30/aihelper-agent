const { LLMProvider } = require('../llm/provider');
const { createToolRegistry } = require('../tools/registry');
const {
  buildSystemPrompt,
  looksLikeSuccessWithoutEvidence,
  taskLikelyNeedsTools,
  buildGroundingReminder,
  buildNoToolNudge,
  buildRejectUnverifiedMessage,
  buildHonestNoToolReply,
  looksLikeFabricatedResult,
  wrapFinalContent,
  compactToolResult,
  buildRoundBudgetHint,
  buildForceFinalMessage,
  isDuplicateToolCall,
  checkSpuriousBrowserClick
} = require('./guardrails');

function createAgentService(options = {}) {
  let config = options.config || {};
  const getMainWindow = options.getMainWindow || (() => null);
  const userDataPath = options.userDataPath || process.cwd();
  const logger = options.logger || null;

  let provider = new LLMProvider(
    config.providers
      ? { ...config, providers: config.providers, active: config.providers.active }
      : config
  );
  syncProvider(config);

  let tools = createToolRegistry({ config, userDataPath, logger });
  let abortController = null;

  function syncProvider(cfg) {
    provider.updateConfig({
      active: cfg.providers?.active || 'local',
      providers: cfg.providers || {}
    });
  }

  function emit(event) {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('agent:event', event);
    }
  }

  function log(level, event, data) {
    if (!logger) return;
    try {
      if (level === 'error') logger.error(event, data);
      else if (level === 'warn') logger.warn(event, data);
      else if (level === 'debug') logger.debug(event, data);
      else logger.info(event, data);
    } catch (_) {}
  }

  function agentOpts() {
    return config.agent || {};
  }

  async function reloadConfig(cfg) {
    config = cfg;
    syncProvider(cfg);
    if (logger && cfg.logging) logger.configure(cfg.logging);
    await tools.shutdown();
    tools = createToolRegistry({ config: cfg, userDataPath, logger });
    log('info', 'config.reloaded', {
      active: cfg.providers?.active,
      maxToolRounds: cfg.agent?.maxToolRounds,
      efficiencyMode: cfg.agent?.efficiencyMode !== false,
      antiHallucination: cfg.agent?.antiHallucination !== false
    });
  }

  async function testProvider(key) {
    const t0 = Date.now();
    const r = await provider.testConnection(key);
    log(r.ok ? 'info' : 'warn', 'provider.test', {
      key: key || config.providers?.active,
      ok: r.ok,
      model: r.model,
      baseUrl: r.baseUrl,
      ms: Date.now() - t0,
      error: r.error
    });
    if (logger) logger.usage('provider.test', { ok: r.ok, key });
    return r;
  }

  function abort() {
    if (abortController) {
      try {
        abortController.abort();
      } catch (_) {}
      // 勿立刻置 null：工具轮次仍靠 signal.aborted 判断；finally 再清
      try {
        if (tools && typeof tools.abortRunning === 'function') {
          tools.abortRunning();
        }
      } catch (_) {}
      emit({ type: 'aborted' });
      log('info', 'chat.aborted', {});
      return { ok: true };
    }
    return { ok: false, error: '无进行中的任务' };
  }

  async function chat(payload) {
    try {
      if (tools && typeof tools.clearAbort === 'function') tools.clearAbort();
    } catch (_) {}
    const userMessage = payload.message || '';
    const history = Array.isArray(payload.history) ? payload.history : [];
    const ao = agentOpts();
    // 0 = 不限制（由配置页填写；不再偷偷改成 24/6）
    const rawMaxRounds = Number(ao.maxToolRounds);
    const unlimitedRounds =
      ao.maxToolRounds === 0 ||
      ao.maxToolRounds === '0' ||
      rawMaxRounds === 0;
    // 有限时至少 1；未配置时默认不限制（避免再出现“到顶就停”）
    const maxRounds = unlimitedRounds
      ? Number.MAX_SAFE_INTEGER
      : Math.max(1, Number.isFinite(rawMaxRounds) && rawMaxRounds > 0 ? rawMaxRounds : Number.MAX_SAFE_INTEGER);

    const trimHistory = ao.trimHistory === true;
    const rawHist = Number(ao.maxHistoryTurns);
    const unlimitedHistory =
      !trimHistory ||
      ao.maxHistoryTurns === 0 ||
      ao.maxHistoryTurns === '0' ||
      rawHist === 0;
    const maxHistoryTurns = unlimitedHistory
      ? null
      : Math.max(0, Number.isFinite(rawHist) ? rawHist : 0);

    const compactOn = ao.compactToolResults === true;
    const rawToolLen = Number(ao.toolResultMaxLen);
    const toolResultMaxLen = !compactOn
      ? 500000
      : Number.isFinite(rawToolLen) && rawToolLen > 0
        ? rawToolLen
        : 6000;
    const parallelTools = ao.parallelTools === true;
    const skipDupTools = ao.skipDuplicateTools === true;
    const effOn = ao.efficiencyMode === true;
    // 与效率提示词独立：各自开关
    const forceFinalOnLast = ao.forceFinalOnLastRound === true;
    const roundBudgetHints = ao.roundBudgetHints === true;
    const logCfg = config.logging || {};
    const sessionId = `s${Date.now().toString(36)}`;
    const tSession = Date.now();
    const antiOn = ao.antiHallucination !== false;
    const forceTools = antiOn && ao.forceToolsForActions !== false;
    const requireToolChoice = ao.requireToolChoice !== false && forceTools;
    const rejectUnverified = ao.rejectUnverifiedAnswers !== false && forceTools;
    const maxNudges = Math.max(0, Number(ao.maxToolNudges ?? 2));
    // 复核与效率完全独立：只看 verifyFinal 自身开关
    const doVerify = antiOn && ao.verifyFinal !== false;
    let recheckLeft = doVerify ? Math.max(0, ao.maxRechecks ?? 1) : 0;
    let nudgeCount = 0;
    let forcedFinal = false;
    const needsTools = taskLikelyNeedsTools(userMessage);

    abortController = new AbortController();
    const signal = abortController.signal;

    const systemPrompt = buildSystemPrompt(
      ao.systemPrompt ||
        '你是一个可操作本地文件与网页的智能助手。优先少轮次完成任务，用中文简短回答。',
      ao
    );

    // 历史：仅当开启裁剪且 maxHistoryTurns>0 时截断
    let hist = history.filter((m) => m.role === 'user' || m.role === 'assistant');
    if (maxHistoryTurns != null && maxHistoryTurns > 0) {
      hist = hist.slice(-maxHistoryTurns * 2);
    }

    const messages = [
      { role: 'system', content: systemPrompt },
      ...hist,
      { role: 'user', content: userMessage }
    ];

    const toolDefs = tools.getDefinitions();
    const trace = [];
    let toolCount = 0;
    let llmRounds = 0;
    let toolErrorCount = 0;

    const active = config.providers?.active || 'local';
    log('info', 'chat.start', {
      sessionId,
      provider: active,
      model: config.providers?.[active]?.model,
      historyLen: hist.length,
      msgLen: userMessage.length,
      maxRounds,
      efficiencyMode: effOn
    });
    if (logger) {
      logger.usage('chat.start', { sessionId, provider: active });
      if (logCfg.logConversations !== false && logCfg.logChatContent !== false) {
        logger.chat({
          sessionId,
          role: 'user',
          content: userMessage,
          meta: {
            provider: active,
            model: config.providers?.[active]?.model,
            historyLen: hist.length
          }
        });
      }
    }

    function finishOk(content, data, extra = {}) {
      const hadToolErrors = toolErrorCount > 0;
      const unverified = extra.unverified || false;
      const finalContent = antiOn
        ? wrapFinalContent(content, {
            toolCount,
            hadToolErrors,
            unverified,
            userMessage
          })
        : content;

      emit({ type: 'final', content: finalContent, trace });
      const ms = Date.now() - tSession;
      log('info', 'chat.end', {
        sessionId,
        ok: true,
        ms,
        llmRounds,
        toolCount,
        toolErrorCount,
        truncated: !!extra.truncated,
        replyLen: finalContent.length,
        usage: data?.usage || null
      });
      if (logger) {
        logger.usage('chat.end', {
          sessionId,
          ok: true,
          ms,
          llmRounds,
          toolCount
        });
        if (logCfg.logConversations !== false && logCfg.logChatContent !== false) {
          logger.chat({
            sessionId,
            role: 'assistant',
            content: finalContent,
            meta: {
              ok: true,
              ms,
              llmRounds,
              toolCount,
              toolErrorCount,
              tools: trace.map((t) => t.name),
              truncated: !!extra.truncated
            }
          });
        }
      }
      return {
        ok: true,
        content: finalContent,
        trace,
        usage: data?.usage || null,
        ...extra
      };
    }

    async function runOneTool(tc) {
      const name = tc.function?.name;
      let args = {};
      try {
        args = JSON.parse(tc.function?.arguments || '{}');
      } catch {
        args = {};
      }

      if (skipDupTools && isDuplicateToolCall(trace, name, args)) {
        const dup = {
          ok: false,
          error: 'duplicate_tool_call',
          hint: '与近期调用重复，已跳过。请基于已有结果直接作答或换参数。'
        };
        log('warn', 'tool.skip_dup', { sessionId, name });
        emit({ type: 'tool_end', name, args, result: dup, error: dup.error, id: tc.id });
        trace.push({ name, args, result: dup });
        return {
          tc,
          resultStr: JSON.stringify(dup),
          error: dup.error,
          result: dup
        };
      }

      const spurious = checkSpuriousBrowserClick(name, args, userMessage);
      if (spurious) {
        log('warn', 'tool.spurious_click', {
          sessionId,
          name,
          text: args && args.text
        });
        emit({
          type: 'tool_end',
          name,
          args,
          result: spurious,
          error: spurious.error,
          id: tc.id
        });
        trace.push({ name, args, result: spurious });
        return {
          tc,
          resultStr: JSON.stringify(spurious),
          error: spurious.error,
          result: spurious
        };
      }

      if (signal.aborted) {
        const err = new Error('已取消');
        err.name = 'AbortError';
        throw err;
      }
      emit({ type: 'tool_start', name, args, id: tc.id });
      const tTool = Date.now();
      let result;
      let error = null;
      try {
        result = await tools.execute(name, args);
        if (signal.aborted) {
          const err = new Error('已取消');
          err.name = 'AbortError';
          throw err;
        }
      } catch (err) {
        if (err && (err.name === 'AbortError' || /已取消/.test(String(err.message || err)))) {
          throw err;
        }
        error = err.message || String(err);
        result = { error };
      }
      const toolMs = Date.now() - tTool;
      const ok = !error && !(result && result.error);

      log('info', 'tool.call', {
        sessionId,
        name,
        ms: toolMs,
        ok,
        error: error || result?.error || undefined,
        args: logCfg.logToolArgs !== false ? args : undefined,
        result: logCfg.logToolResult !== false ? result : ok ? { ok: true } : { error }
      });
      if (logger) logger.usage('tool.call', { name, ok, ms: toolMs });

      const compact = compactToolResult(name, result, toolResultMaxLen);
      let resultStr;
      if (error || compact.error) {
        resultStr = JSON.stringify({
          ok: false,
          error: error || compact.error,
          hint: '工具失败，最终回答必须说明失败，禁止声称成功',
          ...compact
        }).slice(0, toolResultMaxLen + 500);
      } else {
        resultStr = JSON.stringify({ ok: true, ...compact }).slice(
          0,
          toolResultMaxLen + 500
        );
      }

      trace.push({ name, args, result: error ? { error } : result });
      emit({ type: 'tool_end', name, args, result, error, id: tc.id });
      return { tc, resultStr, error: error || compact.error, result };
    }

    try {
      emit({ type: 'start', message: userMessage });

      for (let round = 0; round < maxRounds; round++) {
        if (signal.aborted) throw new Error('已取消');

        const roundsLeft = unlimitedRounds ? 999 : maxRounds - round;
        const budgetHint =
          roundBudgetHints && !unlimitedRounds
            ? buildRoundBudgetHint(round, maxRounds, toolCount)
            : null;

        // 可选：最后一轮强制收尾（有限轮次且打开开关时）
        const lastRound = forceFinalOnLast && !unlimitedRounds && roundsLeft <= 1;
        if (lastRound && toolCount > 0 && !forcedFinal) {
          forcedFinal = true;
          messages.push({
            role: 'user',
            content: buildForceFinalMessage(trace)
          });
        } else if (budgetHint && !lastRound) {
          messages.push({ role: 'system', content: budgetHint });
        }

        emit({ type: 'thinking', round, roundsLeft, maxRounds });
        llmRounds += 1;
        const tLlm = Date.now();

        // 首轮 tool_choice=required 逼调工具；thinking 模型由 provider 自动去掉该字段重试
        let toolChoice;
        const activeModel = String(
          (provider.getActive && provider.getActive().model) || ''
        ).toLowerCase();
        const thinkingModel =
          /flash|reasoner|thinking|r1|o1|o3|o4-mini/i.test(activeModel);
        if (
          !lastRound &&
          !forcedFinal &&
          toolDefs.length &&
          requireToolChoice &&
          needsTools &&
          toolCount === 0 &&
          nudgeCount === 0 &&
          round === 0 &&
          !thinkingModel
        ) {
          toolChoice = 'required';
        }

        const data = await provider.chatCompletions(messages, {
          tools:
            lastRound || forcedFinal
              ? undefined
              : toolDefs.length
                ? toolDefs
                : undefined,
          tool_choice: toolChoice,
          signal
        });

        if (budgetHint && !lastRound) {
          const last = messages[messages.length - 1];
          if (last?.role === 'system' && last.content === budgetHint) {
            messages.pop();
          }
        }

        log('debug', 'llm.round', {
          sessionId,
          round,
          roundsLeft,
          ms: Date.now() - tLlm,
          usage: data.usage || null,
          hasTools: !!(data.choices?.[0]?.message?.tool_calls?.length)
        });

        const choice = data.choices?.[0];
        if (!choice) throw new Error('模型无返回');

        const msg = choice.message || {};
        let toolCalls = msg.tool_calls || [];

        // 最后一轮若仍返回 tool_calls，忽略并强制文本收尾
        if (lastRound && toolCalls.length) {
          log('warn', 'round.force_final_ignore_tools', {
            sessionId,
            n: toolCalls.length
          });
          toolCalls = [];
          if (!msg.content) {
            messages.push({
              role: 'assistant',
              content: null,
              tool_calls: msg.tool_calls
            });
            // 不执行工具，改为再要一次纯文本（计入本轮已用，直接本地拼）
            const summary = buildForceFinalMessage(trace);
            return finishOk(
              summarizeTraceLocally(trace, '轮次用尽，已根据已有工具结果汇总'),
              data,
              { truncated: true }
            );
          }
        }

        if (!toolCalls.length) {
          let content = msg.content || '';

          // 需要工具却空口回答 → 可多次打回
          if (
            forceTools &&
            toolCount === 0 &&
            toolDefs.length &&
            !lastRound &&
            needsTools &&
            nudgeCount < maxNudges
          ) {
            nudgeCount += 1;
            log('warn', 'guard.nudge_tools', { sessionId, nudgeCount, maxNudges });
            messages.push({ role: 'assistant', content: content || '(未调用工具)' });
            messages.push({
              role: 'user',
              content: buildNoToolNudge(userMessage, nudgeCount)
            });
            // 打回后再 required 一次
            continue;
          }

          // 打回用尽仍无工具 + 像假结果 → 直接拒绝，返回诚实说明
          if (
            rejectUnverified &&
            toolCount === 0 &&
            needsTools &&
            (looksLikeFabricatedResult(content) ||
              looksLikeSuccessWithoutEvidence(content, 0) ||
              (content && content.length > 40))
          ) {
            log('warn', 'guard.reject_unverified', {
              sessionId,
              replyLen: (content || '').length
            });
            // 再给一次机会：若还没 reject 过 formal
            if (!lastRound && nudgeCount < maxNudges + 1) {
              nudgeCount += 1;
              messages.push({ role: 'assistant', content });
              messages.push({
                role: 'user',
                content: buildRejectUnverifiedMessage(userMessage, content)
              });
              continue;
            }
            return finishOk(buildHonestNoToolReply(userMessage), data, {
              unverified: true,
              rejectedFake: true
            });
          }

          if (
            doVerify &&
            recheckLeft > 0 &&
            !lastRound &&
            looksLikeSuccessWithoutEvidence(content, toolCount)
          ) {
            recheckLeft -= 1;
            log('warn', 'guard.recheck_no_evidence', { sessionId, toolCount });
            messages.push({ role: 'assistant', content });
            messages.push({
              role: 'user',
              content: buildGroundingReminder(trace, '缺少工具证据却给出成功结论')
            });
            continue;
          }

          // 需要工具、从未调用、回答空泛：仍标记未验证
          if (rejectUnverified && toolCount === 0 && needsTools && content) {
            // 不接受“我已经帮你…”类；短句承认做不到可以过
            const admitsFail = /(无法|不能|做不到|没有权限|未配置|请先配置)/.test(
              content
            );
            if (!admitsFail && looksLikeFabricatedResult(content)) {
              return finishOk(buildHonestNoToolReply(userMessage), data, {
                unverified: true,
                rejectedFake: true
              });
            }
          }

          if (
            doVerify &&
            recheckLeft > 0 &&
            !lastRound &&
            toolErrorCount > 0 &&
            SUCCESS_LIKE(content)
          ) {
            recheckLeft -= 1;
            messages.push({ role: 'assistant', content });
            messages.push({
              role: 'user',
              content: buildGroundingReminder(trace, '存在工具失败，需按真实结果重述')
            });
            continue;
          }

          if (!content && toolCount > 0) {
            content = summarizeTraceLocally(trace, '已执行工具，模型未返回正文');
          }

          return finishOk(content, data, {
            unverified:
              antiOn && toolCount === 0 && taskLikelyNeedsTools(userMessage),
            truncated: lastRound && forcedFinal
          });
        }

        messages.push({
          role: 'assistant',
          content: msg.content || null,
          tool_calls: toolCalls
        });

        // 并行执行同轮多个工具，少耗墙钟时间（仍算 1 个 LLM 轮次）
        let results;
        if (parallelTools && toolCalls.length > 1) {
          results = await Promise.all(toolCalls.map((tc) => runOneTool(tc)));
        } else {
          results = [];
          for (const tc of toolCalls) {
            if (signal.aborted) throw new Error('已取消');
            results.push(await runOneTool(tc));
          }
        }

        for (const r of results) {
          toolCount += 1;
          if (r.error) toolErrorCount += 1;
          messages.push({
            role: 'tool',
            tool_call_id: r.tc.id,
            content: r.resultStr
          });
        }

        if (!unlimitedRounds && roundsLeft === 2 && forceFinalOnLast) {
          messages.push({
            role: 'user',
            content:
              '【提示】下一轮将是最后一轮。请尽快完成剩余必要工具调用；若已足够请直接给最终中文结论。'
          });
        }
      }

      // 仅当配置了有限 maxToolRounds 才会走到这里
      const local = summarizeTraceLocally(
        trace,
        `已达到配置的最大工具轮次(${unlimitedRounds ? '∞' : maxRounds})，以下为已执行结果汇总。可在配置中把「最大工具轮次」设为 0 表示不限制。`
      );
      return finishOk(local, null, { truncated: true });
    } catch (err) {
      const cancelled =
        (err && err.name === 'AbortError') || /已取消/.test(String(err && err.message));
      const message = cancelled ? '已取消' : err.message || String(err);
      if (!cancelled) {
        emit({ type: 'error', error: message, trace });
      }
      log(cancelled ? 'info' : 'error', 'chat.end', {
        sessionId,
        ok: false,
        cancelled: !!cancelled,
        error: message,
        ms: Date.now() - tSession,
        llmRounds,
        toolCount
      });
      if (logger) {
        logger.usage('chat.end', {
          sessionId,
          ok: false,
          cancelled: !!cancelled,
          ms: Date.now() - tSession,
          toolCount
        });
        if (logCfg.logConversations !== false && logCfg.logChatContent !== false) {
          logger.chat({
            sessionId,
            role: 'assistant',
            content: cancelled ? '[已停止]' : `[错误] ${message}`,
            meta: { ok: false, cancelled: !!cancelled, error: message, toolCount }
          });
        }
      }
      return { ok: false, error: message, cancelled: !!cancelled, trace };
    } finally {
      abortController = null;
      try {
        if (tools && typeof tools.clearAbort === 'function') tools.clearAbort();
      } catch (_) {}
    }
  }

  async function shutdown(opts = {}) {
    abort();
    await tools.shutdown(opts);
    log('info', 'agent.shutdown', { force: !!opts.force });
  }

  return {
    chat,
    abort,
    testProvider,
    reloadConfig,
    shutdown
  };
}

function SUCCESS_LIKE(content) {
  return /(已(经)?(成功|完成)|成功|登录成功|写入成功|请求成功)/i.test(content || '');
}

function summarizeTraceLocally(trace, title) {
  if (!trace || !trace.length) {
    return `${title}。\n本轮未能完成有效工具调用，请缩小任务或提高「最大工具轮次」后重试。`;
  }
  const lines = trace.map((t, i) => {
    let body = '';
    try {
      body = JSON.stringify(t.result);
    } catch {
      body = String(t.result);
    }
    if (body.length > 400) body = body.slice(0, 400) + '…';
    return `${i + 1}. ${t.name}: ${body}`;
  });
  return `${title}：\n${lines.join('\n')}\n\n如需继续，请说明下一步或提高最大工具轮次。`;
}

module.exports = { createAgentService };
