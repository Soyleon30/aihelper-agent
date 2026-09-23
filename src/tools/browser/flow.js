/**
 * 录制 / 流程回放。robustClick 由入口注入。
 */
const path = require('path');
const fsp = require('fs').promises;
const bs = require('../browser-session');
const { resolveScreenshotDir } = require('./paths');

function createFlowHelpers(ctx) {
  const { cfg, userDataPath } = ctx;
  const getRobustClick = () => ctx.robustClick;

  function flowsDir() {
    return path.join(userDataPath || process.cwd(), 'flows');
  }
  
  function appendRecordFromPage(event, data, url) {
    const shared = bs.getShared();
    const rec = shared.recording;
    if (!rec || !rec.active) return;
    const now = Date.now();
    const waitMs = rec.lastAt ? Math.min(Math.max(now - rec.lastAt, 0), 15000) : 0;
    rec.lastAt = now;
    const target = (data && data.target) || {};
    if (event === 'page.click') {
      const text = target.text || '';
      const selector = target.selector || '';
      const step = {
        action: 'click',
        text: text || undefined,
        selector: selector || undefined,
        url,
        waitBeforeMs: waitMs > 300 ? waitMs : undefined,
        t: new Date(now).toISOString()
      };
      if (!step.text && !step.selector) return;
      const last = rec.steps[rec.steps.length - 1];
      if (
        last &&
        last.action === 'click' &&
        last.selector === step.selector &&
        last.text === step.text &&
        now - new Date(last.t).getTime() < 400
      ) {
        return;
      }
      rec.steps.push(step);
      return;
    }
    if (event === 'page.input') {
      const selector = target.selector || '';
      const value = data.rawValue != null ? String(data.rawValue) : String(data.value || '');
      if (!selector) return;
      const step = {
        action: 'type',
        selector,
        text: value,
        clear: true,
        url,
        placeholder: target.placeholder,
        waitBeforeMs: waitMs > 300 ? waitMs : undefined,
        t: new Date(now).toISOString()
      };
      const last = rec.steps[rec.steps.length - 1];
      if (last && last.action === 'type' && last.selector === selector) {
        last.text = value;
        last.t = step.t;
        return;
      }
      rec.steps.push(step);
      return;
    }
    if (event === 'page.key' && data.key === 'Enter') {
      const last = rec.steps[rec.steps.length - 1];
      if (last && last.action === 'type') last.pressEnter = true;
      return;
    }
    if (event === 'page.navigate' || event === 'page.loaded') {
      const u = (data && (data.url || data)) || url;
      if (!u || typeof u !== 'string') return;
      const last = rec.steps[rec.steps.length - 1];
      if (last && last.action === 'navigate' && last.url === u) return;
      if (rec.steps.length === 0 || (last && last.action !== 'navigate')) {
        rec.steps.push({
          action: 'navigate',
          url: u,
          t: new Date(now).toISOString()
        });
      }
    }
  }
  
  function suggestVariables(steps) {
    const vars = {};
    let i = 1;
    for (const s of steps) {
      if (s.action !== 'type' || s.text == null || s.text === '') continue;
      const keyBase =
        (s.placeholder && String(s.placeholder).replace(/[^\w\u4e00-\u9fff]+/g, '_').slice(0, 24)) ||
        `input_${i}`;
      let key = keyBase || `var_${i}`;
      if (vars[key] != null && vars[key] !== s.text) key = `${keyBase}_${i}`;
      vars[key] = s.text;
      s.text = `{{${key}}}`;
      s.var = key;
      i += 1;
    }
    return vars;
  }
  
  function applyVars(val, vars) {
    if (val == null) return val;
    let s = String(val);
    const map = vars || {};
    s = s.replace(/\{\{\s*([\w.\u4e00-\u9fff-]+)\s*\}\}/g, (_, k) =>
      map[k] != null ? String(map[k]) : `{{${k}}}`
    );
    return s;
  }
  
  async function runFlowSteps(p, steps, vars) {
    const results = [];
    for (let idx = 0; idx < steps.length; idx++) {
      const raw = steps[idx] || {};
      const step = {
        ...raw,
        text: applyVars(raw.text, vars),
        selector: applyVars(raw.selector, vars),
        url: applyVars(raw.url, vars)
      };
      const waitMs = step.waitBeforeMs || step.waitMs || (step.action === 'navigate' ? 0 : 400);
      if (waitMs > 0) {
        try {
          await p.waitForTimeout(Math.min(waitMs, 20000));
        } catch (_) {}
      }
      try {
        if (step.action === 'navigate' && step.url) {
          await p.goto(step.url, {
            waitUntil: step.waitUntil || 'domcontentloaded',
            timeout: cfg.timeoutMs || 30000
          });
          results.push({ i: idx, action: 'navigate', ok: true, url: p.url() });
        } else if (step.action === 'click') {
          const r = await getRobustClick()(p, {
            selector: step.selector,
            text: step.text,
            timeoutMs: step.timeoutMs || cfg.timeoutMs || 30000,
            force: step.force
          });
          results.push({ i: idx, action: 'click', ok: true, method: r.method, url: p.url() });
        } else if (step.action === 'type') {
          const loc = p.locator(step.selector).first();
          if (step.clear !== false) await loc.fill('');
          await loc.fill(String(step.text ?? ''));
          if (step.pressEnter) await loc.press('Enter');
          results.push({ i: idx, action: 'type', ok: true, url: p.url() });
        } else if (step.action === 'wait') {
          if (step.selector) {
            await p.waitForSelector(step.selector, {
              timeout: step.timeoutMs || cfg.timeoutMs || 30000
            });
          } else {
            await p.waitForTimeout(step.ms || 1000);
          }
          results.push({ i: idx, action: 'wait', ok: true });
        } else if (step.action === 'screenshot') {
          const dir = resolveScreenshotDir(cfg, userDataPath);
          await fsp.mkdir(dir, { recursive: true });
          const file = path.join(dir, step.path || `flow-${Date.now()}-${idx}.png`);
          await p.screenshot({ path: file, fullPage: !!step.fullPage });
          results.push({ i: idx, action: 'screenshot', ok: true, path: file });
        } else {
          results.push({ i: idx, action: step.action || 'unknown', ok: false, error: 'unknown action' });
        }
      } catch (err) {
        results.push({
          i: idx,
          action: step.action,
          ok: false,
          error: err.message || String(err),
          url: p.url()
        });
        if (step.continueOnError) continue;
        return { ok: false, stoppedAt: idx, results, url: p.url() };
      }
    }
    return { ok: true, results, url: p.url() };
  }

  return {
    flowsDir,
    appendRecordFromPage,
    suggestVariables,
    applyVars,
    runFlowSteps
  };
}

module.exports = { createFlowHelpers };
