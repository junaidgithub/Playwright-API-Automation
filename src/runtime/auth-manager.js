'use strict';
/**
 * Runtime side of automatic authentication.
 *
 *  - decides the effective auth of a request (request/folder/collection auth,
 *    explicit "noauth" overrides, optional defaultAuth from auth.config.json)
 *  - logs in on demand when a protected request needs a token that is not
 *    available yet, and reuses the token for every later request
 *  - extracts access / refresh tokens and expiry from configured JSON paths
 *  - refreshes the token (only when configured): proactively before expiry or
 *    once after a 401, retrying the original request a single time
 *  - turns missing/invalid auth setup into clear "auth-config" errors and
 *    rejected credentials into "auth-rejected" errors instead of business failures
 *
 * Token values are only kept in the runtime state file (git-ignored) and are
 * registered with the redactor so they never appear in logs or reports.
 */
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { loadAuthConfig, findRequests, describeRef, readPath } = require('../auth/auth-config');
const { findVariableReferences } = require('../parser/variable-resolver');
const redact = require('../utils/redact');

const AUTH_STATE_KEY = '__auth';
let runtimeCache = null;

/** Loads auth.config.json once per worker and resolves login/refresh requests by name. */
function loadAuthRuntime(generatedDir) {
  if (runtimeCache) return runtimeCache;
  const loaded = loadAuthConfig();
  const errors = [...loaded.errors];
  let defs = [];
  try {
    defs = JSON.parse(fs.readFileSync(path.join(generatedDir, 'request-defs.json'), 'utf8'));
  } catch {
    // Older generated suites have no request-defs.json; on-demand login is then unavailable.
  }
  const resolveRef = (ref, label) => {
    const matches = findRequests(defs, ref);
    if (matches.length === 1) return matches[0];
    errors.push(matches.length === 0
      ? `${label} request "${ref}" was not found in the generated suite. Regenerate the tests or fix the name in ${loaded.path}.`
      : `${label} request "${ref}" is ambiguous; use "Folder / Name" in ${loaded.path}.`);
    return null;
  };
  const cfg = loaded.config;
  const loginDef = cfg?.login?.request && !loaded.errors.length ? resolveRef(cfg.login.request, 'Login') : null;
  const refreshDef = cfg?.refresh?.enabled && cfg.refresh.request && !loaded.errors.length ? resolveRef(cfg.refresh.request, 'Refresh') : null;
  runtimeCache = { ...loaded, errors, config: cfg, loginDef, refreshDef };
  return runtimeCache;
}

/** Variable names that can carry credentials: body, headers, query and auth (not the URL). */
function referencedVariables(def) {
  const texts = [JSON.stringify(def.headers || {}), JSON.stringify(def.query || []), JSON.stringify(def.body || {}), JSON.stringify(def.auth || {})];
  const names = new Set();
  for (const t of texts) for (const n of findVariableReferences(t)) if (!n.startsWith('__secret_') && !n.startsWith('$')) names.add(n);
  return [...names];
}

class AuthManager {
  /** @param {import('./api-fixture').ApiClient} client */
  constructor(client, { generatedDir, readState, writeState }) {
    this.client = client;
    this.rt = loadAuthRuntime(generatedDir);
    this.readState = readState;
    this.writeState = writeState;
    this.events = [];
    this.retried = false;
  }

  get config() {
    return this.rt.config;
  }

  /** Effective auth for a request plus its role (login / refresh / protected). */
  context(def) {
    const cfg = this.config;
    const isLogin = !!this.rt.loginDef && def.id === this.rt.loginDef.id;
    const isRefresh = !!this.rt.refreshDef && def.id === this.rt.refreshDef.id;
    let effective = def.auth && def.auth.type !== 'noauth' ? def.auth : null;
    if (!def.auth && cfg?.defaultAuth && !isLogin && !isRefresh) {
      effective = { ...cfg.defaultAuth, source: `${this.rt.path} (defaultAuth)` };
    }
    const tokenRef = cfg?.login?.tokenVariable ? `{{${cfg.login.tokenVariable}}}` : null;
    const usesToken = !!tokenRef && !!effective && Object.values(effective).some((v) => typeof v === 'string' && v.includes(tokenRef));
    return { effective, isLogin, isRefresh, usesToken };
  }

  authState() {
    return this.readState()[AUTH_STATE_KEY] || { loginCount: 0, refreshCount: 0 };
  }

  saveAuthState(patch) {
    const state = this.readState();
    state[AUTH_STATE_KEY] = { loginCount: 0, refreshCount: 0, ...(state[AUTH_STATE_KEY] || {}), ...patch };
    this.writeState(state);
  }

  /**
   * Runs before a protected request is built: validates the auth setup, logs in
   * on demand and refreshes an expiring token.
   */
  async ensureCredentials(def, ctx) {
    if (!ctx.effective) return;
    if (this.rt.present && this.rt.errors.length && !ctx.isLogin && !ctx.isRefresh) {
      this.client.fail('auth-config', `Authentication configuration ${this.rt.path} is invalid, so this protected request was not sent. ${this.rt.errors.join(' ')}`);
    }
    const cfg = this.config;
    if (!cfg?.login || !ctx.usesToken || ctx.isLogin || ctx.isRefresh) return;

    const current = this.client.resolver(def.folder).lookup(cfg.login.tokenVariable);
    const hasToken = current.found && String(current.value ?? '').trim() !== '';
    const auth = this.authState();
    if (!hasToken) {
      if (auth.login?.status === 'failed') {
        this.client.fail(auth.login.category, `No access token available, so this protected request was not sent. ${auth.login.message}`);
      }
      await this.login(`on demand for "${def.name}"`);
      return;
    }
    if (cfg.refresh?.enabled && auth.expiresAt && Date.now() >= auth.expiresAt - cfg.refresh.beforeExpirySeconds * 1000) {
      await this.refresh('token about to expire');
    }
  }

  /** Should a 401 on this request trigger refresh + one retry? */
  shouldRefreshOn401(def, ctx, status) {
    const r = this.config?.refresh;
    if (status !== 401 || !r?.enabled || !r.on401 || !ctx.usesToken || ctx.isLogin || ctx.isRefresh || this.retried) return false;
    if (this.client.isMutating(def) && !r.retryMutating) {
      this.events.push({ type: 'note', message: `401 received; the token was not refreshed because ${def.method} requests are not retried (refresh.retryMutating=false).` });
      return false;
    }
    this.retried = true;
    return true;
  }

  // ------------------------------------------------------------- login / refresh

  /** Performs the configured login request outside the current test (on demand). */
  async login(trigger) {
    const def = this.rt.loginDef;
    const label = describeRef(def);
    const response = await this.callAuthRequest(def, `Automatic login via "${label}"`);
    const outcome = this.applyLoginResponse(response, trigger);
    this.events.push({ type: 'login', trigger, request: label, status: response.status, durationMs: response.durationMs, outcome: outcome.ok ? 'token obtained' : 'failed' });
    if (!outcome.ok) this.client.fail(outcome.category, `${outcome.message} This protected request was not sent.`);
  }

  /** Refreshes the access token via the refresh request, or by logging in again. */
  async refresh(reason) {
    const cfg = this.config;
    const def = this.rt.refreshDef;
    if (!def) {
      this.saveAuthState({ refreshCount: this.authState().refreshCount + 1 });
      await this.login(`re-login to refresh token (${reason})`);
      return;
    }
    const label = describeRef(def);
    const rtVar = cfg.login.refreshTokenVariable;
    const current = this.client.resolver(def.folder).lookup(rtVar);
    if (!current.found || !String(current.value ?? '').trim()) {
      this.client.fail('auth-config', `Token refresh needs {{${rtVar}}}, but the login response did not contain a refresh token at "${cfg.login.refreshTokenPath}". Check login.refreshTokenPath in ${this.rt.path}.`);
    }
    const response = await this.callAuthRequest(def, `Token refresh via "${label}"`);
    const outcome = this.applyRefreshResponse(response);
    this.events.push({ type: 'refresh', trigger: reason, request: label, status: response.status, durationMs: response.durationMs, outcome: outcome.ok ? 'token refreshed' : 'failed' });
    if (!outcome.ok) this.client.fail(outcome.category, outcome.message);
  }

  async callAuthRequest(def, label) {
    let built;
    try {
      built = this.client.buildRequest(def, def.auth && def.auth.type !== 'noauth' ? def.auth : null);
    } catch (err) {
      this.client.fail('auth-config', `${label} could not be prepared: ${err.message}`);
    }
    const started = performance.now();
    try {
      const response = await this.client.fetchBuilt(def, built);
      const text = (await response.body().catch(() => Buffer.alloc(0))).toString('utf8');
      return { status: response.status(), statusText: response.statusText(), text, durationMs: Math.round(performance.now() - started) };
    } catch (err) {
      const message = `${label} failed: no response (${redact.redactString(String(err.message).split('\n')[0])}).`;
      this.saveAuthState({ login: { status: 'failed', category: 'auth-rejected', message } });
      this.client.fail(/timeout/i.test(err.message) ? 'timeout' : 'network', message);
    }
    return null;
  }

  credentialHint(def) {
    const vars = referencedVariables(def);
    return vars.length ? ` Check the values of ${vars.map((v) => `{{${v}}}`).join(', ')} (set via PM_VAR_<name>, e.g. PM_VAR_${vars[vars.length - 1]}).` : '';
  }

  /**
   * Shared by on-demand login and by the login request's own test.
   * @returns {{ok: boolean, category?: string, message?: string}}
   */
  applyLoginResponse(response, trigger) {
    const cfg = this.config.login;
    const def = this.rt.loginDef;
    const label = describeRef(def);
    const fail = (category, message) => {
      this.saveAuthState({ login: { status: 'failed', category, message, httpStatus: response.status } });
      return { ok: false, category, message };
    };
    if (response.status === 401 || response.status === 403) {
      return fail('auth-rejected', `Login request "${label}" was rejected with HTTP ${response.status}: the credentials are invalid or not authorized.${this.credentialHint(def)}`);
    }
    if (response.status < 200 || response.status >= 300) {
      return fail('auth-rejected', `Login request "${label}" failed with HTTP ${response.status} ${response.statusText || ''}`.trim() + '.');
    }
    let body;
    try {
      body = JSON.parse(response.text);
    } catch {
      return fail('auth-config', `Login request "${label}" returned HTTP ${response.status} but the body is not JSON, so no token could be read at "${cfg.tokenPath}".`);
    }
    const token = readPath(body, cfg.tokenSegments);
    if (typeof token !== 'string' || !token.trim()) {
      const fields = body && typeof body === 'object' ? Object.keys(body).slice(0, 10).join(', ') : typeof body;
      return fail('auth-config', `Login request "${label}" returned HTTP ${response.status} but no token was found at "${cfg.tokenPath}" (response fields: ${fields || 'none'}). Fix login.tokenPath in ${this.rt.path}.`);
    }
    redact.registerSecret(token);
    const patch = { login: { status: 'ok', httpStatus: response.status, trigger }, loginCount: this.authState().loginCount + 1, expiresAt: null };
    this.client.setVariable(cfg.tokenVariable, token, { secret: true });
    if (cfg.refreshTokenSegments) {
      const refreshToken = readPath(body, cfg.refreshTokenSegments);
      if (typeof refreshToken === 'string' && refreshToken) {
        redact.registerSecret(refreshToken);
        this.client.setVariable(cfg.refreshTokenVariable, refreshToken, { secret: true });
      }
    }
    if (cfg.expiresInSegments) {
      const seconds = Number(readPath(body, cfg.expiresInSegments));
      if (Number.isFinite(seconds) && seconds > 0) patch.expiresAt = Date.now() + seconds * 1000;
    }
    this.saveAuthState(patch);
    return { ok: true };
  }

  applyRefreshResponse(response) {
    const cfg = this.config;
    const label = describeRef(this.rt.refreshDef);
    const fail = (category, message) => ({ ok: false, category, message });
    if (response.status < 200 || response.status >= 300) {
      return fail('auth-rejected', `Token refresh via "${label}" was rejected with HTTP ${response.status}. The refresh token may be expired or invalid; check the refresh request and login.refreshTokenPath.`);
    }
    let body;
    try {
      body = JSON.parse(response.text);
    } catch {
      return fail('auth-config', `Token refresh via "${label}" returned a non-JSON body; no token at "${cfg.refresh.tokenPath}".`);
    }
    const token = readPath(body, cfg.refresh.tokenSegments);
    if (typeof token !== 'string' || !token.trim()) {
      return fail('auth-config', `Token refresh via "${label}" returned HTTP ${response.status} but no token was found at "${cfg.refresh.tokenPath}". Fix refresh.tokenPath in ${this.rt.path}.`);
    }
    redact.registerSecret(token);
    this.client.setVariable(cfg.login.tokenVariable, token, { secret: true });
    if (cfg.login.refreshTokenSegments) {
      const next = readPath(body, cfg.login.refreshTokenSegments);
      if (typeof next === 'string' && next) {
        redact.registerSecret(next);
        this.client.setVariable(cfg.login.refreshTokenVariable, next, { secret: true });
      }
    }
    const patch = { refreshCount: this.authState().refreshCount + 1 };
    if (cfg.login.expiresInSegments) {
      const seconds = Number(readPath(body, cfg.login.expiresInSegments));
      if (Number.isFinite(seconds) && seconds > 0) patch.expiresAt = Date.now() + seconds * 1000;
    }
    this.saveAuthState(patch);
    return { ok: true };
  }

  /** Builds a clear error for a missing or empty credential value. */
  missingCredential(label, missing, auth) {
    const cfg = this.config;
    const where = auth.source ? ` (auth defined at ${auth.source})` : '';
    const names = missing.map((n) => `{{${n}}}`).join(', ');
    let hint = ` Provide it via ${missing.map((n) => `PM_VAR_${n}`).join(' / ')} (environment variable) or a Postman environment file.`;
    if (/token/i.test(label) && !cfg?.login) {
      hint += ` If a login API issues this token, configure automatic login in ${this.rt.path} (see auth.config.example.json) with login.tokenVariable = "${missing[0]}".`;
    }
    return `${label} needs ${names}, which is not defined${where}.${hint} The request was not sent.`;
  }

  toReport(ctx) {
    return {
      type: ctx?.effective ? ctx.effective.type : 'none',
      source: ctx?.effective ? ctx.effective.source || null : null,
      role: ctx?.isLogin ? 'login' : ctx?.isRefresh ? 'refresh' : ctx?.effective ? 'protected' : 'public',
      events: this.events,
    };
  }
}

module.exports = { AuthManager, loadAuthRuntime, AUTH_STATE_KEY };
