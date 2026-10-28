'use strict';
/**
 * Dashboard backend (Node's built-in http module, no framework).
 *
 * Endpoints
 *   GET  /api/health              defaults from configuration
 *   POST /api/collection          {collection, environment?, fileName?} -> validation + summary
 *   POST /api/generate            generate Playwright tests for the uploaded collection
 *   GET  /api/generated           list generated files
 *   GET  /api/generated/file?name generated spec content (only names listed by the generator)
 *   POST /api/run                 start a run with validated settings
 *   GET  /api/run                 run status, sanitized log and results
 *   GET  /reports/...             files inside the report directory only
 *
 * Uploaded content is only parsed as JSON; it is never executed and never
 * passed to a shell. The server binds to 127.0.0.1 by default.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { loadDotEnv, getConfig, BASELINE_POLICIES } = require('./config');
const { parseCollection, summarize, CollectionValidationError } = require('./parser/collection-parser');
const { generateTests } = require('./generator/playwright-generator');
const { runTests } = require('./runner/test-runner');
const { redactUrl } = require('./utils/redact');
const { loadAuthConfig, checkAgainstCollection } = require('./auth/auth-config');

loadDotEnv();
const cfg = getConfig();
const WEB_DIR = path.join(__dirname, 'web');
const STATIC_FILES = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/styles.css': 'styles.css' };
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8',
  '.zip': 'application/zip', '.webm': 'video/webm', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg',
};
const LOG_LIMIT = 200_000;

const state = {
  parsed: null,
  fileName: '',
  meta: null,
  run: { status: 'idle', log: '', startedAt: null, finishedAt: null, exitCode: null, summary: null, error: null, settings: null },
};

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function send(res, status, body, headers = {}) {
  const isBuffer = Buffer.isBuffer(body);
  const payload = isBuffer || typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': isBuffer || typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
      reject(new HttpError(415, 'Requests must be sent as application/json.'));
      return;
    }
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > limit) {
      reject(new HttpError(413, `Upload too large (limit ${Math.round(limit / 1048576)} MB). Set MAX_UPLOAD_MB to change it.`));
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, `Upload too large (limit ${Math.round(limit / 1048576)} MB). Set MAX_UPLOAD_MB to change it.`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new HttpError(400, 'Request body is not valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function requireIdle() {
  if (state.run.status === 'running') throw new HttpError(409, 'A test run is in progress. Wait for it to finish.');
}

// ------------------------------------------------------------------ handlers

async function handleCollection(req, res) {
  requireIdle();
  const body = await readJsonBody(req, cfg.maxUploadBytes * 2 + 4096);
  if (typeof body.collection !== 'string') throw new HttpError(400, 'Missing "collection" (the file content as text).');
  if (Buffer.byteLength(body.collection) > cfg.maxUploadBytes) throw new HttpError(413, `Collection file exceeds ${cfg.maxUploadBytes / 1048576} MB.`);
  const fileName = path.basename(String(body.fileName || 'collection.json')).slice(0, 200);
  if (!/\.json$/i.test(fileName)) throw new HttpError(400, 'Please upload a .json file exported from Postman (Collection v2.0 or v2.1).');
  let parsed;
  try {
    parsed = parseCollection(body.collection, { environment: typeof body.environment === 'string' && body.environment.trim() ? body.environment : undefined });
  } catch (err) {
    if (err instanceof CollectionValidationError) throw new HttpError(422, err.message, err.details);
    throw err;
  }
  state.parsed = parsed;
  state.fileName = fileName;
  state.meta = null;
  const summary = summarize(parsed);
  const authConfig = loadAuthConfig();
  const authCheck = checkAgainstCollection(authConfig, parsed);
  summary.auth = authConfig.present ? { configFile: authConfig.path, valid: authCheck.errors.length === 0 } : null;
  for (const [level, list] of [['error', authCheck.errors], ['warning', authCheck.warnings], ['info', authCheck.info]]) {
    for (const message of list) summary.warnings.push({ level, scope: authConfig.path, message });
  }
  summary.groups.forEach((g) => g.requests.forEach((r) => (r.url = redactUrl(r.url))));
  send(res, 200, { ok: true, fileName, summary });
}

async function handleGenerate(req, res) {
  requireIdle();
  await readJsonBody(req, 4096);
  if (!state.parsed) throw new HttpError(400, 'Upload and validate a collection first.');
  const meta = generateTests(state.parsed, { outDir: cfg.generatedDir, sourceName: state.fileName, authConfig: loadAuthConfig() });
  state.meta = meta;
  state.run = { status: 'idle', log: '', startedAt: null, finishedAt: null, exitCode: null, summary: null, error: null, settings: null };
  send(res, 200, { ok: true, ...generatedSummary(meta) });
}

function generatedSummary(meta) {
  return {
    files: meta.files,
    testCount: meta.testCount,
    stats: meta.stats,
    hasDependencies: meta.hasDependencies,
    chainedVariables: meta.chainedVariables,
    auth: meta.auth || null,
    requests: meta.requests.map((r) => ({
      id: r.id, name: r.name, folder: r.folder, method: r.method, url: redactUrl(r.url), file: r.file,
      convertedChecks: r.convertedChecks, baseline: r.baseline, unsupported: r.unsupported.length, skipReason: r.skipReason, notes: r.notes,
    })),
  };
}

function currentMeta() {
  if (state.meta) return state.meta;
  try {
    return JSON.parse(fs.readFileSync(path.join(cfg.generatedDir, 'collection-meta.json'), 'utf8'));
  } catch {
    return null;
  }
}

function handleGeneratedList(res) {
  const meta = currentMeta();
  if (!meta) throw new HttpError(404, 'No tests have been generated yet.');
  send(res, 200, { collection: meta.collection?.name, generatedAt: meta.generatedAt, ...generatedSummary(meta) });
}

function handleGeneratedFile(url, res) {
  const meta = currentMeta();
  const name = url.searchParams.get('name') || '';
  // Only files the generator itself listed can be read – no arbitrary paths.
  if (!meta || !meta.files.some((f) => f.name === name) || !/^\d{2}-[a-z0-9-]+\.spec\.js$/.test(name)) {
    throw new HttpError(404, 'Unknown generated file.');
  }
  send(res, 200, fs.readFileSync(path.join(cfg.generatedDir, name), 'utf8'));
}

function validateRunSettings(body) {
  const out = {};
  const target = typeof body.targetBaseUrl === 'string' ? body.targetBaseUrl.trim() : '';
  if (target) {
    let u;
    try {
      u = new URL(target);
    } catch {
      throw new HttpError(400, 'Target base URL is not a valid URL.');
    }
    if (!/^https?:$/.test(u.protocol) || target.length > 2000) throw new HttpError(400, 'Target base URL must start with http:// or https://');
  }
  out.TARGET_BASE_URL = target;
  out.ALLOW_MUTATING_REQUESTS = body.allowMutating === true ? 'true' : 'false';
  const workers = Number(body.workers ?? 1);
  if (!Number.isInteger(workers) || workers < 1 || workers > 8) throw new HttpError(400, 'Workers must be an integer between 1 and 8.');
  out.WORKERS = String(workers);
  const timeout = Number(body.requestTimeoutMs ?? cfg.requestTimeoutMs);
  if (!Number.isInteger(timeout) || timeout < 500 || timeout > 600000) throw new HttpError(400, 'Request timeout must be between 500 and 600000 ms.');
  out.REQUEST_TIMEOUT_MS = String(timeout);
  out.TEST_TIMEOUT_MS = String(Math.max(cfg.testTimeoutMs, timeout + 10000));
  const baseline = body.baselineStatus ?? cfg.baselineStatus;
  if (!BASELINE_POLICIES.includes(baseline)) throw new HttpError(400, `Baseline status must be one of: ${BASELINE_POLICIES.join(', ')}`);
  out.BASELINE_STATUS = baseline;
  return out;
}

async function handleRun(req, res) {
  requireIdle();
  const body = await readJsonBody(req, 8192);
  if (!currentMeta()) throw new HttpError(400, 'Generate tests before running them.');
  const env = validateRunSettings(body);
  state.run = { status: 'running', log: '', startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, summary: null, error: null, settings: { ...env } };
  const run = state.run;
  runTests({
    env,
    onLog: (chunk) => {
      run.log += chunk;
      if (run.log.length > LOG_LIMIT) run.log = run.log.slice(-LOG_LIMIT);
    },
  })
    .then((result) => {
      run.exitCode = result.exitCode;
      run.summary = result.summary;
      run.status = result.summary ? 'finished' : 'error';
      if (!result.summary) run.error = 'The run ended without producing a summary. Check the log.';
      if (result.timedOut) run.error = 'The run exceeded RUN_TIMEOUT_MS and was stopped.';
    })
    .catch((err) => {
      run.status = 'error';
      run.error = err.message;
    })
    .finally(() => {
      run.finishedAt = new Date().toISOString();
    });
  send(res, 202, { ok: true, status: 'running' });
}

function handleRunStatus(res) {
  const r = state.run;
  const s = r.summary;
  send(res, 200, {
    status: r.status,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    exitCode: r.exitCode,
    error: r.error,
    settings: r.settings ? { ...r.settings, TARGET_BASE_URL: redactUrl(r.settings.TARGET_BASE_URL) } : null,
    log: r.log.slice(-20000),
    progress: (r.log.match(/^\s+(ok|x|-)\s+\d+ /gm) || []).length,
    result: s
      ? {
          verdict: s.verdict,
          totals: s.totals,
          checks: { total: s.checks.total, passed: s.checks.passed, failed: s.checks.failed },
          durationMs: s.durationMs,
          responseTimes: s.responseTimes,
          failureBreakdown: s.failureBreakdown,
          failureCategories: Object.fromEntries(Object.entries(s.failureCategories || {}).map(([k, v]) => [k, v.label])),
          folders: s.folders,
          tests: s.tests.map((t) => ({
            index: t.index, name: t.name, folder: t.folder, method: t.method, url: t.url, status: t.status,
            httpStatus: t.httpStatus, responseTimeMs: t.responseTimeMs, failureCategory: t.failureCategory,
            error: t.error, skipReason: t.skipReason, failedChecks: (t.checks || []).filter((c) => c.status === 'failed'),
          })),
          hasPlaywrightReport: fs.existsSync(path.join(cfg.reportDir, 'playwright-report', 'index.html')),
        }
      : null,
  });
}

function serveReportFile(urlPath, download, res) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath.slice('/reports/'.length));
  } catch {
    throw new HttpError(400, 'Bad path');
  }
  if (!rel || rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(cfg.reportDir, rel);
  if (!file.startsWith(cfg.reportDir + path.sep) || rel.split(/[\\/]/).some((p) => p.startsWith('.'))) throw new HttpError(404, 'Not found');
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new HttpError(404, 'Report not found. Run the tests first.');
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    ...(download ? { 'Content-Disposition': `attachment; filename="${path.basename(file)}"` } : {}),
  });
  fs.createReadStream(file).pipe(res);
}

function serveStatic(urlPath, res) {
  const file = path.join(WEB_DIR, STATIC_FILES[urlPath]);
  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES[path.extname(file)],
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
}

const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', cfg.host]);

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const hostName = String(req.headers.host || '').replace(/:\d+$/, '');
  if (!ALLOWED_HOSTS.has(hostName)) throw new HttpError(403, 'Host not allowed.');
  const p = url.pathname;

  if (req.method === 'GET' && STATIC_FILES[p]) return serveStatic(p, res);
  if (req.method === 'GET' && p.startsWith('/reports/')) return serveReportFile(p, url.searchParams.get('download') === '1', res);
  if (req.method === 'GET' && p === '/api/health') {
    return send(res, 200, {
      ok: true,
      defaults: {
        targetBaseUrl: cfg.targetBaseUrl,
        allowMutating: cfg.allowMutating,
        workers: cfg.workers,
        requestTimeoutMs: cfg.requestTimeoutMs,
        baselineStatus: cfg.baselineStatus,
        maxUploadMb: cfg.maxUploadBytes / 1048576,
      },
      hasGenerated: !!currentMeta(),
    });
  }
  if (req.method === 'POST' && p === '/api/collection') return handleCollection(req, res);
  if (req.method === 'POST' && p === '/api/generate') return handleGenerate(req, res);
  if (req.method === 'GET' && p === '/api/generated') return handleGeneratedList(res);
  if (req.method === 'GET' && p === '/api/generated/file') return handleGeneratedFile(url, res);
  if (req.method === 'POST' && p === '/api/run') return handleRun(req, res);
  if (req.method === 'GET' && p === '/api/run') return handleRunStatus(res);
  throw new HttpError(404, 'Not found');
}

function createServer() {
  return http.createServer((req, res) => {
    route(req, res).catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error('[server]', err);
      if (!res.headersSent) send(res, status, { ok: false, error: status === 500 ? 'Internal error – see server console.' : err.message, details: err.details });
      else res.end();
    });
  });
}

if (require.main === module) {
  const server = createServer();
  server.listen(cfg.port, cfg.host, () => {
    console.log(`Postman → Playwright dashboard running at http://${cfg.host === '0.0.0.0' ? 'localhost' : cfg.host}:${cfg.port}`);
    console.log(`Generated tests: ${cfg.generatedDir}`);
    console.log(`Reports:         ${cfg.reportDir}`);
  });
}

module.exports = { createServer };
