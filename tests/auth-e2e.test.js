'use strict';
/**
 * End-to-end tests for automatic authentication (auth.config.json) against a
 * local token API. The fixture collection has NO Postman scripts: login,
 * token extraction, reuse and refresh come only from the auth configuration.
 * Mutating requests are blocked in every scenario to prove that only the
 * configured login/refresh requests are allowed through.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseCollection } = require('../src/parser/collection-parser');
const { generateTests } = require('../src/generator/playwright-generator');
const { runTests } = require('../src/runner/test-runner');
const { loadAuthConfig } = require('../src/auth/auth-config');
const { startAuthMockApi } = require('./helpers/auth-mock-api');
const { playwrightReportText } = require('./helpers/zip-text');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(__dirname, '.tmp', 'auth-e2e');
const COLLECTION = fs.readFileSync(path.join(__dirname, 'fixtures', 'auth-config-collection.json'), 'utf8');
const VALID_CONFIG = path.join(__dirname, 'fixtures', 'auth.config.json');

// Synthetic test credentials, supplied only through PM_VAR_* variables.
const USER = { username: 'qa_auth_user', password: 'Auth-Pass-123!' };
const BASIC = { username: 'basic_user', password: 'Basic-Pass-456!' };
const API_KEY = 'key-789-abcdef';
const WRONG_PASSWORD = 'Wrong-Pass-000!';

const scenarios = {};

async function runScenario(name, { authConfigFile, env = {}, tokenMaxUses = 2 }) {
  const mock = await startAuthMockApi({ user: USER, basic: BASIC, apiKey: API_KEY, tokenMaxUses });
  const dir = path.join(TMP, name);
  const generated = path.join(dir, 'generated');
  const reports = path.join(dir, 'reports');
  const authLoaded = loadAuthConfig({ file: authConfigFile });
  generateTests(parseCollection(COLLECTION), { outDir: generated, sourceName: 'auth-config-collection.json', authConfig: authLoaded });
  let log = '';
  const result = await runTests({
    env: {
      GENERATED_DIR: path.relative(ROOT, generated),
      REPORT_DIR: path.relative(ROOT, reports),
      AUTH_CONFIG: path.relative(ROOT, authConfigFile),
      TARGET_BASE_URL: '',
      ALLOW_MUTATING_REQUESTS: 'false',
      REQUEST_TIMEOUT_MS: '5000',
      PM_VAR_baseUrl: mock.baseUrl,
      PM_VAR_username: USER.username,
      PM_VAR_password: USER.password,
      PM_VAR_basicUser: BASIC.username,
      PM_VAR_basicPass: BASIC.password,
      PM_VAR_apiKey: API_KEY,
      ...env,
    },
    onLog: (c) => (log += c),
  });
  await new Promise((r) => mock.server.close(r));
  const byName = (n) => result.summary.tests.find((t) => t.name === n);
  return { result, mock, log, dir, generated, reports, byName, authLoaded };
}

test.before(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const badConfig = path.join(TMP, 'bad.auth.config.json');
  // Invalid on purpose: literal credential + missing tokenPath.
  fs.writeFileSync(badConfig, JSON.stringify({ login: { request: 'Auth / Login', tokenVariable: 'accessToken', password: USER.password } }));

  scenarios.valid = await runScenario('valid', { authConfigFile: VALID_CONFIG });
  scenarios.invalidCredentials = await runScenario('invalid-credentials', { authConfigFile: VALID_CONFIG, env: { PM_VAR_password: WRONG_PASSWORD } });
  scenarios.missing = await runScenario('missing', { authConfigFile: path.join(TMP, 'does-not-exist.json'), env: { PM_VAR_basicPass: '' } });
  scenarios.badConfig = await runScenario('bad-config', { authConfigFile: badConfig });
});

const totals = (s) => {
  const t = s.result.summary.totals;
  return { total: t.total, passed: t.passed, failed: t.failed, skipped: t.skipped };
};
const describeTests = (s) => JSON.stringify(s.result.summary.tests.map((t) => [t.name, t.status, t.failureCategory, t.error]), null, 1);

// ------------------------------------------------------------------ valid login

test('authenticated requests pass with automatic login (no Postman scripts needed)', () => {
  const s = scenarios.valid;
  assert.deepEqual(totals(s), { total: 9, passed: 9, failed: 0, skipped: 0 }, describeTests(s));
  assert.equal(s.result.exitCode, 0);
  assert.equal(s.result.summary.settings.workers, 1, 'automatic login forces ordered execution');
});

test('login runs on demand before the first protected request, even though it appears later in the collection', () => {
  const s = scenarios.valid;
  assert.deepEqual(s.mock.events.slice(0, 2).map((e) => e.type), ['login', 'secure']);
  const loginEvent = s.byName('Get Profile').authInfo.events.find((e) => e.type === 'login');
  assert.ok(loginEvent, 'Get Profile records the on-demand login');
  assert.match(loginEvent.trigger, /on demand/);
  assert.equal(loginEvent.status, 200);
});

test('the token is reused by later protected requests (one login, same token)', () => {
  const s = scenarios.valid;
  const secure = s.mock.events.filter((e) => e.type === 'secure' && e.status === 200);
  const [profile, orders] = secure;
  assert.equal(profile.path, '/secure/profile');
  assert.equal(orders.path, '/secure/orders');
  assert.equal(profile.token, orders.token, 'same access token reused');
  const loginsBeforeOrders = s.mock.events.slice(0, s.mock.events.indexOf(orders)).filter((e) => e.type === 'login').length;
  assert.equal(loginsBeforeOrders, 1);
  assert.equal(s.byName('Get Orders').authInfo.events.length, 0, 'no new login for Get Orders');
});

test('token refresh happens once on 401 and the request is retried', () => {
  const s = scenarios.valid;
  const settings = s.byName('Get Settings');
  assert.equal(settings.status, 'passed');
  assert.equal(settings.httpStatus, 200);
  assert.ok(settings.authInfo.events.some((e) => e.type === 'refresh' && e.status === 200));
  assert.ok(settings.authInfo.events.some((e) => e.type === 'note' && /refreshed and the request retried once/.test(e.message)));
  assert.ok(s.mock.stats.refreshCalls >= 1);
});

test('request-level auth overrides are preserved (noauth, basic, api key, explicit bearer)', () => {
  const s = scenarios.valid;
  assert.equal(s.byName('Public Health').status, 'passed', 'noauth request sent without Authorization header');
  assert.equal(s.byName('Public Health').authInfo.type, 'none');
  assert.equal(s.byName('Basic Protected').authInfo.type, 'basic');
  assert.equal(s.byName('Basic Protected').status, 'passed');
  assert.equal(s.byName('API Key Protected').status, 'passed');
  const negative = s.byName('Invalid token is rejected (negative test)');
  assert.equal(negative.status, 'passed', 'expected 401 is not treated as an auth failure');
  assert.equal(negative.httpStatus, 401);
});

test('login and refresh requests get [auth] token checks and are allowed while writes are blocked', () => {
  const s = scenarios.valid;
  for (const name of ['Login', 'Refresh Token']) {
    const t = s.byName(name);
    assert.equal(t.status, 'passed', name);
    assert.ok(t.checks.some((c) => c.origin === 'auth' && c.status === 'passed'), name);
  }
  assert.equal(s.result.summary.authSummary.loginCalls, 2);
  assert.equal(s.result.summary.authSummary.refreshCalls, 2);
});

// ----------------------------------------------------------- invalid credentials

test('invalid credentials are reported as "auth-rejected", not as a business failure', () => {
  const s = scenarios.invalidCredentials;
  assert.deepEqual(totals(s), { total: 9, passed: 4, failed: 5, skipped: 0 }, describeTests(s));
  assert.notEqual(s.result.exitCode, 0);
  const profile = s.byName('Get Profile');
  assert.equal(profile.failureCategory, 'auth-rejected');
  assert.equal(profile.httpStatus, null, 'protected request was not sent');
  assert.match(profile.error, /Login request "Auth \/ Login" was rejected with HTTP 401/);
  assert.match(profile.error, /PM_VAR_password/);
  assert.equal(s.byName('Login').failureCategory, 'auth-rejected');
  for (const t of s.result.summary.tests) assert.notEqual(t.failureCategory, 'assertion', t.name);
});

test('a failed login is not retried for every protected request', () => {
  const s = scenarios.invalidCredentials;
  assert.equal(s.mock.stats.loginCalls, 2, 'one on-demand attempt + the Login test itself');
  assert.match(s.byName('Get Orders').error, /No access token available/);
  assert.equal(s.mock.events.filter((e) => e.type === 'secure' && e.token !== 'unknown').length, 0, 'no protected call was made without a token');
});

// ------------------------------------------------------- missing token / config

test('missing token without auth config gives an actionable auth-config error', () => {
  const s = scenarios.missing;
  assert.deepEqual(totals(s), { total: 9, passed: 3, failed: 4, skipped: 2 }, describeTests(s));
  const profile = s.byName('Get Profile');
  assert.equal(profile.failureCategory, 'auth-config');
  assert.equal(profile.httpStatus, null);
  assert.match(profile.error, /Bearer token needs \{\{accessToken\}\}/);
  assert.match(profile.error, /auth defined at collection/);
  assert.match(profile.error, /PM_VAR_accessToken/);
  assert.match(profile.error, /configure automatic login/);
  assert.equal(s.mock.events.filter((e) => e.type === 'secure' && e.token === 'none').length, 0, 'no request was sent with an empty token');
});

test('empty Basic auth password is reported, never sent blank', () => {
  const b = scenarios.missing.byName('Basic Protected');
  assert.equal(b.failureCategory, 'auth-config');
  assert.match(b.error, /Basic auth password is empty/);
  assert.match(b.error, /PM_VAR_basicPass/);
});

test('invalid auth config blocks protected requests with a clear message and does not echo secrets', () => {
  const s = scenarios.badConfig;
  const profile = s.byName('Get Profile');
  assert.equal(profile.failureCategory, 'auth-config');
  assert.match(profile.error, /Authentication configuration .*bad\.auth\.config\.json is invalid/);
  assert.match(profile.error, /login\.password" contains a literal credential/);
  assert.match(profile.error, /login\.tokenPath is required/);
  assert.equal(s.byName('Public Health').status, 'passed', 'public requests still run');
});

// -------------------------------------------------------------------- leakage

test('no credential or token appears in generated code, logs or reports', () => {
  const secrets = [USER.password, BASIC.password, API_KEY, WRONG_PASSWORD];
  for (const s of Object.values(scenarios)) secrets.push(...s.mock.issued);
  assert.ok(secrets.length > 8);
  for (const [name, s] of Object.entries(scenarios)) {
    const specs = fs.readdirSync(s.generated).filter((f) => f.endsWith('.spec.js') || f === 'request-defs.json' || f === 'collection-meta.json')
      .map((f) => fs.readFileSync(path.join(s.generated, f), 'utf8')).join('\n');
    const sources = {
      'generated files': specs,
      log: s.log,
      'summary.json': fs.readFileSync(path.join(s.reports, 'summary.json'), 'utf8'),
      'api-report.html': fs.readFileSync(path.join(s.reports, 'api-report.html'), 'utf8'),
      'playwright report': playwrightReportText(fs.readFileSync(path.join(s.reports, 'playwright-report', 'index.html'), 'utf8')),
    };
    for (const [where, text] of Object.entries(sources)) {
      for (const secret of secrets) assert.ok(!text.includes(secret), `${name}: "${secret.slice(0, 5)}…" leaked in ${where}`);
    }
  }
});
