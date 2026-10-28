#!/usr/bin/env node
'use strict';
/**
 * CI entry point used by .github/workflows/api-tests.yml (also runnable locally: `npm run ci`).
 *
 *   COLLECTION            empty -> every collection JSON in collections/
 *                         otherwise one file name from collections/ ("x.json", "x" or "collections/x.json")
 *   TARGET_BASE_URL, ALLOW_MUTATING_REQUESTS, REQUEST_TIMEOUT_MS ... are passed through as usual.
 *   ALL_SECRETS           JSON of the repository secrets (GitHub `toJSON(secrets)`); only secrets
 *                         named PM_VAR_<name> are used, as Postman variables.
 *
 * Each collection is generated into generated-tests-ci/<name>/ and reported in reports/<name>/.
 * A Markdown summary is written to $GITHUB_STEP_SUMMARY (or reports/ci-summary.md locally).
 * Exits with 1 when any collection fails or cannot be processed.
 */
const fs = require('node:fs');
const path = require('node:path');
const { ROOT_DIR, loadDotEnv } = require('../src/config');
const { parseCollection, slugify } = require('../src/parser/collection-parser');
const { generateTests } = require('../src/generator/playwright-generator');
const { runTests } = require('../src/runner/test-runner');
const { loadAuthConfig } = require('../src/auth/auth-config');
const { redactString, registerSecret } = require('../src/utils/redact');

loadDotEnv();
const COLLECTIONS_DIR = path.join(ROOT_DIR, 'collections');

/** Collection files in collections/ (Postman environment exports are skipped). */
function listCollections() {
  if (!fs.existsSync(COLLECTIONS_DIR)) return [];
  return fs.readdirSync(COLLECTIONS_DIR)
    .filter((f) => /\.json$/i.test(f) && !/environment\.json$/i.test(f))
    .filter((f) => fs.statSync(path.join(COLLECTIONS_DIR, f)).isFile())
    .sort();
}

function selectCollections(input) {
  const available = listCollections();
  if (!available.length) throw new Error('No collection files found in collections/. Upload a Postman collection JSON into that folder first.');
  const wanted = String(input || '').trim();
  if (!wanted) return available;
  // Only a file name inside collections/ is accepted - never an arbitrary path.
  const name = path.basename(wanted.replace(/\\/g, '/'));
  const candidates = [name, `${name}.json`].map((c) => c.toLowerCase());
  const hit = available.find((f) => candidates.includes(f.toLowerCase()));
  if (!hit) throw new Error(`Collection "${name}" was not found in collections/. Available: ${available.join(', ')}`);
  return [hit];
}

/** Picks PM_VAR_* entries out of the CI secrets JSON and removes the JSON from the environment. */
function variablesFromSecrets() {
  const raw = process.env.ALL_SECRETS;
  delete process.env.ALL_SECRETS; // never hand every repository secret to child processes
  if (!raw) return {};
  try {
    const out = {};
    for (const [k, v] of Object.entries(JSON.parse(raw))) {
      if (/^PM_VAR_[A-Za-z0-9_.-]{1,100}$/.test(k) && typeof v === 'string') {
        out[k] = v;
        registerSecret(v);
      }
    }
    return out;
  } catch {
    return {};
  }
}

function validateSettings() {
  const target = (process.env.TARGET_BASE_URL || '').trim();
  if (target) {
    let ok = false;
    try {
      ok = /^https?:$/.test(new URL(target).protocol);
    } catch {
      ok = false;
    }
    if (!ok) throw new Error(`Target base URL "${target}" is not a valid http(s) URL.`);
  }
}

const fmtDuration = (ms) => (ms == null ? '–' : `${(ms / 1000).toFixed(1)} s`);
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

function writeSummary(results, fatal) {
  const lines = ['## API test results', ''];
  const target = (process.env.TARGET_BASE_URL || '').trim();
  lines.push(`Target: **${target || 'URLs from the collection'}** · POST/PUT/PATCH/DELETE: **${process.env.ALLOW_MUTATING_REQUESTS === 'true' ? 'allowed' : 'blocked'}**`, '');
  if (fatal) lines.push(`> ❌ ${cell(fatal)}`, '');
  if (results.length) {
    lines.push('| Collection | Result | Total | Passed | Failed | Skipped | Duration | Report |', '|---|---|---|---|---|---|---|---|');
    for (const r of results) {
      const t = r.totals || {};
      const icon = { passed: '✅ passed', failed: '❌ failed', empty: '⚪ no requests', error: '❌ error' }[r.status];
      lines.push(`| ${cell(r.file)} | ${icon} | ${t.total ?? '–'} | ${t.passed ?? '–'} | ${t.failed ?? '–'} | ${t.skipped ?? '–'} | ${fmtDuration(r.durationMs)} | ${r.report ? `\`${r.report}\`` : cell(r.note || '')} |`);
    }
    lines.push('', 'Download the **api-test-reports** artifact at the bottom of this run and open the `api-report.html` listed above.');
    const failures = results.flatMap((r) => (r.failures || []).map((f) => ({ ...f, file: r.file })));
    if (failures.length) {
      lines.push('', '### Failed requests', '');
      for (const f of failures.slice(0, 30)) {
        lines.push(`- **${cell(f.file)}** › #${f.index} ${cell(f.name)} (${cell(f.method)}) — *${cell(f.category)}*: ${cell(f.error).slice(0, 220)}`);
      }
      if (failures.length > 30) lines.push(`- … and ${failures.length - 30} more (see the HTML reports)`);
    }
  }
  const markdown = redactString(lines.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  fs.mkdirSync(path.join(ROOT_DIR, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(ROOT_DIR, 'reports', 'ci-summary.md'), `${markdown}\n`);
  console.log(`\n${markdown}`);
}

async function main() {
  const variables = variablesFromSecrets();
  let files;
  try {
    validateSettings();
    files = selectCollections(process.env.COLLECTION);
  } catch (err) {
    writeSummary([], err.message);
    console.error(`Error: ${err.message}`);
    return 1;
  }
  console.log(`Collections to run (${files.length}): ${files.join(', ')}`);
  if (Object.keys(variables).length) console.log(`Variables from repository secrets: ${Object.keys(variables).join(', ')}`);

  const results = [];
  for (const file of files) {
    const slug = slugify(file.replace(/\.json$/i, ''));
    // Separate root so a local `npm run test:generated` never picks these specs up twice.
    const genRel = `generated-tests-ci/${slug}`;
    const repRel = `reports/${slug}`;
    console.log(`\n===== ${file} =====`);
    const row = { file, status: 'error' };
    try {
      const parsed = parseCollection(fs.readFileSync(path.join(COLLECTIONS_DIR, file), 'utf8'));
      const meta = generateTests(parsed, { outDir: path.join(ROOT_DIR, genRel), sourceName: file, authConfig: loadAuthConfig() });
      console.log(`Generated ${meta.testCount} test(s) from ${meta.requestCount} request(s).`);
      for (const w of meta.warnings.filter((x) => x.level !== 'info')) console.log(`  [${w.level}] ${w.scope}: ${w.message}`);
      if (meta.testCount === 0) {
        results.push({ ...row, status: 'empty', note: 'collection has no requests' });
        continue;
      }
      const result = await runTests({
        env: { GENERATED_DIR: genRel, REPORT_DIR: repRel, TARGET_BASE_URL: process.env.TARGET_BASE_URL || '', ...variables },
        onLog: (chunk) => process.stdout.write(chunk),
      });
      if (!result.summary) throw new Error('The run produced no summary (see the log above).');
      results.push({
        file,
        status: result.exitCode === 0 ? 'passed' : 'failed',
        totals: result.summary.totals,
        durationMs: result.summary.durationMs,
        report: `${repRel}/api-report.html`,
        failures: result.summary.tests.filter((t) => t.status === 'failed').map((t) => ({
          index: t.index, name: t.name, method: t.method, category: t.failureCategory, error: (t.error || '').split('\n')[0],
        })),
      });
    } catch (err) {
      row.note = redactString(err.message);
      console.error(`Error in ${file}: ${row.note}`);
      results.push(row);
    }
  }
  writeSummary(results);
  return results.every((r) => r.status === 'passed' || r.status === 'empty') ? 0 : 1;
}

main().then((code) => process.exit(code), (err) => {
  console.error(redactString(err.stack || err.message));
  process.exit(1);
});
