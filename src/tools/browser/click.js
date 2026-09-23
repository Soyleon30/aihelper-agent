/**
 * 点击定位：仅依赖 browser-session，不 require 其它 browser 子模块。
 */
const bs = require('../browser-session');

async function resolveLocator(p, args) {
  if (args.selector) return p.locator(args.selector).first();
  if (args.text) return p.getByText(args.text, { exact: false }).first();
  throw new Error('需要提供 selector 或 text');
}

async function pickVisibleLocator(p, args) {
  const text = args.text != null ? String(args.text) : '';
  const selector = args.selector != null ? String(args.selector) : '';
  const candidates = [];

  // Element UI / 通用 modal：优先弹层内，避免点到遮罩下隐藏节点
  const modalRoots = [
    '.el-dialog__wrapper .el-dialog',
    '.el-message-box__wrapper .el-message-box',
    '.el-drawer__body',
    '.el-overlay-dialog .el-dialog',
    '[role="dialog"]',
    '.ant-modal-content',
    '.ivu-modal-content'
  ];

  if (selector) {
    for (const root of modalRoots) {
      candidates.push(p.locator(root).locator(selector));
    }
    candidates.push(p.locator(selector));
  }
  if (text) {
    for (const root of modalRoots) {
      candidates.push(
        p.locator(root).getByRole('button', { name: text, exact: false })
      );
      candidates.push(
        p.locator(root).locator('button, a, [role="button"], .el-button').filter({
          hasText: text
        })
      );
      candidates.push(p.locator(root).getByText(text, { exact: true }));
    }
    candidates.push(p.getByRole('button', { name: text, exact: false }));
    candidates.push(p.getByRole('link', { name: text, exact: false }));
    candidates.push(
      p.locator('button, a, [role="button"], .el-button').filter({ hasText: text })
    );
    candidates.push(p.getByText(text, { exact: true }));
    candidates.push(p.getByText(text, { exact: false }));
  }
  if (!candidates.length) throw new Error('需要提供 selector 或 text');

  for (const base of candidates) {
    bs.throwIfAborted();
    let count = 0;
    try {
      count = await base.count();
    } catch (_) {
      continue;
    }
    const limit = Math.min(count, 20);
    for (let i = 0; i < limit; i++) {
      const item = base.nth(i);
      try {
        if (await item.isVisible()) return item;
      } catch (_) {}
    }
  }
  return resolveLocator(p, args);
}

async function jsClickFallback(p, args) {
  const text = args.text != null ? String(args.text) : '';
  const selector = args.selector != null ? String(args.selector) : '';
  return p.evaluate(
    ({ selector: sel, text: txt }) => {
      function isVisible(el) {
        if (!el || !(el instanceof Element)) return false;
        const st = window.getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) {
          return false;
        }
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return false;
        // Element 隐藏列/折叠：真正不可见
        if (el.closest && el.closest('.is-hidden')) {
          const hid = el.closest('.is-hidden');
          if (hid && hid !== el) {
            const hs = window.getComputedStyle(hid);
            if (hs.display === 'none') return false;
          }
        }
        return true;
      }
      function inOpenModal(el) {
        if (!el || !el.closest) return false;
        const dlg = el.closest(
          '.el-dialog, .el-message-box, .el-drawer, [role="dialog"], .ant-modal, .ivu-modal'
        );
        if (!dlg) return false;
        const wrap =
          dlg.closest('.el-dialog__wrapper, .el-message-box__wrapper, .el-overlay, .ant-modal-wrap') ||
          dlg;
        const st = window.getComputedStyle(wrap);
        if (st.display === 'none' || st.visibility === 'hidden') return false;
        return true;
      }
      function clickEl(el) {
        if (!el) return false;
        const target =
          (el.closest &&
            (el.closest('button, a, [role="button"], .el-button, .el-link') || el)) ||
          el;
        try {
          target.scrollIntoView({ block: 'center', inline: 'nearest' });
        } catch (_) {}
        try {
          target.focus();
        } catch (_) {}
        try {
          target.click();
          return true;
        } catch (_) {
          try {
            ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach((type) => {
              target.dispatchEvent(
                new MouseEvent(type, { bubbles: true, cancelable: true, view: window })
              );
            });
            return true;
          } catch (__) {
            return false;
          }
        }
      }
      function pickByText(scope, txt) {
        const nodes = Array.from(
          scope.querySelectorAll(
            'button, a, [role="button"], .el-button, .el-link, span, div, li, em, label'
          )
        );
        const matched = nodes.filter((el) => (el.textContent || '').trim() === txt);
        const loose = nodes.filter((el) => (el.textContent || '').trim().includes(txt));
        for (const pool of [matched, loose]) {
          const inModal = pool.filter((el) => isVisible(el) && inOpenModal(el));
          if (inModal.length && clickEl(inModal[inModal.length - 1])) {
            return { ok: true, via: 'text-modal' };
          }
          const vis = pool.filter(isVisible);
          if (vis.length && clickEl(vis[vis.length - 1])) {
            return { ok: true, via: 'text-visible' };
          }
        }
        return null;
      }
      // 1) 选择器：先 modal 内
      if (sel) {
        const list = Array.from(document.querySelectorAll(sel));
        const inModal = list.filter((el) => isVisible(el) && inOpenModal(el));
        if (inModal.length && clickEl(inModal[inModal.length - 1])) {
          return { ok: true, via: 'selector-modal' };
        }
        const vis = list.find(isVisible) || list[list.length - 1];
        if (clickEl(vis)) return { ok: true, via: 'selector' };
      }
      // 2) 文本：先打开的 dialog
      if (txt) {
        const modals = Array.from(
          document.querySelectorAll(
            '.el-dialog__wrapper, .el-message-box__wrapper, [role="dialog"], .ant-modal-wrap'
          )
        ).filter((w) => {
          const st = window.getComputedStyle(w);
          return st.display !== 'none' && st.visibility !== 'hidden';
        });
        for (let i = modals.length - 1; i >= 0; i--) {
          const hit = pickByText(modals[i], txt);
          if (hit) return hit;
        }
        const hit = pickByText(document, txt);
        if (hit) return hit;
      }
      return { ok: false, error: 'jsClick: element not found' };
    },
    { selector, text }
  );
}

function createRobustClick(cfg) {
  cfg = cfg || {};
  return async function robustClick(p, args) {
      bs.throwIfAborted();
      const timeout = args.timeoutMs || cfg.timeoutMs || 30000;
      const force = args.force === true;
      const noForce = args.force === false;
      let lastErr = null;
      const short = Math.min(Math.max(1500, timeout), 4000);
    
      // Element modal 可能还在动画：短等可见 dialog
      try {
        await p
          .locator('.el-dialog, .el-message-box, [role="dialog"], .ant-modal-content')
          .last()
          .waitFor({ state: 'visible', timeout: 1200 })
          .catch(() => null);
      } catch (_) {}
    
      // 1) 可见节点短超时点击
      try {
        bs.throwIfAborted();
        const loc = await pickVisibleLocator(p, args);
        await loc.scrollIntoViewIfNeeded().catch(() => {});
        await loc.click({ timeout: short, force: force || false, trial: false });
        return { ok: true, method: force ? 'visible-force' : 'visible' };
      } catch (err) {
        lastErr = err;
      }
    
      // 2) force 点击（modal 遮罩/动画常见）
      if (!noForce) {
        try {
          bs.throwIfAborted();
          const loc = await pickVisibleLocator(p, args).catch(() => resolveLocator(p, args));
          await loc.click({ timeout: short, force: true });
          return { ok: true, method: 'force' };
        } catch (err) {
          lastErr = err;
        }
      }
    
      // 3) 页面内 JS（优先 modal 内）
      try {
        bs.throwIfAborted();
        const js = await jsClickFallback(p, args);
        if (js && js.ok) return { ok: true, method: 'js', via: js.via };
        lastErr = new Error((js && js.error) || 'js click failed');
      } catch (err) {
        lastErr = err;
      }
    
      // 4) 再试一次 force + 稍长超时
      if (!noForce) {
        try {
          bs.throwIfAborted();
          const loc = await resolveLocator(p, args);
          await loc.click({ timeout: Math.min(timeout, 6000), force: true });
          return { ok: true, method: 'force-retry' };
        } catch (err) {
          lastErr = err;
        }
      }
    
      throw lastErr || new Error('click failed');
  };
}

module.exports = {
  resolveLocator,
  pickVisibleLocator,
  jsClickFallback,
  createRobustClick
};
