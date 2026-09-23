function stealthEnabled(cfg) {
  return (cfg || {}).stealth !== false;
}

function buildLaunchArgs(cfg) {
  cfg = cfg || {};
  const args = [
    '--disable-blink-features=AutomationControlled',
    '--disable-infobars',
    '--no-default-browser-check',
    '--no-first-run',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-features=IsolateOrigins,site-per-process,AutomationControlled'
  ];
  if (cfg.noSandbox) {
    args.push('--no-sandbox', '--disable-setuid-sandbox');
  }
  if (Array.isArray(cfg.extraArgs)) args.push(...cfg.extraArgs);
  return args;
}

function stealthInitScript() {
  return () => {
    try {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
        configurable: true
      });
    } catch (_) {}
    try {
      if (!window.chrome) {
        window.chrome = { runtime: {}, loadTimes: function () {}, csi: function () {} };
      }
    } catch (_) {}
    try {
      const originalQuery = window.navigator.permissions && window.navigator.permissions.query;
      if (originalQuery) {
        window.navigator.permissions.query = (parameters) =>
          parameters && parameters.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission })
            : originalQuery(parameters);
      }
    } catch (_) {}
    try {
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5],
        configurable: true
      });
    } catch (_) {}
    try {
      Object.defineProperty(navigator, 'languages', {
        get: () => ['zh-CN', 'zh', 'en-US', 'en'],
        configurable: true
      });
    } catch (_) {}
  };
}

module.exports = { stealthEnabled, buildLaunchArgs, stealthInitScript };
