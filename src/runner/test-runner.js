'use strict';
/**
 * Runs the generated suite with Playwright Test in a child process.
 * Configuration is passed only through environment variables (never through a
 * shell), so uploaded content cannot inject commands.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { getConfig, ROOT_DIR } = require('../config');
const { redactString } = require('../utils/redact');

const PLAYWRIGHT_CLI = require.resolve('@playwright/test/cli');

/** Only these keys may be overridden by callers (dashboard / CLI). */
const ALLOWED_OVERRIDES = new Set([
  'TARGET_BASE_URL', 'ALLOW_MUTATING_REQUESTS', 'RETRY_MUTATING_REQUESTS', 'WORKERS', 'RETRIES',
  'TEST_TIMEOUT_MS', 'REQUEST_TIMEOUT_MS', 'BASELINE_STATUS', 'MAX_RESPONSE_TIME_MS',
  'IGNORE_HTTPS_ERRORS', 'REPORT_INCLUDE_BODIES', 'GENERATED_DIR', 'REPORT_DIR', 'PLAYWRIGHT_HTML_REPORT', 'AUTH_CONFIG',
]);

/**
 * @param {{env?: Record<string,string>, onLog?: (chunk: string) => void}} options
 * @returns {Promise<{exitCode: number, summary: object|null, reportPath: string, timedOut: boolean}>}
 */
function runTests({ env = {}, onLog = () => {} } = {}) {
  const overrides = {};
  for (const [k, v] of Object.entries(env)) {
    const isVariable = /^PM_VAR_[A-Za-z0-9_.-]{1,100}$/.test(k);
    const allowed = ALLOWED_OVERRIDES.has(k) || isVariable;
    // Empty values are meaningful for TARGET_BASE_URL ("use collection URLs") and variables ("defined but empty").
    if (allowed && v !== undefined && v !== null && (v !== '' || k === 'TARGET_BASE_URL' || isVariable)) overrides[k] = String(v);
  }
  const childEnv = { ...process.env, ...overrides, FORCE_COLOR: '0' };
  const cfg = getConfig(childEnv);
  const metaFile = path.join(cfg.generatedDir, 'collection-meta.json');
  if (!fs.existsSync(metaFile)) {
    return Promise.reject(new Error('No generated tests found. Generate tests from a collection first.'));
  }
  if (JSON.parse(fs.readFileSync(metaFile, 'utf8')).testCount === 0) {
    return Promise.reject(new Error('The generated suite contains no tests because the collection has no requests.'));
  }
  // Remove the previous run's results so a crashed run never shows stale numbers.
  for (const f of ['summary.json', 'api-report.html']) fs.rmSync(path.join(cfg.reportDir, f), { force: true });

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [PLAYWRIGHT_CLI, 'test', '--config', path.join(ROOT_DIR, 'playwright.config.js')], {
      cwd: ROOT_DIR,
      env: childEnv,
      shell: false,
      windowsHide: true,
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      onLog(`\n[runner] Run exceeded RUN_TIMEOUT_MS (${cfg.runTimeoutMs} ms); stopping.\n`);
      child.kill();
    }, cfg.runTimeoutMs);

    const forward = (chunk) => onLog(redactString(chunk.toString('utf8')));
    child.stdout.on('data', forward);
    child.stderr.on('data', forward);
    child.on('error', (err) => onLog(`[runner] Failed to start Playwright: ${err.message}\n`));
    child.on('close', (code) => {
      clearTimeout(timer);
      let summary = null;
      try {
        summary = JSON.parse(fs.readFileSync(path.join(cfg.reportDir, 'summary.json'), 'utf8'));
      } catch {
        onLog('[runner] summary.json was not produced; see the log above for the cause.\n');
      }
      resolve({
        exitCode: code === null ? 1 : code,
        summary,
        reportPath: path.join(cfg.reportDir, 'api-report.html'),
        timedOut,
      });
    });
  });
}

module.exports = { runTests, ALLOWED_OVERRIDES };
