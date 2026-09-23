const bs = require('../browser-session');

function maskText(text, selector) {
  const s = String(text ?? '');
  const sel = String(selector || '');
  if (/pass|pwd|secret|token|credential/i.test(sel)) return '***';
  if (s.length > 120) return s.slice(0, 120) + '…';
  return s;
}

function createStepRunner(cfg) {
  function sanitizeArgs(name, args) {
    const a = { ...(args || {}) };
    if (name === 'browser_type' || name === 'browser_fill_form') {
      if (a.text != null) a.text = maskText(a.text, a.selector);
      if (Array.isArray(a.fields)) {
        a.fields = a.fields.map((f) => ({
          selector: f.selector,
          value: maskText(f.value, f.selector)
        }));
      }
    }
    return a;
  }

  function sanitizeResult(name, result) {
    if (!result || typeof result !== 'object') return result;
    const r = { ...result };
    if (typeof r.text === 'string' && r.text.length > 200) r.text = r.text.slice(0, 200) + '…';
    if (typeof r.html === 'string' && r.html.length > 200) r.html = r.html.slice(0, 200) + '…';
    return r;
  }

  async function withStep(name, args, fn) {
    const t0 = Date.now();
    bs.throwIfAborted();
    bs.logAction('tool.start', { name, args: sanitizeArgs(name, args) });
    try {
      const result = await bs.raceAbort(Promise.resolve().then(() => fn()));
      bs.throwIfAborted();
      try {
        if (bs.getShared().page && !bs.getShared().page.isClosed()) {
          bs.getShared().page.setDefaultTimeout(cfg.timeoutMs || 30000);
        }
      } catch (_) {}
      bs.logAction('tool.end', {
        name,
        ok: true,
        ms: Date.now() - t0,
        result: sanitizeResult(name, result)
      });
      return result;
    } catch (err) {
      try {
        if (bs.getShared().page && !bs.getShared().page.isClosed()) {
          bs.getShared().page.setDefaultTimeout(cfg.timeoutMs || 30000);
        }
      } catch (_) {}
      bs.logAction('tool.end', {
        name,
        ok: false,
        ms: Date.now() - t0,
        error: err.message || String(err)
      });
      throw err;
    }
  }

  return { withStep, sanitizeArgs, sanitizeResult, maskText };
}

module.exports = { maskText, createStepRunner };
