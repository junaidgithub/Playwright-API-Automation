'use strict';
/**
 * Runtime used by generated Playwright tests.
 *
 * Exposes an `api` fixture that:
 *   - resolves {{variables}} (runtime > PM_VAR_ overrides > environment > folder > collection)
 *   - applies auth (bearer / basic / apikey) without ever logging secret values
 *   - sends the request through Playwright's APIRequestContext and times it
 *   - records every check (baseline / collection / example) so a failing check
 *     does not hide the others, then fails the test with a combined message
 *   - attaches a sanitized request/response record used by the HTML report
 */
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const base = require('@playwright/test');
const { loadDotEnv, getConfig, getVariableOverrides } = require('../config');
const { VariableResolver, findVariableReferences } = require('../parser/variable-resolver');
const redact = require('../utils/redact');
const { AuthManager, AUTH_STATE_KEY } = require('./auth-manager');

loadDotEnv();
const config = getConfig();
const STATE_FILE = path.join(config.generatedDir, '.runtime-state.json');
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const ANSI = /\u001b\[[0-9;]*m/g;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

let staticData = null;
function loadStatic() {
  if (staticData) return staticData;
  const vars = readJson(path.join(config.generatedDir, 'collection-variables.json'), {});
  const secrets = readJson(path.join(config.generatedDir, '.secrets.json'), {});
  staticData = {
    collection: vars.collection || {},
    environment: vars.environment || {},
    folders: vars.folders || {},
    secrets,
  };
  // Register every value that could be sensitive so it is masked everywhere.
  Object.values(secrets).forEach(redact.registerSecret);
  const scopes = [staticData.collection, staticData.environment, getVariableOverrides(), ...Object.values(staticData.folders)];
  for (const scope of scopes) {
    for (const [k, v] of Object.entries(scope)) if (redact.isSensitiveKey(k)) redact.registerSecret(v);
  }
  return staticData;
}

function readState() {
  return readJson(STATE_FILE, {});
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function cleanMessage(message) {
  return redact.redactString(String(message || '').replace(ANSI, '')).trim();
}

/** Replaces scheme/host/port (and prefixes the path) with TARGET_BASE_URL. */
function applyBaseOverride(url, baseUrl) {
  const b = new URL(baseUrl);
  if (!/^https?:$/.test(b.protocol)) throw new Error('TARGET_BASE_URL must start with http:// or https://');
  const prefix = b.pathname.replace(/\/+$/, '');
  return new URL(`${b.origin}${prefix}${url.pathname}${url.search}`);
}

const FORBIDDEN_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

class ApiError extends Error {
  constructor(category, message) {
    super(message);
    this.name = {
      timeout: 'RequestTimeoutError',
      network: 'NetworkError',
      'auth-config': 'AuthenticationConfigurationError',
      'auth-rejected': 'AuthenticationRejectedError',
    }[category] || 'RequestConfigurationError';
    this.category = category;
  }
}

class ApiClient {
  constructor(request, testInfo) {
    this.request = request;
    this.testInfo = testInfo;
    this.def = null;
    this.checks = [];
    this.extractions = [];
    this.exchange = null;
    this.error = null;
    this.authContext = null;
    loadStatic();
    this.auth = new AuthManager(this, { generatedDir: config.generatedDir, readState, writeState });
  }

  // ---------------------------------------------------------------- variables
  resolver(folder) {
    const data = loadStatic();
    const folderLayers = [];
    const parts = folder && folder !== '(root)' ? folder.split(' / ') : [];
    for (let i = parts.length; i > 0; i--) {
      const key = parts.slice(0, i).join(' / ');
      if (data.folders[key]) folderLayers.push({ name: `folder:${key}`, values: data.folders[key] });
    }
    return new VariableResolver([
      { name: 'runtime', values: readState() },
      { name: 'override', values: getVariableOverrides() },
      { name: 'environment', values: data.environment },
      ...folderLayers,
      { name: 'collection', values: data.collection },
      { name: 'secrets', values: data.secrets },
    ]);
  }

  setVariable(name, value, { secret = false } = {}) {
    if (name === AUTH_STATE_KEY) return;
    const state = readState();
    state[name] = value;
    // Remember which runtime values are secrets so the reporter can mask them too.
    if (secret) state.__secretKeys = [...new Set([...(state.__secretKeys || []), name])];
    writeState(state);
    if (secret || redact.isSensitiveKey(name)) redact.registerSecret(typeof value === 'string' ? value : JSON.stringify(value));
  }

  unsetVariable(name) {
    const state = readState();
    delete state[name];
    writeState(state);
  }

  // ------------------------------------------------------------------ request
  isMutating(def) {
    return MUTATING_METHODS.has(def.method);
  }

  /**
   * Sends a request definition produced by the generator and returns a response
   * wrapper: { status, statusText, headers, header(name), text, json, durationMs }.
   */
  async send(def) {
    this.def = def;
    const { testInfo } = this;
    if (def.skipReason) base.test.skip(true, def.skipReason);

    const ctx = this.auth.context(def);
    this.authContext = ctx;
    const mutating = this.isMutating(def);
    // A request configured as the login/refresh request is allowed even when writes are blocked.
    if (mutating && !config.allowMutating && !ctx.isLogin && !ctx.isRefresh) {
      base.test.skip(true, `${def.method} request blocked by safety setting. Set ALLOW_MUTATING_REQUESTS=true (dashboard: "Allow POST/PUT/PATCH/DELETE") only for non-production targets.`);
    }
    if (mutating && testInfo.retry > 0 && !config.retryMutating) {
      base.test.skip(true, `Retry of a ${def.method} request skipped (set RETRY_MUTATING_REQUESTS=true to allow retries of mutating requests).`);
    }

    for (const step of def.preRequest || []) {
      if (step.action === 'unset') this.unsetVariable(step.name);
      else this.setVariable(step.name, this.resolver(def.folder).resolveString(String(step.value)));
    }

    await this.auth.ensureCredentials(def, ctx);
    let res = await this.dispatch(def, this.buildRequest(def, ctx.effective));

    if (this.auth.shouldRefreshOn401(def, ctx, res.status)) {
      await this.auth.refresh('server answered 401');
      res = await this.dispatch(def, this.buildRequest(def, ctx.effective));
      this.auth.events.push({ type: 'note', message: `Access token was rejected (401); the token was refreshed and the request retried once -> HTTP ${res.status}.` });
    }

    if (ctx.isLogin) {
      const outcome = this.auth.applyLoginResponse(res, 'login request test');
      await this.verify(`Access token extracted from "${this.auth.config.login.tokenPath}"`, 'auth', () => {
        if (!outcome.ok) throw new Error(outcome.message);
      });
    } else if (ctx.isRefresh) {
      const outcome = this.auth.applyRefreshResponse(res);
      await this.verify(`Refreshed access token extracted from "${this.auth.config.refresh.tokenPath}"`, 'auth', () => {
        if (!outcome.ok) throw new Error(outcome.message);
      });
    }
    return res;
  }

  /** Resolves variables, applies auth and body, and builds the final URL. Throws on setup problems. */
  buildRequest(def, auth) {
    const r = this.resolver(def.folder);
    const headers = {};
    for (const [k, v] of Object.entries(def.headers || {})) headers[r.resolveString(k)] = r.resolveString(String(v));
    const query = (def.query || []).map(([k, v]) => [r.resolveString(k), r.resolveString(String(v))]);
    let urlText = r.resolveString(def.url);

    this.applyAuth(auth, r, headers, query);
    const options = this.buildBody(def.body, r, headers);

    if (r.unresolved.size) {
      const names = [...r.unresolved].join(', ');
      this.fail('config', `Unresolved variable(s): ${names}. Define them in an environment file or as PM_VAR_<name>, or make sure the request that sets them ran (and passed) earlier.`);
    }

    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(urlText)) urlText = `http://${urlText}`; // Postman's default
    let url;
    try {
      url = new URL(urlText);
      if (config.targetBaseUrl) url = applyBaseOverride(url, config.targetBaseUrl);
    } catch (err) {
      this.fail('config', `Invalid URL "${redact.redactUrl(urlText)}": ${err.message}`);
    }
    for (const [k, v] of query) url.searchParams.append(k, v);
    return { url, headers, options };
  }

  fetchBuilt(def, built) {
    return this.request.fetch(built.url.toString(), {
      method: def.method,
      headers: built.headers,
      ...built.options,
      timeout: config.requestTimeoutMs,
      failOnStatusCode: false,
      ignoreHTTPSErrors: config.ignoreHttpsErrors,
    });
  }

  /** Sends a built request, records the sanitized exchange and wraps the response. */
  async dispatch(def, built) {
    this.exchange = {
      request: {
        method: def.method,
        url: redact.redactUrl(built.url.toString()),
        headers: redact.redactHeaders(built.headers),
        body: config.reportIncludeBodies ? this.describeBody(built.options) : undefined,
      },
      response: null,
    };

    const started = performance.now();
    let response;
    try {
      response = await this.fetchBuilt(def, built);
    } catch (err) {
      const elapsed = Math.round(performance.now() - started);
      const first = cleanMessage(String(err.message).split('\n')[0]);
      const timeout = /timeout|timed out/i.test(err.message);
      this.exchange.durationMs = elapsed;
      this.fail(
        timeout ? 'timeout' : 'network',
        timeout
          ? `Request timeout: no response within ${config.requestTimeoutMs} ms (${def.method} ${this.exchange.request.url}). ${first}`
          : `Network error: could not get a response from ${this.exchange.request.url}. ${first}`,
      );
    }

    const durationMs = Math.round(performance.now() - started);
    const bodyBuffer = await response.body().catch(() => Buffer.alloc(0));
    const text = bodyBuffer.toString('utf8');
    const responseHeaders = response.headers();
    const res = createResponse(response.status(), response.statusText(), responseHeaders, text, durationMs);

    this.exchange.response = {
      status: res.status,
      statusText: res.statusText,
      durationMs,
      contentType: responseHeaders['content-type'] || '',
      sizeBytes: bodyBuffer.length,
      headers: redact.redactHeaders(responseHeaders),
      body: config.reportIncludeBodies ? redact.redactBody(text, config.reportBodyLimit) : undefined,
    };
    this.testInfo.annotations.push({ type: 'http', description: `${def.method} ${this.exchange.request.url} -> ${res.status} ${res.statusText} in ${durationMs} ms` });
    return res;
  }

  /** Applies bearer / basic / API-key auth. Missing or empty credentials are reported, never sent blank. */
  applyAuth(auth, r, headers, query) {
    if (!auth || auth.type === 'noauth') return;
    const hasHeader = (name) => Object.keys(headers).some((h) => h.toLowerCase() === name.toLowerCase());
    const credential = (field, label) => {
      const template = String(auth[field] ?? '');
      const value = r.resolveString(template);
      const missing = [...findVariableReferences(value)];
      if (missing.length) this.fail('auth-config', this.auth.missingCredential(label, missing, auth));
      if (!value.trim()) {
        const vars = [...findVariableReferences(template)];
        const where = auth.source ? ` (auth defined at ${auth.source})` : '';
        this.fail('auth-config', `${label} is empty${vars.length ? `: ${vars.map((v) => `{{${v}}}`).join(', ')} resolved to an empty value` : ''}${where}. Set it via ${vars.length ? vars.map((v) => `PM_VAR_${v}`).join(' / ') : 'the collection auth settings'}. The request was not sent.`);
      }
      redact.registerSecret(value);
      return value;
    };
    if (auth.type === 'bearer') {
      const token = credential('token', 'Bearer token');
      if (!hasHeader('authorization')) headers.Authorization = `Bearer ${token}`;
    } else if (auth.type === 'basic') {
      const user = credential('username', 'Basic auth username');
      const pass = credential('password', 'Basic auth password');
      const encoded = Buffer.from(`${user}:${pass}`).toString('base64');
      redact.registerSecret(encoded);
      if (!hasHeader('authorization')) headers.Authorization = `Basic ${encoded}`;
    } else if (auth.type === 'apikey') {
      const key = credential('key', 'API key name');
      const value = credential('value', 'API key value');
      if (auth.in === 'query') query.push([key, value]);
      else if (!hasHeader(key)) headers[key] = value;
    }
  }

  buildBody(body, r, headers) {
    if (!body) return {};
    const hasContentType = Object.keys(headers).some((h) => h.toLowerCase() === 'content-type');
    switch (body.mode) {
      case 'json':
        if (!hasContentType) headers['Content-Type'] = 'application/json';
        return { data: JSON.stringify(r.resolveDeep(body.json)) };
      case 'raw': {
        if (!hasContentType && body.contentType) headers['Content-Type'] = body.contentType;
        return { data: r.resolveString(body.raw) };
      }
      case 'urlencoded':
        return { form: Object.fromEntries(body.fields.map(([k, v]) => [r.resolveString(k), r.resolveString(String(v))])) };
      case 'formdata': {
        const multipart = {};
        for (const [k, v] of body.fields) multipart[r.resolveString(k)] = r.resolveString(String(v));
        for (const f of body.files || []) {
          const file = path.resolve(config.filesDir, path.basename(String(f.src || '')));
          if (!file.startsWith(config.filesDir + path.sep) || !fs.existsSync(file)) {
            this.fail('config', `Form-data file "${path.basename(String(f.src || ''))}" not found in FILES_DIR (${path.relative(config.rootDir, config.filesDir)}).`);
          }
          multipart[f.key] = { name: path.basename(file), mimeType: 'application/octet-stream', buffer: fs.readFileSync(file) };
        }
        return { multipart };
      }
      case 'graphql':
        if (!hasContentType) headers['Content-Type'] = 'application/json';
        return { data: JSON.stringify(r.resolveDeep({ query: body.query, variables: body.variables })) };
      default:
        return {};
    }
  }

  describeBody(options) {
    if (options.data !== undefined) return redact.redactBody(options.data, config.reportBodyLimit);
    if (options.form) return redact.redactBody(JSON.stringify(options.form), config.reportBodyLimit);
    if (options.multipart) {
      const shown = Object.fromEntries(Object.entries(options.multipart).map(([k, v]) => [k, typeof v === 'object' ? `[file ${v.name}]` : v]));
      return redact.redactBody(JSON.stringify(shown), config.reportBodyLimit);
    }
    return undefined;
  }

  fail(category, message) {
    this.error = { category, message: cleanMessage(message) };
    throw new ApiError(category, this.error.message);
  }

  // ------------------------------------------------------------------- checks
  /**
   * Runs one check as a Playwright step. Failures are recorded (not thrown) so
   * every check runs, like Postman's pm.test; assertAllChecksPassed() fails the test.
   * @param {'baseline'|'collection'|'example'} origin
   */
  async verify(title, origin, fn) {
    try {
      await base.test.step(`[${origin}] ${title}`, async () => {
        await fn();
      }, { box: true });
      this.checks.push({ title, origin, status: 'passed' });
    } catch (err) {
      this.checks.push({ title, origin, status: 'failed', message: cleanMessage(err.message) });
    }
  }

  /** Default status check used when the collection defines no status expectation. */
  async verifyBaselineStatus(res) {
    if (config.baselineStatus === 'none') return;
    if (config.baselineStatus === 'non-5xx') {
      await this.verify('Status code is not a server error (< 500)', 'baseline', () => {
        base.expect(res.status, 'Server error status received').toBeLessThan(500);
      });
      return;
    }
    await this.verify('Status code is 2xx (success)', 'baseline', () => {
      base.expect(res.status, `Expected a 2xx status, received ${res.status} ${res.statusText}`).toBeGreaterThanOrEqual(200);
      base.expect(res.status, `Expected a 2xx status, received ${res.status} ${res.statusText}`).toBeLessThan(300);
    });
  }

  /** If the server says the body is JSON, it must parse. Non-JSON responses are not forced to be JSON. */
  async verifyJsonIfDeclared(res) {
    const ct = res.header('content-type') || '';
    if (!/[/+]json\b/i.test(ct) || res.text.length === 0) return;
    await this.verify('Body is valid JSON (Content-Type declares JSON)', 'baseline', () => {
      base.expect(this.isJson(res), 'Response declared JSON but the body could not be parsed').toBe(true);
    });
  }

  async verifyResponseTime(res) {
    if (!config.maxResponseTimeMs) return;
    await this.verify(`Response time is below ${config.maxResponseTimeMs} ms`, 'baseline', () => {
      base.expect(res.durationMs, 'Response was slower than MAX_RESPONSE_TIME_MS').toBeLessThan(config.maxResponseTimeMs);
    });
  }

  /** Stores a value from the response for later requests (request chaining). */
  async extract(name, scope, getter) {
    try {
      const value = getter();
      if (value === undefined) throw new Error('value not present in the response');
      this.setVariable(name, value);
      this.extractions.push({ name, scope, status: 'set', preview: redact.isSensitiveKey(name) ? redact.MASK : redact.redactString(JSON.stringify(value)).slice(0, 120) });
    } catch (err) {
      this.extractions.push({ name, scope, status: 'failed', message: cleanMessage(err.message) });
      this.checks.push({ title: `Extract variable "${name}" for later requests`, origin: 'collection', status: 'failed', message: cleanMessage(err.message) });
    }
  }

  assertAllChecksPassed() {
    const failed = this.checks.filter((c) => c.status === 'failed');
    if (!failed.length) return;
    const lines = failed.map((c) => `  ✗ [${c.origin}] ${c.title}\n      ${c.message.split('\n').slice(0, 4).join('\n      ')}`);
    const err = new Error(`${failed.length} of ${this.checks.length} check(s) failed:\n${lines.join('\n')}`);
    err.name = 'AssertionFailure';
    throw err;
  }

  // ------------------------------------------------------------------ helpers
  jsonPath(res, segments) {
    let current = res.json;
    for (const seg of segments) {
      if (current === null || current === undefined) return undefined;
      if (FORBIDDEN_PATH_SEGMENTS.has(String(seg))) return undefined;
      current = current[seg];
    }
    return current;
  }

  isJson(res) {
    try {
      void res.json;
      return true;
    } catch {
      return false;
    }
  }

  typeOf(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
  }

  isEmpty(value) {
    if (value === null || value === undefined) return true;
    if (typeof value === 'string' || Array.isArray(value)) return value.length === 0;
    if (typeof value === 'object') return Object.keys(value).length === 0;
    return false;
  }

  toReport() {
    return {
      id: this.def?.id,
      name: this.def?.name,
      folder: this.def?.folder,
      method: this.def?.method,
      rawUrl: this.def ? redact.redactUrl(this.def.url) : undefined,
      targetOverride: config.targetBaseUrl ? redact.redactUrl(config.targetBaseUrl) : null,
      exchange: this.exchange,
      error: this.error,
      checks: this.checks,
      extractions: this.extractions,
      auth: this.def ? this.auth.toReport(this.authContext) : null,
    };
  }
}

function createResponse(status, statusText, headers, text, durationMs) {
  let parsed;
  let parseError = null;
  let parsedOnce = false;
  return {
    status,
    statusText,
    headers,
    text,
    durationMs,
    header(name) {
      return headers[String(name).toLowerCase()];
    },
    get json() {
      if (!parsedOnce) {
        parsedOnce = true;
        try {
          parsed = JSON.parse(text);
        } catch (err) {
          parseError = new Error(`Response body is not valid JSON (Content-Type: ${headers['content-type'] || 'none'}): ${err.message}`);
        }
      }
      if (parseError) throw parseError;
      return parsed;
    },
  };
}

const test = base.test.extend({
  api: async ({ request }, use, testInfo) => {
    const api = new ApiClient(request, testInfo);
    await use(api);
    await testInfo.attach('api-result', { body: JSON.stringify(api.toReport()), contentType: 'application/json' });
  },
});

module.exports = { test, expect: base.expect, ApiClient, applyBaseOverride, STATE_FILE };
