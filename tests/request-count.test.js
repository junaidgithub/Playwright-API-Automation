'use strict';
/**
 * The tool must never assume a fixed number of requests. Collections of very
 * different sizes (and shapes) are parsed, generated and summarized dynamically.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseCollection, summarize } = require('../src/parser/collection-parser');
const { generateTests } = require('../src/generator/playwright-generator');
const { buildReportData } = require('../src/reporter/report-service');

const TMP = path.join(__dirname, '.tmp', 'request-count');
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/** Builds a synthetic collection with `count` requests spread over nested folders. */
function syntheticCollection(count, topFolders) {
  const folders = Array.from({ length: topFolders }, (_, i) => ({ name: `Folder ${i + 1}`, item: [{ name: 'Nested', item: [] }] }));
  const root = [];
  for (let i = 0; i < count; i++) {
    const req = { name: `Request ${i + 1}`, request: { method: METHODS[i % METHODS.length], url: `http://h.test/resource/${i + 1}` } };
    if (topFolders === 0 || i % 7 === 0) root.push(req);
    else {
      const folder = folders[i % topFolders];
      if (i % 3 === 0) folder.item[0].item.push(req);
      else folder.item.push(req);
    }
  }
  return { info: { name: `Synthetic ${count}`, schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, item: [...root, ...folders] };
}

for (const [count, topFolders] of [[0, 0], [1, 0], [10, 2], [43, 6], [250, 9]]) {
  test(`collection with ${count} request(s) is handled dynamically`, () => {
    const parsed = parseCollection(JSON.stringify(syntheticCollection(count, topFolders)));
    const summary = summarize(parsed);
    assert.equal(summary.requestCount, count);
    assert.equal(summary.groups.reduce((n, g) => n + g.count, 0), count);

    const outDir = path.join(TMP, String(count));
    fs.rmSync(outDir, { recursive: true, force: true });
    const meta = generateTests(parsed, { outDir });
    assert.equal(meta.requestCount, count);
    assert.equal(meta.testCount, count);
    assert.equal(meta.requests.length, count);

    const specs = fs.readdirSync(outDir).filter((f) => f.endsWith('.spec.js'));
    assert.equal(specs.length, meta.files.length);
    const generatedTests = specs.reduce((n, f) => n + (fs.readFileSync(path.join(outDir, f), 'utf8').match(/^ {2}test\(/gm) || []).length, 0);
    assert.equal(generatedTests, count);
    assert.equal(new Set(meta.requests.map((r) => r.id)).size, count, 'every request gets a unique id');

    const records = meta.requests.map((r, i) => ({ index: i + 1, name: r.name, folder: r.folder, method: r.method, url: r.url, status: i % 4 === 0 ? 'failed' : 'passed', checks: [], httpStatus: 200, responseTimeMs: 10 + i }));
    const report = buildReportData({ records, meta, startedAt: new Date(), finishedAt: new Date(), durationMs: 1, runStatus: 'passed', settings: {} });
    assert.equal(report.totals.total, count);
    assert.equal(report.totals.passed + report.totals.failed, count);
    if (count === 0) assert.ok(meta.warnings.some((w) => /no requests/.test(w.message)));
  });
}
