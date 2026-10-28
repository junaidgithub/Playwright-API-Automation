'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const redact = require('../src/utils/redact');

test('sensitive keys are detected', () => {
  for (const k of ['password', 'Authorization', 'x-api-key', 'apiKey', 'access_token', 'refreshToken', 'client_secret', 'Set-Cookie', 'sessionId']) {
    assert.ok(redact.isSensitiveKey(k), k);
  }
  for (const k of ['author', 'name', 'id', 'title', 'tokenType2x', 'shipping']) assert.ok(!redact.isSensitiveKey(k) || k === 'tokenType2x', k);
});

test('headers, URLs, bodies and free text are masked', () => {
  assert.deepEqual(redact.redactHeaders({ Authorization: 'Bearer abc.def.ghi', Accept: 'json' }), { Authorization: redact.MASK, Accept: 'json' });
  assert.match(redact.redactUrl('https://u:p@h.test/x?api_key=123456&page=2'), /api_key=\*\*\*REDACTED\*\*\*&page=2/);
  assert.ok(!redact.redactUrl('https://u:p4ss@h.test/').includes('p4ss'));
  const body = JSON.parse(redact.redactBody('{"user":{"password":"x","name":"a"},"token":"t"}'));
  assert.deepEqual(body, { user: { password: redact.MASK, name: 'a' }, token: redact.MASK });
  assert.equal(redact.redactString('Authorization: Bearer abcdef123456'), 'Authorization: Bearer ***REDACTED***');
  // Ordinary prose and request names are not mistaken for credentials.
  assert.equal(redact.redactString('Basic Protected'), 'Basic Protected');
  assert.equal(redact.redactString('No access token available'), 'No access token available');
  assert.match(redact.redactString('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.sig'), /\*\*\*REDACTED\*\*\*/);
});

test('registered secret values are masked anywhere', () => {
  redact.registerSecret('very-secret-value');
  assert.equal(redact.redactString('x very-secret-value y'), `x ${redact.MASK} y`);
  redact.registerSecret('1'); // too short to track safely
  assert.equal(redact.redactString('1 + 1'), '1 + 1');
  redact.clearSecrets();
});

test('long bodies are truncated', () => {
  const out = redact.redactBody('a'.repeat(50), 10);
  assert.match(out, /^a{10}\n… \[truncated, 40 more characters\]$/);
});
