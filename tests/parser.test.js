'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseCollection, parseEnvironment, summarize, CollectionValidationError } = require('../src/parser/collection-parser');
const { VariableResolver } = require('../src/parser/variable-resolver');

const SAMPLE = fs.readFileSync(path.join(__dirname, '..', 'collections', 'JSONPlaceholder_CRUD_API_Collection.json'), 'utf8');

const collection = (item, extra = {}) => ({
  info: { name: 'T', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  item,
  ...extra,
});

test('supplied collection: discovers all 43 requests grouped by folder', () => {
  const parsed = parseCollection(SAMPLE);
  const s = summarize(parsed);
  assert.equal(s.requestCount, 43);
  assert.deepEqual(s.groups.map((g) => [g.folder, g.count]), [
    ['Posts', 7], ['Users', 6], ['Comments', 8], ['Albums', 7], ['Photos', 8], ['Todos', 7],
  ]);
  assert.deepEqual(s.methods, { GET: 19, POST: 6, PUT: 6, PATCH: 6, DELETE: 6 });
  assert.equal(s.schemaVersion, '2.1');
});

test('supplied collection: query params, bodies and order are preserved', () => {
  const parsed = parseCollection(SAMPLE);
  const byUser = parsed.requests.find((r) => r.name === 'Get Posts by User');
  assert.equal(byUser.url, 'https://api.jsonplaceholder.dev/posts');
  assert.deepEqual(byUser.query, [{ key: 'userId', value: '1', disabled: false }]);
  const create = parsed.requests.find((r) => r.name === 'Create Post');
  assert.equal(create.body.mode, 'raw');
  assert.equal(create.body.language, 'json');
  assert.deepEqual(JSON.parse(create.body.raw), { title: 'New Post', body: 'Post created for API automation demo', userId: 1 });
  assert.deepEqual(parsed.requests.map((r) => r.index), Array.from({ length: 43 }, (_, i) => i + 1));
  assert.ok(parsed.warnings.some((w) => /baseUrl/.test(w.message)), 'unused baseUrl variable is reported');
});

test('nested folders, auth inheritance and overrides', () => {
  const parsed = parseCollection(collection([
    {
      name: 'A',
      item: [
        { name: 'B', item: [{ name: 'deep', request: { method: 'get', url: 'http://x/deep' } }] },
        { name: 'noauth', request: { method: 'GET', url: 'http://x/n', auth: { type: 'noauth' } } },
      ],
    },
    { name: 'F', auth: { type: 'basic', basic: [{ key: 'username', value: 'u' }, { key: 'password', value: 'p' }] }, item: [{ name: 'basic', request: { url: 'http://x/b' } }] },
  ], { auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{t}}' }] } }));
  const [deep, noauth, basic] = parsed.requests;
  assert.deepEqual(deep.folderPath, ['A', 'B']);
  assert.equal(deep.folder, 'A / B');
  assert.equal(deep.method, 'GET');
  assert.equal(deep.auth.type, 'bearer');
  assert.equal(deep.authSource, 'collection');
  assert.equal(noauth.auth, null);
  assert.equal(basic.auth.type, 'basic');
  assert.equal(basic.auth.params.username, 'u');
  assert.match(basic.authSource, /folder: F/);
});

test('v2.0 formats: string URL, string headers, object auth params, path variables', () => {
  const parsed = parseCollection({
    info: { name: 'old', schema: 'https://schema.getpostman.com/json/collection/v2.0.0/collection.json' },
    item: [
      { name: 'a', request: { method: 'GET', url: 'http://h/x?q=1&r=2', header: 'Accept: application/json\nX-Y: z', auth: { type: 'bearer', bearer: { token: 'abc' } } } },
      { name: 'b', request: { method: 'GET', url: { raw: 'http://h/users/:id', variable: [{ key: 'id', value: '7' }] } } },
    ],
  });
  const [a, b] = parsed.requests;
  assert.equal(parsed.info.schemaVersion, '2.0');
  assert.equal(a.url, 'http://h/x');
  assert.deepEqual(a.query.map((q) => [q.key, q.value]), [['q', '1'], ['r', '2']]);
  assert.deepEqual(a.headers.map((h) => [h.key, h.value]), [['Accept', 'application/json'], ['X-Y', 'z']]);
  assert.equal(a.auth.params.token, 'abc');
  assert.equal(b.url, 'http://h/users/7');
});

test('disabled headers/query are flagged and unsupported features are reported', () => {
  const parsed = parseCollection(collection([
    {
      name: 'r',
      request: {
        method: 'POST',
        url: { raw: 'http://h/x', query: [{ key: 'a', value: '1' }, { key: 'b', value: '2', disabled: true }] },
        header: [{ key: 'X-On', value: '1' }, { key: 'X-Off', value: '0', disabled: true }],
        body: { mode: 'file', file: { src: 'x.bin' } },
        auth: { type: 'oauth2', oauth2: [] },
      },
    },
  ]));
  const r = parsed.requests[0];
  assert.equal(r.stats.disabledHeaders, 1);
  assert.equal(r.stats.disabledQuery, 1);
  assert.ok(r.body.unsupported);
  assert.ok(parsed.warnings.some((w) => /Body mode "file"/.test(w.message)));
  assert.ok(parsed.warnings.some((w) => /oauth2/.test(w.message)));
});

test('invalid JSON is rejected with line and column', () => {
  assert.throws(() => parseCollection('{\n  "info": {,\n}'), (err) => {
    assert.ok(err instanceof CollectionValidationError);
    assert.match(err.message, /not valid JSON \(line 2, column \d+\)/);
    return true;
  });
  assert.throws(() => parseCollection(''), /empty/);
});

test('non-collection JSON is rejected with a useful message', () => {
  assert.throws(() => parseCollection('[]'), /top-level JSON value must be an object/);
  assert.throws(() => parseCollection('{"foo": 1}'), /missing "info" object, missing "item" array/);
  assert.throws(() => parseCollection('{"name":"x","requests":[]}'), /Collection v1/);
  assert.throws(() => parseCollection('{"name":"env","values":[]}'), /environment file/);
});

test('environment files are parsed and disabled values ignored', () => {
  const env = parseEnvironment('{"name":"QA","values":[{"key":"a","value":"1","enabled":true},{"key":"b","value":"2","enabled":false}]}');
  assert.deepEqual(env, { name: 'QA', values: [{ key: 'a', value: '1' }] });
  assert.throws(() => parseEnvironment('{"name":"x"}'), /values/);
});

test('variable resolver: precedence, nesting, dynamic and unresolved variables', () => {
  const r = new VariableResolver([
    { name: 'runtime', values: { token: 'runtime-token' } },
    { name: 'environment', values: [{ key: 'host', value: 'env.example' }, { key: 'token', value: 'env-token' }] },
    { name: 'collection', values: [{ key: 'host', value: 'col.example' }, { key: 'base', value: 'https://{{host}}' }, { key: 'off', value: 'x', disabled: true }] },
  ]);
  assert.equal(r.resolveString('{{base}}/a?t={{token}}'), 'https://env.example/a?t=runtime-token');
  assert.match(r.resolveString('{{$guid}}'), /^[0-9a-f-]{36}$/);
  assert.equal(r.resolveString('{{missing}}/{{off}}'), '{{missing}}/{{off}}');
  assert.deepEqual([...r.unresolved].sort(), ['missing', 'off']);
  assert.deepEqual(r.resolveDeep({ a: ['{{host}}', 1] }), { a: ['env.example', 1] });
});

test('variable resolver stops on self-referencing variables', () => {
  const r = new VariableResolver([{ name: 'c', values: { a: '{{a}}x' } }]);
  assert.ok(r.resolveString('{{a}}').length < 100);
});
