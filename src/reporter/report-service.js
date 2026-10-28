'use strict';
/**
 * Builds report data (totals, breakdowns, timings) and renders the
 * self-contained HTML report. The HTML has no external dependencies so it can
 * be opened offline, attached to tickets or archived by CI.
 */

const FAILURE_CATEGORIES = {
  assertion: {
    label: 'Assertion failure',
    explain: 'The API responded, but one or more checks did not match the expected result.',
    hint: 'Compare the expected and actual values in the failed checks. If the API behaviour changed intentionally, update the Postman tests; otherwise raise a defect.',
  },
  'http-error': {
    label: 'HTTP error + failed checks',
    explain: 'The API returned a 4xx/5xx status code and the checks for this request failed.',
    hint: '4xx usually means the request is wrong (data, auth, missing resource). 5xx means the server failed — check server logs. Look at the response body below for the API\'s own error message.',
  },
  network: {
    label: 'Network error',
    explain: 'No HTTP response was received (DNS failure, connection refused/reset, TLS problem).',
    hint: 'Check that the host is reachable from this machine (VPN, proxy, firewall), that the base URL is correct, and that the service is running.',
  },
  timeout: {
    label: 'Timeout',
    explain: 'The request or the test did not finish within the configured time limit.',
    hint: 'The service may be slow or unreachable. Retry later or raise REQUEST_TIMEOUT_MS / TEST_TIMEOUT_MS if slower responses are acceptable.',
  },
  config: {
    label: 'Configuration problem',
    explain: 'The request could not be built — for example an undefined {{variable}} or an invalid URL.',
    hint: 'Provide the missing variables (environment file or PM_VAR_<name>) or make sure the request that sets them ran successfully first.',
  },
  'auth-config': {
    label: 'Authentication setup problem',
    explain: 'The request was not sent because its authentication could not be prepared: a token or credential is missing/empty, the auth config is invalid, or the login response had no token at the configured path.',
    hint: 'Read the message: it names the missing variable or config field. Provide credentials via PM_VAR_<name> or an environment file, or fix auth.config.json. This is a setup issue, not an API defect.',
  },
  'auth-rejected': {
    label: 'Authentication rejected',
    explain: 'The server rejected the credentials or token (HTTP 401/403), or the login/refresh request failed, so the request could not be authenticated.',
    hint: 'Check that the credentials are valid for this environment, that the token has not expired (enable refresh in auth.config.json if the API issues refresh tokens) and that the user has permission. Not a business-logic failure.',
  },
  'test-error': {
    label: 'Test error',
    explain: 'The generated test failed for a reason other than a check (unexpected exception).',
    hint: 'Read the error message; it may indicate a generator limitation. Please report it with the request definition.',
  },
  interrupted: {
    label: 'Interrupted',
    explain: 'The run was stopped before this test finished.',
    hint: 'Re-run the suite.',
  },
};

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function hostOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function buildReportData({ records, meta, startedAt, finishedAt, durationMs, runStatus, playwrightVersion, settings, hasPlaywrightReport, authState = null }) {
  const count = (fn) => records.filter(fn).length;
  const passed = count((r) => r.status === 'passed');
  const failed = count((r) => r.status === 'failed');
  const skipped = count((r) => r.status === 'skipped');
  const executed = passed + failed;

  const allChecks = records.flatMap((r) => r.checks);
  const checks = {
    total: allChecks.length,
    passed: allChecks.filter((c) => c.status === 'passed').length,
    failed: allChecks.filter((c) => c.status === 'failed').length,
    byOrigin: ['collection', 'example', 'auth', 'baseline'].map((origin) => ({
      origin,
      total: allChecks.filter((c) => c.origin === origin).length,
      failed: allChecks.filter((c) => c.origin === origin && c.status === 'failed').length,
    })),
  };

  const failureBreakdown = {};
  for (const r of records) if (r.failureCategory) failureBreakdown[r.failureCategory] = (failureBreakdown[r.failureCategory] || 0) + 1;

  const times = records.map((r) => r.responseTimeMs).filter((t) => typeof t === 'number').sort((a, b) => a - b);
  const responseTimes = times.length
    ? {
        count: times.length,
        avg: Math.round(times.reduce((a, b) => a + b, 0) / times.length),
        min: times[0],
        median: percentile(times, 50),
        p95: percentile(times, 95),
        max: times[times.length - 1],
      }
    : null;

  const statusClasses = {};
  for (const r of records) {
    if (r.httpStatus) {
      const cls = `${String(r.httpStatus)[0]}xx`;
      statusClasses[cls] = (statusClasses[cls] || 0) + 1;
    }
  }

  const folderMap = new Map();
  for (const r of records) {
    if (!folderMap.has(r.folder)) folderMap.set(r.folder, { folder: r.folder, total: 0, passed: 0, failed: 0, skipped: 0, times: [] });
    const f = folderMap.get(r.folder);
    f.total++;
    f[r.status]++;
    if (typeof r.responseTimeMs === 'number') f.times.push(r.responseTimeMs);
  }
  const folders = [...folderMap.values()].map(({ times: t, ...f }) => ({
    ...f,
    avgMs: t.length ? Math.round(t.reduce((a, b) => a + b, 0) / t.length) : null,
  }));

  const methods = {};
  for (const r of records) methods[r.method] = (methods[r.method] || 0) + 1;

  let verdict = 'passed';
  if (records.length === 0) verdict = 'empty';
  else if (failed > 0) verdict = 'failed';
  else if (passed === 0) verdict = 'skipped';
  if (runStatus === 'interrupted' || runStatus === 'timedout') verdict = 'incomplete';

  const hosts = [...new Set(records.map((r) => hostOf(r.url)).filter(Boolean))];

  return {
    tool: 'postman-to-playwright',
    reportVersion: 1,
    collection: meta
      ? { name: meta.collection?.name, schemaVersion: meta.collection?.schemaVersion, sourceFile: meta.sourceFile, generatedAt: meta.generatedAt, environment: meta.environment }
      : { name: 'Unknown collection' },
    verdict,
    runStatus,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: Math.round(durationMs),
    playwrightVersion,
    settings,
    hosts,
    totals: {
      total: records.length,
      executed,
      passed,
      failed,
      skipped,
      flaky: count((r) => r.flaky),
      passRate: executed ? Math.round((passed / executed) * 1000) / 10 : null,
    },
    checks,
    failureBreakdown,
    responseTimes,
    statusClasses,
    methods,
    folders,
    slowest: records.filter((r) => typeof r.responseTimeMs === 'number').sort((a, b) => b.responseTimeMs - a.responseTimeMs).slice(0, 5).map((r) => ({ index: r.index, name: r.name, folder: r.folder, method: r.method, responseTimeMs: r.responseTimeMs })),
    generation: meta
      ? {
          stats: meta.stats,
          warnings: meta.warnings || [],
          hasDependencies: meta.hasDependencies,
          chainedVariables: meta.chainedVariables || [],
          unsupported: (meta.requests || []).flatMap((r) => r.unsupported.map((u) => ({ request: r.name, folder: r.folder, ...u }))),
        }
      : null,
    authSummary: meta?.auth
      ? {
          ...meta.auth,
          loginRequest: records.find((r) => r.id === meta.auth.loginRequestId)?.name || null,
          refreshRequest: records.find((r) => r.id === meta.auth.refreshRequestId)?.name || null,
          loginCalls: authState?.loginCount ?? 0,
          refreshCalls: authState?.refreshCount ?? 0,
          loginStatus: authState?.login?.status || 'not run',
        }
      : null,
    failureCategories: FAILURE_CATEGORIES,
    hasPlaywrightReport,
    tests: records,
  };
}

/** Serializes data for embedding inside <script type="application/json">. */
function embedJson(data) {
  return JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderHtml(data) {
  const title = `API Test Report – ${data.collection?.name || 'Collection'}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body>
<div id="app"><noscript>This report needs JavaScript enabled to render. Raw results are in summary.json.</noscript></div>
<script id="report-data" type="application/json">${embedJson(data)}</script>
<script>${CLIENT_JS}</script>
</body>
</html>`;
}

const CSS = String.raw`
:root{
  --bg:#f4f6fa;--surface:#ffffff;--surface-2:#f8fafc;--border:#e3e8ef;--text:#0f172a;--muted:#5b6678;--faint:#8a94a6;
  --accent:#3056d3;--accent-soft:#e8eefc;
  --pass:#13854e;--pass-soft:#e3f5ec;--fail:#c5283d;--fail-soft:#fde8eb;--skip:#a26b00;--skip-soft:#fdf3dc;--info:#2f6fb5;--info-soft:#e4effa;
  --get:#13854e;--post:#b0620a;--put:#2f6fb5;--patch:#7a4fc2;--delete:#c5283d;--other:#5b6678;
  --shadow:0 1px 2px rgba(15,23,42,.05),0 2px 8px rgba(15,23,42,.04);--radius:12px;
  --mono:ui-monospace,SFMono-Regular,"Cascadia Code",Consolas,"Liberation Mono",monospace;
}
@media (prefers-color-scheme:dark){:root{
  --bg:#0d1117;--surface:#151b24;--surface-2:#1b2230;--border:#2a3342;--text:#e6ebf2;--muted:#9aa5b5;--faint:#6f7a8b;
  --accent:#7b9cff;--accent-soft:#1d2a4a;
  --pass:#3ccf8b;--pass-soft:#11301f;--fail:#ff6b7f;--fail-soft:#3a1820;--skip:#f2b545;--skip-soft:#352a12;--info:#6fb0ff;--info-soft:#14273d;
  --get:#3ccf8b;--post:#f2a34a;--put:#6fb0ff;--patch:#b892ff;--delete:#ff6b7f;--other:#9aa5b5;
  --shadow:none;
}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
a{color:var(--accent)}
.wrap{max-width:1240px;margin:0 auto;padding:0 20px}
header.top{background:var(--surface);border-bottom:1px solid var(--border)}
.top-inner{display:flex;gap:24px;align-items:flex-start;justify-content:space-between;padding:28px 0 22px;flex-wrap:wrap}
.eyebrow{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);font-weight:600}
h1{font-size:26px;line-height:1.25;margin:6px 0 6px;font-weight:700;letter-spacing:-.01em}
.sub{color:var(--muted);font-size:13px}
.verdict{display:flex;flex-direction:column;align-items:flex-end;gap:6px}
.verdict-badge{font-weight:800;letter-spacing:.06em;font-size:15px;padding:10px 18px;border-radius:999px;display:inline-flex;align-items:center;gap:8px}
.v-passed{background:var(--pass-soft);color:var(--pass)}.v-failed{background:var(--fail-soft);color:var(--fail)}
.v-skipped,.v-incomplete,.v-empty{background:var(--skip-soft);color:var(--skip)}
.dot{width:9px;height:9px;border-radius:50%;background:currentColor;display:inline-block}
.meta-strip{display:flex;flex-wrap:wrap;gap:8px 22px;padding:12px 0 16px;color:var(--muted);font-size:12.5px}
.meta-strip b{color:var(--text);font-weight:600}
nav.tabs{position:sticky;top:0;z-index:5;background:var(--surface);border-bottom:1px solid var(--border)}
nav.tabs .wrap{display:flex;gap:4px;overflow-x:auto}
nav.tabs a{padding:12px 14px;text-decoration:none;color:var(--muted);font-weight:600;font-size:13px;border-bottom:2px solid transparent;white-space:nowrap}
nav.tabs a:hover{color:var(--text)}
nav.tabs a .count{margin-left:6px;font-size:11px;padding:1px 7px;border-radius:999px;background:var(--surface-2);border:1px solid var(--border)}
nav.tabs a .count.bad{background:var(--fail-soft);color:var(--fail);border-color:transparent}
main{padding:24px 0 60px}
section{margin-bottom:34px;scroll-margin-top:60px}
h2{font-size:17px;margin:0 0 4px;font-weight:700}
.section-intro{color:var(--muted);margin:0 0 14px;font-size:13px;max-width:820px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow)}
.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
@media (max-width:760px){.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}}
.kpi{padding:14px 16px}
.kpi .label{font-size:12px;color:var(--muted);font-weight:600}
.kpi .value{font-size:26px;font-weight:750;margin-top:2px;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.kpi .hint{font-size:11.5px;color:var(--faint)}
.kpi.pass .value{color:var(--pass)}.kpi.fail .value{color:var(--fail)}.kpi.skip .value{color:var(--skip)}
.dist{margin-top:14px;padding:16px}
.bar{display:flex;height:12px;border-radius:999px;overflow:hidden;background:var(--surface-2);border:1px solid var(--border)}
.bar span{display:block;height:100%}
.bar .p{background:var(--pass)}.bar .f{background:var(--fail)}.bar .s{background:var(--skip)}
.legend{display:flex;gap:16px;flex-wrap:wrap;margin-top:10px;font-size:12.5px;color:var(--muted)}
.legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;vertical-align:-1px}
.summary-text{padding:16px 18px;margin-top:14px;font-size:14px;line-height:1.65}
.summary-text p{margin:0 0 6px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px}
@media (max-width:860px){.grid2{grid-template-columns:1fr}}
.mini{padding:16px}
.mini h3{font-size:13px;margin:0 0 10px;color:var(--muted);font-weight:650;text-transform:uppercase;letter-spacing:.06em}
.stat-row{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px dashed var(--border);font-size:13px}
.stat-row:last-child{border-bottom:0}
.stat-row b{font-variant-numeric:tabular-nums}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font-size:11.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:650;padding:10px 12px;border-bottom:1px solid var(--border);background:var(--surface-2);position:sticky;top:45px}
td{padding:10px 12px;border-bottom:1px solid var(--border);vertical-align:middle}
tr:last-child td{border-bottom:0}
.num{text-align:right;font-variant-numeric:tabular-nums}
.table-card{overflow:hidden}
.table-scroll{overflow-x:auto}
.method{font-family:var(--mono);font-size:11px;font-weight:700;padding:2px 7px;border-radius:5px;border:1px solid currentColor;display:inline-block;min-width:58px;text-align:center}
.m-GET{color:var(--get)}.m-POST{color:var(--post)}.m-PUT{color:var(--put)}.m-PATCH{color:var(--patch)}.m-DELETE{color:var(--delete)}.m-other{color:var(--other)}
.pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:700;padding:3px 10px;border-radius:999px}
.pill.passed{background:var(--pass-soft);color:var(--pass)}.pill.failed{background:var(--fail-soft);color:var(--fail)}.pill.skipped{background:var(--skip-soft);color:var(--skip)}
.code{font-family:var(--mono);font-size:12.5px}
.http{font-family:var(--mono);font-weight:700;font-size:12.5px}
.h2xx{color:var(--pass)}.h3xx{color:var(--info)}.h4xx{color:var(--skip)}.h5xx{color:var(--fail)}
.muted{color:var(--muted)}.faint{color:var(--faint)}
.tbar{display:flex;align-items:center;gap:8px}
.tbar .track{flex:1;min-width:50px;height:6px;background:var(--surface-2);border-radius:999px;overflow:hidden}
.tbar .track span{display:block;height:100%;background:var(--accent);border-radius:999px}
.tbar.slow .track span{background:var(--skip)}
.toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:12px;border-bottom:1px solid var(--border)}
.chip{border:1px solid var(--border);background:var(--surface);color:var(--text);border-radius:999px;padding:5px 12px;font-size:12.5px;font-weight:600;cursor:pointer}
.chip[aria-pressed=true]{background:var(--accent);border-color:var(--accent);color:#fff}
select,input[type=search]{border:1px solid var(--border);background:var(--surface);color:var(--text);border-radius:8px;padding:6px 10px;font-size:13px}
input[type=search]{min-width:220px;flex:1}
tr.row{cursor:pointer}
tr.row:hover td{background:var(--surface-2)}
tr.row.open td{background:var(--accent-soft)}
tr.row td:first-child{width:36px}
.caret{display:inline-block;transition:transform .15s;color:var(--faint)}
tr.open .caret{transform:rotate(90deg)}
.req-name{font-weight:600}
.req-url{font-family:var(--mono);font-size:11.5px;color:var(--muted);word-break:break-all}
tr.detail td{background:var(--surface-2);padding:0}
.detail-inner{padding:16px 18px 20px}
.detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media (max-width:900px){.detail-grid{grid-template-columns:1fr}}
.panel{background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden}
.panel h4{margin:0;padding:9px 12px;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);border-bottom:1px solid var(--border);background:var(--surface-2);display:flex;justify-content:space-between}
.panel .pbody{padding:10px 12px}
.kv{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;font-size:12.5px}
.kv dt{color:var(--muted)}.kv dd{margin:0;font-family:var(--mono);word-break:break-all}
pre{margin:0;font-family:var(--mono);font-size:12px;white-space:pre-wrap;word-break:break-word;max-height:340px;overflow:auto;background:var(--surface-2);padding:10px;border-radius:8px;border:1px solid var(--border)}
details.hdrs summary{cursor:pointer;color:var(--muted);font-size:12px;margin:8px 0 6px}
.checks{list-style:none;margin:0;padding:0}
.checks li{display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);align-items:flex-start}
.checks li:last-child{border-bottom:0}
.icon{width:20px;height:20px;border-radius:50%;flex:none;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:800}
.icon.ok{background:var(--pass-soft);color:var(--pass)}.icon.bad{background:var(--fail-soft);color:var(--fail)}
.origin{font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;font-weight:700;padding:1px 7px;border-radius:5px;margin-left:6px}
.o-collection{background:var(--accent-soft);color:var(--accent)}.o-auth{background:var(--pass-soft);color:var(--pass)}.o-example{background:var(--info-soft);color:var(--info)}.o-baseline{background:var(--surface-2);color:var(--muted);border:1px solid var(--border)}
.check-msg{font-family:var(--mono);font-size:12px;color:var(--fail);white-space:pre-wrap;margin-top:4px}
.callout{border-radius:10px;padding:12px 14px;margin-bottom:14px;font-size:13px}
.callout.fail{background:var(--fail-soft);color:var(--text);border-left:4px solid var(--fail)}
.callout.skip{background:var(--skip-soft);border-left:4px solid var(--skip)}
.callout.info{background:var(--info-soft);border-left:4px solid var(--info)}
.callout b{display:block;margin-bottom:2px}
.fail-card{padding:16px 18px;margin-bottom:12px;border-left:4px solid var(--fail)}
.fail-head{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center}
.fail-title{font-weight:700;font-size:15px}
.cat{font-size:12px;font-weight:700;padding:3px 10px;border-radius:999px;background:var(--fail-soft);color:var(--fail)}
.hint{color:var(--muted);font-size:12.5px;margin-top:8px}
.hint b{color:var(--text)}
.empty{padding:28px;text-align:center;color:var(--muted)}
.notes li{margin-bottom:6px}
.glossary{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}
.glossary .card{padding:14px 16px}
.glossary h3{font-size:14px;margin:0 0 6px}
.glossary p{margin:0;color:var(--muted);font-size:13px}
footer{color:var(--faint);font-size:12px;padding:20px 0 40px;border-top:1px solid var(--border)}
.btn-link{display:inline-block;margin-right:14px}
@media print{nav.tabs,.toolbar{display:none}th{position:static}body{background:#fff}}
`;

const CLIENT_JS = String.raw`
(function(){
'use strict';
var D = JSON.parse(document.getElementById('report-data').textContent);
var esc = function(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); };
var fmtMs = function(ms){ if (ms == null) return '–'; if (ms < 1000) return ms + ' ms'; return (ms/1000).toFixed(ms < 10000 ? 2 : 1) + ' s'; };
var fmtDur = function(ms){ if (ms == null) return '–'; var s = ms/1000; if (s < 60) return s.toFixed(1) + ' s'; var m = Math.floor(s/60); return m + ' min ' + Math.round(s - m*60) + ' s'; };
var fmtDate = function(iso){ try { return new Date(iso).toLocaleString(); } catch(e){ return iso; } };
var methodCls = function(m){ return ['GET','POST','PUT','PATCH','DELETE'].indexOf(m) >= 0 ? 'm-' + m : 'm-other'; };
var httpCls = function(s){ return s ? 'h' + String(s)[0] + 'xx' : ''; };
var plural = function(n, w){ return n + ' ' + w + (n === 1 ? '' : 's'); };
var T = D.totals, S = D.settings || {}, C = D.collection || {}, CAT = D.failureCategories;
var maxTime = Math.max.apply(null, D.tests.map(function(t){ return t.responseTimeMs || 0; }).concat([1]));
var slowThreshold = D.responseTimes ? Math.max(D.responseTimes.p95 || 0, 1) : Infinity;

var verdictText = { passed:'ALL TESTS PASSED', failed:'TESTS FAILED', skipped:'NOTHING EXECUTED', incomplete:'RUN INCOMPLETE', empty:'NO TESTS' }[D.verdict];

function pct(n, d){ return d ? Math.round(n/d*1000)/10 : 0; }

function header(){
  var target = S.targetBaseUrl ? '<b>' + esc(S.targetBaseUrl) + '</b> <span class="faint">(base URL override)</span>' : '<b>' + esc(D.hosts.join(', ') || '–') + '</b>';
  return '<header class="top"><div class="wrap"><div class="top-inner">' +
    '<div><div class="eyebrow">API Test Execution Report</div><h1>' + esc(C.name) + '</h1>' +
    '<div class="sub">Generated from Postman collection ' + (C.sourceFile ? '<b>' + esc(C.sourceFile) + '</b>' : '') +
    (C.environment ? ' · environment <b>' + esc(C.environment) + '</b>' : '') + ' · executed with Playwright ' + esc(D.playwrightVersion) + '</div></div>' +
    '<div class="verdict"><span class="verdict-badge v-' + D.verdict + '"><span class="dot"></span>' + verdictText + '</span>' +
    '<span class="sub">' + T.passed + ' of ' + T.executed + ' executed requests passed' + (T.skipped ? ' · ' + T.skipped + ' skipped' : '') + '</span></div>' +
    '</div><div class="meta-strip">' +
    '<span>Target: ' + target + '</span>' +
    '<span>Started: <b>' + esc(fmtDate(D.startedAt)) + '</b></span>' +
    '<span>Duration: <b>' + fmtDur(D.durationMs) + '</b></span>' +
    '<span>Workers: <b>' + esc(S.workers) + '</b></span>' +
    '<span>Request timeout: <b>' + fmtMs(S.requestTimeoutMs) + '</b></span>' +
    '<span>Retries: <b>' + esc(S.retries) + '</b></span>' +
    '<span>POST/PUT/PATCH/DELETE: <b>' + (S.allowMutating ? 'allowed' : 'blocked (safety)') + '</b></span>' +
    '<span>Baseline status rule: <b>' + esc(S.baselineStatus) + '</b></span>' +
    '</div></div></header>';
}

function nav(){
  var f = T.failed;
  return '<nav class="tabs"><div class="wrap">' +
    '<a href="#overview">Overview</a>' +
    '<a href="#failures">Failures<span class="count' + (f ? ' bad' : '') + '">' + f + '</span></a>' +
    '<a href="#requests">All requests<span class="count">' + T.total + '</span></a>' +
    '<a href="#folders">By folder<span class="count">' + D.folders.length + '</span></a>' +
    '<a href="#notes">Collection notes</a>' +
    '<a href="#guide">How to read this report</a>' +
    '</div></nav>';
}

function kpi(label, value, hint, cls){
  return '<div class="card kpi ' + (cls || '') + '"><div class="label">' + label + '</div><div class="value">' + value + '</div><div class="hint">' + (hint || '&nbsp;') + '</div></div>';
}

function plainSummary(){
  var parts = [];
  var where = S.targetBaseUrl ? ' against <b>' + esc(S.targetBaseUrl) + '</b>' : (D.hosts.length ? ' against <b>' + esc(D.hosts.join(', ')) + '</b>' : '');
  parts.push('<p><b>' + plural(T.total, 'request') + '</b> from the collection were turned into tests and ' + (T.executed ? plural(T.executed, 'request') + ' were sent' + where : 'none were sent') + '. ' +
    '<span style="color:var(--pass)"><b>' + T.passed + ' passed</b></span>, <span style="color:var(--fail)"><b>' + T.failed + ' failed</b></span>' +
    (T.skipped ? ' and <span style="color:var(--skip)"><b>' + T.skipped + ' were skipped</b></span>' : '') + '.</p>');
  var fb = Object.keys(D.failureBreakdown);
  if (fb.length) parts.push('<p>Failures by type: ' + fb.map(function(k){ return '<b>' + D.failureBreakdown[k] + '</b> ' + esc((CAT[k] || {label:k}).label.toLowerCase()); }).join(', ') + '. See <a href="#failures">Failures</a> for details and what to check.</p>');
  if (D.responseTimes) parts.push('<p>Response times: average <b>' + fmtMs(D.responseTimes.avg) + '</b>, median ' + fmtMs(D.responseTimes.median) + ', 95% of requests within <b>' + fmtMs(D.responseTimes.p95) + '</b>, slowest ' + fmtMs(D.responseTimes.max) + '.</p>');
  var col = D.checks.byOrigin.filter(function(o){ return o.origin === 'collection'; })[0];
  if (col && col.total === 0) parts.push('<p class="muted">The collection contains no Postman test scripts, so only <b>baseline checks</b> were applied (response received, status code class, valid JSON). These confirm the API responds correctly at a technical level; they do <b>not</b> verify business rules.</p>');
  else if (col) parts.push('<p>' + plural(col.total, 'check') + ' came from the collection\'s own Postman test scripts' + (col.failed ? ', of which <b style="color:var(--fail)">' + col.failed + ' failed</b>' : ', all passed') + '.</p>');
  var skippedBlocked = D.tests.filter(function(t){ return t.status === 'skipped' && /blocked by safety/.test(t.skipReason || ''); }).length;
  if (skippedBlocked) parts.push('<p class="muted"><b>' + skippedBlocked + '</b> POST/PUT/PATCH/DELETE requests were skipped because mutating requests are blocked by default. Enable them only for non-production targets.</p>');
  return '<div class="card summary-text">' + parts.join('') + '</div>';
}

function overview(){
  var rt = D.responseTimes;
  var html = '<section id="overview"><h2>Overview</h2><p class="section-intro">Headline numbers for this run. A request <b>passes</b> only when every check on it passes.</p>';
  html += '<div class="kpis">' +
    kpi('Total requests', T.total, Object.keys(D.methods).map(function(m){ return m + ' ' + D.methods[m]; }).join(' · ')) +
    kpi('Passed', T.passed, pct(T.passed, T.total) + '% of total', 'pass') +
    kpi('Failed', T.failed, pct(T.failed, T.total) + '% of total', 'fail') +
    kpi('Skipped', T.skipped, T.skipped ? 'not sent – see reasons' : 'none', 'skip') +
    kpi('Pass rate', T.passRate == null ? '–' : T.passRate + '%', 'of executed requests') +
    kpi('Checks', D.checks.passed + '/' + D.checks.total, D.checks.failed ? D.checks.failed + ' failed' : 'all passed') +
    kpi('Avg response', rt ? fmtMs(rt.avg) : '–', rt ? 'p95 ' + fmtMs(rt.p95) : '') +
    kpi('Run duration', fmtDur(D.durationMs), 'wall-clock time') +
    '</div>';
  html += '<div class="card dist"><div class="bar">' +
    '<span class="p" style="width:' + pct(T.passed, T.total) + '%"></span><span class="f" style="width:' + pct(T.failed, T.total) + '%"></span><span class="s" style="width:' + pct(T.skipped, T.total) + '%"></span></div>' +
    '<div class="legend"><span><i style="background:var(--pass)"></i>Passed ' + T.passed + '</span><span><i style="background:var(--fail)"></i>Failed ' + T.failed + '</span><span><i style="background:var(--skip)"></i>Skipped ' + T.skipped + '</span></div></div>';
  html += plainSummary();

  var sc = Object.keys(D.statusClasses).sort().map(function(k){ return '<div class="stat-row"><span><span class="http h' + k + '">' + k + '</span> ' + ({ '1xx':'informational','2xx':'success','3xx':'redirect','4xx':'client error','5xx':'server error'}[k] || '') + '</span><b>' + D.statusClasses[k] + '</b></div>'; }).join('') || '<div class="faint">No responses received.</div>';
  var origins = D.checks.byOrigin.map(function(o){ return '<div class="stat-row"><span><span class="origin o-' + o.origin + '">' + o.origin + '</span></span><b>' + (o.total - o.failed) + ' / ' + o.total + ' passed</b></div>'; }).join('');
  var slow = D.slowest.map(function(s){ return '<div class="stat-row"><span><span class="method ' + methodCls(s.method) + '">' + esc(s.method) + '</span> ' + esc(s.name) + ' <span class="faint">' + esc(s.folder) + '</span></span><b>' + fmtMs(s.responseTimeMs) + '</b></div>'; }).join('') || '<div class="faint">No timings recorded.</div>';
  var rtRows = rt ? ['min','median','avg','p95','max'].map(function(k){ return '<div class="stat-row"><span>' + ({min:'Fastest',median:'Median',avg:'Average',p95:'95th percentile',max:'Slowest'}[k]) + '</span><b>' + fmtMs(rt[k]) + '</b></div>'; }).join('') : '<div class="faint">No timings recorded.</div>';
  html += '<div class="grid2">' +
    '<div class="card mini"><h3>HTTP status codes received</h3>' + sc + '</div>' +
    '<div class="card mini"><h3>Checks by origin</h3>' + origins + '</div>' +
    '<div class="card mini"><h3>Response time distribution</h3>' + rtRows + '</div>' +
    '<div class="card mini"><h3>Slowest requests</h3>' + slow + '</div>' +
    authCard() +
    '</div></section>';
  return html;
}

function authCard(){
  var A = D.authSummary;
  if (!A) return '';
  var row = function(k, v){ return '<div class="stat-row"><span>' + k + '</span><b>' + v + '</b></div>'; };
  return '<div class="card mini"><h3>Automatic authentication</h3>' +
    row('Config file', esc(A.configFile) + (A.valid ? '' : ' <span style="color:var(--fail)">(invalid)</span>')) +
    (A.valid
      ? row('Login request', esc(A.loginRequest || '–')) +
        row('Token', 'from <span class="code">' + esc(A.tokenPath) + '</span> → {{' + esc(A.tokenVariable) + '}}') +
        row('Logins performed', esc(A.loginCalls) + ' <span class="faint">(token reused by later requests)</span>') +
        row('Token refresh', A.refreshEnabled ? 'enabled · ' + esc(A.refreshCalls) + ' refresh(es)' : 'disabled') +
        row('Last login result', esc(A.loginStatus))
      : row('Errors', esc((A.errors || []).join(' ')))) +
    '<div class="faint" style="font-size:12px;margin-top:6px">Token values are never shown; they are masked as ***REDACTED***.</div></div>';
}

function authPanel(t){
  var a = t.authInfo;
  if (!a || (a.type === 'none' && !(a.events || []).length)) return '';
  var ev = (a.events || []).map(function(e){
    return '<li>' + (e.type === 'note' ? esc(e.message) : '<b>' + (e.type === 'login' ? 'Login' : 'Token refresh') + '</b> via "' + esc(e.request) + '" (' + esc(e.trigger) + ') → HTTP ' + esc(e.status) + ', ' + fmtMs(e.durationMs) + ' · ' + esc(e.outcome)) + '</li>';
  }).join('');
  return '<div class="panel" style="margin-top:14px"><h4><span>Authentication</span><span>' + esc(a.role) + '</span></h4><div class="pbody">' +
    '<dl class="kv"><dt>Type</dt><dd>' + esc(a.type) + '</dd>' + (a.source ? '<dt>Defined at</dt><dd>' + esc(a.source) + '</dd>' : '') + '</dl>' +
    (ev ? '<ul class="notes" style="margin:8px 0 0 18px;padding:0">' + ev + '</ul>' : '') + '</div></div>';
}

function checkList(checks){
  if (!checks || !checks.length) return '<div class="faint">No checks were executed.</div>';
  return '<ul class="checks">' + checks.map(function(c){
    var ok = c.status === 'passed';
    return '<li><span class="icon ' + (ok ? 'ok' : 'bad') + '">' + (ok ? '✓' : '✕') + '</span><div><div>' + esc(c.title) + '<span class="origin o-' + esc(c.origin) + '">' + esc(c.origin) + '</span></div>' +
      (ok ? '' : '<div class="check-msg">' + esc(c.message) + '</div>') + '</div></li>';
  }).join('') + '</ul>';
}

function failures(){
  var failed = D.tests.filter(function(t){ return t.status === 'failed'; });
  var html = '<section id="failures"><h2>Failures</h2><p class="section-intro">Every failed request with the reason, the failed checks and suggestions on what to check next.</p>';
  if (!failed.length) return html + '<div class="card empty">✓ No failures in this run.</div></section>';
  failed.forEach(function(t){
    var cat = CAT[t.failureCategory] || { label: t.failureCategory, explain: '', hint: '' };
    var failedChecks = (t.checks || []).filter(function(c){ return c.status === 'failed'; });
    html += '<div class="card fail-card"><div class="fail-head"><div><div class="fail-title">#' + t.index + ' ' + esc(t.name) + '</div>' +
      '<div class="muted"><span class="method ' + methodCls(t.method) + '">' + esc(t.method) + '</span> <span class="code">' + esc(t.url) + '</span></div></div>' +
      '<div><span class="cat">' + esc(cat.label) + '</span></div></div>' +
      '<div class="kv" style="margin-top:10px"><dt>Folder</dt><dd>' + esc(t.folder) + '</dd><dt>HTTP status</dt><dd><span class="http ' + httpCls(t.httpStatus) + '">' + (t.httpStatus ? esc(t.httpStatus + ' ' + t.statusText) : 'no response') + '</span></dd>' +
      '<dt>Response time</dt><dd>' + fmtMs(t.responseTimeMs) + '</dd></div>' +
      '<p style="margin:10px 0 6px">' + esc(cat.explain) + '</p>' +
      (failedChecks.length ? checkList(failedChecks) : '<pre>' + esc(t.error || 'No error message') + '</pre>') +
      (t.failureCategory === 'auth-rejected' && t.authInfo && t.authInfo.type === 'none' ? '<div class="hint"><b>Note:</b> no authentication was sent with this request, but the endpoint appears to require it. Configure auth on the request/collection or set defaultAuth in auth.config.json.</div>' : '') +
      '<div class="hint"><b>What to check:</b> ' + esc(cat.hint) + '</div>' +
      '<div class="hint"><a href="#req-' + t.index + '" data-open="' + t.index + '">Open full request / response details →</a></div></div>';
  });
  return html + '</section>';
}

function headersBlock(h){
  var keys = Object.keys(h || {});
  if (!keys.length) return '<div class="faint" style="font-size:12px">No headers</div>';
  return '<dl class="kv">' + keys.map(function(k){ return '<dt>' + esc(k) + '</dt><dd>' + esc(h[k]) + '</dd>'; }).join('') + '</dl>';
}

function detail(t){
  var html = '<div class="detail-inner">';
  if (t.status === 'failed') {
    var cat = CAT[t.failureCategory] || { label: t.failureCategory, explain: '' };
    html += '<div class="callout fail"><b>' + esc(cat.label) + '</b>' + esc(cat.explain) + '</div>';
  }
  if (t.status === 'skipped') html += '<div class="callout skip"><b>Skipped – request was not sent</b>' + esc(t.skipReason) + '</div>';
  if (t.description) html += '<p class="muted" style="margin-top:0">' + esc(t.description) + '</p>';
  html += '<div class="detail-grid">';
  var rq = t.request, rs = t.response;
  html += '<div class="panel"><h4><span>Request</span><span>' + esc(t.method) + '</span></h4><div class="pbody">' +
    '<dl class="kv"><dt>URL</dt><dd>' + esc(rq ? rq.url : t.url) + '</dd>' +
    (t.rawUrl && rq && t.rawUrl !== rq.url ? '<dt>In collection</dt><dd>' + esc(t.rawUrl) + '</dd>' : '') +
    '<dt>Test file</dt><dd>' + esc(t.file) + '</dd></dl>' +
    (rq ? '<details class="hdrs"><summary>Headers (' + Object.keys(rq.headers || {}).length + ')</summary>' + headersBlock(rq.headers) + '</details>' +
      (rq.body ? '<div class="faint" style="font-size:12px;margin:8px 0 6px">Body</div><pre>' + esc(rq.body) + '</pre>' : '') : '<div class="faint" style="margin-top:8px">Request was not sent.</div>') +
    '</div></div>';
  html += '<div class="panel"><h4><span>Response</span><span>' + (rs ? '<span class="http ' + httpCls(rs.status) + '">' + esc(rs.status + ' ' + rs.statusText) + '</span>' : '') + '</span></h4><div class="pbody">' +
    (rs ? '<dl class="kv"><dt>Status</dt><dd><span class="http ' + httpCls(rs.status) + '">' + esc(rs.status + ' ' + rs.statusText) + '</span></dd><dt>Response time</dt><dd>' + fmtMs(rs.durationMs) + '</dd>' +
      '<dt>Content type</dt><dd>' + esc(rs.contentType || '–') + '</dd><dt>Size</dt><dd>' + esc(rs.sizeBytes) + ' bytes</dd></dl>' +
      '<details class="hdrs"><summary>Headers (' + Object.keys(rs.headers || {}).length + ')</summary>' + headersBlock(rs.headers) + '</details>' +
      (rs.body !== undefined && rs.body !== null && rs.body !== '' ? '<div class="faint" style="font-size:12px;margin:8px 0 6px">Body (sensitive fields redacted' + (S.bodiesIncluded ? '' : '') + ')</div><pre>' + esc(rs.body) + '</pre>' : '<div class="faint" style="font-size:12px;margin-top:8px">' + (S.bodiesIncluded ? 'Empty body' : 'Bodies excluded (REPORT_INCLUDE_BODIES=false)') + '</div>')
      : '<div class="faint">' + (t.status === 'skipped' ? 'Not sent.' : 'No HTTP response received.') + '</div>' + (t.error ? '<pre style="margin-top:8px">' + esc(t.error) + '</pre>' : '')) +
    '</div></div>';
  html += '</div>';
  html += authPanel(t);
  html += '<div class="panel" style="margin-top:14px"><h4><span>Checks</span><span>' + (t.checks || []).filter(function(c){ return c.status === 'passed'; }).length + ' / ' + (t.checks || []).length + ' passed</span></h4><div class="pbody">' + checkList(t.checks) + '</div></div>';
  if (t.extractions && t.extractions.length) {
    html += '<div class="panel" style="margin-top:14px"><h4><span>Variables saved for later requests</span></h4><div class="pbody"><dl class="kv">' +
      t.extractions.map(function(x){ return '<dt>' + esc(x.name) + '</dt><dd>' + (x.status === 'set' ? esc(x.preview) : '<span style="color:var(--fail)">failed: ' + esc(x.message) + '</span>') + '</dd>'; }).join('') + '</dl></div></div>';
  }
  if (t.notes && t.notes.length) html += '<div class="callout info" style="margin-top:14px"><b>Conversion notes</b><ul class="notes" style="margin:4px 0 0 18px;padding:0">' + t.notes.map(function(n){ return '<li>' + esc(n) + '</li>'; }).join('') + '</ul></div>';
  if (t.status === 'failed' && t.errors && t.errors.length) html += '<details class="hdrs"><summary>Raw Playwright error</summary><pre>' + esc(t.errors.join('\n\n')) + '</pre></details>';
  return html + '</div>';
}

function requestsSection(){
  var folders = D.folders.map(function(f){ return '<option>' + esc(f.folder) + '</option>'; }).join('');
  var methods = Object.keys(D.methods).map(function(m){ return '<option>' + esc(m) + '</option>'; }).join('');
  return '<section id="requests"><h2>All requests</h2><p class="section-intro">Every request in collection order. Click a row to see the sanitized request and response, every check and why it passed or failed.</p>' +
    '<div class="card table-card"><div class="toolbar">' +
    '<button class="chip" data-filter="all" aria-pressed="true">All ' + T.total + '</button>' +
    '<button class="chip" data-filter="passed" aria-pressed="false">Passed ' + T.passed + '</button>' +
    '<button class="chip" data-filter="failed" aria-pressed="false">Failed ' + T.failed + '</button>' +
    '<button class="chip" data-filter="skipped" aria-pressed="false">Skipped ' + T.skipped + '</button>' +
    '<select id="f-folder" aria-label="Folder"><option value="">All folders</option>' + folders + '</select>' +
    '<select id="f-method" aria-label="Method"><option value="">All methods</option>' + methods + '</select>' +
    '<input type="search" id="f-search" placeholder="Search name or URL…" aria-label="Search">' +
    '<button class="chip" id="expand-failed">Expand failed</button>' +
    '</div><div class="table-scroll"><table><thead><tr><th></th><th>#</th><th>Result</th><th>Request</th><th>Folder</th><th class="num">HTTP</th><th>Response time</th><th class="num">Checks</th></tr></thead><tbody id="rows"></tbody></table></div>' +
    '<div id="no-rows" class="empty" hidden>No requests match the current filter.</div></div></section>';
}

function rowHtml(t){
  var passedChecks = (t.checks || []).filter(function(c){ return c.status === 'passed'; }).length;
  var slow = t.responseTimeMs != null && t.responseTimeMs >= slowThreshold && D.tests.length > 5;
  return '<tr class="row" id="req-' + t.index + '" data-index="' + t.index + '"><td><span class="caret">▶</span></td><td class="muted">' + t.index + '</td>' +
    '<td><span class="pill ' + t.status + '">' + ({passed:'PASS',failed:'FAIL',skipped:'SKIP'}[t.status]) + '</span></td>' +
    '<td><div><span class="method ' + methodCls(t.method) + '">' + esc(t.method) + '</span> <span class="req-name">' + esc(t.name) + '</span></div><div class="req-url">' + esc(t.url) + '</div></td>' +
    '<td class="muted">' + esc(t.folder) + '</td>' +
    '<td class="num"><span class="http ' + httpCls(t.httpStatus) + '">' + (t.httpStatus || '–') + '</span></td>' +
    '<td style="min-width:150px">' + (t.responseTimeMs != null ? '<div class="tbar' + (slow ? ' slow' : '') + '"><span class="code" style="min-width:58px">' + fmtMs(t.responseTimeMs) + '</span><span class="track"><span style="width:' + Math.max(2, t.responseTimeMs / maxTime * 100) + '%"></span></span></div>' : '<span class="faint">–</span>') + '</td>' +
    '<td class="num">' + ((t.checks || []).length ? '<span' + (passedChecks < t.checks.length ? ' style="color:var(--fail);font-weight:700"' : '') + '>' + passedChecks + '/' + t.checks.length + '</span>' : '<span class="faint">–</span>') + '</td></tr>';
}

function foldersSection(){
  var rows = D.folders.map(function(f){
    return '<tr><td class="req-name">' + esc(f.folder) + '</td><td class="num">' + f.total + '</td><td class="num" style="color:var(--pass)">' + f.passed + '</td><td class="num" style="color:var(--fail)">' + f.failed + '</td><td class="num" style="color:var(--skip)">' + f.skipped + '</td>' +
      '<td class="num">' + fmtMs(f.avgMs) + '</td><td style="min-width:160px"><div class="bar" style="height:8px"><span class="p" style="width:' + pct(f.passed, f.total) + '%"></span><span class="f" style="width:' + pct(f.failed, f.total) + '%"></span><span class="s" style="width:' + pct(f.skipped, f.total) + '%"></span></div></td></tr>';
  }).join('');
  return '<section id="folders"><h2>Results by folder</h2><p class="section-intro">Folders mirror the structure of the Postman collection.</p>' +
    '<div class="card table-card"><div class="table-scroll"><table><thead><tr><th>Folder</th><th class="num">Total</th><th class="num">Passed</th><th class="num">Failed</th><th class="num">Skipped</th><th class="num">Avg response</th><th>Result split</th></tr></thead><tbody>' + rows + '</tbody></table></div></div></section>';
}

function notesSection(){
  var g = D.generation;
  var html = '<section id="notes"><h2>Collection conversion notes</h2><p class="section-intro">What the generator found in the collection and anything it could not convert automatically. Unsupported items are never silently ignored.</p>';
  if (!g) return html + '<div class="card empty">Generation metadata not available.</div></section>';
  var st = g.stats || {};
  html += '<div class="grid2"><div class="card mini"><h3>Generation summary</h3>' +
    '<div class="stat-row"><span>Collection generated at</span><b>' + esc(fmtDate(C.generatedAt)) + '</b></div>' +
    '<div class="stat-row"><span>Postman schema</span><b>v' + esc(C.schemaVersion) + '</b></div>' +
    '<div class="stat-row"><span>Checks converted from Postman scripts</span><b>' + esc(st.convertedChecks) + '</b></div>' +
    '<div class="stat-row"><span>Requests with only baseline checks</span><b>' + esc(st.requestsWithBaselineOnly) + '</b></div>' +
    '<div class="stat-row"><span>Unsupported script statements</span><b>' + esc(st.unsupportedStatements) + '</b></div>' +
    '<div class="stat-row"><span>Literal secrets moved out of test code</span><b>' + esc(st.secretsExtracted) + '</b></div>' +
    '<div class="stat-row"><span>Request chaining</span><b>' + (g.hasDependencies ? 'yes (' + esc(g.chainedVariables.join(', ')) + ')' : 'none detected') + '</b></div>' +
    '</div><div class="card mini"><h3>Warnings</h3>' +
    (g.warnings.length ? '<ul class="notes" style="margin:0;padding-left:18px">' + g.warnings.map(function(w){ return '<li><b>' + esc(w.level) + '</b> · ' + esc(w.scope) + ': ' + esc(w.message) + '</li>'; }).join('') + '</ul>' : '<div class="faint">No warnings.</div>') +
    '</div></div>';
  if (g.unsupported.length) {
    html += '<div class="card table-card" style="margin-top:14px"><div class="table-scroll"><table><thead><tr><th>Request</th><th>Script</th><th>Statement</th><th>Reason</th></tr></thead><tbody>' +
      g.unsupported.map(function(u){ return '<tr><td>' + esc(u.request) + '<div class="faint">' + esc(u.folder) + '</div></td><td>' + esc(u.source) + (u.test ? '<div class="faint">' + esc(u.test) + '</div>' : '') + '</td><td class="code">' + esc(u.code) + '</td><td>' + esc(u.reason) + '</td></tr>'; }).join('') +
      '</tbody></table></div></div>';
  }
  return html + '</section>';
}

function guideSection(){
  var cards = [
    ['PASS', 'The request got a response and every check on it passed.'],
    ['FAIL', 'At least one check failed, or no response was received. The failure type tells you which.'],
    ['SKIP', 'The request was deliberately not sent – for example a POST/PUT/PATCH/DELETE while mutating requests are blocked, an unsupported auth type, or a disabled request. The reason is shown on the row.'],
    ['[collection] checks', 'Converted from the Postman test scripts in the collection (pm.test / pm.expect). These are the checks your team wrote and represent real expectations.'],
    ['[example] checks', 'The expected status code was taken from a saved example response in the collection.'],
    ['[baseline] checks', 'Generic checks added by the tool when the collection defines no expectations: status code is 2xx (configurable via BASELINE_STATUS) and JSON bodies parse. They prove the API responds sensibly, not that business rules are met.'],
    ['Assertion failure vs HTTP error', 'An assertion failure means the API answered but not as expected. An HTTP error means the API itself returned 4xx/5xx. A 4xx can still PASS if the collection expects it (e.g. negative tests).'],
    ['[auth] checks', 'Added for the login/refresh request configured in auth.config.json: the access token must be present at the configured JSON path.'],
    ['Authentication setup problem vs rejected', 'A setup problem means the request was never sent (missing token/credential or invalid auth config). Rejected means the server answered 401/403 or login failed. Neither is reported as a business-logic failure.'],
    ['Network error / Timeout', 'No HTTP response arrived. This usually points at connectivity, DNS, VPN, a wrong base URL or a slow service – not at the API logic.'],
    ['Response time', 'Measured from sending the request to receiving the full response body on this machine. Includes network latency.'],
    ['Redaction', 'Authorization headers, tokens, passwords, API keys and other sensitive fields are replaced with ***REDACTED*** everywhere in this report.'],
  ];
  return '<section id="guide"><h2>How to read this report</h2><p class="section-intro">Short definitions of every term used above.</p><div class="glossary">' +
    cards.map(function(c){ return '<div class="card"><h3>' + esc(c[0]) + '</h3><p>' + esc(c[1]) + '</p></div>'; }).join('') + '</div></section>';
}

function footer(){
  return '<footer><div class="wrap">Generated by postman-to-playwright on ' + esc(fmtDate(D.finishedAt)) + ' · ' +
    '<a class="btn-link" href="summary.json">summary.json (machine-readable)</a>' +
    (D.hasPlaywrightReport ? '<a class="btn-link" href="playwright-report/index.html">Playwright technical report</a>' : '') +
    '</div></footer>';
}

document.getElementById('app').innerHTML = header() + nav() + '<main><div class="wrap">' + overview() + failures() + requestsSection() + foldersSection() + notesSection() + guideSection() + '</div></main>' + footer();

// ---- interactive table
var state = { filter: 'all', folder: '', method: '', q: '', open: {} };
var byIndex = {}; D.tests.forEach(function(t){ byIndex[t.index] = t; });
function renderRows(){
  var q = state.q.toLowerCase();
  var list = D.tests.filter(function(t){
    return (state.filter === 'all' || t.status === state.filter) && (!state.folder || t.folder === state.folder) && (!state.method || t.method === state.method) &&
      (!q || (t.name + ' ' + t.url + ' ' + t.folder).toLowerCase().indexOf(q) >= 0);
  });
  document.getElementById('rows').innerHTML = list.map(function(t){
    var open = !!state.open[t.index];
    return rowHtml(t).replace('class="row"', 'class="row' + (open ? ' open' : '') + '"') + (open ? '<tr class="detail"><td colspan="8">' + detail(t) + '</td></tr>' : '');
  }).join('');
  document.getElementById('no-rows').hidden = list.length > 0;
}
renderRows();
document.getElementById('rows').addEventListener('click', function(e){
  var tr = e.target.closest('tr.row'); if (!tr) return;
  var i = tr.getAttribute('data-index'); state.open[i] = !state.open[i]; renderRows();
});
document.querySelectorAll('[data-filter]').forEach(function(b){
  b.addEventListener('click', function(){
    state.filter = b.getAttribute('data-filter');
    document.querySelectorAll('[data-filter]').forEach(function(x){ x.setAttribute('aria-pressed', String(x === b)); });
    renderRows();
  });
});
document.getElementById('f-folder').addEventListener('change', function(e){ state.folder = e.target.value; renderRows(); });
document.getElementById('f-method').addEventListener('change', function(e){ state.method = e.target.value; renderRows(); });
document.getElementById('f-search').addEventListener('input', function(e){ state.q = e.target.value; renderRows(); });
document.getElementById('expand-failed').addEventListener('click', function(){
  D.tests.forEach(function(t){ if (t.status === 'failed') state.open[t.index] = true; }); renderRows();
});
document.querySelectorAll('[data-open]').forEach(function(a){
  a.addEventListener('click', function(e){
    e.preventDefault();
    var i = a.getAttribute('data-open');
    state.filter = 'all'; state.folder = ''; state.method = ''; state.q = ''; state.open[i] = true;
    document.querySelectorAll('[data-filter]').forEach(function(x){ x.setAttribute('aria-pressed', String(x.getAttribute('data-filter') === 'all')); });
    document.getElementById('f-folder').value = ''; document.getElementById('f-method').value = ''; document.getElementById('f-search').value = '';
    renderRows();
    var row = document.getElementById('req-' + i); if (row) row.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});
})();
`;

module.exports = { buildReportData, renderHtml, FAILURE_CATEGORIES };
