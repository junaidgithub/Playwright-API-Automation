'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseCollection } = require('../src/parser/collection-parser');
const { generateTests } = require('../src/generator/playwright-generator');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(__dirname, '.tmp', 'generator');
const SAMPLE = fs.readFileSync(path.join(ROOT, 'collections', 'JSONPlaceholder_CRUD_API_Collection.json'), 'utf8');

function generate(collection, name) {
  const outDir = path.join(TMP, name);
  fs.rmSync(outDir, { recursive: true, force: true });
  const meta = generateTests(parseCollection(collection), { outDir, sourceName: `${name}.json` });
  const specs = Object.fromEntries(meta.files.map((f) => [f.name, fs.readFileSync(path.join(outDir, f.name), 'utf8')]));
  return { meta, specs, outDir };
}

test('supplied collection: 43 syntactically valid tests in 6 ordered files', () => {
  const { meta, specs } = generate(SAMPLE, 'sample');
  assert.equal(meta.testCount, 43);
  assert.deepEqual(Object.keys(specs), ['01-posts.spec.js', '02-users.spec.js', '03-comments.spec.js', '04-albums.spec.js', '05-photos.spec.js', '06-todos.spec.js']);
  let total = 0;
  for (const [name, code] of Object.entries(specs)) {
    assert.doesNotThrow(() => new vm.Script(code, { filename: name }), name);
    total += (code.match(/^ {2}test\(/gm) || []).length;
  }
  assert.equal(total, 43);
  assert.match(specs['01-posts.spec.js'], /test\("Create Post \[POST\]"/);
  assert.match(specs['01-posts.spec.js'], /json: \{ title: "New Post", body: "Post created for API automation demo", userId: 1 \}/);
  assert.match(specs['01-posts.spec.js'], /query: \[\s*\["userId", "1"\],\s*\]/);
});

test('collection without expectations gets baseline checks only, never a hardcoded 200', () => {
  const { meta, specs } = generate(SAMPLE, 'sample-baseline');
  assert.equal(meta.stats.convertedChecks, 0);
  assert.equal(meta.stats.requestsWithBaselineOnly, 43);
  const all = Object.values(specs).join('\n');
  assert.ok(!/toBe\(200\)|toEqual\(200\)/.test(all));
  assert.equal((all.match(/verifyBaselineStatus/g) || []).length, 43);
});

test('generator source has no target-specific endpoints hardcoded', () => {
  for (const dir of ['parser', 'generator', 'runtime', 'runner', 'reporter']) {
    for (const f of fs.readdirSync(path.join(ROOT, 'src', dir))) {
      const src = fs.readFileSync(path.join(ROOT, 'src', dir, f), 'utf8');
      assert.ok(!/jsonplaceholder|typicode|\/posts|\/todos/i.test(src), `${dir}/${f} mentions the sample API`);
    }
  }
});

test('collection status assertions replace the baseline status check', () => {
  const { specs } = generate({
    info: { name: 'x', schema: 'v2.1' },
    item: [{ name: 'Create', event: [{ listen: 'test', script: { exec: ['pm.test("201", () => pm.response.to.have.status(201));'] } }], request: { method: 'POST', url: 'http://h/x' } }],
  }, 'status');
  const code = Object.values(specs)[0];
  assert.match(code, /expect\(res\.status, "Status code equals 201"\)\.toEqual\(201\);/);
  assert.ok(!code.includes('verifyBaselineStatus'));
});

test('saved example response status is used when no script defines one', () => {
  const { specs } = generate({
    info: { name: 'x', schema: 'v2.1' },
    item: [{ name: 'Del', request: { method: 'DELETE', url: 'http://h/x/1' }, response: [{ code: 204 }] }],
  }, 'example');
  assert.match(Object.values(specs)[0], /'example', \(\) => \{\n\s+expect\(res\.status, "Status code is 204 \(from saved example response\)"\)\.toBe\(204\);/);
});

test('literal secrets are moved out of generated code', () => {
  const { specs, outDir } = generate({
    info: { name: 'x', schema: 'v2.1' },
    auth: { type: 'bearer', bearer: [{ key: 'token', value: 'literal-bearer-123456' }] },
    item: [{
      name: 'r',
      request: {
        method: 'POST',
        url: { raw: 'http://h/x?api_key=query-secret-999', query: [{ key: 'api_key', value: 'query-secret-999' }] },
        header: [{ key: 'X-Api-Key', value: 'header-secret-777' }, { key: 'Authorization', value: 'Bearer {{token}}' }],
        body: { mode: 'raw', raw: '{"user":"a","password":"pw-secret-555"}', options: { raw: { language: 'json' } } },
      },
    }],
  }, 'secrets');
  const code = Object.values(specs)[0];
  for (const s of ['literal-bearer-123456', 'query-secret-999', 'header-secret-777', 'pw-secret-555']) assert.ok(!code.includes(s), s);
  assert.match(code, /Bearer \{\{token\}\}/, 'variable references are left in place');
  const secrets = JSON.parse(fs.readFileSync(path.join(outDir, '.secrets.json'), 'utf8'));
  assert.equal(Object.keys(secrets).length, 4);
});

test('untrusted names, scripts and values cannot inject code', () => {
  const evil = '"); require("child_process").execSync("calc"); //\n*/   x';
  const { specs } = generate({
    info: { name: evil, schema: 'v2.1' },
    item: [{
      name: evil,
      item: [{
        name: evil,
        event: [{ listen: 'test', script: { exec: [`pm.test(${JSON.stringify(evil)}, () => { pm.expect(pm.response.json().a).to.eql(${JSON.stringify(evil)}); });`] } }],
        request: { method: 'GET', url: 'http://h/x', header: [{ key: 'X', value: evil }], description: evil },
      }],
    }],
  }, 'evil');
  const code = Object.values(specs)[0];
  assert.doesNotThrow(() => new vm.Script(code));
  // Every occurrence of the payload is inside a string literal or a single-line comment.
  const lines = code.split('\n').filter((l) => l.includes('execSync'));
  assert.ok(lines.length > 0);
  for (const l of lines) assert.ok(/^\s*\/\/|"[^"]*\\"\); require/.test(l), l);
});

test('duplicate request names get unique titles', () => {
  const { specs } = generate({
    info: { name: 'x', schema: 'v2.1' },
    item: [{ name: 'Same', request: { url: 'http://h/1' } }, { name: 'Same', request: { url: 'http://h/2' } }],
  }, 'dupes');
  const code = Object.values(specs)[0];
  assert.match(code, /"Same \[GET\]"/);
  assert.match(code, /"Same \[GET\] \(2\)"/);
});

test('chaining is detected so the run uses a single worker', () => {
  const { meta } = generate({
    info: { name: 'x', schema: 'v2.1' },
    item: [
      { name: 'login', event: [{ listen: 'test', script: { exec: ['pm.environment.set("tok", pm.response.json().t);'] } }], request: { method: 'POST', url: 'http://h/login' } },
      { name: 'use', request: { url: 'http://h/me', auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{tok}}' }] } } },
    ],
  }, 'chain');
  assert.equal(meta.hasDependencies, true);
  assert.deepEqual(meta.chainedVariables, ['tok']);
});

test('regeneration only removes files the generator owns', () => {
  const outDir = path.join(TMP, 'own');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'my-notes.txt'), 'keep me');
  generateTests(parseCollection(SAMPLE), { outDir });
  generateTests(parseCollection(SAMPLE), { outDir });
  assert.equal(fs.readFileSync(path.join(outDir, 'my-notes.txt'), 'utf8'), 'keep me');
});
