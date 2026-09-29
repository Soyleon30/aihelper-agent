/**
 * 稳健输入：可见优先、清空、触发 Vue/Element 事件、校验值、可选回车。
 * 仅依赖 browser-session，不 require 其它 browser 业务模块。
 */
const bs = require('../browser-session');

const SEARCH_HINT_RE =
  /搜索|查找|筛选|过滤|请输入|关键字|关键词|名称|应用|模板|search|filter|query|keyword/i;

function candidateSelectors(args) {
  const out = [];
  const sel = args.selector != null ? String(args.selector).trim() : '';
  const placeholder = args.placeholder != null ? String(args.placeholder).trim() : '';
  const label = args.label != null ? String(args.label).trim() : '';
  if (sel) out.push(sel);
  if (placeholder) {
    out.push(`input[placeholder*="${cssEscape(placeholder)}"]`);
    out.push(`textarea[placeholder*="${cssEscape(placeholder)}"]`);
  }
  if (label) {
    out.push(`input[aria-label*="${cssEscape(label)}"]`);
    out.push(`[placeholder*="${cssEscape(label)}"]`);
  }
  // Element UI / 通用搜索框兜底（仅在无明确 selector 或失败重试时用）
  out.push(
    '.el-dialog input:not([type="hidden"]):not([disabled])',
    '.el-message-box input:not([type="hidden"]):not([disabled])',
    'input.el-input__inner:not([disabled])',
    'input[type="search"]:not([disabled])',
    'input[type="text"]:not([disabled])',
    'textarea:not([disabled])',
    'input:not([type="hidden"]):not([disabled]):not([type="checkbox"]):not([type="radio"])'
  );
  return [...new Set(out.filter(Boolean))];
}

function cssEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function pickTypeLocator(p, args) {
  const selectors = candidateSelectors(args);
  const preferSearch = args.preferSearch !== false;
  const modalRoots = [
    '.el-dialog__wrapper .el-dialog',
    '.el-message-box__wrapper .el-message-box',
    '.el-drawer__body',
    '[role="dialog"]',
    '.ant-modal-content'
  ];

  async function scoreVisible(loc, limit) {
    const n = Math.min(await loc.count().catch(() => 0), limit || 12);
    const hits = [];
    for (let i = 0; i < n; i++) {
      const item = loc.nth(i);
      try {
        if (!(await item.isVisible())) continue;
        const meta = await item
          .evaluate((el) => {
            const r = el.getBoundingClientRect();
            const ph = el.getAttribute('placeholder') || '';
            const aria = el.getAttribute('aria-label') || '';
            const name = el.getAttribute('name') || '';
            const id = el.id || '';
            const cls = el.className || '';
            const type = (el.getAttribute('type') || 'text').toLowerCase();
            const disabled = !!(el.disabled || el.readOnly);
            const inModal = !!(
              el.closest &&
              el.closest(
                '.el-dialog, .el-message-box, .el-drawer, [role="dialog"], .ant-modal'
              )
            );
            return {
              ph,
              aria,
              name,
              id,
              cls: String(cls),
              type,
              disabled,
              inModal,
              w: r.width,
              h: r.height,
              y: r.top,
              x: r.left
            };
          })
          .catch(() => null);
        if (!meta || meta.disabled || meta.w < 8 || meta.h < 8) continue;
        let score = 10;
        if (meta.inModal) score += 40;
        if (preferSearch && SEARCH_HINT_RE.test(`${meta.ph} ${meta.aria} ${meta.name} ${meta.id}`)) {
          score += 30;
        }
        if (/el-input__inner/.test(meta.cls)) score += 8;
        if (meta.type === 'search') score += 6;
        // 列表页顶部搜索通常靠上
        if (meta.y > 40 && meta.y < 280) score += 5;
        hits.push({ item, score, meta });
      } catch (_) {}
    }
    hits.sort((a, b) => b.score - a.score);
    return hits[0] || null;
  }

  // 1) 显式 selector / placeholder：先 modal 内
  const primary = [];
  if (args.selector) primary.push(String(args.selector));
  if (args.placeholder) {
    primary.push(`input[placeholder*="${cssEscape(String(args.placeholder))}"]`);
  }
  for (const sel of primary) {
    for (const root of modalRoots) {
      const hit = await scoreVisible(p.locator(root).locator(sel), 8);
      if (hit) return { loc: hit.item, via: 'modal-selector', meta: hit.meta, selector: sel };
    }
    const hit = await scoreVisible(p.locator(sel), 12);
    if (hit) return { loc: hit.item, via: 'selector', meta: hit.meta, selector: sel };
  }

  // 2) 兜底候选
  for (const sel of selectors) {
    if (primary.includes(sel)) continue;
    const hit = await scoreVisible(p.locator(sel), 10);
    if (hit) return { loc: hit.item, via: 'fallback', meta: hit.meta, selector: sel };
  }

  // 3) 最后仍用 first locator（交给 Playwright 报错）
  const fallbackSel = args.selector || 'input:not([type="hidden"])';
  return {
    loc: p.locator(fallbackSel).first(),
    via: 'first',
    meta: null,
    selector: fallbackSel
  };
}

async function readInputValue(loc) {
  try {
    return await loc.inputValue();
  } catch (_) {
    try {
      return await loc.evaluate((el) => el.value != null ? String(el.value) : (el.textContent || ''));
    } catch (__) {
      return '';
    }
  }
}

/** Playwright locator.evaluate 传入元素为第一回调参数 */
async function setValueWithEvents(loc, text, clear) {
  return loc.evaluate(
    (el, { value, doClear }) => {
      if (!el) return { ok: false, error: 'no element' };
      try {
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
      } catch (_) {}
      try {
        el.focus();
      } catch (_) {}
      try {
        el.click();
      } catch (_) {}

      const proto =
        el.tagName === 'TEXTAREA'
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      const setter = desc && desc.set;

      function setVal(v) {
        if (setter) setter.call(el, v);
        else el.value = v;
      }

      if (doClear) {
        setVal('');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }

      // 模拟逐字，利于部分防抖搜索
      setVal('');
      const s = String(value ?? '');
      if (s.length <= 64) {
        let cur = '';
        for (const ch of s) {
          cur += ch;
          setVal(cur);
          el.dispatchEvent(
            new InputEvent('input', {
              bubbles: true,
              cancelable: true,
              data: ch,
              inputType: 'insertText'
            })
          );
        }
      } else {
        setVal(s);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Unidentified' }));
      return { ok: true, value: el.value };
    },
    { value: String(text ?? ''), doClear: !!clear }
  );
}

function createRobustType(cfg) {
  cfg = cfg || {};
  return async function robustType(p, args) {
    bs.throwIfAborted();
    const text = args.text != null ? String(args.text) : '';
    const clear = args.clear !== false; // 默认清空
    const pressEnter = args.pressEnter === true;
    const timeout = args.timeoutMs || cfg.timeoutMs || 30000;
    const short = Math.min(Math.max(2000, timeout), 8000);
    let lastErr = null;
    let picked = null;

    // 弹层动画短等
    try {
      await p
        .locator('.el-dialog, .el-message-box, [role="dialog"]')
        .last()
        .waitFor({ state: 'visible', timeout: 800 })
        .catch(() => null);
    } catch (_) {}

    try {
      picked = await pickTypeLocator(p, args);
    } catch (err) {
      lastErr = err;
    }

    const loc = picked && picked.loc;
    if (!loc) {
      throw lastErr || new Error('需要提供 selector 或 placeholder');
    }

    async function tryFill() {
      bs.throwIfAborted();
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      await loc.waitFor({ state: 'visible', timeout: short }).catch(() => {});
      await loc.click({ timeout: 2000 }).catch(() => {});
      if (clear) {
        await loc.fill('').catch(() => {});
        await loc.press('Control+A').catch(() => {});
        await loc.press('Backspace').catch(() => {});
      }
      // Playwright fill（触发部分框架）
      try {
        await loc.fill(text, { timeout: short });
      } catch (err) {
        lastErr = err;
      }
      // JS + 原生 setter + input/change（Vue/Element 必需）
      try {
        await setValueWithEvents(loc, text, clear);
      } catch (err) {
        lastErr = err;
      }
      // 仍不对再 type 逐字
      let val = await readInputValue(loc);
      if (val !== text) {
        try {
          if (clear) await loc.fill('');
          await loc.type(text, { delay: text.length > 40 ? 0 : 15, timeout: short });
        } catch (err) {
          lastErr = err;
        }
        val = await readInputValue(loc);
      }
      if (val !== text) {
        // 最后一次 JS 强制
        await setValueWithEvents(loc, text, true).catch(() => {});
        val = await readInputValue(loc);
      }
      return val;
    }

    let value = '';
    let activeLoc = loc;
    try {
      value = await tryFill();
    } catch (err) {
      lastErr = err;
      // 换兜底 selector 再试一次
      try {
        const again = await pickTypeLocator(p, {
          ...args,
          selector: undefined,
          preferSearch: true
        });
        if (again && again.loc) {
          picked = again;
          activeLoc = again.loc;
          await activeLoc.click({ timeout: 1500 }).catch(() => {});
          await setValueWithEvents(activeLoc, text, true);
          value = await readInputValue(activeLoc);
        }
      } catch (err2) {
        lastErr = err2;
      }
    }

    if (pressEnter || args.submitSearch === true) {
      try {
        await activeLoc.press('Enter');
      } catch (_) {
        await p.keyboard.press('Enter').catch(() => {});
      }
      // Element 搜索有时要点放大镜按钮
      if (args.clickSearchButton) {
        try {
          const btn = p
            .locator(
              '.el-input-group__append button, .el-input__suffix, button:has-text("搜索"), button:has-text("查询")'
            )
            .first();
          if (await btn.isVisible().catch(() => false)) {
            await btn.click({ timeout: 2000 }).catch(() => {});
          }
        } catch (_) {}
      }
    }

    const matched = value === text;
    if (!matched && text !== '') {
      // 仍返回结果但标记 failed，让 agent 知道要重试
      const err = new Error(
        `输入未生效: 期望「${text.slice(0, 80)}」实际「${String(value).slice(0, 80)}」（selector=${
          (picked && picked.selector) || args.selector || ''
        }）`
      );
      err.code = 'TYPE_VALUE_MISMATCH';
      err.meta = {
        ok: false,
        expected: text,
        value,
        selector: (picked && picked.selector) || args.selector,
        via: picked && picked.via
      };
      throw err;
    }

    // 搜索类输入后短等列表刷新
    if (pressEnter || args.submitSearch || SEARCH_HINT_RE.test(String(args.selector || '') + String((picked && picked.meta && picked.meta.ph) || ''))) {
      await p.waitForTimeout(Math.min(Number(args.afterMs) || 600, 3000)).catch(() => {});
    }

    return {
      ok: true,
      method: 'robust',
      via: (picked && picked.via) || 'selector',
      selector: (picked && picked.selector) || args.selector || '',
      value,
      matched: true,
      pressEnter: !!(pressEnter || args.submitSearch),
      cleared: clear
    };
  };
}

module.exports = {
  createRobustType,
  pickTypeLocator,
  setValueWithEvents,
  candidateSelectors
};
