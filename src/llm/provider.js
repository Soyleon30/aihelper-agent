const fetch = require('node-fetch');

class LLMProvider {
  constructor(config) {
    this.config = config || {};
  }

  updateConfig(config) {
    this.config = config || {};
  }

  getActive() {
    const key = this.config.active || 'local';
    const providers = this.config.providers || this.config;
    const p = (this.config.providers && this.config.providers[key]) || providers[key];
    if (!p) throw new Error(`未找到提供商配置: ${key}`);
    return { key, ...p };
  }

  async chatCompletions(messages, options = {}) {
    const p = options.providerOverride || this.getActive();
    const baseUrl = String(p.baseUrl || '').replace(/\/$/, '');
    let apiPath = String(p.apiPath != null ? p.apiPath : '/chat/completions').trim();
    if (!apiPath) apiPath = '/chat/completions';
    if (!apiPath.startsWith('/')) apiPath = `/${apiPath}`;
    const url = `${baseUrl}${apiPath}`;
    const body = {
      model: p.model,
      messages,
      temperature: p.temperature ?? 0.3,
      max_tokens: p.maxTokens ?? 4096,
      stream: false
    };
    if (options.tools && options.tools.length) {
      body.tools = options.tools;
      // 仅当显式传入才带 tool_choice。thinking 模型（如 deepseek-flash）
      // 常拒绝 required/auto，省略字段由服务端默认处理更稳。
      if (options.tool_choice != null && options.tool_choice !== '') {
        body.tool_choice = options.tool_choice;
      }
    }

    const doRequest = async (payload) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), p.timeoutMs || 120000);
      let onAbort = null;
      if (options.signal) {
        onAbort = () => {
          try {
            controller.abort();
          } catch (_) {}
        };
        if (options.signal.aborted) onAbort();
        else options.signal.addEventListener('abort', onAbort, { once: true });
      }
      try {
        if (options.signal && options.signal.aborted) {
          const err = new Error('已取消');
          err.name = 'AbortError';
          throw err;
        }
        const headers = { 'Content-Type': 'application/json' };
        if (p.apiKey) headers.Authorization = `Bearer ${p.apiKey}`;
        const res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal
        });
        const text = await res.text();
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          throw new Error(`模型返回非 JSON (${res.status}): ${text.slice(0, 500)}`);
        }
        if (!res.ok) {
          const msg = data.error?.message || data.message || text.slice(0, 500);
          const err = new Error(`模型请求失败 ${res.status}: ${msg}`);
          err.status = res.status;
          err.apiMessage = msg;
          throw err;
        }
        return data;
      } catch (err) {
        // node-fetch / AbortController：用户点停止
        if (
          (options.signal && options.signal.aborted) ||
          (err && (err.name === 'AbortError' || err.type === 'aborted'))
        ) {
          const e = new Error('已取消');
          e.name = 'AbortError';
          throw e;
        }
        throw err;
      } finally {
        clearTimeout(timeout);
        if (options.signal && onAbort) {
          try {
            options.signal.removeEventListener('abort', onAbort);
          } catch (_) {}
        }
      }
    };

    try {
      return await doRequest(body);
    } catch (err) {
      const em = String((err && (err.apiMessage || err.message)) || err);
      const rejectTc =
        body.tools &&
        body.tool_choice != null &&
        /tool_choice/i.test(em) &&
        (/thinking/i.test(em) || /does not support/i.test(em) || err.status === 400);
      if (!rejectTc) throw err;
      // 去掉 tool_choice 再试（thinking 模式常见限制）
      const retry = { ...body };
      delete retry.tool_choice;
      return await doRequest(retry);
    }
  }

  async testConnection(providerKey) {
    const providers = this.config.providers || this.config;
    const key = providerKey || this.config.active || 'local';
    const p = providers[key];
    if (!p) return { ok: false, error: `提供商不存在: ${key}` };

    try {
      const data = await this.chatCompletions(
        [{ role: 'user', content: 'ping，请只回复 ok' }],
        { providerOverride: p }
      );
      const content = data.choices?.[0]?.message?.content || '';
      return {
        ok: true,
        model: p.model,
        baseUrl: p.baseUrl,
        sample: String(content).slice(0, 200)
      };
    } catch (err) {
      return { ok: false, error: err.message, model: p.model, baseUrl: p.baseUrl };
    }
  }
}

module.exports = { LLMProvider };
