/**
 * Playwright 解析器 —— **不新装包**，复用本机全局安装
 *
 * 纪律（`tavern-browser-automation` skill）：
 *  - 前置条件明写「两者都不新装」；反模式表把「为跑 E2E 全局安装新版 / 覆盖 1.62.1」列为
 *    环境漂移事故。故此处**只解析、不安装**。
 *  - 本机现状（2026-09-26 取证）：`npm ls -g` 只有 `playwright@1.62.1`，
 *    **`@playwright/test` 未全局安装** ⇒ 用例必须走 `playwright` 库 API，
 *    不能用 `@playwright/test` 的 runner。
 *  - 解析顺序：先本仓 `require`（若将来入了 devDependencies 则自然命中），
 *    再 `npm root -g` 兜底 —— 与上轮 `.pw-verify-changes.cjs:20-26` 的既有模式一致。
 *
 * @module e2e/lib/resolve-playwright
 */

const path = require('path');
const { execSync } = require('child_process');

/** 本机既有版本；不符时**告警但不阻断**（阻断会让脚本在他人机器上无谓失效） */
const EXPECTED_VERSION = '1.62.1';

let cached = null;

/** @returns {typeof import('playwright')} */
function loadPlaywright() {
  if (cached) return cached;
  let mod;
  let source;
  try {
    mod = require('playwright');
    source = '本仓 node_modules';
  } catch {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    mod = require(path.join(globalRoot, 'playwright'));
    source = globalRoot;
  }
  cached = mod;
  cached.__source = source;
  return cached;
}

/**
 * 版本告警。**不抛错**：换机器时版本可能不同，抛错只会让脚本无谓失效；
 * 但必须让人看见，因为 skill 的反模式表明确把版本漂移列为事故。
 * @param {{version?: string}} [playwright]
 * @returns {string} 实际版本
 */
function warnOnVersionDrift(playwright) {
  let actual = '';
  try {
    // playwright 包内的 package.json 版本最可靠
    const pkgPath = require.resolve('playwright/package.json');
    actual = require(pkgPath).version;
  } catch {
    try {
      const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
      actual = require(path.join(globalRoot, 'playwright', 'package.json')).version;
    } catch {
      actual = (playwright && playwright.version) || '未知';
    }
  }
  if (actual !== EXPECTED_VERSION) {
    console.warn(`⚠ Playwright 版本 ${actual} ≠ 预期 ${EXPECTED_VERSION}。`
      + '按 skill 反模式表，**不要**为此升级或覆盖全局安装；如判定确需变更，走 PARDON 单独请批。');
  }
  return actual;
}

module.exports = { loadPlaywright, warnOnVersionDrift, EXPECTED_VERSION };
