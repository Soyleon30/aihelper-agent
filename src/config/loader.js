const fs = require('fs');
const path = require('path');

function loadDefaultConfig(electronDir) {
  const candidates = [
    path.join(electronDir, '..', 'config', 'default.json'),
    path.join(process.resourcesPath || '', 'config', 'default.json'),
    path.join(__dirname, '..', '..', 'config', 'default.json')
  ];
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
      }
    } catch (_) {}
  }
  return {
    providers: {
      active: 'local',
      local: {
        name: '本地模型',
        baseUrl: 'http://127.0.0.1:11434/v1',
        apiKey: 'ollama',
        model: 'qwen2.5:7b',
        temperature: 0.3,
        maxTokens: 4096,
        timeoutMs: 120000
      }
    },
    agent: {
      systemPrompt: '你是一个可操作本地文件与网页的智能助手。',
      maxToolRounds: 0,
      efficiencyMode: false,
      parallelTools: false,
      skipDuplicateTools: false,
      trimHistory: false,
      compactToolResults: false,
      forceFinalOnLastRound: false,
      roundBudgetHints: false,
      maxHistoryTurns: 0,
      toolResultMaxLen: 6000,
      antiHallucination: true,
      forceToolsForActions: true,
      verifyFinal: true,
      maxRechecks: 1,
      confirmDangerousOps: true
    },
    tools: {
      file: { enabled: true, allowedRoots: [], maxReadBytes: 2097152 },
      http: { enabled: true, timeoutMs: 30000, maxBodyBytes: 5242880 },
      browser: { enabled: true, headless: false, timeoutMs: 30000 }
    },
    paths: { workspace: '', downloadDir: '', screenshotDir: '' },
    ui: { theme: 'dark', language: 'zh-CN' }
  };
}

module.exports = { loadDefaultConfig };
