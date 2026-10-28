#!/usr/bin/env node
'use strict';
/**
 * Command line entry point.
 *
 *   node src/cli.js generate --collection <file> [--environment <file>]
 *   node src/cli.js run [--target <url>] [--allow-mutating] [--workers N] [--timeout MS]
 *   node src/cli.js all --collection <file> ...      (generate + run)
 *
 * Exit code is non-zero when generation fails or any test fails.
 */
const fs = require('node:fs');
const path = require('node:path');
const { loadDotEnv, getConfig } = require('./config');
const { parseCollection, summarize } = require('./parser/collection-parser');
const { generateTests } = require('./generator/playwright-generator');
const { runTests } = require('./runner/test-runner');
const { loadAuthConfig } = require('./auth/auth-config');

loadDotEnv();

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else args[key] = argv[++i];
    } else {
      args._.push(a);
    }
  }
  return args;
}

function generate(args) {
  if (!args.collection) throw new Error('Missing --collection <path to Postman collection JSON>');
  const file = path.resolve(args.collection);
  const parsed = parseCollection(fs.readFileSync(file, 'utf8'), {
    environment: args.environment ? fs.readFileSync(path.resolve(args.environment), 'utf8') : undefined,
  });
  const summary = summarize(parsed);
  console.log(`Collection: ${summary.name} (schema v${summary.schemaVersion})`);
  console.log(`Requests discovered: ${summary.requestCount} in ${summary.folderCount} folder(s)`);
  for (const g of summary.groups) console.log(`  - ${g.folder}: ${g.count}`);
  console.log(`Methods: ${Object.entries(summary.methods).map(([m, n]) => `${m} ${n}`).join(', ')}`);
  for (const w of summary.warnings) console.log(`  [${w.level}] ${w.scope}: ${w.message}`);

  const { generatedDir } = getConfig();
  const authConfig = loadAuthConfig();
  const meta = generateTests(parsed, { outDir: generatedDir, sourceName: path.basename(file), authConfig });
  for (const w of meta.warnings.filter((x) => x.scope === authConfig.path)) console.log(`  [auth ${w.level}] ${w.message}`);
  if (!authConfig.present) console.log(`Automatic authentication: not configured (${authConfig.path} not found).`);
  console.log(`\nGenerated ${meta.testCount} tests in ${meta.files.length} file(s) -> ${path.relative(process.cwd(), generatedDir) || '.'}`);
  console.log(`Converted Postman checks: ${meta.stats.convertedChecks}; requests with baseline checks only: ${meta.stats.requestsWithBaselineOnly}; unsupported script statements: ${meta.stats.unsupportedStatements}`);
  if (meta.hasDependencies) console.log('Request chaining detected: tests will run with 1 worker in collection order.');
  return meta;
}

async function run(args) {
  const overrides = {};
  if (args.target) overrides.TARGET_BASE_URL = String(args.target);
  if (args['allow-mutating']) overrides.ALLOW_MUTATING_REQUESTS = 'true';
  if (args.workers) overrides.WORKERS = String(args.workers);
  if (args.timeout) overrides.REQUEST_TIMEOUT_MS = String(args.timeout);
  if (args['auth-config']) overrides.AUTH_CONFIG = String(args['auth-config']);
  const result = await runTests({ env: overrides, onLog: (line) => process.stdout.write(line) });
  if (result.summary) {
    const t = result.summary.totals;
    console.log(`\nResult: ${t.total} total, ${t.passed} passed, ${t.failed} failed, ${t.skipped} skipped (${(result.summary.durationMs / 1000).toFixed(1)}s)`);
    console.log(`HTML report: ${result.reportPath}`);
  }
  return result.exitCode;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (cmd === 'generate') {
    generate(args);
    return 0;
  }
  if (cmd === 'run') return run(args);
  if (cmd === 'all') {
    generate(args);
    return run(args);
  }
  console.log('Usage:\n  node src/cli.js generate --collection <file> [--environment <file>]\n  node src/cli.js run [--target <url>] [--allow-mutating] [--workers N] [--timeout MS]\n  node src/cli.js all --collection <file> [run options]');
  return cmd ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  },
);
