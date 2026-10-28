'use strict';
/** Dashboard API: validation, error handling, limits and filesystem isolation. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

// Isolate generated output from the real project folders.
process.env.GENERATED_DIR = 'tests/.tmp/server/generated';
process.env.REPORT_DIR = 'tests/.tmp/server/reports';
process.env.MAX_UPLOAD_MB = '1';
const { createServer } = require('../src/server');

const SAMPLE = fs.readFileSync(path.join(__dirname, '..', 'collections', 'JSONPlaceholder_CRUD_API_Collection.json'), 'utf8');
let server;
let port;

function request(method, urlPath, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch {
          // not JSON
        }
        resolve({ status: res.statusCode, json, text: data, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

test.before(async () => {
  fs.rmSync(path.join(__dirname, '.tmp', 'server'), { recursive: true, force: true });
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
test.after(() => new Promise((r) => server.close(r)));

test('serves the dashboard with a strict CSP', async () => {
  const res = await request('GET', '/');
  assert.equal(res.status, 200);
  assert.match(res.text, /Postman → Playwright/);
  assert.match(res.headers['content-security-policy'], /script-src 'self'/);
});

test('valid collection is accepted and summarized', async () => {
  const res = await request('POST', '/api/collection', { body: { fileName: 'c.json', collection: SAMPLE } });
  assert.equal(res.status, 200);
  assert.equal(res.json.summary.requestCount, 43);
  assert.equal(res.json.summary.groups.length, 6);
});

test('invalid JSON is rejected with a useful message', async () => {
  const res = await request('POST', '/api/collection', { body: { fileName: 'bad.json', collection: '{ "info": { "name": "x" , }' } });
  assert.equal(res.status, 422);
  assert.match(res.json.error, /not valid JSON \(line 1, column \d+\)/);
});

test('non-collection JSON and wrong file types are rejected', async () => {
  let res = await request('POST', '/api/collection', { body: { fileName: 'x.json', collection: '{"hello": "world"}' } });
  assert.equal(res.status, 422);
  assert.match(res.json.error, /Not a Postman collection/);
  res = await request('POST', '/api/collection', { body: { fileName: 'x.txt', collection: SAMPLE } });
  assert.equal(res.status, 400);
});

test('request body must be JSON and within the size limit', async () => {
  let res = await request('POST', '/api/collection', { body: 'a=b', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  assert.equal(res.status, 415);
  res = await request('POST', '/api/collection', { body: { fileName: 'big.json', collection: 'x'.repeat(1024 * 1024 + 10) } });
  assert.equal(res.status, 413);
});

test('generate, then read only generator-listed files', async () => {
  await request('POST', '/api/collection', { body: { fileName: 'c.json', collection: SAMPLE } });
  const gen = await request('POST', '/api/generate', { body: {} });
  assert.equal(gen.status, 200);
  assert.equal(gen.json.testCount, 43);
  const ok = await request('GET', '/api/generated/file?name=01-posts.spec.js');
  assert.equal(ok.status, 200);
  assert.match(ok.text, /test\.describe\("Posts"/);
  for (const name of ['../../package.json', '..%2F..%2Fpackage.json', '.secrets.json', 'collection-variables.json']) {
    const bad = await request('GET', `/api/generated/file?name=${name}`);
    assert.equal(bad.status, 404, name);
  }
});

test('report route cannot escape the report directory', async () => {
  for (const p of ['/reports/../package.json', '/reports/..%2F..%2Fpackage.json', '/reports/%2e%2e/.env', '/reports/.hidden']) {
    const res = await request('GET', p);
    assert.ok([400, 404].includes(res.status), `${p} -> ${res.status}`);
  }
});

test('run settings are validated', async () => {
  let res = await request('POST', '/api/run', { body: { targetBaseUrl: 'file:///etc/passwd' } });
  assert.equal(res.status, 400);
  res = await request('POST', '/api/run', { body: { targetBaseUrl: 'https://x.test', workers: 99 } });
  assert.equal(res.status, 400);
  res = await request('POST', '/api/run', { body: { baselineStatus: 'rm -rf /' } });
  assert.equal(res.status, 400);
});

test('foreign Host headers are refused (DNS rebinding protection)', async () => {
  const res = await request('GET', '/api/health', { headers: { Host: 'evil.example.com' } });
  assert.equal(res.status, 403);
});
