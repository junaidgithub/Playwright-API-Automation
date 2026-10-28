// @ts-check
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { defineConfig } = require('@playwright/test');
const { loadDotEnv, getConfig } = require('./src/config');
const { loadAuthConfig } = require('./src/auth/auth-config');

loadDotEnv();
const cfg = getConfig();

// Requests that depend on values extracted by earlier requests must run in order.
let hasDependencies = false;
try {
  hasDependencies = JSON.parse(fs.readFileSync(path.join(cfg.generatedDir, 'collection-meta.json'), 'utf8')).hasDependencies === true;
} catch {
  // No generated suite yet.
}
// Automatic login shares one token, so it also requires ordered, single-worker execution.
if (loadAuthConfig().config?.login) hasDependencies = true;
const workers = hasDependencies ? 1 : cfg.workers;

const reporters = [
  ['list'],
  ['./src/reporter/api-reporter.js', { outputDir: cfg.reportDir }],
];
if (cfg.playwrightHtmlReport) {
  reporters.push(['html', { outputFolder: path.join(cfg.reportDir, 'playwright-report'), open: 'never' }]);
}

module.exports = defineConfig({
  testDir: cfg.generatedDir,
  testMatch: '**/*.spec.js',
  fullyParallel: false, // tests inside a file always run in collection order
  workers,
  retries: cfg.retries,
  timeout: cfg.testTimeoutMs,
  forbidOnly: true,
  globalSetup: require.resolve('./src/runtime/global-setup.js'),
  outputDir: path.join(cfg.reportDir, 'test-results'),
  reporter: /** @type {any} */ (reporters),
  use: {
    ignoreHTTPSErrors: cfg.ignoreHttpsErrors,
    trace: 'off',
  },
});
