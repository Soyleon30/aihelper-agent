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
 * 读信场景：优先最长子 iframe 正文，再回退主页面+frames 合并。
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

  for (const css of bodyCss) {
    try {
      const loc = page.locator(css).first();
      if ((await loc.count()) === 0) continue;
      const tag = await loc.evaluate((el) => el.tagName).catch(() => '');
      if (String(tag).toUpperCase() === 'IFRAME') {
        const handle = await loc.elementHandle();
        const frame = handle ? await handle.contentFrame() : null;
        if (frame) {
          const t = await frameInnerText(frame, 'body', 4000);
          if (t && t.length > 15) {
            body = t;
            bodySource = 'iframe-selector';
            break;
          }
        }
      } else {
        const t = await frameInnerText(page.mainFrame(), css, 4000);
        if (t && t.length > 15) {
          body = t;
          bodySource = 'main-selector';
          break;
        }
      }
    } catch (_) {}
  }

  const frames = typeof page.frames === 'function' ? page.frames() : [];
  const main = typeof page.mainFrame === 'function' ? page.mainFrame() : frames[0];
  let bestFrame = { t: '', len: 0, url: '' };
  for (const f of frames) {
    if (main && f === main) continue;
    const t = await frameInnerText(f, 'body', 4000);
    if (t.length > bestFrame.len) {
      let url = '';
      try {
        url = f.url() || '';
      } catch (_) {}
      bestFrame = { t, len: t.length, url };
    }
  }

  if (bestFrame.len > (body || '').length + 30) {
    body = bestFrame.t;
    bodySource = bestFrame.url || 'iframe-longest';
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
