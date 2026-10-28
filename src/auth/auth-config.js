'use strict';
/**
 * Automatic authentication configuration (auth.config.json).
 *
 * The file describes HOW to authenticate, never the credentials themselves:
 * credentials stay in collection/environment variables or PM_VAR_<name>.
 *
 * {
 *   "login": {
 *     "request": "Auth / Login",          // request name, or "Folder / Name" when names repeat
 *     "tokenPath": "data.accessToken",     // JSON path of the access token in the login response
 *     "tokenVariable": "accessToken",      // variable used by protected requests, e.g. {{accessToken}}
 *     "refreshTokenPath": "data.refreshToken",   // optional
 *     "refreshTokenVariable": "refreshToken",    // optional (required with refreshTokenPath)
 *     "expiresInPath": "data.expiresIn"          // optional, seconds
 *   },
 *   "refresh": {                           // optional; token refresh only happens when enabled
 *     "enabled": true,
 *     "request": "Auth / Refresh Token",   // optional; without it the login request is repeated
 *     "tokenPath": "data.accessToken",     // optional, defaults to login.tokenPath
 *     "on401": true,                       // refresh + retry once when a protected request gets 401
 *     "beforeExpirySeconds": 30,           // refresh proactively when expiresInPath is known
 *     "retryMutating": false               // never re-send POST/PUT/PATCH/DELETE unless true
 *   },
 *   "defaultAuth": { "type": "bearer", "token": "{{accessToken}}" }   // optional: for requests with no auth anywhere
 * }
 */
const fs = require('node:fs');
const path = require('node:path');
const { ROOT_DIR } = require('../config');
const { isSensitiveKey } = require('../utils/redact');

const SUPPORTED_DEFAULT_AUTH = new Set(['bearer', 'basic', 'apikey']);
const VARIABLE_NAME = /^[A-Za-z_][\w.-]{0,99}$/;
const PURE_VARIABLES = /^(\s*(Bearer|Basic|Token)\s*)?(\s*\{\{[^{}]+\}\}\s*)+$/i;

function configPath(env = process.env) {
  return path.resolve(ROOT_DIR, env.AUTH_CONFIG || 'auth.config.json');
}

/** "data.items[0].token" -> ['data', 'items', 0, 'token']; null if invalid. */
function parseJsonPath(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const segments = [];
  for (const part of text.trim().replace(/^\$\.?/, '').split('.')) {
    const m = /^([^[\]]*)((?:\[\d+\])*)$/.exec(part);
    if (!m) return null;
    if (m[1]) segments.push(m[1]);
    for (const idx of m[2].match(/\d+/g) || []) segments.push(Number(idx));
    if (!m[1] && !m[2]) return null;
  }
  return segments.length ? segments : null;
}

function readPath(value, segments) {
  let current = value;
  for (const seg of segments) {
    if (current === null || current === undefined) return undefined;
    if (['__proto__', 'prototype', 'constructor'].includes(String(seg))) return undefined;
    current = current[seg];
  }
  return current;
}

/** Finds credentials accidentally written into the config file. */
function findLiteralCredentials(value, prefix = '') {
  const found = [];
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const where = prefix ? `${prefix}.${k}` : k;
      if (typeof v === 'string' && isSensitiveKey(k) && v.trim() && !PURE_VARIABLES.test(v)) found.push(where);
      else found.push(...findLiteralCredentials(v, where));
    }
  }
  return found;
}

function validateAuthObject(auth, where, errors) {
  if (!auth || typeof auth !== 'object') {
    errors.push(`${where} must be an object like {"type": "bearer", "token": "{{accessToken}}"}.`);
    return;
  }
  if (!SUPPORTED_DEFAULT_AUTH.has(auth.type)) {
    errors.push(`${where}.type must be one of: ${[...SUPPORTED_DEFAULT_AUTH].join(', ')}.`);
    return;
  }
  const required = { bearer: ['token'], basic: ['username', 'password'], apikey: ['key', 'value'] }[auth.type];
  for (const field of required) {
    if (typeof auth[field] !== 'string' || !auth[field].trim()) errors.push(`${where}.${field} is required (use a variable such as "{{${field === 'token' ? 'accessToken' : field}}}").`);
  }
}

/** Validates the raw JSON structure. Returns {config, errors}. */
function validateAuthConfig(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { config: null, errors: ['The auth configuration must be a JSON object.'] };
  }
  for (const key of Object.keys(raw)) {
    if (!['login', 'refresh', 'defaultAuth', '$schema', 'description'].includes(key)) errors.push(`Unknown top-level setting "${key}" (allowed: login, refresh, defaultAuth).`);
  }
  for (const where of findLiteralCredentials(raw)) {
    errors.push(`"${where}" contains a literal credential. The auth config must not contain secrets: store the value in an environment variable (PM_VAR_<name>) and reference it as {{name}}.`);
  }

  const config = { login: null, refresh: null, defaultAuth: null };
  if (raw.login !== undefined) {
    const l = raw.login;
    if (!l || typeof l !== 'object') {
      errors.push('"login" must be an object.');
    } else {
      if (typeof l.request !== 'string' || !l.request.trim()) errors.push('login.request is required: the name of the login request in the collection (e.g. "Auth / Login").');
      const tokenPath = parseJsonPath(l.tokenPath);
      if (!tokenPath) errors.push('login.tokenPath is required: the JSON path of the access token in the login response (e.g. "data.accessToken").');
      if (typeof l.tokenVariable !== 'string' || !VARIABLE_NAME.test(l.tokenVariable)) {
        errors.push('login.tokenVariable is required: the variable protected requests use, e.g. "accessToken" for {{accessToken}}.');
      }
      const refreshTokenPath = l.refreshTokenPath === undefined ? null : parseJsonPath(l.refreshTokenPath);
      if (l.refreshTokenPath !== undefined && !refreshTokenPath) errors.push('login.refreshTokenPath is not a valid JSON path.');
      if ((l.refreshTokenPath === undefined) !== (l.refreshTokenVariable === undefined)) {
        errors.push('login.refreshTokenPath and login.refreshTokenVariable must be configured together.');
      }
      if (l.refreshTokenVariable !== undefined && (typeof l.refreshTokenVariable !== 'string' || !VARIABLE_NAME.test(l.refreshTokenVariable))) {
        errors.push('login.refreshTokenVariable must be a variable name such as "refreshToken".');
      }
      const expiresInPath = l.expiresInPath === undefined ? null : parseJsonPath(l.expiresInPath);
      if (l.expiresInPath !== undefined && !expiresInPath) errors.push('login.expiresInPath is not a valid JSON path.');
      config.login = {
        request: String(l.request || '').trim(),
        tokenPath: l.tokenPath,
        tokenSegments: tokenPath,
        tokenVariable: l.tokenVariable,
        refreshTokenPath: l.refreshTokenPath || null,
        refreshTokenSegments: refreshTokenPath,
        refreshTokenVariable: l.refreshTokenVariable || null,
        expiresInPath: l.expiresInPath || null,
        expiresInSegments: expiresInPath,
      };
    }
  }

  if (raw.refresh !== undefined) {
    const r = raw.refresh;
    if (!r || typeof r !== 'object') {
      errors.push('"refresh" must be an object.');
    } else if (r.enabled === true) {
      if (!config.login) errors.push('refresh.enabled requires a "login" section (the token being refreshed comes from login).');
      const tokenPath = r.tokenPath === undefined ? config.login?.tokenSegments : parseJsonPath(r.tokenPath);
      if (r.tokenPath !== undefined && !tokenPath) errors.push('refresh.tokenPath is not a valid JSON path.');
      if (r.request !== undefined && (typeof r.request !== 'string' || !r.request.trim())) errors.push('refresh.request must be the name of the refresh request.');
      if (r.request && !config.login?.refreshTokenVariable) {
        errors.push('refresh.request needs login.refreshTokenPath and login.refreshTokenVariable so the refresh token can be sent.');
      }
      const before = r.beforeExpirySeconds === undefined ? 30 : Number(r.beforeExpirySeconds);
      if (!Number.isFinite(before) || before < 0) errors.push('refresh.beforeExpirySeconds must be a number >= 0.');
      config.refresh = {
        enabled: true,
        request: r.request ? String(r.request).trim() : null,
        tokenPath: r.tokenPath || config.login?.tokenPath || null,
        tokenSegments: tokenPath || null,
        on401: r.on401 !== false,
        beforeExpirySeconds: Number.isFinite(before) ? before : 30,
        retryMutating: r.retryMutating === true,
      };
    } else if (r.enabled !== undefined && r.enabled !== false) {
      errors.push('refresh.enabled must be true or false.');
    }
  }

  if (raw.defaultAuth !== undefined) {
    validateAuthObject(raw.defaultAuth, 'defaultAuth', errors);
    config.defaultAuth = { ...raw.defaultAuth };
  }
  return { config, errors };
}

/**
 * Loads and validates the auth config file. A missing file simply means
 * "no automatic authentication"; an invalid file produces errors.
 */
function loadAuthConfig({ env = process.env, file } = {}) {
  const p = file || configPath(env);
  const rel = path.relative(ROOT_DIR, p) || p;
  if (!fs.existsSync(p)) return { present: false, path: rel, config: null, errors: [] };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
  } catch (err) {
    return { present: true, path: rel, config: null, errors: [`${rel} is not valid JSON: ${err.message}`] };
  }
  const { config, errors } = validateAuthConfig(raw);
  return { present: true, path: rel, config, errors };
}

/** Matches a request by name or by "Folder / Name" – never by position. */
function findRequests(requests, ref) {
  const wanted = String(ref || '').trim();
  return requests.filter((r) => r.name === wanted || `${r.folder} / ${r.name}` === wanted);
}

function describeRef(r) {
  return r.folder && r.folder !== '(root)' ? `${r.folder} / ${r.name}` : r.name;
}

/**
 * Cross-checks the config against a parsed collection (requests exist, are
 * unambiguous and the token variable is actually used).
 */
function checkAgainstCollection(loaded, parsed) {
  const result = { errors: [...(loaded?.errors || [])], warnings: [], info: [], loginRequestId: null, refreshRequestId: null };
  const cfg = loaded?.config;
  if (!loaded?.present || !cfg) return result;
  const requests = parsed.requests;

  const resolveRef = (ref, label) => {
    const matches = findRequests(requests, ref);
    if (matches.length === 1) return matches[0];
    if (matches.length === 0) {
      const candidates = requests.filter((r) => r.method === 'POST').slice(0, 8).map(describeRef);
      result.errors.push(`${label} request "${ref}" was not found in the collection.${candidates.length ? ` POST requests available: ${candidates.join(', ')}.` : ''}`);
    } else {
      result.errors.push(`${label} request "${ref}" is ambiguous (${matches.length} matches). Use "Folder / Name": ${matches.map(describeRef).join(', ')}.`);
    }
    return null;
  };

  if (cfg.login?.request) {
    const login = resolveRef(cfg.login.request, 'Login');
    if (login) {
      result.loginRequestId = login.id;
      result.info.push(`Automatic login: "${describeRef(login)}" → token at "${cfg.login.tokenPath}" → {{${cfg.login.tokenVariable}}}.`);
    }
  }
  if (cfg.refresh?.enabled && cfg.refresh.request) {
    const refresh = resolveRef(cfg.refresh.request, 'Refresh');
    if (refresh) result.refreshRequestId = refresh.id;
  }
  if (cfg.refresh?.enabled) {
    result.info.push(`Token refresh enabled (${cfg.refresh.request ? `via "${cfg.refresh.request}"` : 'by repeating the login'}${cfg.refresh.on401 ? ', retry once on 401' : ''}).`);
  }

  if (cfg.login?.tokenVariable) {
    const needle = `{{${cfg.login.tokenVariable}}}`;
    const usedByRequests = requests.some((r) => Object.values(r.auth?.params || {}).some((v) => String(v).includes(needle)) || r.headers.some((h) => h.value.includes(needle)));
    const usedByDefault = Object.values(cfg.defaultAuth || {}).some((v) => String(v).includes(needle));
    if (!usedByRequests && !usedByDefault) {
      result.warnings.push(`Token variable ${needle} is not used by any request. Reference it in the collection's auth (e.g. Bearer ${needle}) or set "defaultAuth": {"type": "bearer", "token": "${needle}"} in ${loaded.path}.`);
    }
  }
  return result;
}

module.exports = {
  configPath,
  loadAuthConfig,
  validateAuthConfig,
  checkAgainstCollection,
  findRequests,
  describeRef,
  parseJsonPath,
  readPath,
};
