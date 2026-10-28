'use strict';
/**
 * Custom Playwright reporter. Collects the sanitized request/response record
 * attached by the runtime fixture and writes:
 *   <reportDir>/summary.json     machine-readable results
 *   <reportDir>/api-report.html  self-contained, human-friendly HTML report
 */
const fs = require('node:fs');
const path = require('node:path');
const { getConfig, getVariableOverrides, loadDotEnv } = require('../config');
const redact = require('../utils/redact');
const { buildReportData, renderHtml } = require('./report-service');

class ApiReporter {
  constructor(options = {}) {
    loadDotEnv();
    this.cfg = getConfig();
    this.outputDir = options.outputDir || this.cfg.reportDir;
    this.results = new Map();
  }

  printsToStdio() {
    return false;
  }

  onBegin(config, suite) {
    this.startedAt = new Date();
    this.tests = suite.allTests();
    this.playwrightVersion = config.version;
    this.workers = config.workers;
  }

  onTestEnd(test, result) {
    // With retries, the last attempt wins.
    this.results.set(test.id, { test, result });
  }

  async onEnd(fullResult) {
    const meta = readJson(path.join(this.cfg.generatedDir, 'collection-meta.json'), null);
    registerKnownSecrets(this.cfg.generatedDir);

    const records = this.tests.map((test, i) => toRecord(i + 1, test, this.results.get(test.id), meta));
    const data = buildReportData({
      records,
      meta,
      startedAt: this.startedAt,
      finishedAt: new Date(),
      durationMs: fullResult.duration,
      runStatus: fullResult.status,
      playwrightVersion: this.playwrightVersion,
      settings: {
        targetBaseUrl: this.cfg.targetBaseUrl ? redact.redactUrl(this.cfg.targetBaseUrl) : null,
        workers: this.workers,
        retries: this.cfg.retries,
        requestTimeoutMs: this.cfg.requestTimeoutMs,
        testTimeoutMs: this.cfg.testTimeoutMs,
        allowMutating: this.cfg.allowMutating,
        baselineStatus: this.cfg.baselineStatus,
        maxResponseTimeMs: this.cfg.maxResponseTimeMs || null,
        bodiesIncluded: this.cfg.reportIncludeBodies,
      },
      hasPlaywrightReport: this.cfg.playwrightHtmlReport,
      authState: readJson(path.join(this.cfg.generatedDir, '.runtime-state.json'), {}).__auth || null,
    });

    // Final safety net: mask every known secret anywhere in the output.
    const safe = redact.redactValue(data);
    fs.mkdirSync(this.outputDir, { recursive: true });
    fs.writeFileSync(path.join(this.outputDir, 'summary.json'), JSON.stringify(toSummary(safe), null, 2));
    fs.writeFileSync(path.join(this.outputDir, 'api-report.html'), renderHtml(safe));
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function registerKnownSecrets(generatedDir) {
  Object.values(readJson(path.join(generatedDir, '.secrets.json'), {})).forEach(redact.registerSecret);
  const vars = readJson(path.join(generatedDir, 'collection-variables.json'), {});
  const scopes = [vars.collection || {}, vars.environment || {}, getVariableOverrides(), ...Object.values(vars.folders || {})];
  for (const scope of scopes) for (const [k, v] of Object.entries(scope)) if (redact.isSensitiveKey(k)) redact.registerSecret(v);
  const state = readJson(path.join(generatedDir, '.runtime-state.json'), {});
  const secretKeys = new Set(state.__secretKeys || []);
  for (const [k, v] of Object.entries(state)) {
    if (k.startsWith('__')) continue;
    if (secretKeys.has(k) || redact.isSensitiveKey(k)) redact.registerSecret(typeof v === 'string' ? v : JSON.stringify(v));
  }
}

const clean = (s) => redact.redactString(String(s || '').replace(/\u001b\[[0-9;]*m/g, '')).trim();

function toRecord(index, test, entry, meta) {
  const annotations = [...test.annotations, ...(entry?.result?.annotations || [])];
  const ann = (type) => annotations.filter((a) => a.type === type).map((a) => a.description || '');
  const requestId = ann('request-id')[0];
  const info = meta?.requests?.find((r) => r.id === requestId) || null;
  const result = entry?.result;
  const attachment = result?.attachments?.find((a) => a.name === 'api-result' && a.body);
  const api = attachment ? readAttachment(attachment.body) : null;

  const outcome = entry ? test.outcome() : 'skipped';
  const status = outcome === 'skipped' ? 'skipped' : outcome === 'expected' || outcome === 'flaky' ? 'passed' : 'failed';
  const httpStatus = api?.exchange?.response?.status ?? null;
  const checks = api?.checks || [];
  const errors = (result?.errors || []).map((e) => clean(e.message || e.value || ''));

  let failureCategory = null;
  if (status === 'failed') {
    if (api?.error?.category) failureCategory = api.error.category;
    else if (result?.status === 'timedOut') failureCategory = 'timeout';
    else if (checks.some((c) => c.status === 'failed')) {
      if (httpStatus === 401 || httpStatus === 403) failureCategory = 'auth-rejected';
      else if (checks.some((c) => c.status === 'failed' && c.origin === 'auth')) failureCategory = 'auth-config';
      else failureCategory = httpStatus >= 400 ? 'http-error' : 'assertion';
    }
    else failureCategory = 'test-error';
  }
  if (result?.status === 'interrupted') failureCategory = 'interrupted';

  const skipReason = status === 'skipped' ? ann('skip').filter(Boolean)[0] || (entry ? 'Skipped' : 'Not run (suite stopped before this test)') : null;

  return {
    index,
    id: requestId || test.id,
    title: test.title,
    name: info?.name || api?.name || test.title,
    folder: info?.folder || api?.folder || test.parent?.title || '(root)',
    file: path.basename(test.location.file),
    method: info?.method || api?.method || '',
    rawUrl: redact.redactUrl(info?.url || ''),
    url: api?.exchange?.request?.url || redact.redactUrl(info?.url || ''),
    description: info?.description || '',
    status,
    flaky: outcome === 'flaky',
    retries: result?.retry || 0,
    httpStatus,
    statusText: api?.exchange?.response?.statusText || '',
    responseTimeMs: api?.exchange?.response?.durationMs ?? api?.exchange?.durationMs ?? null,
    durationMs: result?.duration ?? 0,
    failureCategory,
    error: api?.error?.message || errors[0] || null,
    errors,
    checks,
    extractions: api?.extractions || [],
    skipReason,
    notes: ann('conversion-warning'),
    baseline: info?.baseline || null,
    authInfo: api?.auth || null,
    request: api?.exchange?.request || null,
    response: api?.exchange?.response || null,
  };
}

function readAttachment(body) {
  try {
    return JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : String(body));
  } catch {
    return null;
  }
}

/** summary.json omits headers and bodies to stay concise. */
function toSummary(data) {
  return {
    ...data,
    tests: data.tests.map(({ request, response, ...rest }) => ({
      ...rest,
      contentType: response?.contentType || null,
      responseSizeBytes: response?.sizeBytes ?? null,
    })),
  };
}

module.exports = ApiReporter;
