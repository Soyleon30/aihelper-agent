const path = require('path');
const { resolveDownloadRoot } = require('../download-path');

function resolveScreenshotDir(cfg, userDataPath) {
  const d = String(
    (cfg && (cfg.screenshotDir || cfg.pathsScreenshotDir)) || ''
  ).trim();
  if (d) return path.resolve(d);
  const pictures = process.env.USERPROFILE
    ? path.join(process.env.USERPROFILE, 'Pictures', 'AIHelper-Screenshots')
    : path.join(userDataPath, 'screenshots');
  return pictures;
}

function resolveBrowserDownloadDir(cfg, userDataPath) {
  return resolveDownloadRoot(cfg && cfg.downloadDir, userDataPath);
}

module.exports = { resolveScreenshotDir, resolveBrowserDownloadDir };
