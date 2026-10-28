'use strict';
/**
 * Postman Collection (v2.0 / v2.1) parser.
 *
 * Turns an exported collection into a normalized, API-agnostic model:
 *   { info, variables, auth, folders[], requests[], warnings[] }
 * The parser never executes scripts; it only reads their source text so the
 * assertion converter can pattern-match it later.
 */
const { findVariableReferences } = require('./variable-resolver');

const SUPPORTED_AUTH = new Set(['noauth', 'bearer', 'basic', 'apikey']);
const SUPPORTED_BODY_MODES = new Set(['raw', 'urlencoded', 'formdata', 'graphql']);
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

class CollectionValidationError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'CollectionValidationError';
    this.details = details;
  }
}

/** Parses JSON text and turns syntax errors into a readable message with line/column. */
function parseJsonText(text, label = 'File') {
  if (typeof text !== 'string' || !text.trim()) throw new CollectionValidationError(`${label} is empty.`);
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (err) {
    const pos = /position (\d+)/.exec(err.message);
    let where = '';
    if (pos) {
      const before = text.slice(0, Number(pos[1]));
      const line = before.split('\n').length;
      const column = Number(pos[1]) - before.lastIndexOf('\n');
      where = ` (line ${line}, column ${column})`;
    }
    throw new CollectionValidationError(`${label} is not valid JSON${where}: ${err.message}`);
  }
}

function detectSchemaVersion(info) {
  const schema = String(info?.schema || '');
  if (schema.includes('v2.1')) return '2.1';
  if (schema.includes('v2.0')) return '2.0';
  return 'unknown';
}

/** Throws CollectionValidationError if the object is not a usable Postman collection. */
function validateCollection(collection) {
  const problems = [];
  if (!collection || typeof collection !== 'object' || Array.isArray(collection)) {
    throw new CollectionValidationError('Not a Postman collection: the top-level JSON value must be an object.');
  }
  if (Array.isArray(collection.requests) && !collection.item) {
    throw new CollectionValidationError(
      'This looks like a Postman Collection v1 export, which is not supported. Re-export it from Postman as "Collection v2.1".',
    );
  }
  if (collection.info === undefined && collection.values && collection.name) {
    throw new CollectionValidationError('This looks like a Postman environment file, not a collection. Upload it in the "Environment" field instead.');
  }
  if (!collection.info || typeof collection.info !== 'object') problems.push('missing "info" object');
  if (!Array.isArray(collection.item)) problems.push('missing "item" array');
  if (problems.length) {
    throw new CollectionValidationError(`Not a Postman collection: ${problems.join(', ')}.`, problems);
  }
}

function scriptText(exec) {
  if (Array.isArray(exec)) return exec.join('\n');
  return typeof exec === 'string' ? exec : '';
}

/** Extracts {prerequest, test} script source from an item/folder/collection "event" array. */
function readEvents(events) {
  const out = { prerequest: '', test: '' };
  if (!Array.isArray(events)) return out;
  for (const ev of events) {
    if (!ev || ev.disabled === true || !ev.script) continue;
    const code = scriptText(ev.script.exec).trim();
    if (!code) continue;
    if (ev.listen === 'prerequest' || ev.listen === 'test') {
      out[ev.listen] = out[ev.listen] ? `${out[ev.listen]}\n${code}` : code;
    }
  }
  return out;
}

/** Normalizes v2.0 ({token: 'x'}) and v2.1 ([{key:'token', value:'x'}]) auth params. */
function normalizeAuth(auth) {
  if (auth === undefined) return undefined; // inherit from parent
  if (auth === null) return undefined;
  const type = auth.type || 'noauth';
  if (type === 'inherit') return undefined;
  const params = {};
  const raw = auth[type];
  if (Array.isArray(raw)) {
    for (const p of raw) if (p && typeof p.key === 'string') params[p.key] = p.value;
  } else if (raw && typeof raw === 'object') {
    Object.assign(params, raw);
  }
  return { type, params };
}

function normalizeKeyValues(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((h) => h && typeof h.key === 'string' && h.key !== '')
    .map((h) => ({
      key: h.key,
      value: h.value === undefined || h.value === null ? '' : String(h.value),
      disabled: h.disabled === true,
      ...(h.type ? { type: h.type } : {}),
      ...(h.src !== undefined ? { src: h.src } : {}),
    }));
}

/** v2.0 header strings look like "Key: value\nKey2: value2". */
function normalizeHeaders(header) {
  if (typeof header === 'string') {
    return header
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const idx = line.indexOf(':');
        return { key: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim(), disabled: false };
      })
      .filter((h) => h.key);
  }
  return normalizeKeyValues(header);
}

function parseQueryString(qs) {
  if (!qs) return [];
  return qs.split('&').filter(Boolean).map((pair) => {
    const idx = pair.indexOf('=');
    const key = idx === -1 ? pair : pair.slice(0, idx);
    const value = idx === -1 ? '' : pair.slice(idx + 1);
    return { key, value, disabled: false };
  });
}

/**
 * Normalizes the URL into { base, query[] } where base has no query string and
 * Postman path variables (:id) are substituted from url.variable.
 */
function normalizeUrl(url) {
  if (url === undefined || url === null) return { base: '', query: [], raw: '' };
  if (typeof url === 'string') {
    const [base, ...rest] = url.split('?');
    return { base, query: parseQueryString(rest.join('?')), raw: url };
  }
  let raw = typeof url.raw === 'string' ? url.raw : '';
  if (!raw) {
    const host = Array.isArray(url.host) ? url.host.join('.') : url.host || '';
    const p = Array.isArray(url.path) ? url.path.join('/') : url.path || '';
    raw = `${url.protocol ? `${url.protocol}://` : ''}${host}${url.port ? `:${url.port}` : ''}${p ? `/${p}` : ''}`;
  }
  const hashless = raw.split('#')[0];
  const qIndex = hashless.indexOf('?');
  let base = qIndex === -1 ? hashless : hashless.slice(0, qIndex);
  const query = Array.isArray(url.query) ? normalizeKeyValues(url.query) : parseQueryString(qIndex === -1 ? '' : hashless.slice(qIndex + 1));

  for (const v of Array.isArray(url.variable) ? url.variable : []) {
    if (!v || !v.key) continue;
    const value = v.value === undefined || v.value === null ? '' : String(v.value);
    base = base.replace(new RegExp(`/:${v.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=/|$)`, 'g'), `/${value}`);
  }
  return { base, query, raw };
}

function normalizeBody(body, warn) {
  if (!body || body.disabled === true || !body.mode) return null;
  const mode = body.mode;
  if (!SUPPORTED_BODY_MODES.has(mode)) {
    warn(`Body mode "${mode}" is not supported; the request is generated as a skipped test.`);
    return { mode, unsupported: true };
  }
  if (mode === 'raw') {
    return { mode, raw: typeof body.raw === 'string' ? body.raw : '', language: body.options?.raw?.language || 'text' };
  }
  if (mode === 'urlencoded') return { mode, fields: normalizeKeyValues(body.urlencoded) };
  if (mode === 'formdata') return { mode, fields: normalizeKeyValues(body.formdata) };
  if (mode === 'graphql') return { mode, query: body.graphql?.query || '', variables: body.graphql?.variables || '' };
  return null;
}

function slugify(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'item';
}

/**
 * Parses a collection object (or JSON text) into the normalized model.
 * @param {object|string} input
 * @param {{environment?: object|string}} options
 */
function parseCollection(input, options = {}) {
  const collection = typeof input === 'string' ? parseJsonText(input, 'Collection file') : input;
  validateCollection(collection);

  const warnings = [];
  const addWarning = (scope, message, level = 'warning') => warnings.push({ level, scope, message });

  const info = {
    name: String(collection.info.name || 'Untitled collection'),
    description: typeof collection.info.description === 'string' ? collection.info.description : '',
    schemaVersion: detectSchemaVersion(collection.info),
    postmanId: collection.info._postman_id || '',
  };
  if (info.schemaVersion === 'unknown') {
    addWarning('collection', 'Collection schema version not recognised; parsing it as v2.1.');
  }

  const environment = options.environment ? parseEnvironment(options.environment) : null;

  const collectionAuth = normalizeAuth(collection.auth);
  const collectionEvents = readEvents(collection.event);
  if (collectionAuth && !SUPPORTED_AUTH.has(collectionAuth.type)) {
    addWarning('collection', `Collection auth type "${collectionAuth.type}" is not supported (supported: bearer, basic, apikey, noauth).`);
  }

  const folders = [];
  const requests = [];
  const usedVariables = new Set();

  function visit(items, ctx) {
    items.forEach((item, idx) => {
      if (!item || typeof item !== 'object') return;
      const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : `Unnamed item ${idx + 1}`;

      if (Array.isArray(item.item)) {
        const folderPath = [...ctx.folderPath, name];
        const folderAuth = normalizeAuth(item.auth);
        const folder = {
          path: folderPath,
          name,
          description: typeof item.description === 'string' ? item.description : '',
          variables: item.variable || [],
          auth: folderAuth || null,
          requestCount: 0,
        };
        folders.push(folder);
        if (folderAuth && !SUPPORTED_AUTH.has(folderAuth.type)) {
          addWarning(folderPath.join(' / '), `Folder auth type "${folderAuth.type}" is not supported.`);
        }
        const events = readEvents(item.event);
        visit(item.item, {
          folderPath,
          folderChain: [...ctx.folderChain, folder],
          auth: folderAuth !== undefined ? { auth: folderAuth, source: `folder: ${folderPath.join(' / ')}` } : ctx.auth,
          scripts: {
            prerequest: [...ctx.scripts.prerequest, ...(events.prerequest ? [{ source: `folder: ${folderPath.join(' / ')}`, code: events.prerequest }] : [])],
            test: [...ctx.scripts.test, ...(events.test ? [{ source: `folder: ${folderPath.join(' / ')}`, code: events.test }] : [])],
          },
        });
        return;
      }

      if (!item.request) {
        addWarning([...ctx.folderPath, name].join(' / '), 'Item has neither a request nor child items; ignored.');
        return;
      }

      const scope = [...ctx.folderPath, name].join(' / ');
      const reqWarnings = [];
      const warn = (message) => {
        reqWarnings.push(message);
        addWarning(scope, message);
      };

      // v2.0 allows "request": "https://url" as a plain string.
      const req = typeof item.request === 'string' ? { method: 'GET', url: item.request } : item.request;
      let method = String(req.method || 'GET').toUpperCase();
      if (!HTTP_METHODS.has(method)) warn(`HTTP method "${method}" is unusual; it is sent as-is.`);

      const url = normalizeUrl(req.url);
      if (!url.base) warn('Request has no URL.');

      const requestAuth = normalizeAuth(req.auth);
      const effective = requestAuth !== undefined ? { auth: requestAuth, source: 'request' } : ctx.auth;
      const auth = effective ? effective.auth : null;
      if (requestAuth && !SUPPORTED_AUTH.has(requestAuth.type)) warn(`Auth type "${requestAuth.type}" is not supported.`);

      const events = readEvents(item.event);
      const scripts = {
        prerequest: [...ctx.scripts.prerequest, ...(events.prerequest ? [{ source: 'request', code: events.prerequest }] : [])],
        test: [...ctx.scripts.test, ...(events.test ? [{ source: 'request', code: events.test }] : [])],
      };

      const headers = normalizeHeaders(req.header);
      const disabledHeaders = headers.filter((h) => h.disabled).length;
      const body = normalizeBody(req.body, warn);
      const exampleStatuses = Array.isArray(item.response)
        ? [...new Set(item.response.map((r) => Number(r?.code)).filter((c) => Number.isInteger(c) && c >= 100 && c < 600))]
        : [];

      const record = {
        id: `r${requests.length + 1}`,
        index: requests.length + 1,
        name,
        folderPath: ctx.folderPath,
        folder: ctx.folderPath.join(' / ') || '(root)',
        description: typeof req.description === 'string' ? req.description : '',
        method,
        url: url.base,
        rawUrl: url.raw || url.base,
        query: url.query,
        headers,
        body,
        auth: auth && auth.type !== 'noauth' ? auth : null,
        authSource: effective ? effective.source : 'none',
        scripts,
        exampleStatuses,
        disabled: item.disabled === true,
        folderVariables: ctx.folderChain.map((f) => f.variables).filter((v) => v && v.length),
        warnings: reqWarnings,
        stats: { disabledHeaders, disabledQuery: url.query.filter((q) => q.disabled).length },
      };
      if (record.disabled) warn('Request is marked disabled; it is generated as a skipped test.');

      for (const text of [record.url, ...record.query.map((q) => q.value), ...headers.map((h) => h.value), body?.raw || '']) {
        for (const v of findVariableReferences(text)) usedVariables.add(v);
      }
      for (const v of Object.values(auth?.params || {})) for (const n of findVariableReferences(String(v))) usedVariables.add(n);

      requests.push(record);
      for (const f of ctx.folderChain) f.requestCount += 1;
    });
  }

  visit(collection.item, {
    folderPath: [],
    folderChain: [],
    auth: collectionAuth !== undefined ? { auth: collectionAuth, source: 'collection' } : null,
    scripts: {
      prerequest: collectionEvents.prerequest ? [{ source: 'collection', code: collectionEvents.prerequest }] : [],
      test: collectionEvents.test ? [{ source: 'collection', code: collectionEvents.test }] : [],
    },
  });

  if (requests.length === 0) addWarning('collection', 'The collection contains no requests.');

  const collectionVariables = Array.isArray(collection.variable) ? collection.variable : [];
  const declared = new Set([
    ...collectionVariables.map((v) => v?.key),
    ...(environment ? environment.values.map((v) => v.key) : []),
    ...folders.flatMap((f) => (Array.isArray(f.variables) ? f.variables.map((v) => v?.key) : [])),
  ]);
  const undeclared = [...usedVariables].filter((v) => !declared.has(v) && !v.startsWith('$'));
  const unused = collectionVariables.map((v) => v?.key).filter((k) => k && !usedVariables.has(k));
  if (unused.length) {
    addWarning('collection', `Collection variable(s) declared but never referenced in requests: ${unused.join(', ')}. Requests use hardcoded URLs; use TARGET_BASE_URL to point them at another host.`, 'info');
  }
  if (undeclared.length) {
    addWarning('collection', `Variable(s) used but not declared in the collection or environment: ${undeclared.join(', ')}. Provide them via an environment file, PM_VAR_<name>, or a script extraction.`, 'info');
  }

  if (Array.isArray(collection.protocolProfileBehavior) || collection.protocolProfileBehavior) {
    addWarning('collection', 'protocolProfileBehavior settings are ignored.', 'info');
  }

  return {
    info,
    variables: collectionVariables,
    environment,
    auth: collectionAuth || null,
    folders,
    requests,
    warnings,
    variableReport: {
      used: [...usedVariables].sort(),
      undeclared: undeclared.sort(),
    },
  };
}

/** Parses a Postman environment export ({name, values:[{key,value,enabled}]}). */
function parseEnvironment(input) {
  const env = typeof input === 'string' ? parseJsonText(input, 'Environment file') : input;
  if (!env || typeof env !== 'object' || !Array.isArray(env.values)) {
    throw new CollectionValidationError('Not a Postman environment: expected an object with a "values" array.');
  }
  return {
    name: String(env.name || 'Environment'),
    values: env.values
      .filter((v) => v && typeof v.key === 'string' && v.enabled !== false)
      .map((v) => ({ key: v.key, value: v.value === undefined || v.value === null ? '' : v.value })),
  };
}

/** Compact summary used by the CLI and dashboard. */
function summarize(parsed) {
  const methods = {};
  const groups = new Map();
  for (const r of parsed.requests) {
    methods[r.method] = (methods[r.method] || 0) + 1;
    if (!groups.has(r.folder)) groups.set(r.folder, []);
    groups.get(r.folder).push({ id: r.id, name: r.name, method: r.method, url: r.rawUrl, disabled: r.disabled });
  }
  return {
    name: parsed.info.name,
    schemaVersion: parsed.info.schemaVersion,
    requestCount: parsed.requests.length,
    folderCount: groups.size,
    methods,
    groups: [...groups.entries()].map(([folder, requests]) => ({ folder, count: requests.length, requests })),
    scripts: {
      prerequest: parsed.requests.filter((r) => r.scripts.prerequest.length).length,
      test: parsed.requests.filter((r) => r.scripts.test.length).length,
    },
    auth: [...new Set(parsed.requests.map((r) => r.auth?.type || 'none'))],
    variables: parsed.variableReport,
    environment: parsed.environment ? parsed.environment.name : null,
    warnings: parsed.warnings,
  };
}

module.exports = {
  parseCollection,
  parseEnvironment,
  parseJsonText,
  validateCollection,
  summarize,
  slugify,
  normalizeAuth,
  normalizeUrl,
  CollectionValidationError,
  SUPPORTED_AUTH,
};
