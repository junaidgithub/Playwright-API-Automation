'use strict';
/* Dashboard client. Talks only to the local backend; every value comes from real API responses. */
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const methodCls = (m) => (['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(m) ? `m-${m}` : 'm-other');
  const fmtMs = (ms) => (ms == null ? '–' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`);
  const kpi = (label, value, hint = '', cls = '') => `<div class="kpi ${cls}"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div><div class="hint">${esc(hint)}</div></div>`;

  let maxUploadMb = 5;
  let collectionFile = null;
  let pollTimer = null;
  let expectedTests = 0;

  async function api(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    });
    const isJson = (res.headers.get('content-type') || '').includes('application/json');
    const data = isJson ? await res.json() : await res.text();
    if (!res.ok) {
      const err = new Error(isJson ? data.error || `Request failed (${res.status})` : `Request failed (${res.status})`);
      err.details = isJson ? data.details : null;
      throw err;
    }
    return data;
  }

  function showError(el, err) {
    el.hidden = false;
    el.innerHTML = `<b>${esc(err.message)}</b>${err.details && err.details.length ? `<ul>${err.details.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}`;
  }

  function setStep(n) {
    document.querySelectorAll('.stepper li').forEach((li) => {
      const s = Number(li.dataset.step);
      li.classList.toggle('active', s === n);
      li.classList.toggle('done', s < n);
    });
  }

  // ------------------------------------------------------------ step 1: upload
  const dz = $('dropzone');
  $('file-collection').addEventListener('change', (e) => pickCollection(e.target.files[0]));
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', (e) => pickCollection(e.dataTransfer.files[0]));

  function pickCollection(file) {
    $('upload-error').hidden = true;
    if (!file) return;
    if (!/\.json$/i.test(file.name)) {
      showError($('upload-error'), new Error('Please choose a .json file exported from Postman.'));
      return;
    }
    if (file.size > maxUploadMb * 1048576) {
      showError($('upload-error'), new Error(`File is ${(file.size / 1048576).toFixed(1)} MB; the limit is ${maxUploadMb} MB.`));
      return;
    }
    collectionFile = file;
    $('collection-name').textContent = `${file.name} · ${(file.size / 1024).toFixed(1)} KB`;
    dz.classList.add('has-file');
    $('btn-validate').disabled = false;
    validate();
  }

  $('btn-validate').addEventListener('click', validate);

  async function validate() {
    if (!collectionFile) return;
    const btn = $('btn-validate');
    btn.disabled = true;
    btn.textContent = 'Validating…';
    $('upload-error').hidden = true;
    $('validation').hidden = true;
    $('btn-generate').disabled = true;
    try {
      const envFile = $('file-environment').files[0];
      const body = { fileName: collectionFile.name, collection: await collectionFile.text() };
      if (envFile) body.environment = await envFile.text();
      const data = await api('/api/collection', { method: 'POST', body: JSON.stringify(body) });
      renderValidation(data.summary);
      $('btn-generate').disabled = false;
      setStep(2);
    } catch (err) {
      showError($('upload-error'), err);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Validate collection';
    }
  }

  function renderValidation(s) {
    $('validation').hidden = false;
    const methods = Object.entries(s.methods).map(([m, n]) => `${m} ${n}`).join(' · ');
    $('validation-kpis').innerHTML =
      kpi('Collection', s.name.length > 28 ? `${s.name.slice(0, 26)}…` : s.name, `Postman schema v${s.schemaVersion}`) +
      kpi('Requests found', s.requestCount, methods) +
      kpi('Folders', s.folderCount, s.environment ? `environment: ${s.environment}` : 'no environment file') +
      kpi('Postman scripts', `${s.scripts.test} / ${s.scripts.prerequest}`, 'requests with test / pre-request scripts');
    const warnings = s.warnings || [];
    $('validation-warnings').innerHTML = warnings.length
      ? `<div class="alert ${warnings.some((w) => w.level === 'warning') ? 'warn' : 'info'}"><b>${warnings.length} note(s) about this collection</b><ul>${warnings.map((w) => `<li><b>${esc(w.scope)}</b>: ${esc(w.message)}</li>`).join('')}</ul></div>`
      : '<div class="alert info">✓ Collection is valid. No unsupported features detected.</div>';
    $('folder-list').innerHTML = s.groups.map((g) => `
      <details>
        <summary><span>${esc(g.folder)}</span><span class="count">${g.count} request${g.count === 1 ? '' : 's'}</span></summary>
        <ul>${g.requests.map((r) => `<li><span class="method ${methodCls(r.method)}">${esc(r.method)}</span><span>${esc(r.name)}${r.disabled ? ' <span class="count">(disabled)</span>' : ''}<div class="url">${esc(r.url)}</div></span></li>`).join('')}</ul>
      </details>`).join('');
  }

  // ---------------------------------------------------------- step 2: generate
  $('btn-generate').addEventListener('click', async () => {
    const btn = $('btn-generate');
    btn.disabled = true;
    btn.textContent = 'Generating…';
    $('generate-error').hidden = true;
    try {
      const data = await api('/api/generate', { method: 'POST', body: '{}' });
      renderGenerated(data);
      $('btn-run').disabled = false;
      setStep(3);
    } catch (err) {
      showError($('generate-error'), err);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Regenerate tests';
    }
  });

  function renderGenerated(g) {
    expectedTests = g.testCount;
    $('generated').hidden = false;
    const st = g.stats;
    $('generated-kpis').innerHTML =
      kpi('Tests generated', g.testCount, `${g.files.length} spec file(s)`) +
      kpi('Postman checks converted', st.convertedChecks, `${st.requestsWithCollectionChecks} request(s) with checks`) +
      kpi('Baseline-only requests', st.requestsWithBaselineOnly, 'no expectations in collection') +
      kpi('Unsupported statements', st.unsupportedStatements, st.skippedAtGeneration ? `${st.skippedAtGeneration} request(s) will be skipped` : 'see notes below', st.unsupportedStatements ? 'skip' : '');
    const notes = [];
    if (g.auth) notes.push(g.auth.valid ? `Automatic authentication from ${g.auth.configFile}: token {{${g.auth.tokenVariable}}} is obtained by the login request and reused${g.auth.refreshEnabled ? '; refresh is enabled' : ''}.` : `Authentication config ${g.auth.configFile} has errors: ${g.auth.errors.join(' ')} Protected requests will fail with an authentication configuration error.`);
    if (g.hasDependencies) notes.push(`Request chaining detected (${g.chainedVariables.join(', ')}): tests run with 1 worker in collection order.`);
    if (st.secretsExtracted) notes.push(`${st.secretsExtracted} literal secret(s) were moved out of the generated code into generated-tests/.secrets.json (git-ignored).`);
    if (st.requestsWithBaselineOnly) notes.push(`${st.requestsWithBaselineOnly} request(s) have no expectations in the collection and get baseline checks only. Baseline checks are not business requirements.`);
    const unsupported = g.requests.filter((r) => r.notes.length);
    $('generated-notes').innerHTML =
      (notes.length ? `<div class="alert info"><ul>${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div>` : '') +
      (unsupported.length ? `<div class="alert warn"><b>Conversion notes</b><ul>${unsupported.slice(0, 50).map((r) => `<li><b>${esc(r.name)}</b>: ${r.notes.map(esc).join(' · ')}</li>`).join('')}</ul></div>` : '');
    const tabs = $('code-tabs');
    tabs.innerHTML = g.files.map((f, i) => `<button role="tab" aria-selected="${i === 0}" data-file="${esc(f.name)}">${esc(f.name)} <span class="count">(${f.tests})</span></button>`).join('');
    tabs.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => loadCode(b)));
    if (g.files.length) loadCode(tabs.querySelector('button'));
  }

  async function loadCode(btn) {
    $('code-tabs').querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
    $('code-view').textContent = 'Loading…';
    try {
      $('code-view').textContent = await api(`/api/generated/file?name=${encodeURIComponent(btn.dataset.file)}`);
    } catch (err) {
      $('code-view').textContent = err.message;
    }
  }

  // --------------------------------------------------------------- step 3: run
  $('btn-run').addEventListener('click', async () => {
    $('run-error').hidden = true;
    const settings = {
      targetBaseUrl: $('opt-target').value.trim(),
      requestTimeoutMs: Number($('opt-timeout').value),
      workers: Number($('opt-workers').value),
      baselineStatus: $('opt-baseline').value,
      allowMutating: $('opt-mutating').checked,
    };
    try {
      $('btn-run').disabled = true;
      $('btn-generate').disabled = true;
      await api('/api/run', { method: 'POST', body: JSON.stringify(settings) });
      $('step-results').hidden = true;
      $('run-status').hidden = false;
      $('spinner').classList.remove('stopped');
      $('status-text').textContent = 'Running tests…';
      $('progress-bar').style.width = '0%';
      poll();
    } catch (err) {
      showError($('run-error'), err);
      $('btn-run').disabled = false;
      $('btn-generate').disabled = false;
    }
  });

  async function poll() {
    clearTimeout(pollTimer);
    try {
      const s = await api('/api/run');
      const log = $('run-log');
      const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
      log.textContent = s.log || '';
      if (atBottom) log.scrollTop = log.scrollHeight;
      if (expectedTests) $('progress-bar').style.width = `${Math.min(100, (s.progress / expectedTests) * 100)}%`;
      if (s.status === 'running') {
        $('status-text').textContent = `Running tests… ${s.progress}${expectedTests ? ` / ${expectedTests}` : ''} done`;
        pollTimer = setTimeout(poll, 1000);
        return;
      }
      $('spinner').classList.add('stopped');
      $('btn-run').disabled = false;
      $('btn-generate').disabled = false;
      if (s.status === 'error') {
        $('status-text').textContent = 'Run did not complete';
        showError($('run-error'), new Error(s.error || 'Unknown error'));
        $('log-details').open = true;
        return;
      }
      $('progress-bar').style.width = '100%';
      $('status-text').textContent = `Finished · exit code ${s.exitCode} ${s.exitCode === 0 ? '(all executed tests passed)' : '(failures present)'}`;
      renderResults(s);
      setStep(4);
    } catch (err) {
      showError($('run-error'), err);
      pollTimer = setTimeout(poll, 3000);
    }
  }

  // ----------------------------------------------------------- step 4: results
  function renderResults(s) {
    const r = s.result;
    if (!r) return;
    $('step-results').hidden = false;
    $('link-report-top').hidden = false;
    $('link-pw-report').hidden = !r.hasPlaywrightReport;
    const t = r.totals;
    const target = s.settings && s.settings.TARGET_BASE_URL ? s.settings.TARGET_BASE_URL : 'collection URLs';
    $('results-sub').textContent = `Target: ${target} · finished ${new Date(s.finishedAt).toLocaleString()} · ${(r.durationMs / 1000).toFixed(1)} s` +
      (r.responseTimes ? ` · avg response ${fmtMs(r.responseTimes.avg)}, p95 ${fmtMs(r.responseTimes.p95)}` : '');
    const verdict = $('verdict');
    verdict.className = `verdict ${r.verdict}`;
    verdict.textContent = { passed: 'ALL TESTS PASSED', failed: 'TESTS FAILED', skipped: 'NOTHING EXECUTED', incomplete: 'RUN INCOMPLETE', empty: 'NO TESTS' }[r.verdict];
    $('result-kpis').innerHTML =
      kpi('Total', t.total, `${t.executed} executed`) +
      kpi('Passed', t.passed, t.passRate == null ? '' : `${t.passRate}% pass rate`, 'pass') +
      kpi('Failed', t.failed, Object.entries(r.failureBreakdown).map(([k, n]) => `${n} ${(r.failureCategories[k] || k).toLowerCase()}`).join(', '), 'fail') +
      kpi('Skipped', t.skipped, t.skipped ? 'not sent – see reasons below' : 'none', 'skip');
    const pct = (n) => `${t.total ? (n / t.total) * 100 : 0}%`;
    $('bar-pass').style.width = pct(t.passed);
    $('bar-fail').style.width = pct(t.failed);
    $('bar-skip').style.width = pct(t.skipped);

    const failed = r.tests.filter((x) => x.status === 'failed');
    $('failed-list').innerHTML = failed.length
      ? failed.map((f) => `
        <div class="fail-item">
          <div><span class="title">#${f.index} ${esc(f.name)}</span><span class="cat">${esc(r.failureCategories[f.failureCategory] || f.failureCategory)}</span></div>
          <div class="url"><span class="method ${methodCls(f.method)}">${esc(f.method)}</span> ${esc(f.url)} · HTTP ${esc(f.httpStatus ?? 'no response')} · ${fmtMs(f.responseTimeMs)}</div>
          <pre>${esc(f.failedChecks.length ? f.failedChecks.map((c) => `✕ [${c.origin}] ${c.title}\n   ${c.message}`).join('\n') : f.error)}</pre>
        </div>`).join('')
      : '<div class="empty-note">✓ No failed requests.</div>';

    $('result-rows').innerHTML = r.tests.map((x) => `
      <tr>
        <td class="muted">${x.index}</td>
        <td><span class="pill ${x.status}">${x.status.toUpperCase()}</span></td>
        <td><span class="method ${methodCls(x.method)}">${esc(x.method)}</span> ${esc(x.name)}<div class="url">${esc(x.status === 'skipped' ? x.skipReason : x.url)}</div></td>
        <td class="muted">${esc(x.folder)}</td>
        <td class="num">${esc(x.httpStatus ?? '–')}</td>
        <td class="num">${fmtMs(x.responseTimeMs)}</td>
      </tr>`).join('');
    $('step-results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // -------------------------------------------------------------------- init
  (async function init() {
    try {
      const h = await api('/api/health');
      const d = h.defaults;
      maxUploadMb = d.maxUploadMb;
      $('opt-target').value = d.targetBaseUrl || '';
      $('opt-timeout').value = d.requestTimeoutMs;
      $('opt-workers').value = d.workers;
      $('opt-baseline').value = d.baselineStatus;
      $('opt-mutating').checked = !!d.allowMutating;
      const g = await api('/api/generated').catch(() => null);
      if (g) {
        renderGenerated(g);
        $('btn-run').disabled = false;
      }
      const run = await api('/api/run');
      if (run.status === 'running') {
        $('run-status').hidden = false;
        poll();
      } else if (run.result) {
        $('run-status').hidden = false;
        $('spinner').classList.add('stopped');
        $('status-text').textContent = `Last run finished · exit code ${run.exitCode}`;
        $('run-log').textContent = run.log;
        renderResults(run);
      }
    } catch (err) {
      showError($('upload-error'), new Error(`Backend not reachable: ${err.message}`));
    }
  })();
})();
