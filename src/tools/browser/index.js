/**
 * 浏览器工具入口：单向组装，子模块不互相 require 业务能力。
 *
 * 依赖方向：
 *   paths / stealth / util / click  → 无业务兄弟依赖
 *   download / flow                 → 仅经 ctx.robustClick
 *   launch                          → 经 ctx 拿 download/flow 的绑定函数
 *   tools                           → 经 ctx 拿全部能力
 */
const bs = require('../browser-session');
const { resolveScreenshotDir } = require('./paths');
const { createRobustClick } = require('./click');
const { createDownloadHelpers } = require('./download');
const { createFlowHelpers } = require('./flow');
const { createLaunchHelpers } = require('./launch');
const { createStepRunner, maskText } = require('./util');
const { createBrowserToolHandlers } = require('./tools');

function createBrowserTools(options = {}) {
  const cfg = options.config || {};
  const userDataPath = options.userDataPath || process.cwd();
  const logger = options.logger || null;
  const keepSession = cfg.keepSession !== false;

  bs.setLogger(logger);
  bs.setConfig(cfg, userDataPath);

  // 共享上下文：后装能力挂到同一对象，避免循环 require
  const ctx = {
    cfg,
    userDataPath,
    logger,
    keepSession
  };

  ctx.robustClick = createRobustClick(cfg);

  const dl = createDownloadHelpers(ctx);
  Object.assign(ctx, dl);

  const flow = createFlowHelpers(ctx);
  Object.assign(ctx, flow);

  const launch = createLaunchHelpers(ctx);
  Object.assign(ctx, launch);

  const step = createStepRunner(cfg);
  ctx.withStep = step.withStep;
  ctx.maskText = maskText;

  return createBrowserToolHandlers(ctx);
}

module.exports = { createBrowserTools, resolveScreenshotDir };
