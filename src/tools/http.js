const fetch = require('node-fetch');
const { URLSearchParams } = require('url');

function createHttpTools(options = {}) {
  const cfg = options.config || {};
  const defaultTimeout = cfg.timeoutMs || 30000;
  const maxBody = cfg.maxBodyBytes || 5 * 1024 * 1024;

  return {
    async http_request(args) {
      const method = (args.method || 'GET').toUpperCase();
      const headers = { ...(args.headers || {}) };
      let body;

      if (args.json != null) {
        headers['Content-Type'] = headers['Content-Type'] || 'application/json';
        body = JSON.stringify(args.json);
      } else if (args.form != null) {
        headers['Content-Type'] =
          headers['Content-Type'] || 'application/x-www-form-urlencoded';
        body = new URLSearchParams(args.form).toString();
      } else if (args.body != null) {
        body = args.body;
      }

      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        args.timeoutMs || defaultTimeout
      );

      try {
        const res = await fetch(args.url, {
          method,
          headers,
          body: ['GET', 'HEAD'].includes(method) ? undefined : body,
          signal: controller.signal,
          redirect: 'follow'
        });

        const buf = await res.buffer();
        const truncated = buf.length > maxBody;
        const slice = truncated ? buf.slice(0, maxBody) : buf;
        const contentType = res.headers.get('content-type') || '';
        let text = slice.toString('utf8');
        let json = null;
        if (contentType.includes('application/json')) {
          try {
            json = JSON.parse(text);
          } catch (_) {}
        }

        const responseHeaders = {};
        res.headers.forEach((v, k) => {
          responseHeaders[k] = v;
        });

        return {
          ok: res.ok,
          status: res.status,
          statusText: res.statusText,
          url: res.url,
          headers: responseHeaders,
          truncated,
          bodyLength: buf.length,
          json,
          text: json ? undefined : text.slice(0, 200000)
        };
      } finally {
        clearTimeout(timeout);
      }
    }
  };
}

module.exports = { createHttpTools };
