'use strict';
/**
 * Central configuration. Every value comes from environment variables (optionally
 * loaded from a local .env file) so nothing target-specific is hardcoded.
 */
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');

const ROOT_DIR = path.resolve(__dirname, '..');

/** Loads ROOT/.env without overriding variables that are already set. */
function loadDotEnv(file = path.join(ROOT_DIR, '.env')) {
  if (!fs.existsSync(file)) return;
  const parsed = util.parseEnv(fs.readFileSync(file, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function toInt(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

const BASELINE_POLICIES = ['2xx', 'non-5xx', 'none'];

function getConfig(env = process.env) {
  const baselineStatus = BASELINE_POLICIES.includes(env.BASELINE_STATUS) ? env.BASELINE_STATUS : '2xx';
  return {
    rootDir: ROOT_DIR,
    generatedDir: path.resolve(ROOT_DIR, env.GENERATED_DIR || 'generated-tests'),
    reportDir: path.resolve(ROOT_DIR, env.REPORT_DIR || 'reports'),
    filesDir: path.resolve(ROOT_DIR, env.FILES_DIR || 'collections/files'),
    targetBaseUrl: (env.TARGET_BASE_URL || '').trim(),
    allowMutating: env.ALLOW_MUTATING_REQUESTS === 'true',
    retryMutating: env.RETRY_MUTATING_REQUESTS === 'true',
    workers: toInt(env.WORKERS, 1, { min: 1, max: 16 }),
    retries: toInt(env.RETRIES, 0, { min: 0, max: 5 }),
    testTimeoutMs: toInt(env.TEST_TIMEOUT_MS, 30000, { min: 1000, max: 600000 }),
    requestTimeoutMs: toInt(env.REQUEST_TIMEOUT_MS, 15000, { min: 500, max: 600000 }),
    runTimeoutMs: toInt(env.RUN_TIMEOUT_MS, 15 * 60000, { min: 10000 }),
    baselineStatus,
    maxResponseTimeMs: toInt(env.MAX_RESPONSE_TIME_MS, 0),
    ignoreHttpsErrors: env.IGNORE_HTTPS_ERRORS === 'true',
    reportIncludeBodies: env.REPORT_INCLUDE_BODIES !== 'false',
    reportBodyLimit: toInt(env.REPORT_BODY_LIMIT, 4000, { min: 0, max: 200000 }),
    playwrightHtmlReport: env.PLAYWRIGHT_HTML_REPORT !== 'false',
    host: env.HOST || '127.0.0.1',
    port: toInt(env.PORT, 3000, { min: 1, max: 65535 }),
    maxUploadBytes: toInt(env.MAX_UPLOAD_MB, 5, { min: 1, max: 50 }) * 1024 * 1024,
  };
}

/** Variables supplied as PM_VAR_<name>=value override collection/environment values. */
function getVariableOverrides(env = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('PM_VAR_') && key.length > 7) out[key.slice(7)] = value;
  }
  return out;
}

module.exports = { ROOT_DIR, BASELINE_POLICIES, loadDotEnv, getConfig, getVariableOverrides };
