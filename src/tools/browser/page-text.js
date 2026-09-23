/**
 * 页面文本/HTML：主 frame + 子 iframe（Coremail 正文常在 iframe）。
 */

async function frameInnerText(frame, selector, timeoutMs = 2500) {
  const sel = selector && String(selector).trim() ? String(selector).trim() : 'body';
  try {
    const t = await frame.locator(sel).first().innerText({ timeout: timeoutMs });
    return String(t || '')
      .replace(/\s+/g, ' ')
      .trim();
  } catch (_) {
    try {
      return await frame.evaluate((s) => {
        let el = null;
        if (s && s !== 'body') {
          try {
            el = document.querySelector(s);
          } catch (_) {}
        }
        if (!el) el = document.body;
        return ((el && (el.innerText || el.textContent)) || '')
          .replace(/\s+/g, ' ')
          .trim();
      }, sel);
    } catch (_) {
      return '';
    }
  }
}

function alreadyHave(parts, t) {
  if (!t || t.length < 20) return true;
  const head = t.slice(0, Math.min(120, t.length));
  return parts.some((p) => p.includes(head) || head.includes(p.slice(0, Math.min(120, p.length))));
}

/**
 * @param {import('playwright').Page} page
 * @param {{ selector?: string, maxChars?: number, includeFrames?: boolean }} opts
 */
async function collectPageText(page, opts = {}) {
  const maxChars = Math.min(Math.max(Number(opts.maxChars) || 100000, 1), 200000);
  const selector = opts.selector ? String(opts.selector).trim() : '';
  const includeFrames = opts.includeFrames !== false;
  const parts = [];
  const sources = [];
  const frames = typeof page.frames === 'function' ? page.frames() : [];
  const main = typeof page.mainFrame === 'function' ? page.mainFrame() : frames[0];

  async function pushFrom(frame, sel, label) {
    const t = await frameInnerText(frame, sel);
    if (!t || alreadyHave(parts, t)) return false;
    parts.push(t);
    sources.push(label);
    return true;
  }

  if (selector) {
    if (main) await pushFrom(main, selector, 'main');
    if (includeFrames) {
      for (const f of frames) {
        if (main && f === main) continue;
        let label = 'iframe';
        try {
          label = f.url() || 'iframe';
        } catch (_) {}
        await pushFrom(f, selector, label);
      }
    }
  }

  if (!parts.length) {
    let mainBody = '';
    if (main) {
      mainBody = await frameInnerText(main, 'body');
      if (mainBody) {
        parts.push(mainBody);
        sources.push('main');
      }
    }
    if (includeFrames) {
      const extras = [];
      for (const f of frames) {
        if (main && f === main) continue;
        const t = await frameInnerText(f, 'body');
        if (!t || t.length < 25) continue;
        if (mainBody && mainBody.includes(t.slice(0, Math.min(80, t.length)))) continue;
        let url = '';
        try {
          url = f.url() || '';
        } catch (_) {}
        extras.push({ t, url, len: t.length });
      }
      extras.sort((a, b) => b.len - a.len);
      for (const ex of extras) {
        if (alreadyHave(parts, ex.t)) continue;
        parts.push(ex.t);
        sources.push(ex.url || 'iframe');
      }
    }
  }

  let text = parts.join('\n\n---\n\n');
  const truncated = text.length > maxChars;
  if (truncated) text = text.slice(0, maxChars) + '…';
  return {
    text,
    sources,
    frameCount: frames.length,
    includedFrames: sources.filter((s) => s !== 'main').length,
    truncated
  };
}

/**
 * @param {import('playwright').Page} page
 * @param {{ selector?: string, maxChars?: number, includeFrames?: boolean }} opts
 */
async function collectPageHtml(page, opts = {}) {
  const maxChars = Math.min(Math.max(Number(opts.maxChars) || 200000, 1), 500000);
  const selector = opts.selector ? String(opts.selector).trim() : '';
  const includeFrames = opts.includeFrames !== false;
  const chunks = [];
  const frames = typeof page.frames === 'function' ? page.frames() : [];
  const main = typeof page.mainFrame === 'function' ? page.mainFrame() : frames[0];

  async function htmlFrom(frame, sel) {
    try {
      if (sel) {
        return await frame.locator(sel).first().innerHTML({ timeout: 2500 });
      }
      return await frame.content();
    } catch (_) {
      try {
        return await frame.evaluate((s) => {
          if (s) {
            const el = document.querySelector(s);
            return el ? el.innerHTML : '';
          }
          return document.documentElement ? document.documentElement.outerHTML : '';
        }, sel || null);
      } catch (_) {
        return '';
      }
    }
  }

  if (selector) {
    if (main) {
      const h = await htmlFrom(main, selector);
      if (h) chunks.push(h);
    }
    if (includeFrames) {
      for (const f of frames) {
        if (main && f === main) continue;
        const h = await htmlFrom(f, selector);
        if (h && h.length > 20) {
          let url = '';
          try {
            url = f.url() || '';
          } catch (_) {}
          chunks.push(`<!-- iframe ${url} -->\n${h}`);
        }
      }
    }
  }

  if (!chunks.length) {
    try {
      chunks.push(await page.content());
    } catch (_) {
      if (main) {
        const h = await htmlFrom(main, null);
        if (h) chunks.push(h);
      }
    }
    if (includeFrames) {
      for (const f of frames) {
        if (main && f === main) continue;
        const h = await htmlFrom(f, null);
        if (h && h.length > 40) {
          let url = '';
          try {
            url = f.url() || '';
          } catch (_) {}
          chunks.push(`<!-- iframe ${url} -->\n${h}`);
        }
      }
    }
  }

  let html = chunks.join('\n\n');
  if (html.length > maxChars) html = html.slice(0, maxChars) + '…';
  return { html, frameCount: frames.length };
}

/**
 * 从 frame 文档提取正文（优先 p 段）与收发件人（#rc_from / blockquote）。
 * Coremail：.mail-content > iframe > body > p… + blockquote #rc_from
 */
async function extractMailDoc(frame) {
  try {
    return await frame.evaluate(() => {
      function clean(s) {
        return String(s || '')
          .replace(/\u00a0/g, ' ')
          .replace(/[ \t]+/g, ' ')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
      }
      const body = document.body;
      if (!body) return { text: '', from: [], to: [], paragraphs: 0 };

      const rcNodes = Array.from(
        document.querySelectorAll(
          '#rc_from, [id="rc_from"], [id*="rc_from"], .rc_from, [class*="rc_from"]'
        )
      );
      const from = [];
      const to = [];
      const seen = new Set();
      for (const n of rcNodes) {
        const t = clean(n.innerText || n.textContent);
        if (!t || t.length > 500 || seen.has(t)) continue;
        seen.add(t);
        const label = clean(
          (n.getAttribute('title') || n.getAttribute('aria-label') || n.className || '') +
            ' ' +
            (n.parentElement ? n.parentElement.innerText || '' : '')
        ).slice(0, 80);
        if (/收件|to\b|抄送|cc\b|密送|bcc/i.test(label) && !/发件|from/i.test(label)) {
          to.push(t);
        } else {
          from.push(t);
        }
      }

      const bqs = Array.from(document.querySelectorAll('blockquote'));
      for (const bq of bqs) {
        const t = clean(bq.innerText || bq.textContent);
        if (!t || t.length > 800) continue;
        if (/发件人|From\s*:/i.test(t) && from.length === 0) {
          const m = t.match(/(?:发件人|From)\s*[:：]\s*(.+)/i);
          if (m) from.push(clean(m[1]).slice(0, 200));
        }
        if (/收件人|To\s*:/i.test(t) && to.length === 0) {
          const m = t.match(/(?:收件人|To)\s*[:：]\s*(.+)/i);
          if (m) to.push(clean(m[1]).slice(0, 200));
        }
      }

      const ps = Array.from(body.querySelectorAll('p'))
        .map((p) => clean(p.innerText || p.textContent))
        .filter((t) => t && t.length > 0);
      let text = '';
      if (ps.length >= 1) {
        const joined = ps.join('\n\n');
        const bqText = bqs.map((b) => clean(b.innerText || b.textContent)).join('\n');
        if (bqText && joined.includes(bqText.slice(0, Math.min(40, bqText.length)))) {
          text = ps
            .filter((t) => {
              if (from.some((f) => t.includes(f) || f.includes(t))) return false;
              if (to.some((x) => t.includes(x) || x.includes(t))) return false;
              if (/^(发件人|收件人|抄送|主题|From|To|Cc|Subject)\s*[:：]/i.test(t)) return false;
              return true;
            })
            .join('\n\n');
        } else {
          text = joined;
        }
      }
      if (!text || text.length < 8) {
        text = clean(body.innerText || body.textContent);
      }
      if (from.length || to.length) {
        const drop = new Set([...from, ...to].map((x) => x.slice(0, 40)));
        const lines = text.split(/\n+/).filter((line) => {
          const L = clean(line);
          if (!L) return false;
          for (const d of drop) {
            if (d && L.includes(d) && L.length < d.length + 30) return false;
          }
          if (/^(发件人|收件人|抄送|密送|主题)\s*[:：]/.test(L) && L.length < 120) return false;
          return true;
        });
        if (lines.join('\n').length > 20) text = lines.join('\n');
      }
      return {
        text: clean(text),
        from: from.slice(0, 20),
        to: to.slice(0, 20),
        paragraphs: ps.length
      };
    });
  } catch (_) {
    const t = await frameInnerText(frame, 'body', 4000);
    return { text: t || '', from: [], to: [], paragraphs: 0 };
  }
}

async function frameFromElement(loc) {
  try {
    const handle = await loc.elementHandle();
    if (!handle) return null;
    return handle.contentFrame();
  } catch (_) {
    return null;
  }
}

/**
 * 读信：.mail-content 内 iframe body 的 p 正文 + #rc_from 收发件人。
 * @param {import('playwright').Page} page
 * @param {{ bodySelectors?: string, subjectSelectors?: string, maxChars?: number }} opts
 */
async function collectMailBody(page, opts = {}) {
  const maxChars = Math.min(Math.max(Number(opts.maxChars) || 15000, 1), 100000);
  const bodyCss = String(opts.bodySelectors || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && !/^iframe$/i.test(s));
  const subjectCss = String(opts.subjectSelectors || '');

  let subject = '';
  try {
    subject = await page.evaluate((css) => {
      const text = (el) =>
        ((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim();
      for (const part of (css || '').split(',')) {
        try {
          const el = document.querySelector(part.trim());
          if (el) {
            const t = text(el);
            if (t) return t;
          }
        } catch (_) {}
      }
      return '';
    }, subjectCss);
  } catch (_) {}

  let body = '';
  let bodySource = '';
  let from = [];
  let to = [];
  let paragraphs = 0;

  // 1) .mail-content 等容器：先找内部 iframe，再取 iframe 文档
  for (const css of bodyCss) {
    try {
      const loc = page.locator(css).first();
      if ((await loc.count()) === 0) continue;
      const tag = await loc.evaluate((el) => el.tagName).catch(() => '');
      if (String(tag).toUpperCase() === 'IFRAME') {
        const frame = await frameFromElement(loc);
        if (frame) {
          const doc = await extractMailDoc(frame);
          if (doc.text && doc.text.length > 8) {
            body = doc.text;
            from = doc.from || [];
            to = doc.to || [];
            paragraphs = doc.paragraphs || 0;
            bodySource = 'iframe-selector';
            break;
          }
        }
      } else {
        // 容器 div：优先子 iframe（Coremail: .mail-content > iframe）
        const nested = loc.locator('iframe').first();
        if ((await nested.count()) > 0) {
          const frame = await frameFromElement(nested);
          if (frame) {
            const doc = await extractMailDoc(frame);
            if (doc.text && doc.text.length > 8) {
              body = doc.text;
              from = doc.from || [];
              to = doc.to || [];
              paragraphs = doc.paragraphs || 0;
              bodySource = 'mail-content-iframe';
              break;
            }
          }
        }
        // 容器内直接正文（无 iframe）
        const docMain = await page.evaluate((sel) => {
          const root = document.querySelector(sel);
          if (!root) return null;
          const clean = (s) =>
            String(s || '')
              .replace(/\s+/g, ' ')
              .trim();
          const ps = Array.from(root.querySelectorAll('p'))
            .map((p) => clean(p.innerText || p.textContent))
            .filter(Boolean);
          const rc = Array.from(
            root.querySelectorAll('#rc_from, [id="rc_from"], [id*="rc_from"]')
          ).map((n) => clean(n.innerText || n.textContent));
          return {
            text: ps.length ? ps.join('\n\n') : clean(root.innerText || root.textContent),
            from: rc.filter(Boolean).slice(0, 20),
            paragraphs: ps.length
          };
        }, css);
        if (docMain && docMain.text && docMain.text.length > 15) {
          body = docMain.text;
          if (docMain.from && docMain.from.length) from = docMain.from;
          paragraphs = docMain.paragraphs || 0;
          bodySource = 'main-selector';
          break;
        }
      }
    } catch (_) {}
  }

  // 2) 全部子 frame：取最长正文（并解析 rc_from）
  const frames = typeof page.frames === 'function' ? page.frames() : [];
  const main = typeof page.mainFrame === 'function' ? page.mainFrame() : frames[0];
  let best = { text: '', len: 0, url: '', from: [], to: [], paragraphs: 0 };
  for (const f of frames) {
    if (main && f === main) continue;
    const doc = await extractMailDoc(f);
    const len = (doc.text || '').length;
    if (len > best.len) {
      let url = '';
      try {
        url = f.url() || '';
      } catch (_) {}
      best = {
        text: doc.text || '',
        len,
        url,
        from: doc.from || [],
        to: doc.to || [],
        paragraphs: doc.paragraphs || 0
      };
    }
  }

  // 有 iframe 正文时，优先用它（避免 .mail-content 外壳的短文本抢先）
  if (best.len > 0 && (best.len >= (body || '').length || (body || '').length < 80)) {
    if (best.len > (body || '').length || bodySource === 'main-selector' || !body) {
      body = best.text;
      bodySource = best.url || 'iframe-longest';
      if (best.from.length) from = best.from;
      if (best.to.length) to = best.to;
      paragraphs = best.paragraphs;
    }
  }

  if ((!body || body.length < 40) && main) {
    const docMain = await extractMailDoc(main);
    if ((docMain.text || '').length > (body || '').length) {
      body = docMain.text;
      bodySource = bodySource || 'main-body';
      if (docMain.from.length) from = docMain.from;
      if (docMain.to.length) to = docMain.to;
      paragraphs = docMain.paragraphs;
    }
  }

  if (!body || body.length < 40) {
    const all = await collectPageText(page, { maxChars, includeFrames: true });
    if ((all.text || '').length > (body || '').length) {
      body = all.text;
      bodySource = bodySource || 'page+frames';
    }
  }

  if (body.length > maxChars) body = body.slice(0, maxChars) + '…';
  let title = '';
  try {
    title = await page.title();
  } catch (_) {}
  return {
    subject: subject || title || '(无主题)',
    text: body || '',
    from: from.length ? from : undefined,
    to: to.length ? to : undefined,
    paragraphs: paragraphs || undefined,
    url: page.url(),
    bodySource: bodySource || 'empty',
    frameCount: frames.length
  };
}

module.exports = {
  frameInnerText,
  collectPageText,
  collectPageHtml,
  collectMailBody
};
