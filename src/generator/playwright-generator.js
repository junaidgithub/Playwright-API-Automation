'use strict';
/**
 * Generates readable Playwright Test spec files from the normalized collection model.
 *
 * Output (in the generated-tests directory):
 *   NN-<folder>.spec.js         one file per top-level folder, tests in collection order
 *   collection-meta.json         request inventory, conversion report, warnings
 *   collection-variables.json    collection / environment / folder variables
 *   .secrets.json                literal secrets moved out of the generated code (git-ignored)
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { slugify, SUPPORTED_AUTH } = require('../parser/collection-parser');
const { toVariableMap, findVariableReferences } = require('../parser/variable-resolver');
const { convertTestScripts, convertPrerequestScripts, describeAssertion } = require('./assertion-converter');
const { isSensitiveKey, redactUrl } = require('../utils/redact');
const { checkAgainstCollection } = require('../auth/auth-config');

const GENERATED_FILE_PATTERN = /^(\d{2}-.+\.spec\.js|collection-meta\.json|collection-variables\.json|request-defs\.json|\.secrets\.json|\.runtime-state\.json)$/;

// ---------------------------------------------------------------------------
// JS emission helpers (all untrusted text goes through JSON.stringify)
// ---------------------------------------------------------------------------

function str(value) {
  return JSON.stringify(String(value));
}

// Line terminators (CR, LF, U+2028, U+2029) must never reach a // comment in generated code.
const LINE_BREAKS = new RegExp(`[${['\r', '\n', String.fromCharCode(0x2028), String.fromCharCode(0x2029)].join('')}]+`, 'g');

function comment(text) {
  return String(text).replace(LINE_BREAKS, ' ').slice(0, 240);
}

function isIdentifier(key) {
  return /^[A-Za-z_$][\w$]*$/.test(key) && key !== '__proto__';
}

/** Pretty-prints a JSON-compatible value as a JS literal. */
function toJs(value, indent = '') {
  const next = `${indent}  `;
  if (value === undefined) return 'undefined';
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const simple = value.every((v) => v === null || ['string', 'number', 'boolean'].includes(typeof v));
    const inline = `[${value.map((v) => toJs(v)).join(', ')}]`;
    if (simple && inline.length <= 80) return inline;
    return `[\n${value.map((v) => `${next}${toJs(v, next)}`).join(',\n')},\n${indent}]`;
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return '{}';
  const key = (k) => (isIdentifier(k) ? k : k === '__proto__' ? '["__proto__"]' : JSON.stringify(k));
  const flat = entries.every(([, v]) => v === null || ['string', 'number', 'boolean'].includes(typeof v));
  const inline = `{ ${entries.map(([k, v]) => `${key(k)}: ${toJs(v)}`).join(', ')} }`;
  if (flat && entries.length <= 3 && inline.length <= 100) return inline;
  return `{\n${entries.map(([k, v]) => `${next}${key(k)}: ${toJs(v, next)}`).join(',\n')},\n${indent}}`;
}

// ---------------------------------------------------------------------------
// Secret handling: literal credentials never appear in generated code
// ---------------------------------------------------------------------------

class SecretStore {
  constructor() {
    this.values = {};
    this.byValue = new Map();
  }

  /** Returns "{{__secret_N}}" for literal values; variable references are kept as-is. */
  protect(value) {
    if (typeof value !== 'string' || value === '') return value;
    // An auth scheme word plus variables ("Bearer {{token}}") contains no literal secret.
    const literalPart = value.replace(/\{\{[^{}]+\}\}/g, '').replace(/^\s*(Bearer|Basic|Digest|Token)\b/i, '').trim();
    if (!literalPart) return value; // pure variable reference, e.g. "{{token}}" or "Bearer {{token}}"
    if (this.byValue.has(value)) return this.byValue.get(value);
    const name = `__secret_${Object.keys(this.values).length + 1}`;
    this.values[name] = value;
    const placeholder = `{{${name}}}`;
    this.byValue.set(value, placeholder);
    return placeholder;
  }
}

function protectDeep(value, secrets, keyName) {
  if (typeof value === 'string') return keyName && isSensitiveKey(keyName) ? secrets.protect(value) : value;
  if (Array.isArray(value)) return value.map((v) => protectDeep(v, secrets, keyName));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = protectDeep(v, secrets, k);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Request definition building
// ---------------------------------------------------------------------------

const RAW_CONTENT_TYPES = { json: 'application/json', xml: 'application/xml', html: 'text/html', javascript: 'application/javascript', text: 'text/plain' };

function buildBody(body, headers, secrets, notes) {
  if (!body || body.unsupported) return undefined;
  if (body.mode === 'raw') {
    const ct = Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1] || '';
    const looksJson = body.language === 'json' || /json/i.test(ct);
    if (looksJson && body.raw.trim()) {
      try {
        return { mode: 'json', json: protectDeep(JSON.parse(body.raw), secrets) };
      } catch {
        notes.push('Raw JSON body is not strict JSON (e.g. unquoted {{variables}}); it is sent as text after variable substitution.');
      }
    }
    return body.raw === '' ? undefined : { mode: 'raw', raw: body.raw, contentType: RAW_CONTENT_TYPES[body.language] || (looksJson ? 'application/json' : 'text/plain') };
  }
  if (body.mode === 'urlencoded') {
    return { mode: 'urlencoded', fields: body.fields.filter((f) => !f.disabled).map((f) => [f.key, isSensitiveKey(f.key) ? secrets.protect(f.value) : f.value]) };
  }
  if (body.mode === 'formdata') {
    const active = body.fields.filter((f) => !f.disabled);
    const files = active.filter((f) => f.type === 'file').map((f) => ({ key: f.key, src: Array.isArray(f.src) ? f.src[0] : f.src || '' }));
    if (files.length) notes.push(`Form-data file field(s) ${files.map((f) => f.key).join(', ')} read the file from FILES_DIR.`);
    return { mode: 'formdata', fields: active.filter((f) => f.type !== 'file').map((f) => [f.key, isSensitiveKey(f.key) ? secrets.protect(f.value) : f.value]), ...(files.length ? { files } : {}) };
  }
  if (body.mode === 'graphql') {
    let variables = body.variables;
    if (typeof variables === 'string' && variables.trim()) {
      try {
        variables = JSON.parse(variables);
      } catch {
        notes.push('GraphQL variables are not valid JSON; they are sent as an empty object.');
        variables = {};
      }
    }
    return { mode: 'graphql', query: body.query, variables: variables || {} };
  }
  return undefined;
}

/**
 * Auth for the generated request. `source` records where it was defined
 * (request / folder / collection) for error messages. An explicit "noauth"
 * is kept so it is never replaced by a default auth at runtime.
 */
function buildAuth(req, secrets) {
  const auth = req.auth;
  if (!auth) return req.authSource && req.authSource !== 'none' ? { type: 'noauth', source: req.authSource } : null;
  const p = auth.params || {};
  const source = req.authSource;
  if (auth.type === 'bearer') return { type: 'bearer', token: secrets.protect(String(p.token ?? '')), source };
  if (auth.type === 'basic') return { type: 'basic', username: String(p.username ?? ''), password: secrets.protect(String(p.password ?? '')), source };
  if (auth.type === 'apikey') return { type: 'apikey', key: String(p.key ?? ''), value: secrets.protect(String(p.value ?? '')), in: p.in === 'query' ? 'query' : 'header', source };
  return { type: auth.type, source };
}

function buildDefinition(req, secrets) {
  const notes = [...req.warnings];
  const headers = {};
  for (const h of req.headers.filter((x) => !x.disabled)) {
    if (Object.keys(headers).some((k) => k.toLowerCase() === h.key.toLowerCase())) notes.push(`Duplicate header "${h.key}": the last value is used.`);
    headers[h.key] = isSensitiveKey(h.key) ? secrets.protect(h.value) : h.value;
  }
  const query = req.query.filter((q) => !q.disabled).map((q) => [q.key, isSensitiveKey(q.key) ? secrets.protect(q.value) : q.value]);

  let skipReason = null;
  if (req.disabled) skipReason = 'Request is disabled in the collection.';
  else if (req.body?.unsupported) skipReason = `Body mode "${req.body.mode}" is not supported by the generator.`;
  else if (req.auth && !SUPPORTED_AUTH.has(req.auth.type)) {
    skipReason = `Auth type "${req.auth.type}" is not supported. Obtain a token separately and use bearer auth with PM_VAR_<name>.`;
  } else if (!req.url) skipReason = 'Request has no URL.';

  const def = {
    id: req.id,
    folder: req.folder,
    name: req.name,
    method: req.method,
    url: req.url,
  };
  if (query.length) def.query = query;
  if (Object.keys(headers).length) def.headers = headers;
  const auth = buildAuth(req, secrets);
  if (auth) def.auth = auth;
  const body = buildBody(req.body, headers, secrets, notes);
  if (body) def.body = body;
  if (skipReason) def.skipReason = skipReason;
  return { def, notes };
}

// ---------------------------------------------------------------------------
// Assertion code
// ---------------------------------------------------------------------------

function actualExpr(subject) {
  switch (subject.kind) {
    case 'status': return 'res.status';
    case 'statusText': return 'res.statusText';
    case 'responseTime': return 'res.durationMs';
    case 'header': return `res.header(${str(subject.name)})${subject.lengthOf ? '?.length' : ''}`;
    case 'body': return `res.text${subject.lengthOf ? '.length' : ''}`;
    case 'json': return subject.path.length ? `api.jsonPath(res, ${toJs(subject.path)})` : 'res.json';
    default: throw new Error(`Unknown subject ${subject.kind}`);
  }
}

function assertionCode(a) {
  const actual = actualExpr(a.subject);
  const msg = str(describeAssertion(a));
  const not = a.negate ? '.not' : '';
  const e = (subject = actual) => `expect(${subject}, ${msg})`;
  const v = (x) => toJs(x);
  switch (a.op) {
    case 'eq': return `${e()}${not}.toEqual(${v(a.expected)});`;
    case 'between':
      return a.negate
        ? `${e(`${actual} >= ${a.expected[0]} && ${actual} <= ${a.expected[1]}`)}.toBe(false);`
        : `${e()}.toBeGreaterThanOrEqual(${a.expected[0]});\n${e()}.toBeLessThanOrEqual(${a.expected[1]});`;
    case 'oneOf': return `${e(v(a.expected))}${not}.toContainEqual(${actual});`;
    case 'include':
      if (a.expected && typeof a.expected === 'object' && !Array.isArray(a.expected)) return `${e()}${not}.toMatchObject(${v(a.expected)});`;
      return `${e()}${not}.toContain(${v(a.expected)});`;
    case 'property':
      return a.expected.hasValue
        ? `${e()}${not}.toHaveProperty([${str(a.expected.name)}], ${v(a.expected.value)});`
        : `${e()}${not}.toHaveProperty([${str(a.expected.name)}]);`;
    case 'type': return `${e(`api.typeOf(${actual})`)}${not}.toBe(${str(a.expected)});`;
    case 'length': return `${e()}${not}.toHaveLength(${a.expected});`;
    case 'above': return `${e()}${not}.toBeGreaterThan(${a.expected});`;
    case 'below': return `${e()}${not}.toBeLessThan(${a.expected});`;
    case 'least': return `${e()}${not}.toBeGreaterThanOrEqual(${a.expected});`;
    case 'most': return `${e()}${not}.toBeLessThanOrEqual(${a.expected});`;
    case 'match': return `${e()}${not}.toMatch(new RegExp(${str(a.expected.source)}, ${str(a.expected.flags)}));`;
    case 'exist': return `${e(`${actual} ?? null`)}${a.negate ? '' : '.not'}.toBeNull();`;
    case 'true': return `${e()}${not}.toBe(true);`;
    case 'false': return `${e()}${not}.toBe(false);`;
    case 'null': return `${e()}${not}.toBeNull();`;
    case 'undefined': return `${e()}${not}.toBeUndefined();`;
    case 'ok': return `${e()}${not}.toBeTruthy();`;
    case 'empty': return `${e(`api.isEmpty(${actual})`)}${not}.toBe(true);`;
    case 'isJson': return `${e('api.isJson(res)')}${not}.toBe(true);`;
    default: throw new Error(`Unknown op ${a.op}`);
  }
}

function extractionCode(x) {
  if (x.action === 'unset') return `api.unsetVariable(${str(x.name)});`;
  const s = x.source;
  let getter;
  if (s.from === 'json') getter = s.path.length ? `api.jsonPath(res, ${toJs(s.path)})` : 'res.json';
  else if (s.from === 'header') getter = `res.header(${str(s.name)})`;
  else if (s.from === 'status') getter = 'res.status';
  else if (s.from === 'responseTime') getter = 'res.durationMs';
  else if (s.from === 'body') getter = 'res.text';
  else getter = toJs(s.value);
  if (s.stringify) getter = `JSON.stringify(${getter})`;
  return `await api.extract(${str(x.name)}, ${str(x.scope)}, () => ${getter});`;
}

function indentBlock(code, pad) {
  return code.split('\n').map((l) => (l ? pad + l : l)).join('\n');
}

// ---------------------------------------------------------------------------
// Test emission
// ---------------------------------------------------------------------------

function buildTest(req, secrets, title) {
  const { def, notes } = buildDefinition(req, secrets);
  const tests = convertTestScripts(req.scripts.test);
  const pre = convertPrerequestScripts(req.scripts.prerequest);

  if (pre.sets.length) {
    def.preRequest = pre.sets.map((s) => (s.action === 'unset' ? { action: 'unset', name: s.name } : { action: 'set', name: s.name, value: isSensitiveKey(s.name) ? secrets.protect(String(s.source.value)) : s.source.value }));
  }
  for (const u of [...pre.unsupported, ...tests.unsupported]) {
    notes.push(`Unsupported script (${u.source}${u.test ? `, test "${u.test}"` : ''}): ${u.reason}${u.code ? ` — ${u.code}` : ''}`);
  }

  const hasStatusCheck = tests.groups.some((g) => g.assertions.some((a) => a.subject.kind === 'status'));
  const body = [];
  body.push(`const res = await api.send(${toJs(def)});`);
  body.push('');

  if (tests.groups.length) {
    body.push('// Checks converted from the collection\'s Postman test scripts');
    for (const g of tests.groups) {
      const inner = g.assertions.map((a) => `// ${comment(a.code)}\n${assertionCode(a)}`).join('\n');
      body.push(`await api.verify(${str(g.title)}, 'collection', () => {\n${indentBlock(inner, '  ')}\n});`);
    }
    body.push('');
  }

  body.push('// Baseline checks: generated defaults, NOT verified business requirements');
  if (!hasStatusCheck) {
    if (req.exampleStatuses.length) {
      const codes = req.exampleStatuses;
      const title = codes.length === 1 ? `Status code is ${codes[0]} (from saved example response)` : `Status code is one of ${codes.join(', ')} (from saved example responses)`;
      const check = codes.length === 1
        ? `expect(res.status, ${str(title)}).toBe(${codes[0]});`
        : `expect(${toJs(codes)}, ${str(title)}).toContain(res.status);`;
      body.push(`await api.verify(${str(title)}, 'example', () => {\n  ${check}\n});`);
    } else {
      body.push('await api.verifyBaselineStatus(res);');
    }
  }
  body.push('await api.verifyJsonIfDeclared(res);');
  body.push('await api.verifyResponseTime(res);');

  if (tests.extractions.length) {
    body.push('');
    body.push('// Values saved for later requests (request chaining)');
    for (const x of tests.extractions) body.push(`// ${comment(x.code)}\n${extractionCode(x)}`);
  }
  body.push('');
  body.push('api.assertAllChecksPassed();');

  const annotations = [{ type: 'request-id', description: req.id }, { type: 'request', description: `${req.method} ${redactUrl(req.rawUrl)}` }];
  if (req.description) annotations.push({ type: 'description', description: req.description.slice(0, 500) });
  for (const n of notes) annotations.push({ type: 'conversion-warning', description: n.slice(0, 500) });

  const details = `{\n  tag: [${str(`@${req.method.toLowerCase()}`)}],\n  annotation: ${toJs(annotations, '  ')},\n}`;
  const code = `test(${str(title)}, ${details}, async ({ api }) => {\n${indentBlock(body.join('\n'), '  ')}\n});`;

  return {
    code,
    def,
    info: {
      id: req.id,
      name: req.name,
      title,
      folder: req.folder,
      method: req.method,
      url: redactUrl(req.rawUrl),
      description: req.description,
      convertedChecks: tests.groups.reduce((n, g) => n + g.assertions.length, 0),
      convertedTests: tests.groups.map((g) => g.title),
      extractions: tests.extractions.map((x) => x.name),
      preRequestSets: pre.sets.map((s) => s.name),
      unsupported: [...pre.unsupported, ...tests.unsupported],
      notes,
      skipReason: def.skipReason || null,
      baseline: !hasStatusCheck ? (req.exampleStatuses.length ? 'example-status' : 'policy-status') : 'collection-status',
    },
  };
}

function uniqueTitle(base, used) {
  let title = base;
  let n = 2;
  while (used.has(title)) title = `${base} (${n++})`;
  used.add(title);
  return title;
}

function fileHeader(collectionName, folder, runtimeImport) {
  return [
    '// @ts-check',
    `// AUTO-GENERATED by postman-to-playwright from collection: ${comment(collectionName)}`,
    `// Folder: ${comment(folder)}`,
    '// Regenerate from the collection instead of editing this file by hand.',
    '//',
    '// Check origins:',
    '//   [collection] converted from the collection\'s own Postman test scripts',
    '//   [example]    expected status taken from a saved example response',
    '//   [baseline]   generic default (configurable); NOT a verified business requirement',
    '//   [auth]       token extraction configured in auth.config.json (login / refresh requests)',
    "'use strict';",
    `const { test, expect } = require(${str(runtimeImport)});`,
    '',
  ].join('\n');
}

/**
 * Generates spec files for a parsed collection.
 * @param {ReturnType<import('../parser/collection-parser').parseCollection>} parsed
 * @param {{outDir: string, sourceName?: string, authConfig?: ReturnType<import('../auth/auth-config').loadAuthConfig>}} options
 *   authConfig: result of loadAuthConfig(); omitted means no automatic authentication.
 */
function generateTests(parsed, { outDir, sourceName = '', authConfig = null }) {
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of fs.readdirSync(outDir)) {
    if (GENERATED_FILE_PATTERN.test(f)) fs.rmSync(path.join(outDir, f), { force: true });
  }

  const runtimePath = path.relative(outDir, path.join(__dirname, '..', 'runtime', 'api-fixture.js')).split(path.sep).join('/');
  const runtimeImport = runtimePath.startsWith('.') ? runtimePath : `./${runtimePath}`;
  const secrets = new SecretStore();

  // Group by top-level folder, keeping collection order.
  const groups = [];
  for (const req of parsed.requests) {
    const top = req.folderPath[0] || '(root)';
    let g = groups.find((x) => x.top === top);
    if (!g) groups.push((g = { top, requests: [] }));
    g.requests.push(req);
  }
  // Root-level requests first (they usually include login), then folders in order.
  groups.sort((a, b) => (a.top === '(root)' ? -1 : b.top === '(root)' ? 1 : 0));

  const files = [];
  const requestInfo = [];
  const requestDefs = [];
  groups.forEach((g, i) => {
    const fileName = `${String(i + 1).padStart(2, '0')}-${slugify(g.top === '(root)' ? 'root-requests' : g.top)}.spec.js`;
    const parts = [fileHeader(parsed.info.name, g.top, runtimeImport)];
    // Consecutive requests in the same (sub)folder share one describe block.
    let current = null;
    let block = [];
    let used = new Set();
    const flush = () => {
      if (!current) return;
      parts.push(`test.describe(${str(current)}, () => {\n${block.map((b) => indentBlock(b, '  ')).join('\n\n')}\n});\n`);
      block = [];
    };
    for (const req of g.requests) {
      if (req.folder !== current) {
        flush();
        current = req.folder;
        used = new Set();
      }
      const t = buildTest(req, secrets, uniqueTitle(`${req.name} [${req.method}]`, used));
      block.push(t.code);
      requestInfo.push({ ...t.info, file: fileName });
      requestDefs.push(t.def);
    }
    flush();
    const code = parts.join('\n');
    try {
      new vm.Script(code, { filename: fileName }); // syntax validation only, nothing is executed
    } catch (err) {
      throw new Error(`Internal generator error: ${fileName} is not valid JavaScript (${err.message})`);
    }
    fs.writeFileSync(path.join(outDir, fileName), code);
    files.push({ name: fileName, folder: g.top, tests: g.requests.length });
  });

  // Variables used at runtime. Sensitive collection values are moved to .secrets.json.
  const variables = {
    collection: Object.fromEntries(toVariableMap(parsed.variables)),
    environment: parsed.environment ? Object.fromEntries(toVariableMap(parsed.environment.values)) : {},
    folders: Object.fromEntries(parsed.folders.filter((f) => f.variables?.length).map((f) => [f.path.join(' / '), Object.fromEntries(toVariableMap(f.variables))])),
  };

  const setNames = new Set(requestInfo.flatMap((r) => [...r.extractions, ...r.preRequestSets]));
  const usesSetVariables = parsed.requests.some((r) => {
    const texts = [r.url, ...r.query.map((q) => q.value), ...r.headers.map((h) => h.value), r.body?.raw || '', ...Object.values(r.auth?.params || {}).map(String)];
    return texts.some((t) => [...findVariableReferences(t)].some((v) => setNames.has(v)));
  });

  const authCheck = authConfig ? checkAgainstCollection(authConfig, parsed) : null;
  const authWarnings = authCheck
    ? [
        ...authCheck.errors.map((message) => ({ level: 'error', scope: authConfig.path, message })),
        ...authCheck.warnings.map((message) => ({ level: 'warning', scope: authConfig.path, message })),
        ...authCheck.info.map((message) => ({ level: 'info', scope: authConfig.path, message })),
      ]
    : [];

  const unsupportedTotal = requestInfo.reduce((n, r) => n + r.unsupported.length, 0);
  const meta = {
    collection: parsed.info,
    sourceFile: sourceName,
    generatedAt: new Date().toISOString(),
    requestCount: parsed.requests.length,
    testCount: requestInfo.length,
    files,
    folders: [...new Set(parsed.requests.map((r) => r.folder))],
    // Automatic login shares one token across requests, so the suite must run in order.
    hasDependencies: (setNames.size > 0 && usesSetVariables) || !!authCheck?.loginRequestId,
    chainedVariables: [...setNames],
    environment: parsed.environment ? parsed.environment.name : null,
    stats: {
      convertedChecks: requestInfo.reduce((n, r) => n + r.convertedChecks, 0),
      requestsWithCollectionChecks: requestInfo.filter((r) => r.convertedChecks > 0).length,
      requestsWithBaselineOnly: requestInfo.filter((r) => r.convertedChecks === 0).length,
      unsupportedStatements: unsupportedTotal,
      skippedAtGeneration: requestInfo.filter((r) => r.skipReason).length,
      secretsExtracted: Object.keys(secrets.values).length,
    },
    auth: authConfig?.present
      ? {
          configFile: authConfig.path,
          valid: authCheck.errors.length === 0,
          errors: authCheck.errors,
          loginRequestId: authCheck.loginRequestId,
          tokenVariable: authConfig.config?.login?.tokenVariable || null,
          tokenPath: authConfig.config?.login?.tokenPath || null,
          refreshEnabled: !!authConfig.config?.refresh?.enabled,
          refreshRequestId: authCheck.refreshRequestId,
          defaultAuth: authConfig.config?.defaultAuth?.type || null,
        }
      : null,
    warnings: [...parsed.warnings, ...authWarnings],
    requests: requestInfo,
  };

  fs.writeFileSync(path.join(outDir, 'collection-meta.json'), JSON.stringify(meta, null, 2));
  fs.writeFileSync(path.join(outDir, 'collection-variables.json'), JSON.stringify(variables, null, 2));
  fs.writeFileSync(path.join(outDir, '.secrets.json'), JSON.stringify(secrets.values, null, 2));
  // Request definitions let the runtime perform login/refresh on demand (secrets are placeholders).
  fs.writeFileSync(path.join(outDir, 'request-defs.json'), JSON.stringify(requestDefs, null, 2));
  return meta;
}

module.exports = { generateTests, toJs, assertionCode, GENERATED_FILE_PATTERN, SecretStore };
