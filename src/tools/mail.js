/**
 * Coremail / 企业邮箱：仅查看（IMAP 只读），不发送。
 */
const { ImapFlow } = require('imapflow');

function addrList(v) {
  if (!v) return [];
  if (Array.isArray(v)) {
    return v.map((a) => {
      if (!a) return '';
      if (typeof a === 'string') return a;
      const name = a.name || '';
      const addr = a.address || a.email || '';
      return name ? `${name} <${addr}>` : addr;
    }).filter(Boolean);
  }
  if (typeof v === 'object') {
    const name = v.name || '';
    const addr = v.address || v.email || '';
    return [name ? `${name} <${addr}>` : addr].filter(Boolean);
  }
  return [String(v)];
}

function createMailTools(options = {}) {
  const cfg = options.config || {};
  const logger = options.logger || null;

  function requireConfigured() {
    if (cfg.enabled === false) {
      throw new Error('邮件工具已关闭');
    }
    if (!cfg.host || !cfg.user || !cfg.password) {
      throw new Error(
        '请先在配置页填写 Coremail：IMAP 主机、账号、密码（或授权码）'
      );
    }
  }

  function clientOptions() {
    requireConfigured();
    const port = Number(cfg.port) || 993;
    const secure = cfg.secure !== false && port !== 143;
    return {
      host: String(cfg.host).trim(),
      port,
      secure,
      auth: {
        user: String(cfg.user).trim(),
        pass: String(cfg.password)
      },
      logger: false,
      tls: {
        rejectUnauthorized: cfg.rejectUnauthorized !== false
      }
    };
  }

  async function withClient(fn) {
    const client = new ImapFlow(clientOptions());
    try {
      await client.connect();
      return await fn(client);
    } finally {
      try {
        await client.logout();
      } catch (_) {
        try {
          client.close();
        } catch (__) {}
      }
    }
  }

  function mapEnvelope(env, uid, seq, flags) {
    return {
      uid,
      seq,
      subject: env?.subject || '(无主题)',
      from: addrList(env?.from).join(', '),
      to: addrList(env?.to).join(', '),
      cc: addrList(env?.cc).join(', '),
      date: env?.date ? new Date(env.date).toISOString() : null,
      messageId: env?.messageId || null,
      flags: flags ? [...flags] : []
    };
  }

  async function openBox(client, folder) {
    const box = folder || cfg.folder || 'INBOX';
    // 只读打开，避免误改邮件
    const lock = await client.getMailboxLock(box, { readOnly: true });
    return { box, lock };
  }

  return {
    async mail_test() {
      requireConfigured();
      return withClient(async (client) => {
        const boxes = await client.list();
        const names = (boxes || []).map((b) => b.path).slice(0, 50);
        if (logger) logger.info('mail.test', { host: cfg.host, user: cfg.user, boxes: names.length });
        return {
          ok: true,
          host: cfg.host,
          port: Number(cfg.port) || 993,
          user: cfg.user,
          folders: names,
          message: 'IMAP 连接成功（只读）'
        };
      });
    },

    async mail_list_folders() {
      return withClient(async (client) => {
        const boxes = await client.list();
        return {
          ok: true,
          folders: (boxes || []).map((b) => ({
            path: b.path,
            name: b.name,
            delimiter: b.delimiter,
            specialUse: b.specialUse || null
          }))
        };
      });
    },

    async mail_list(args = {}) {
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
      const folder = args.folder || cfg.folder || 'INBOX';
      const unseenOnly = args.unseenOnly === true;

      return withClient(async (client) => {
        const { lock } = await openBox(client, folder);
        try {
          const total = client.mailbox?.exists || 0;
          if (!total) {
            return { ok: true, folder, total: 0, count: 0, messages: [] };
          }

          let uids;
          if (unseenOnly) {
            uids = await client.search({ seen: false }, { uid: true });
          } else {
            uids = await client.search({ all: true }, { uid: true });
          }
          if (!Array.isArray(uids)) uids = [];
          const slice = uids.slice(-limit).reverse();

          const messages = [];
          if (slice.length) {
            for await (const msg of client.fetch(
              slice,
              { envelope: true, flags: true, uid: true },
              { uid: true }
            )) {
              messages.push(
                mapEnvelope(msg.envelope, msg.uid, msg.seq, msg.flags)
              );
            }
          }
          // 按 uid 新→旧
          messages.sort((a, b) => (b.uid || 0) - (a.uid || 0));

          return {
            ok: true,
            folder,
            total,
            count: messages.length,
            unseenOnly,
            messages
          };
        } finally {
          lock.release();
        }
      });
    },

    async mail_search(args = {}) {
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
      const folder = args.folder || cfg.folder || 'INBOX';
      const query = {};
      if (args.from) query.from = String(args.from);
      if (args.to) query.to = String(args.to);
      if (args.subject) query.subject = String(args.subject);
      if (args.since) query.since = new Date(args.since);
      if (args.before) query.before = new Date(args.before);
      if (args.unseenOnly === true) query.seen = false;
      if (args.query) {
        // 简单关键字：主题或正文（imapflow 用 body）
        query.body = String(args.query);
      }
      if (!Object.keys(query).length) {
        query.all = true;
      }

      return withClient(async (client) => {
        const { lock } = await openBox(client, folder);
        try {
          let uids = await client.search(query, { uid: true });
          if (!Array.isArray(uids)) uids = [];
          const slice = uids.slice(-limit).reverse();
          const messages = [];
          if (slice.length) {
            for await (const msg of client.fetch(
              slice,
              { envelope: true, flags: true, uid: true },
              { uid: true }
            )) {
              messages.push(
                mapEnvelope(msg.envelope, msg.uid, msg.seq, msg.flags)
              );
            }
          }
          messages.sort((a, b) => (b.uid || 0) - (a.uid || 0));
          return {
            ok: true,
            folder,
            matched: uids.length,
            count: messages.length,
            query: args,
            messages
          };
        } finally {
          lock.release();
        }
      });
    },

    async mail_read(args = {}) {
      const uid = Number(args.uid);
      if (!uid) throw new Error('需要邮件 uid（来自 mail_list / mail_search）');
      const folder = args.folder || cfg.folder || 'INBOX';
      const maxText = Math.min(Number(args.maxChars) || 15000, 100000);

      return withClient(async (client) => {
        const { lock } = await openBox(client, folder);
        try {
          let found = null;
          for await (const msg of client.fetch(
            String(uid),
            {
              envelope: true,
              flags: true,
              uid: true,
              bodyStructure: true,
              source: false
            },
            { uid: true }
          )) {
            found = msg;
          }
          if (!found) throw new Error(`未找到 uid=${uid}`);

          // 取纯文本 / html
          let text = '';
          let html = '';
          try {
            const t = await client.download(String(uid), 'TEXT', { uid: true });
            if (t?.content) {
              const chunks = [];
              for await (const chunk of t.content) chunks.push(chunk);
              text = Buffer.concat(chunks).toString('utf8');
            }
          } catch (_) {}

          if (!text) {
            try {
              // 部分服务器用完整 message
              const dl = await client.download(String(uid), undefined, { uid: true });
              if (dl?.content) {
                const chunks = [];
                for await (const chunk of dl.content) chunks.push(chunk);
                const raw = Buffer.concat(chunks).toString('utf8');
                // 极简提取 text/plain
                const m = /Content-Type:\s*text\/plain[\s\S]*?\r?\n\r?\n([\s\S]*?)(?=\r?\n--|\r?\nContent-Type:|$)/i.exec(
                  raw
                );
                text = (m && m[1]) || raw.slice(0, maxText);
              }
            } catch (_) {}
          }

          try {
            // 尝试 html part：遍历 bodyStructure 找 text/html
            const htmlPart = findPart(found.bodyStructure, 'text/html');
            if (htmlPart?.part) {
              const h = await client.download(String(uid), htmlPart.part, {
                uid: true
              });
              if (h?.content) {
                const chunks = [];
                for await (const chunk of h.content) chunks.push(chunk);
                html = Buffer.concat(chunks).toString('utf8');
              }
            }
          } catch (_) {}

          const attachments = listAttachments(found.bodyStructure);

          const textOut =
            text.length > maxText
              ? text.slice(0, maxText) + `…(+${text.length - maxText})`
              : text;
          const htmlOut =
            html.length > maxText
              ? html.slice(0, Math.min(maxText, 8000)) + '…'
              : html.slice(0, 8000);

          return {
            ok: true,
            folder,
            ...mapEnvelope(found.envelope, found.uid, found.seq, found.flags),
            text: textOut || undefined,
            html: htmlOut || undefined,
            attachments,
            message: '只读查看，不会标记已读/发送'
          };
        } finally {
          lock.release();
        }
      });
    }
  };
}

function findPart(node, mime) {
  if (!node) return null;
  const type = `${node.type || ''}/${node.subtype || ''}`.toLowerCase();
  if (type === mime.toLowerCase()) {
    return { part: node.part || node.id, node };
  }
  if (Array.isArray(node.childNodes)) {
    for (const c of node.childNodes) {
      const f = findPart(c, mime);
      if (f) return f;
    }
  }
  return null;
}

function listAttachments(node, out = []) {
  if (!node) return out;
  const disp = (node.disposition || '').toLowerCase();
  const type = `${node.type || ''}/${node.subtype || ''}`.toLowerCase();
  if (
    disp === 'attachment' ||
    (node.dispositionParameters && node.dispositionParameters.filename) ||
    (type !== 'text/plain' &&
      type !== 'text/html' &&
      type !== 'multipart/mixed' &&
      type !== 'multipart/alternative' &&
      type !== 'multipart/related' &&
      node.type &&
      node.type !== 'multipart')
  ) {
    const filename =
      (node.dispositionParameters && node.dispositionParameters.filename) ||
      (node.parameters && node.parameters.name) ||
      'attachment';
    out.push({
      filename,
      type,
      size: node.size || null,
      part: node.part || null
    });
  }
  if (Array.isArray(node.childNodes)) {
    for (const c of node.childNodes) listAttachments(c, out);
  }
  return out;
}

module.exports = { createMailTools };
