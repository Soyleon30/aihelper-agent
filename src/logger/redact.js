/**
 * 日志脱敏：键名 / 字符串内容 / 自定义规则
 * 默认开启，可配置关闭或追加规则。
 */

const DEFAULT_SENSITIVE_KEYS =
  /^(apiKey|api_key|authorization|password|passwd|pwd|pass|token|access_token|refresh_token|secret|client_secret|cookie|set-cookie|session|sessionid|sid|jwt|private_key|privateKey|credential|auth)$/i;

const DEFAULT_PATTERNS = [
  // Bearer / Basic
  { name: 'bearer', re: /\b(Bearer)\s+[A-Za-z0-9\-._~+/]+=*/gi, replace: '$1 ***' },
  { name: 'basic', re: /\b(Basic)\s+[A-Za-z0-9+/=]+/gi, replace: '$1 ***' },
  // JWT
  {
    name: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    replace: '[JWT_REDACTED]'
  },
  // 常见 API Key 形态
  {
    name: 'sk_key',
    re: /\b(sk-[A-Za-z0-9]{10,}|sk-or-v1-[A-Za-z0-9]+|rk_live_[A-Za-z0-9]+)\b/g,
    replace: '[API_KEY_REDACTED]'
  },
  // 邮箱
  {
    name: 'email',
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replace: '[EMAIL_REDACTED]'
  },
  // 中国大陆手机号
  {
    name: 'phone_cn',
    re: /(?<!\d)(1[3-9]\d)\d{4}(\d{4})(?!\d)/g,
    replace: '$1****$2'
  },
  // 身份证粗匹配 18 位
  {
    name: 'id_cn',
    re: /(?<!\d)([1-9]\d{5})(?:19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/g,
    replace: '$1************'
  },
  // URL query 中的敏感参数
  {
    name: 'url_query_secret',
    re: /([?&](password|passwd|pwd|token|access_token|api_?key|secret|authorization)=)[^&\s#]+/gi,
    replace: '$1***'
  },
  // Windows 路径中的用户目录可保留，密码字段在 key 层处理
];

function compileExtraPatterns(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    if (!item) continue;
    try {
      if (typeof item === 'string') {
        out.push({ name: 'custom', re: new RegExp(item, 'gi'), replace: '***' });
      } else if (item.pattern) {
        out.push({
          name: item.name || 'custom',
          re: new RegExp(item.pattern, item.flags || 'gi'),
          replace: item.replace != null ? item.replace : '***'
        });
      }
    } catch (_) {}
  }
  return out;
}

function createRedactor(options = {}) {
  const enabled = options.enabled !== false;
  const mask = options.mask != null ? String(options.mask) : '***';
  const redactEmails = options.redactEmails !== false;
  const redactPhones = options.redactPhones !== false;
  const redactIds = options.redactIds === true;
  const extraKeys = Array.isArray(options.extraKeys)
    ? options.extraKeys.map((k) => String(k).toLowerCase())
    : [];

  let keyRe = DEFAULT_SENSITIVE_KEYS;
  if (extraKeys.length) {
    const escaped = extraKeys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    keyRe = new RegExp(
      `^(?:${DEFAULT_SENSITIVE_KEYS.source.replace(/^\^|\$$/g, '')}|${escaped.join('|')})$`,
      'i'
    );
  }

  const patterns = DEFAULT_PATTERNS.filter((p) => {
    if (p.name === 'email' && !redactEmails) return false;
    if (p.name === 'phone_cn' && !redactPhones) return false;
    if (p.name === 'id_cn' && !redactIds) return false;
    return true;
  }).concat(compileExtraPatterns(options.extraPatterns));

  function isSensitiveKey(k) {
    if (!k) return false;
    if (keyRe.test(String(k))) return true;
    const s = String(k).toLowerCase();
    return (
      s.includes('password') ||
      s.includes('passwd') ||
      s.includes('secret') ||
      s.includes('token') ||
      s.includes('apikey') ||
      s.includes('api_key') ||
      s.includes('authorization') ||
      s.includes('cookie')
    );
  }

  function redactString(str) {
    if (!enabled || str == null) return str;
    let s = String(str);
    for (const p of patterns) {
      try {
        s = s.replace(p.re, p.replace);
      } catch (_) {}
    }
    return s;
  }

  function redact(value, maxLen) {
    if (!enabled) {
      return truncateOnly(value, maxLen);
    }
    if (value == null) return value;
    if (typeof value === 'string') {
      const s = redactString(value);
      if (maxLen && s.length > maxLen) return s.slice(0, maxLen) + `…(+${s.length - maxLen})`;
      return s;
    }
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) {
      const out = value.slice(0, 40).map((x) => redact(x, maxLen));
      if (value.length > 40) out.push(`…(+${value.length - 40} items)`);
      return out;
    }
    if (typeof value === 'object') {
      const out = {};
      let n = 0;
      for (const [k, val] of Object.entries(value)) {
        if (n++ >= 40) {
          out._more = true;
          break;
        }
        if (isSensitiveKey(k)) {
          out[k] = mask;
          continue;
        }
        out[k] = redact(val, maxLen);
      }
      return out;
    }
    return redactString(String(value));
  }

  function truncateOnly(v, max) {
    if (v == null) return v;
    if (typeof v === 'string') {
      return max && v.length > max ? v.slice(0, max) + `…(+${v.length - max})` : v;
    }
    if (typeof v === 'number' || typeof v === 'boolean') return v;
    if (Array.isArray(v)) {
      return v.slice(0, 20).map((x) => truncateOnly(x, max));
    }
    if (typeof v === 'object') {
      const out = {};
      let n = 0;
      for (const [k, val] of Object.entries(v)) {
        if (n++ >= 30) {
          out._more = true;
          break;
        }
        out[k] = truncateOnly(val, max);
      }
      return out;
    }
    return String(v);
  }

  return {
    enabled,
    redact,
    redactString,
    isSensitiveKey
  };
}

module.exports = {
  createRedactor,
  DEFAULT_SENSITIVE_KEYS,
  DEFAULT_PATTERNS
};
