'use strict';
/**
 * End-to-end test of the whole pipeline against a local mock API:
 * parse -> generate -> run Playwright -> reports. Verifies login/token chaining,
 * request chaining, real PASS/FAIL/SKIP outcomes, failure categories, the
 * non-zero exit code, and that no secret appears in generated code, logs or reports.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseCollection } = require('../src/parser/collection-parser');
const { generateTests } = require('../src/generator/playwright-generator');
const { runTests } = require('../src/runner/test-runner');
const { startMockApi, TEST_USER, ISSUED_TOKEN, API_KEY } = require('./helpers/mock-api');
const { playwrightReportText } = require('./helpers/zip-text');

const TMP = path.join(__dirname, '.tmp', 'e2e');
const GENERATED = path.join(TMP, 'generated');
const REPORTS = path.join(TMP, 'reports');
const FIXTURE = path.join(__dirname, 'fixtures', 'auth-chain-collection.json');
const SECRETS = [TEST_USER.password, ISSUED_TOKEN, API_KEY, 'refresh_TEST_99887766'];

let mock;
let result;
let log = '';

test.before(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  mock = await startMockApi();
  const parsed = parseCollection(fs.readFileSync(FIXTURE, 'utf8'));
  generateTests(parsed, { outDir: GENERATED, sourceName: 'auth-chain-collection.json' });
  result = await runTests({
    env: {
      GENERATED_DIR: path.relative(path.join(__dirname, '..'), GENERATED),
      REPORT_DIR: path.relative(path.join(__dirname, '..'), REPORTS),
      PM_VAR_baseUrl: mock.baseUrl,
      TARGET_BASE_URL: '',
      ALLOW_MUTATING_REQUESTS: 'true',
      REQUEST_TIMEOUT_MS: '5000',
      WORKERS: '4', // must be forced back to 1 because of request chaining
    },
    onLog: (chunk) => (log += chunk),
  });
});

test.after(() => new Promise((resolve) => mock.server.close(resolve)));

const byName = (name) => result.summary.tests.find((t) => t.name === name);

test('run exits non-zero because tests failed', () => {
  assert.notEqual(result.exitCode, 0, log);
  assert.ok(result.summary, 'summary.json produced');
});

test('totals match the real outcomes', () => {
  assert.deepEqual(
    { total: result.summary.totals.total, passed: result.summary.totals.passed, failed: result.summary.totals.failed, skipped: result.summary.totals.skipped },
    { total: 12, passed: 8, failed: 3, skipped: 1 },
    JSON.stringify(result.summary.tests.map((t) => [t.name, t.status, t.error]), null, 1),
  );
  assert.equal(result.summary.settings.workers, 1, 'chained collection forced to 1 worker');
});

test('login token is chained into bearer auth and created id into later URLs', () => {
  assert.equal(byName('Login').status, 'passed');
  assert.equal(byName('Create Item').status, 'passed');
  assert.equal(byName('Create Item').httpStatus, 201);
  const get = byName('Get Item');
  assert.equal(get.status, 'passed');
  assert.match(get.url, /\/items\/100$/);
  assert.equal(get.checks.filter((c) => c.origin === 'collection').length, 4);
  assert.equal(byName('Delete Item').httpStatus, 204);
});

test('intentional failing assertion is reported as an assertion failure', () => {
  const t = byName('Get Item - intentional failing assertion');
  assert.equal(t.status, 'failed');
  assert.equal(t.failureCategory, 'assertion');
  assert.equal(t.httpStatus, 200);
  const failed = t.checks.filter((c) => c.status === 'failed');
  assert.equal(failed.length, 1);
  assert.match(failed[0].title, /Gadget/);
  assert.match(failed[0].message, /Gadget/);
  assert.match(failed[0].message, /Widget/);
  // The other check in the same test still ran (soft semantics like pm.test).
  assert.ok(t.checks.some((c) => c.title === 'Status 200' && c.status === 'passed'));
});

test('expected 4xx responses pass; unexpected 5xx is an HTTP error', () => {
  assert.equal(byName('Missing item returns 404').status, 'passed');
  assert.equal(byName('Missing item returns 404').httpStatus, 404);
  assert.equal(byName('Unauthorized without token').status, 'passed');
  const boom = byName('Server error without expectations');
  assert.equal(boom.status, 'failed');
  assert.equal(boom.failureCategory, 'http-error');
  assert.equal(boom.httpStatus, 500);
});

test('network errors are distinguished from HTTP errors', () => {
  const t = byName('Unreachable host');
  assert.equal(t.status, 'failed');
  assert.equal(t.failureCategory, 'network');
  assert.equal(t.httpStatus, null);
  assert.match(t.error, /Network error/);
});

test('API key auth works and example status is used', () => {
  const t = byName('API key auth');
  assert.equal(t.status, 'passed');
  assert.ok(t.checks.some((c) => c.origin === 'example' && /200/.test(c.title)));
});

test('unsupported auth is skipped with a reason, unsupported script lines are reported', () => {
  const oauth = byName('OAuth2 request (unsupported)');
  assert.equal(oauth.status, 'skipped');
  assert.match(oauth.skipReason, /oauth2/);
  const scripted = byName('Script with unsupported statements');
  assert.equal(scripted.status, 'passed');
  assert.ok(scripted.notes.some((n) => /control flow/.test(n)));
  assert.ok(scripted.notes.some((n) => /pm\.sendRequest/.test(n)));
  assert.ok(scripted.notes.some((n) => /child_process/.test(n)));
  assert.ok(!log.includes('pwned'), 'imported script must never execute');
});

test('HTML reports are produced', () => {
  const html = fs.readFileSync(path.join(REPORTS, 'api-report.html'), 'utf8');
  assert.match(html, /<title>API Test Report/);
  assert.ok(fs.existsSync(path.join(REPORTS, 'playwright-report', 'index.html')));
});

test('no secret leaks into generated code, logs, summary or either HTML report', () => {
  const specs = fs.readdirSync(GENERATED).filter((f) => f.endsWith('.spec.js')).map((f) => fs.readFileSync(path.join(GENERATED, f), 'utf8')).join('\n');
  const pwHtml = fs.readFileSync(path.join(REPORTS, 'playwright-report', 'index.html'), 'utf8');
  const sources = {
    'generated specs': specs,
    'runner log': log,
    'summary.json': fs.readFileSync(path.join(REPORTS, 'summary.json'), 'utf8'),
    'api-report.html': fs.readFileSync(path.join(REPORTS, 'api-report.html'), 'utf8'),
    'playwright report data': playwrightReportText(pwHtml),
  };
  assert.ok(sources['playwright report data'].length > 1000, 'Playwright report data was decoded');
  for (const [where, text] of Object.entries(sources)) {
    for (const secret of SECRETS) assert.ok(!text.includes(secret), `secret "${secret.slice(0, 4)}…" leaked in ${where}`);
  }
  // The secrets file holds the moved literals and is git-ignored.
  const secretsFile = JSON.parse(fs.readFileSync(path.join(GENERATED, '.secrets.json'), 'utf8'));
  assert.ok(Object.values(secretsFile).includes(TEST_USER.password));
  assert.ok(Object.values(secretsFile).includes(API_KEY));
});
