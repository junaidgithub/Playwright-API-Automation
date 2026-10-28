'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { convertTestScripts, convertPrerequestScripts, splitStatements, parseLiteral, parsePath } = require('../src/generator/assertion-converter');

const convert = (code) => convertTestScripts([{ source: 'request', code }]);
const only = (code) => {
  const r = convert(code);
  assert.equal(r.unsupported.length, 0, JSON.stringify(r.unsupported));
  return r.groups.flatMap((g) => g.assertions);
};

test('status code patterns', () => {
  assert.deepEqual(only('pm.response.to.have.status(201);').map((a) => [a.subject.kind, a.op, a.expected]), [['status', 'eq', 201]]);
  assert.deepEqual(only('pm.response.to.be.ok').map((a) => [a.op, a.expected]), [['eq', 200]]);
  assert.deepEqual(only('pm.response.to.be.success;').map((a) => [a.op, a.expected]), [['between', [200, 299]]]);
  assert.deepEqual(only('pm.response.to.not.be.serverError;').map((a) => [a.op, a.negate]), [['between', true]]);
  assert.deepEqual(only('pm.expect(pm.response.code).to.be.oneOf([200, 201]);').map((a) => [a.op, a.expected]), [['oneOf', [200, 201]]]);
  assert.deepEqual(only('pm.response.to.have.status("Created")').map((a) => [a.subject.kind, a.expected]), [['statusText', 'Created']]);
});

test('pm.test groups keep their names and multiple assertions', () => {
  const r = convert(`
    pm.test("Body checks", function () {
      var jsonData = pm.response.json();
      pm.expect(jsonData.user.name).to.eql("Ann");
      pm.expect(jsonData.items[0]['full-name']).to.not.equal('x');
      pm.expect(jsonData).to.have.property('id');
    });`);
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0].title, 'Body checks');
  assert.deepEqual(r.groups[0].assertions.map((a) => a.subject.path), [['user', 'name'], ['items', 0, 'full-name'], []]);
  assert.equal(r.groups[0].assertions[1].negate, true);
});

test('chained chai assertions become several assertions', () => {
  const a = only("pm.expect(pm.response.json().tags).to.be.an('array').that.is.not.empty;");
  assert.deepEqual(a.map((x) => [x.op, x.expected, x.negate]), [['type', 'array', false], ['empty', undefined, true]]);
});

test('header, body text, response time and JSON checks', () => {
  const a = only(`
    pm.response.to.have.header("Content-Type");
    pm.expect(pm.response.headers.get('Content-Type')).to.include('json');
    pm.expect(pm.response.text()).to.include("ok");
    pm.expect(pm.response.responseTime).to.be.below(500);
    pm.response.to.be.json;
    pm.expect(pm.response.json().count).to.be.at.least(3);
    pm.expect(pm.response.json().email).to.match(/@example\\.com$/i);
  `);
  assert.deepEqual(a.map((x) => `${x.subject.kind}:${x.op}`), ['header:exist', 'header:include', 'body:include', 'responseTime:below', 'body:isJson', 'json:least', 'json:match']);
  assert.deepEqual(a[6].expected, { source: '@example\\.com$', flags: 'i' });
});

test('variable extraction for request chaining', () => {
  const r = convert(`
    const body = pm.response.json();
    const id = body.data.id;
    pm.environment.set("userId", id);
    pm.collectionVariables.set('token', pm.response.json().token);
    pm.globals.set("ct", pm.response.headers.get("Content-Type"));
    postman.setEnvironmentVariable("legacy", body.x);
    pm.environment.unset("old");
  `);
  assert.equal(r.unsupported.length, 0, JSON.stringify(r.unsupported));
  assert.deepEqual(r.extractions.map((x) => [x.scope, x.name, x.action, x.source?.from, x.source?.path || x.source?.name]), [
    ['environment', 'userId', 'set', 'json', ['data', 'id']],
    ['collectionVariables', 'token', 'set', 'json', ['token']],
    ['globals', 'ct', 'set', 'header', 'Content-Type'],
    ['environment', 'legacy', 'set', 'json', ['x']],
    ['environment', 'old', 'unset', undefined, undefined],
  ]);
});

test('legacy tests[] syntax', () => {
  const a = only('tests["Status code is 200"] = responseCode.code === 200;');
  assert.deepEqual(a.map((x) => [x.subject.kind, x.op, x.expected]), [['status', 'eq', 200]]);
});

test('unsupported statements are reported, never executed', () => {
  globalThis.__converterExecuted = false;
  const r = convert(`
    pm.test("ok", () => pm.response.to.have.status(200));
    if (pm.response.code === 200) { pm.expect(1).to.eql(1); }
    pm.sendRequest("https://x", () => {});
    postman.setNextRequest("Other");
    globalThis.__converterExecuted = true;
    pm.expect(computeSomething()).to.eql(1);
    var x = someFunction();
  `);
  assert.equal(globalThis.__converterExecuted, false);
  assert.equal(r.groups.length, 1);
  const reasons = r.unsupported.map((u) => u.reason);
  assert.ok(reasons.includes('control flow (if/for/try) is not converted'));
  assert.ok(reasons.includes('pm.sendRequest is not supported'));
  assert.ok(reasons.some((x) => /setNextRequest/.test(x)));
  assert.equal(r.unsupported.length, 6);
});

test('pre-request scripts: literal assignments only', () => {
  const r = convertPrerequestScripts([{ source: 'collection', code: 'pm.environment.set("lang", "en");\npm.variables.set("id", pm.variables.replaceIn("{{$guid}}"));\npm.variables.set("t", Date.now());' }]);
  assert.deepEqual(r.sets.map((s) => [s.name, s.source.value]), [['lang', 'en'], ['id', '{{$guid}}']]);
  assert.equal(r.unsupported.length, 1);
});

test('tokenizer handles comments, strings and multi-line chains', () => {
  const s = splitStatements('// x;\nvar a = "it\'s; fine"; /* c; */ pm.expect(a)\n  .to.eql(1)\nb()');
  // A line starting with "." continues the previous statement (joined with spaces).
  assert.deepEqual(s, ['var a = "it\'s; fine"', 'pm.expect(a)   .to.eql(1)', 'b()']);
});

test('literal parsing does not evaluate code', () => {
  assert.deepEqual(parseLiteral("{a: 'x', \"b\": [1, true, null]}"), { ok: true, value: { a: 'x', b: [1, true, null] } });
  assert.deepEqual(parseLiteral("'it\\'s'"), { ok: true, value: "it's" });
  assert.equal(parseLiteral('process.exit(1)').ok, false);
  assert.equal(parseLiteral('`${x}`').ok, false);
  assert.deepEqual(parsePath('.a[0]["b c"].d'), ['a', 0, 'b c', 'd']);
  assert.equal(parsePath('.a()'), null);
});
