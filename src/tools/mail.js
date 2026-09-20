/**
 * Coremail 邮件查看：通过本机客户端 / 已登录网页会话（不用 IMAP/POP3）。
 * 依赖浏览器会话保持，在用户已登录的 Coremail 界面上列表/搜索/读信。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const bs = require('./browser-session');

const DEFAULT_SELECTORS = {
  /** 收件箱/邮件列表行（可多选，取第一个匹配） */
  listRows:
    'tr[mid], tr[msgId], .mail-list tr, .xt-mail-list tr, table.list tbody tr, [class*="mail-item"], [class*="msg-item"]',
  /** 行内主题 */
  listSubject:
    '.subject, .mail-subject, td.subject, [class*="subject"], a[href*="view"]',
  /** 行内发件人 */
  listFrom: '.from, .mail-from, td.from, [class*="from"]',
  /** 行内日期 */
  listDate: '.date, .mail-date, td.date, [class*="date"], [class*="time"]',
  /** 读信区主题 */
  readSubject:
    '.read-subject, .mail-read-subject, h1.subject, [class*="read"] [class*="subject"], .subject-text',
  /** 读信区正文 */
  readBody:
    '.mail-content, .read-content, #mailContent, .content-body, [class*="mail-body"], [class*="msg-content"], iframe',
  /** 搜索框 */
  searchInput:
    'input[type="search"], input[name*="search"], input[placeholder*="搜索"], input[placeholder*="search"], #searchInput',
  /** 搜索按钮 */
  searchButton:
    'button[type="submit"], .search-btn, [class*="search-btn"], a.search',
  /** 收件箱入口 */
  inboxLink:
    'a[href*="inbox"], a[href*="INBOX"], [title*="收件箱"], a:has-text("收件箱"), .folder-inbox'
};

function createMailTools(options = {}) {
  const cfg = options.config || {};
  const logger = options.logger || null;
  const userDataPath = options.userDataPath || process.cwd();

  function log(event, data) {
    if (!logger) return;
    try {
      logger.info(event, data);
      if (logger.action) logger.action('mail', event, data);
    } catch (_) {}
  }

  function selectors() {
    return { ...DEFAULT_SELECTORS, ...(cfg.selectors || {}) };
  }

  function baseUrl() {
    return String(cfg.baseUrl || cfg.webmailUrl || '').replace(/\/$/, '');
  }

  function requireUiReady() {
    if (cfg.enabled === false) throw new Error('邮件工具已关闭');
    if (!baseUrl() && !cfg.exePath && !bs.isPageAlive()) {
      throw new Error(
        '请配置 Coremail 网页地址 baseUrl，或先打开已登录的 Coremail 页面；也可填写本机客户端 exePath'
      );
    }
  }

  async function ensurePlaywrightPage() {
    // 复用浏览器工具的 ensure 逻辑：通过 browser-session；若未启动则临时 launch
    if (bs.isPageAlive()) return bs.getShared().page;

    const { createBrowserTools } = require('./browser');
    const browserTools = createBrowserTools({
      config: {
        headless: false,
        stealth: true,
        preferSystemBrowser: true,
        keepSession: true,
        ...(cfg.browser || {})
      },
      userDataPath,
      logger
    });
    // 触发 ensurePage
    if (baseUrl()) {
      await browserTools.browser_navigate({ url: baseUrl() });
    } else {
      await browserTools.browser_state();
      if (!bs.isPageAlive()) {
        throw new Error('浏览器未打开。请先打开 Coremail 并登录，或配置 baseUrl');
      }
    }
    return bs.getShared().page;
  }

  async function gotoMailHome() {
    const page = await ensurePlaywrightPage();
    const url = baseUrl();
    if (url) {
      const cur = page.url() || '';
      if (!cur.includes(new URL(url).host) && !/coremail|mail/i.test(cur)) {
        await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: cfg.timeoutMs || 60000
        });
      }
    }
    return page;
  }

  async function tryClickInbox(page) {
    const sel = selectors();
    const candidates = sel.inboxLink.split(',').map((s) => s.trim());
    for (const c of candidates) {
      try {
        if (c.includes(':has-text')) {
          const text = /:has-text\("([^"]+)"\)/.exec(c);
          if (text) {
            const loc = page.getByText(text[1], { exact: false }).first();
            if (await loc.count()) {
              await loc.click({ timeout: 3000 });
              await page.waitForTimeout(800);
              return true;
            }
          }
        } else {
          const loc = page.locator(c).first();
          if ((await loc.count()) > 0) {
            await loc.click({ timeout: 3000 });
            await page.waitForTimeout(800);
            return true;
          }
        }
      } catch (_) {}
    }
    return false;
  }

  async function scrapeList(page, limit) {
    const sel = selectors();
    // 在页面内尽量通用抽取
    const rows = await page.evaluate(
      ({ listRows, listSubject, listFrom, listDate, limit }) => {
        function text(el) {
          return (el && (el.innerText || el.textContent) || '').replace(/\s+/g, ' ').trim();
        }
        function pick(row, css) {
          if (!css) return '';
          for (const part of css.split(',')) {
            const el = row.querySelector(part.trim());
            if (el) return text(el);
          }
          return '';
        }
        const rowSel = listRows.split(',').map((s) => s.trim());
        let nodes = [];
        for (const s of rowSel) {
          try {
            const found = Array.from(document.querySelectorAll(s));
            if (found.length) {
              nodes = found;
              break;
            }
          } catch (_) {}
        }
        // 过滤空行、表头
        nodes = nodes.filter((n) => {
          const t = text(n);
          return t.length > 2 && !/主题|发件人|日期|时间/.test(t.slice(0, 12));
        });
        const out = [];
        for (let i = 0; i < Math.min(nodes.length, limit); i++) {
          const row = nodes[i];
          const subject =
            pick(row, listSubject) ||
            text(row.querySelector('a')) ||
            text(row).slice(0, 80);
          const from = pick(row, listFrom);
          const date = pick(row, listDate);
          const mid =
            row.getAttribute('mid') ||
            row.getAttribute('msgid') ||
            row.getAttribute('data-id') ||
            row.getAttribute('data-mid') ||
            String(i + 1);
          out.push({
            id: mid,
            index: i + 1,
            subject: subject || '(无主题)',
            from: from || '',
            date: date || '',
            preview: text(row).slice(0, 120)
          });
        }
        return out;
      },
      {
        listRows: sel.listRows,
        listSubject: sel.listSubject,
        listFrom: sel.listFrom,
        listDate: sel.listDate,
        limit
      }
    );
    return rows || [];
  }

  async function scrapeRead(page, maxChars) {
    const sel = selectors();
    return page.evaluate(
      ({ readSubject, readBody, maxChars }) => {
        function text(el) {
          return (el && (el.innerText || el.textContent) || '').replace(/\s+/g, ' ').trim();
        }
        function first(css) {
          for (const part of (css || '').split(',')) {
            try {
              const el = document.querySelector(part.trim());
              if (el) return el;
            } catch (_) {}
          }
          return null;
        }
        let subject = text(first(readSubject));
        let body = '';
        const bodyEl = first(readBody);
        if (bodyEl) {
          if (bodyEl.tagName === 'IFRAME') {
            try {
              body = text(bodyEl.contentDocument && bodyEl.contentDocument.body);
            } catch (_) {
              body = '';
            }
          } else {
            body = text(bodyEl);
          }
        }
        if (!body) {
          body = text(document.querySelector('body')).slice(0, maxChars);
        }
        if (body.length > maxChars) body = body.slice(0, maxChars) + '…';
        return {
          subject: subject || document.title || '(无主题)',
          text: body,
          url: location.href
        };
      },
      {
        readSubject: sel.readSubject,
        readBody: sel.readBody,
        maxChars
      }
    );
  }

  function findClientExe() {
    const candidates = [
      cfg.exePath,
      process.env.COREMAIL_EXE,
      'C:\\Program Files\\Coremail\\Coremail.exe',
      'C:\\Program Files (x86)\\Coremail\\Coremail.exe',
      'C:\\Program Files\\Coremail XT\\Coremail.exe',
      'C:\\Program Files (x86)\\Coremail XT\\Coremail.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Coremail', 'Coremail.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Coremail', 'Coremail.exe')
    ].filter(Boolean);
    for (const p of candidates) {
      try {
        if (p && fs.existsSync(p)) return p;
      } catch (_) {}
    }
    return null;
  }

  return {
    async mail_test() {
      requireUiReady();
      const exe = findClientExe();
      let pageInfo = { open: false };
      try {
        if (bs.isPageAlive() || baseUrl()) {
          const page = await gotoMailHome();
          pageInfo = {
            open: true,
            url: page.url(),
            title: await page.title().catch(() => '')
          };
        }
      } catch (err) {
        pageInfo = { open: false, error: err.message };
      }
      const ok = !!(exe || pageInfo.open || baseUrl());
      log('mail.test', { ok, exe, pageInfo, baseUrl: baseUrl() });
      return {
        ok,
        mode: 'client_ui',
        protocol: 'none_imap_pop3',
        message: ok
          ? '将通过本机 Coremail 客户端/网页会话查看邮件（不使用 IMAP/POP3）'
          : '未检测到客户端或网页会话，请配置 baseUrl / exePath，或先登录 Coremail',
        exePath: exe || cfg.exePath || null,
        baseUrl: baseUrl() || null,
        browser: pageInfo,
        hint: '请先在浏览器或客户端中登录邮箱，再让助手 mail_list / mail_read'
      };
    },

    async mail_launch_client() {
      const exe = findClientExe();
      if (!exe) {
        throw new Error(
          '未找到 Coremail 客户端。请在配置中填写 exePath（本机 .exe 完整路径）'
        );
      }
      spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
      log('mail.launch', { exe });
      return {
        ok: true,
        exePath: exe,
        message: '已启动 Coremail 客户端，请确认已登录后再列表/读信'
      };
    },

    async mail_list_folders() {
      // UI 模式下列出常见文件夹提示 + 尝试从侧栏抓取
      const page = await gotoMailHome();
      let folders = [];
      try {
        folders = await page.evaluate(() => {
          const links = Array.from(
            document.querySelectorAll(
              'a[href*="folder"], a[href*="mbox"], .folder-list a, [class*="folder"] a, nav a'
            )
          );
          const names = [];
          const seen = new Set();
          for (const a of links) {
            const t = (a.innerText || '').replace(/\s+/g, ' ').trim();
            if (t && t.length < 40 && !seen.has(t)) {
              seen.add(t);
              names.push({ path: t, name: t });
            }
          }
          return names.slice(0, 40);
        });
      } catch (_) {}
      if (!folders.length) {
        folders = [
          { path: '收件箱', name: '收件箱' },
          { path: '已发送', name: '已发送' },
          { path: '草稿箱', name: '草稿箱' },
          { path: '已删除', name: '已删除' }
        ];
      }
      return { ok: true, mode: 'client_ui', folders };
    },

    async mail_list(args = {}) {
      requireUiReady();
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 50);
      const page = await gotoMailHome();
      if (args.folder && /收件箱|inbox/i.test(args.folder)) {
        await tryClickInbox(page);
      } else if (!args.folder) {
        await tryClickInbox(page);
      } else if (args.folder) {
        try {
          await page.getByText(String(args.folder), { exact: false }).first().click({
            timeout: 5000
          });
          await page.waitForTimeout(1000);
        } catch (_) {}
      }

      await page.waitForTimeout(600);
      let messages = await scrapeList(page, limit);
      if (args.unseenOnly === true) {
        messages = messages.filter(
          (m) =>
            /未读|new|unread/i.test(m.preview || '') ||
            /未读/.test(m.subject || '')
        );
      }

      log('mail.list', { count: messages.length, url: page.url() });
      return {
        ok: true,
        mode: 'client_ui',
        folder: args.folder || '收件箱',
        count: messages.length,
        url: page.url(),
        messages,
        message:
          messages.length
            ? '来自本机 Coremail 界面列表（非 IMAP）。读信请用 mail_read，id 或 index 任选其一。'
            : '未解析到邮件行。请确认已登录且在收件箱；可在配置中调整 selectors.listRows'
      };
    },

    async mail_search(args = {}) {
      requireUiReady();
      const q =
        args.query ||
        args.subject ||
        args.from ||
        [args.subject, args.from, args.query].filter(Boolean).join(' ');
      if (!q) throw new Error('请提供 query / subject / from');
      const page = await gotoMailHome();
      const sel = selectors();
      let filled = false;
      for (const part of sel.searchInput.split(',')) {
        try {
          const loc = page.locator(part.trim()).first();
          if ((await loc.count()) > 0) {
            await loc.fill(String(q));
            filled = true;
            break;
          }
        } catch (_) {}
      }
      if (!filled) {
        // 尝试快捷键或占位
        try {
          await page.keyboard.press('Control+F');
        } catch (_) {}
      }
      for (const part of sel.searchButton.split(',')) {
        try {
          const loc = page.locator(part.trim()).first();
          if ((await loc.count()) > 0) {
            await loc.click({ timeout: 2000 });
            break;
          }
        } catch (_) {}
      }
      try {
        await page.keyboard.press('Enter');
      } catch (_) {}
      await page.waitForTimeout(1200);
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 50);
      const messages = await scrapeList(page, limit);
      return {
        ok: true,
        mode: 'client_ui',
        query: q,
        count: messages.length,
        messages
      };
    },

    async mail_read(args = {}) {
      requireUiReady();
      const page = await gotoMailHome();
      const maxChars = Math.min(Number(args.maxChars) || 15000, 100000);
      const index = Number(args.index) || Number(args.uid) || 0;
      const id = args.id != null ? String(args.id) : null;

      if (id || index) {
        const sel = selectors();
        const clicked = await page.evaluate(
          ({ listRows, id, index }) => {
            const rowSel = listRows.split(',').map((s) => s.trim());
            let nodes = [];
            for (const s of rowSel) {
              try {
                const found = Array.from(document.querySelectorAll(s));
                if (found.length) {
                  nodes = found.filter((n) => (n.innerText || '').trim().length > 2);
                  break;
                }
              } catch (_) {}
            }
            let target = null;
            if (id) {
              target = nodes.find(
                (n) =>
                  n.getAttribute('mid') === id ||
                  n.getAttribute('msgid') === id ||
                  n.getAttribute('data-id') === id ||
                  n.getAttribute('data-mid') === id
              );
            }
            if (!target && index > 0 && nodes[index - 1]) target = nodes[index - 1];
            if (!target) return false;
            const a = target.querySelector('a') || target;
            a.click();
            return true;
          },
          { listRows: sel.listRows, id, index }
        );
        if (!clicked) {
          throw new Error(
            `未找到邮件 id=${id || ''} index=${index || ''}。请先 mail_list 再读。`
          );
        }
        await page.waitForTimeout(1200);
      }

      const content = await scrapeRead(page, maxChars);
      log('mail.read', { subject: content.subject, url: content.url });
      return {
        ok: true,
        mode: 'client_ui',
        id: id || undefined,
        index: index || undefined,
        subject: content.subject,
        text: content.text,
        url: content.url,
        message: '正文来自本机 Coremail 界面（只读，未使用 IMAP/POP3）'
      };
    }
  };
}

module.exports = { createMailTools, DEFAULT_SELECTORS };
