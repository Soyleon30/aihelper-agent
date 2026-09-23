/**
 * 兼容入口：实现已拆到 ./browser/*，对外 API 不变。
 * registry / mail 仍 require('./browser')。
 */
module.exports = require('./browser/index');
