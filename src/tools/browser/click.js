/**
 * 点击定位：仅依赖 browser-session，不 require 其它 browser 子模块。
 * 支持 attr/fid（Coremail 树）、within 作用域、多命中歧义拒绝。
 */
const bs = require('../browser-session');

function cssEscapeAttr(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** 由 attr / fid 生成属性选择器片段，如 [fid="1@1"] */
function attrSelectorFromArgs(args) {
  const parts = [];
  if (args.fid != null && String(args.fid).trim() !== '') {
    parts.push(`[fid="${cssEscapeAttr(String(args.fid).trim())}"]`);
  }
  const attr = args.attr;
  if (attr && typeof attr === 'object') {
    for (const [k, v] of Object.entries(attr)) {
      if (k == null || v == null) continue;
      const key = String(k).replace(/[^\w:-]/g, '');
      if (!key) continue;
      parts.push(`[${key}="${cssEscapeAttr(String(v))}"]`);
    }
  }
  return parts.join('');
}

function buildScopedSelector(args) {
  const attrPart = attrSelectorFromArgs(args);
  let sel = args.selector != null ? String(args.selector).trim() : '';
  const within = args.within != null ? String(args.within).trim() : '';
  if (attrPart) {
    if (sel && sel.includes('[')) {
      // 已有属性时仍可追加 fid
      sel = sel.includes(attrPart) ? sel : `${sel}${attrPart}`;
    } else if (sel) {
      sel = `${sel}${attrPart}`;
    } else {
      sel = `a${attrPart}, [role="link"]${attrPart}, li${attrPart}, span${attrPart}, div${attrPart}, *${attrPart}`;
    }
  }
  if (within && sel) {
    // within 下找 sel：Playwright 用 nested locator，这里返回标记
    return { within, selector: sel, attrPart };
  }
  return { within: within || '', selector: sel, attrPart };
}

async function resolveLocator(p, args) {
  const built = buildScopedSelector(args);
  const root = built.within ? p.locator(built.within) : p;
  if (built.selector) return root.locator(built.selector).first();
  if (args.text) {
    const exact = args.exact === true;
    return root.getByText(String(args.text), { exact }).first();
  }
  throw new Error('需要提供 selector、fid/attr 或 text');
}

/**
 * 收集可见命中；若仅 text 且多个「收件箱」类短词，拒绝 first() 以免点到个人邮箱。
 */
async function collectVisibleHits(p, args) {
  const text = args.text != null ? String(args.text) : '';
  const built = buildScopedSelector(args);
  const selector = built.selector;
  const within = built.within;
  const root = within ? p.locator(within) : p;
  const modalRoots = [
    '.el-dialog__wrapper .el-dialog',
    '.el-message-box__wrapper .el-message-box',
    '.el-drawer__body',
    '.el-overlay-dialog .el-dialog',
    '[role="dialog"]',
    '.ant-modal-content',
    '.ivu-modal-content'
  ];
  const candidates = [];

  if (selector) {
    for (const mr of modalRoots) {
      candidates.push({ loc: p.locator(mr).locator(selector), prefer: 30 });
    }
    if (within) {
      candidates.push({ loc: p.locator(within).locator(selector), prefer: 40 });
    }
    candidates.push({ loc: p.locator(selector), prefer: 20 });
  }
  if (text) {
    const exact = args.exact === true;
    for (const mr of modalRoots) {
      candidates.push({
        loc: p.locator(mr).getByRole('button', { name: text, exact: false }),
        prefer: 25
      });
      candidates.push({
        loc: p
          .locator(mr)
          .locator('button, a, [role="button"], .el-button')
          .filter({ hasText: text }),
        prefer: 24
      });
      candidates.push({
        loc: p.locator(mr).getByText(text, { exact: true }),
        prefer: 23
      });
    }
    if (within) {
      candidates.push({
        loc: root.locator('a, button, [role="button"], .el-button, li, span, div').filter({
          hasText: text
        }),
        prefer: 35
      });
      candidates.push({ loc: root.getByText(text, { exact }), prefer: 34 });
    }
    candidates.push({
      loc: p.getByRole('button', { name: text, exact: false }),
      prefer: 15
    });
    candidates.push({ loc: p.getByRole('link', { name: text, exact: false }), prefer: 15 });
    candidates.push({
      loc: p.locator('button, a, [role="button"], .el-button').filter({ hasText: text }),
      prefer: 14
    });
    candidates.push({ loc: p.getByText(text, { exact: true }), prefer: 12 });
    candidates.push({ loc: p.getByText(text, { exact: false }), prefer: 10 });
  }
  if (!candidates.length) throw new Error('需要提供 selector、fid/attr 或 text');

  const hits = [];
  const seen = new Set();
  for (const { loc: base, prefer } of candidates) {
    bs.throwIfAborted();
    let count = 0;
    try {
      count = await base.count();
    } catch (_) {
      continue;
    }
    const limit = Math.min(count, 25);
    for (let i = 0; i < limit; i++) {
      const item = base.nth(i);
      try {
        if (!(await item.isVisible())) continue;
        const meta = await item
          .evaluate((el) => {
            const a =
              (el.closest &&
                (el.closest('a[fid], a[id^="mltree"], li[id^="mltree"] a, a') || el)) ||
              el;
            const r = a.getBoundingClientRect();
            return {
              id: a.id || el.id || '',
              fid: a.getAttribute('fid') || el.getAttribute('fid') || '',
              tag: (a.tagName || '').toLowerCase(),
              text: (a.innerText || a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
              href: a.getAttribute('href') || '',
              x: Math.round(r.left),
              y: Math.round(r.top)
            };
          })
          .catch(() => null);
        const key = meta
          ? `${meta.id}|${meta.fid}|${meta.x},${meta.y}|${meta.text}`
          : `i${hits.length}`;
        if (seen.has(key)) continue;
        seen.add(key);
        let score = prefer;
        if (meta && meta.fid) score += 5;
        // Coremail：带未读数字的「218 收件箱」优于光秃「收件箱」
        if (meta && /^\d+\s*收件箱/.test(meta.text)) score += 15;
        if (meta && meta.id && /^mltree_\d+_a$/.test(meta.id)) score += 3;
        hits.push({ item, meta, score, prefer });
      } catch (_) {}
    }
    // 有 attr/fid 且已命中，不必扫完所有 text 候选
    if (selector && hits.length >= 1 && attrSelectorFromArgs(args)) break;
  }
  hits.sort((a, b) => b.score - a.score);
  return hits;
}

async function pickVisibleLocator(p, args) {
  const hits = await collectVisibleHits(p, args);
  if (!hits.length) return resolveLocator(p, args);

  const text = args.text != null ? String(args.text).trim() : '';
  const hasAttr = !!(args.fid || (args.attr && Object.keys(args.attr).length) || args.selector);
  const ambiguousInbox =
    text === '收件箱' ||
    text === '草稿箱' ||
    text === '已发送' ||
    text === '已删除' ||
    text === '垃圾邮件';

  // 多节点同名（Coremail 个人/共享都有「收件箱」）：无 fid/selector 时禁止 first()
  if (!hasAttr && hits.length > 1) {
    const fids = [
      ...new Set(hits.map((h) => (h.meta && h.meta.fid) || '').filter(Boolean))
    ];
    const ids = [
      ...new Set(hits.map((h) => (h.meta && h.meta.id) || '').filter(Boolean))
    ];
    if (ambiguousInbox || fids.length > 1 || (ids.length > 1 && text.length <= 8)) {
      const err = new Error(
        `点击歧义：文本「${text || '(selector)'}」命中 ${hits.length} 个可见节点` +
          (fids.length ? `，fid=[${fids.join(', ')}]` : '') +
          (ids.length ? `，id=[${ids.slice(0, 6).join(', ')}]` : '') +
          `。请用 fid:"1@1" 或 selector:"a[fid=\\"1@1\\"]" / #mltree_xx_a，勿只用 text="收件箱"。`
      );
      err.code = 'CLICK_AMBIGUOUS';
      err.meta = {
        count: hits.length,
        fids,
        ids: ids.slice(0, 10),
        samples: hits.slice(0, 5).map((h) => h.meta)
      };
      throw err;
    }
  }

  // 有目标 fid 时优先匹配
  const wantFid = args.fid != null ? String(args.fid).trim() : '';
  if (wantFid) {
    const hit = hits.find((h) => h.meta && h.meta.fid === wantFid);
    if (hit) return hit.item;
  }

  return hits[0].item;
}

async function jsClickFallback(p, args) {
  const text = args.text != null ? String(args.text) : '';
  const built = buildScopedSelector(args);
  const selector = built.selector || (args.selector != null ? String(args.selector) : '');
  const wantFid = args.fid != null ? String(args.fid).trim() : '';
  const within = built.within || '';
  return p.evaluate(
    ({ selector: sel, text: txt, wantFid: fid, within: scopeSel }) => {
      function isVisible(el) {
        if (!el || !(el instanceof Element)) return false;
        const st = window.getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) {
          return false;
        }
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return false;
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
          dlg.closest(
            '.el-dialog__wrapper, .el-message-box__wrapper, .el-overlay, .ant-modal-wrap'
          ) || dlg;
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
      function getFid(el) {
        if (!el) return '';
        return (
          el.getAttribute('fid') ||
          (el.closest && el.closest('[fid]') && el.closest('[fid]').getAttribute('fid')) ||
          ''
        );
      }
      function pickByText(scope, t, preferFid) {
        const nodes = Array.from(
          scope.querySelectorAll(
            'button, a, [role="button"], .el-button, .el-link, span, div, li, em, label'
          )
        );
        let matched = nodes.filter((el) => (el.textContent || '').trim() === t);
        let loose = nodes.filter((el) => (el.textContent || '').trim().includes(t));
        if (preferFid) {
          const byFid = (pool) => pool.filter((el) => getFid(el) === preferFid);
          const mf = byFid(matched);
          const lf = byFid(loose);
          if (mf.length || lf.length) {
            matched = mf.length ? mf : matched;
            loose = lf.length ? lf : loose;
            if (mf.length) {
              const vis = mf.filter(isVisible);
              if (vis.length && clickEl(vis[0])) return { ok: true, via: 'text-fid' };
            }
          }
        }
        for (const pool of [matched, loose]) {
          const inModal = pool.filter((el) => isVisible(el) && inOpenModal(el));
          if (inModal.length && clickEl(inModal[inModal.length - 1])) {
            return { ok: true, via: 'text-modal' };
          }
          // 多命中且无 fid：不点第一个「收件箱」
          const vis = pool.filter(isVisible);
          if (vis.length > 1 && !preferFid && (t === '收件箱' || t.length <= 4)) {
            const withUnread = vis.filter((el) =>
              /^\d+/.test((el.textContent || '').replace(/\s+/g, ' ').trim())
            );
            // 仍多义则失败，让上层报歧义
            if (withUnread.length !== 1) {
              return {
                ok: false,
                error: `jsClick ambiguous text=${t} count=${vis.length}`,
                ambiguous: true
              };
            }
            if (clickEl(withUnread[0])) return { ok: true, via: 'text-unread' };
          }
          if (vis.length && clickEl(vis[vis.length - 1])) {
            return { ok: true, via: 'text-visible' };
          }
        }
        return null;
      }
      const scopeRoot =
        scopeSel && document.querySelector(scopeSel)
          ? document.querySelector(scopeSel)
          : document;

      // 0) 仅 fid
      if (fid && !sel) {
        const byFid = Array.from(document.querySelectorAll(`[fid="${fid}"]`)).filter(isVisible);
        if (byFid.length && clickEl(byFid[0])) return { ok: true, via: 'fid' };
      }
      // 1) 选择器：先 modal 内
      if (sel) {
        let list = [];
        try {
          list = Array.from(scopeRoot.querySelectorAll(sel));
        } catch (_) {
          list = [];
        }
        if (fid) {
          const ff = list.filter((el) => getFid(el) === fid && isVisible(el));
          if (ff.length && clickEl(ff[0])) return { ok: true, via: 'selector-fid' };
        }
        const inModal = list.filter((el) => isVisible(el) && inOpenModal(el));
        if (inModal.length && clickEl(inModal[inModal.length - 1])) {
          return { ok: true, via: 'selector-modal' };
        }
        const vis = list.filter(isVisible);
        if (vis.length === 1 && clickEl(vis[0])) return { ok: true, via: 'selector' };
        if (vis.length > 1 && fid) {
          const ff = vis.find((el) => getFid(el) === fid);
          if (ff && clickEl(ff)) return { ok: true, via: 'selector-fid-vis' };
        }
        if (vis.length && clickEl(vis[vis.length - 1])) return { ok: true, via: 'selector' };
      }
      // 2) 文本
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
          const hit = pickByText(modals[i], txt, fid);
          if (hit) return hit;
        }
        const hit = pickByText(scopeRoot, txt, fid);
        if (hit) return hit;
      }
      return { ok: false, error: 'jsClick: element not found' };
    },
    { selector, text, wantFid, within }
  );
}

function parseFidFromUrl(url) {
  try {
    let u = String(url || '');
    // 先尽量解码 hash（1%401 → 1@1）
    try {
      const hash = u.includes('#') ? u.slice(u.indexOf('#') + 1) : u;
      u = u + ' ' + decodeURIComponent(hash.replace(/\+/g, ' '));
    } catch (_) {}
    // #mail.list|{"fid":"1@1"} 明文或已解码
    const m = u.match(/["']fid["']\s*:\s*["']([^"']+)["']/);
    if (m) return m[1];
    const m4 = u.match(/["']fid["']\s*:\s*(\d+)\b/);
    if (m4) return m4[1];
    // 仍编码：%22fid%22%3A%221%401%22 或 %22fid%22%3A1%7D
    const m2 = u.match(/%22fid%22%3A%22((?:[^%]|%[0-9A-Fa-f]{2})+?)%22/);
    if (m2) {
      try {
        return decodeURIComponent(m2[1]);
      } catch (_) {
        return m2[1].replace(/%40/gi, '@');
      }
    }
    const m3 = u.match(/%22fid%22%3A(\d+)(?:%7D|%2C|%22)/);
    if (m3) return m3[1];
  } catch (_) {}
  return '';
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
    const expectFid =
      args.expectFid != null
        ? String(args.expectFid).trim()
        : args.fid != null
          ? String(args.fid).trim()
          : '';

    try {
      await p
        .locator('.el-dialog, .el-message-box, [role="dialog"], .ant-modal-content')
        .last()
        .waitFor({ state: 'visible', timeout: 1200 })
        .catch(() => null);
    } catch (_) {}

    async function afterClick(method, extra) {
      const out = { ok: true, method, ...(extra || {}) };
      if (expectFid) {
        await p.waitForTimeout(400).catch(() => {});
        const url = p.url();
        const got = parseFidFromUrl(url);
        out.url = url;
        out.fid = got || null;
        out.expectFid = expectFid;
        if (got && got !== expectFid) {
          out.ok = false;
          out.error = `点击后 fid 不符：期望 ${expectFid}，实际 ${got}（常为点到个人收件箱 fid=1）`;
          out.hint =
            '请 browser_click({ fid:"1@1" }) 或 selector:\'a[fid="1@1"]\'，禁止 text:"收件箱"';
          const err = new Error(out.error);
          err.code = 'FID_MISMATCH';
          err.meta = out;
          throw err;
        }
        if (!got && expectFid.includes('@')) {
          // hash 尚未更新时不硬失败，仅标记
          out.fidCheck = 'pending';
        } else if (got === expectFid) {
          out.fidCheck = 'ok';
        }
      }
      return out;
    }

    // 1) 可见节点
    try {
      bs.throwIfAborted();
      const loc = await pickVisibleLocator(p, args);
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      await loc.click({ timeout: short, force: force || false, trial: false });
      return await afterClick(force ? 'visible-force' : 'visible');
    } catch (err) {
      lastErr = err;
      if (err && err.code === 'CLICK_AMBIGUOUS') throw err;
      if (err && err.code === 'FID_MISMATCH') throw err;
    }

    // 2) force
    if (!noForce) {
      try {
        bs.throwIfAborted();
        const loc = await pickVisibleLocator(p, args).catch(() => resolveLocator(p, args));
        await loc.click({ timeout: short, force: true });
        return await afterClick('force');
      } catch (err) {
        lastErr = err;
        if (err && (err.code === 'CLICK_AMBIGUOUS' || err.code === 'FID_MISMATCH')) throw err;
      }
    }

    // 3) JS
    try {
      bs.throwIfAborted();
      const js = await jsClickFallback(p, args);
      if (js && js.ok) return await afterClick('js', { via: js.via });
      if (js && js.ambiguous) {
        const err = new Error(js.error || 'click ambiguous');
        err.code = 'CLICK_AMBIGUOUS';
        throw err;
      }
      lastErr = new Error((js && js.error) || 'js click failed');
    } catch (err) {
      lastErr = err;
      if (err && (err.code === 'CLICK_AMBIGUOUS' || err.code === 'FID_MISMATCH')) throw err;
    }

    // 4) force-retry
    if (!noForce) {
      try {
        bs.throwIfAborted();
        const loc = await resolveLocator(p, args);
        await loc.click({ timeout: Math.min(timeout, 6000), force: true });
        return await afterClick('force-retry');
      } catch (err) {
        lastErr = err;
        if (err && err.code === 'FID_MISMATCH') throw err;
      }
    }

    throw lastErr || new Error('click failed');
  };
}

module.exports = {
  resolveLocator,
  pickVisibleLocator,
  jsClickFallback,
  createRobustClick,
  attrSelectorFromArgs,
  parseFidFromUrl
};
