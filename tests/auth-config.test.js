'use strict';
/** Unit tests for auth.config.json validation and request matching. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validateAuthConfig, loadAuthConfig, checkAgainstCollection, findRequests, parseJsonPath, readPath } = require('../src/auth/auth-config');
const { parseCollection } = require('../src/parser/collection-parser');

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'auth-config-collection.json'), 'utf8');
const TMP = path.join(__dirname, '.tmp', 'auth-config');

const validLogin = { request: 'Auth / Login', tokenPath: 'data.accessToken', tokenVariable: 'accessToken' };

test('valid config is accepted and normalized', () => {
  const { config, errors } = validateAuthConfig({
    login: { ...validLogin, refreshTokenPath: 'data.refreshToken', refreshTokenVariable: 'refreshToken', expiresInPath: 'data.expiresIn' },
    refresh: { enabled: true, request: 'Auth / Refresh Token' },
    defaultAuth: { type: 'bearer', token: '{{accessToken}}' },
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(config.login.tokenSegments, ['data', 'accessToken']);
  assert.equal(config.refresh.on401, true);
  assert.equal(config.refresh.retryMutating, false);
  assert.deepEqual(config.refresh.tokenSegments, ['data', 'accessToken'], 'refresh token path defaults to login.tokenPath');
});

test('missing fields produce actionable messages', () => {
  const { errors } = validateAuthConfig({ login: {} });
  assert.ok(errors.some((e) => /login\.request is required/.test(e)));
  assert.ok(errors.some((e) => /login\.tokenPath is required/.test(e)));
  assert.ok(errors.some((e) => /login\.tokenVariable is required/.test(e)));
  assert.ok(validateAuthConfig({ refresh: { enabled: true } }).errors.some((e) => /requires a "login" section/.test(e)));
  assert.ok(validateAuthConfig({ login: { ...validLogin, refreshTokenPath: 'x' } }).errors.some((e) => /configured together/.test(e)));
  assert.ok(validateAuthConfig({ defaultAuth: { type: 'oauth2' } }).errors.some((e) => /defaultAuth\.type must be one of/.test(e)));
  assert.ok(validateAuthConfig({ logins: {} }).errors.some((e) => /Unknown top-level setting "logins"/.test(e)));
  assert.deepEqual(validateAuthConfig([]).errors, ['The auth configuration must be a JSON object.']);
});

test('credentials in the config file are rejected without echoing them', () => {
  const { errors } = validateAuthConfig({
    login: { ...validLogin, password: 'Sup3r-Secret!' },
    defaultAuth: { type: 'basic', username: '{{u}}', password: 'hunter2-literal' },
  });
  const text = errors.join(' ');
  assert.match(text, /"login\.password" contains a literal credential/);
  assert.match(text, /"defaultAuth\.password" contains a literal credential/);
  assert.ok(!text.includes('Sup3r-Secret!') && !text.includes('hunter2-literal'));
  // Variable references are fine.
  assert.deepEqual(validateAuthConfig({ defaultAuth: { type: 'bearer', token: 'Bearer {{accessToken}}' } }).errors, []);
});

test('missing file means "not configured"; broken JSON is reported', () => {
  fs.mkdirSync(TMP, { recursive: true });
  assert.equal(loadAuthConfig({ file: path.join(TMP, 'nope.json') }).present, false);
  const broken = path.join(TMP, 'broken.json');
  fs.writeFileSync(broken, '{ "login": ');
  const loaded = loadAuthConfig({ file: broken });
  assert.equal(loaded.present, true);
  assert.match(loaded.errors[0], /is not valid JSON/);
});

test('login request is matched by name or "Folder / Name", never by position or count', () => {
  const parsed = parseCollection(FIXTURE);
  assert.equal(findRequests(parsed.requests, 'Login').length, 1);
  assert.equal(findRequests(parsed.requests, 'Auth / Login').length, 1);
  // Reversing the collection (different positions) still finds the same request.
  const reversed = [...parsed.requests].reverse();
  assert.equal(findRequests(reversed, 'Auth / Login')[0].id, findRequests(parsed.requests, 'Auth / Login')[0].id);
});

test('config is cross-checked against the collection', () => {
  const parsed = parseCollection(FIXTURE);
  const ok = checkAgainstCollection({ present: true, path: 'auth.config.json', errors: [], config: validateAuthConfig({ login: validLogin }).config }, parsed);
  assert.deepEqual(ok.errors, []);
  assert.ok(ok.loginRequestId);
  assert.ok(ok.info.some((i) => /Automatic login/.test(i)));

  const missing = checkAgainstCollection({ present: true, path: 'auth.config.json', errors: [], config: validateAuthConfig({ login: { ...validLogin, request: 'Sign In' } }).config }, parsed);
  assert.match(missing.errors[0], /Login request "Sign In" was not found.*POST requests available: Auth \/ Login/);

  const unused = checkAgainstCollection({ present: true, path: 'auth.config.json', errors: [], config: validateAuthConfig({ login: { ...validLogin, tokenVariable: 'jwt' } }).config }, parsed);
  assert.ok(unused.warnings.some((w) => /\{\{jwt\}\} is not used by any request/.test(w)));

  const dup = parseCollection(JSON.stringify({
    info: { name: 'x', schema: 'v2.1' },
    item: [{ name: 'A', item: [{ name: 'Login', request: { method: 'POST', url: 'http://h/a' } }] }, { name: 'B', item: [{ name: 'Login', request: { method: 'POST', url: 'http://h/b' } }] }],
  }));
  const ambiguous = checkAgainstCollection({ present: true, path: 'auth.config.json', errors: [], config: validateAuthConfig({ login: { ...validLogin, request: 'Login' } }).config }, dup);
  assert.match(ambiguous.errors[0], /ambiguous.*A \/ Login, B \/ Login/);
});

test('JSON paths', () => {
  assert.deepEqual(parseJsonPath('data.items[0].token'), ['data', 'items', 0, 'token']);
  assert.deepEqual(parseJsonPath('$.token'), ['token']);
  assert.equal(parseJsonPath(''), null);
  assert.equal(parseJsonPath('a..b'), null);
  assert.equal(readPath({ data: { items: [{ token: 't' }] } }, ['data', 'items', 0, 'token']), 't');
  assert.equal(readPath({}, ['__proto__', 'x']), undefined);
});
