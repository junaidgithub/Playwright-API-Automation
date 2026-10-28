'use strict';
/**
 * Converts common Postman test / pre-request script patterns into a data model
 * of assertions and variable extractions.
 *
 * SECURITY: scripts from imported collections are untrusted. Nothing here
 * evaluates them – statements are tokenised and matched against known patterns.
 * Anything that is not recognised is reported as "unsupported".
 *
 * Supported test-script patterns (see README for the full list):
 *   pm.test("name", function () { ... })            -> grouped check
 *   pm.response.to.have.status(201)                  -> status code
 *   pm.response.to.be.ok / success / created / notFound / clientError / ...
 *   pm.expect(pm.response.code).to.eql(200) / .to.be.oneOf([200, 201])
 *   pm.response.to.have.header("X"[, "value"])
 *   pm.expect(pm.response.headers.get("X")).to.include("json")
 *   pm.expect(pm.response.responseTime).to.be.below(500)
 *   pm.response.to.be.json / pm.response.to.have.jsonBody(["path"[, value]])
 *   pm.expect(pm.response.text()).to.include("x")
 *   pm.expect(jsonData.a.b[0]).to.eql / have.property / be.an / include /
 *       have.lengthOf / be.above / below / least / most / oneOf / match / exist /
 *       be.true / be.false / be.null / be.undefined / be.empty / be.ok   (with optional .not)
 *   var jsonData = pm.response.json();  const id = jsonData.data.id;   (aliases)
 *   pm.environment|collectionVariables|globals|variables.set("name", <json path | header | literal>)
 *   legacy: tests["name"] = responseCode.code === 200; postman.setEnvironmentVariable(...)
 */

const LANGUAGE_CHAINS = new Set(['to', 'be', 'been', 'is', 'that', 'which', 'and', 'has', 'have', 'with', 'at', 'of', 'same', 'but', 'does', 'still', 'deep', 'nested', 'own', 'all', 'any']);

const METHOD_OPS = {
  eql: 'eq', equal: 'eq', equals: 'eq', eq: 'eq',
  property: 'property',
  a: 'type', an: 'type',
  include: 'include', includes: 'include', contain: 'include', contains: 'include',
  lengthOf: 'length', length: 'length',
  above: 'above', greaterThan: 'above', gt: 'above',
  below: 'below', lessThan: 'below', lt: 'below',
  least: 'least', gte: 'least',
  most: 'most', lte: 'most',
  oneOf: 'oneOf',
  match: 'match', matches: 'match',
};
const TERMINAL_OPS = new Set(['exist', 'true', 'false', 'null', 'undefined', 'empty', 'ok']);
const ARGLESS_OPS = new Set(['eq', 'include', 'length', 'above', 'below', 'least', 'most', 'oneOf', 'match', 'type', 'property']);

const STATUS_SHORTCUTS = {
  ok: { op: 'eq', expected: 200 },
  success: { op: 'between', expected: [200, 299] },
  created: { op: 'eq', expected: 201 },
  accepted: { op: 'eq', expected: 202 },
  badRequest: { op: 'eq', expected: 400 },
  unauthorized: { op: 'eq', expected: 401 },
  unauthorised: { op: 'eq', expected: 401 },
  forbidden: { op: 'eq', expected: 403 },
  notFound: { op: 'eq', expected: 404 },
  rateLimited: { op: 'eq', expected: 429 },
  info: { op: 'between', expected: [100, 199] },
  redirection: { op: 'between', expected: [300, 399] },
  clientError: { op: 'between', expected: [400, 499] },
  serverError: { op: 'between', expected: [500, 599] },
  error: { op: 'between', expected: [400, 599] },
};

const SET_SCOPES = new Set(['environment', 'collectionVariables', 'globals', 'variables', 'iterationData']);

class Unsupported extends Error {}

// ---------------------------------------------------------------------------
// Tokenising helpers
// ---------------------------------------------------------------------------

/** Splits script source into top-level statements, dropping comments. */
function splitStatements(code) {
  const out = [];
  let buf = '';
  let depth = 0;
  let quote = null;
  const flush = () => {
    const t = buf.trim();
    if (t) out.push(t);
    buf = '';
  };
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    const n = code[i + 1];
    if (quote) {
      buf += c;
      if (c === '\\' && n !== undefined) {
        buf += n;
        i++;
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === '/' && n === '/') {
      while (i < code.length && code[i] !== '\n') i++;
      i--;
      continue;
    }
    if (c === '/' && n === '*') {
      const end = code.indexOf('*/', i + 2);
      i = end === -1 ? code.length : end + 1;
      buf += ' ';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      buf += c;
      continue;
    }
    if ('([{'.includes(c)) depth++;
    if (')]}'.includes(c)) depth = Math.max(0, depth - 1);
    if (depth === 0 && (c === ';' || c === '\n' || c === '\r')) {
      if (c !== ';') {
        const next = /^\s*(\S)/.exec(code.slice(i + 1));
        const last = buf.trimEnd().slice(-1);
        if ((next && next[1] === '.') || ['.', ',', '(', '+', '=', '&', '|', '?', ':', '{'].includes(last)) {
          buf += ' ';
          continue;
        }
      }
      flush();
      continue;
    }
    buf += c;
  }
  flush();
  return out;
}

/** Index of the bracket that closes the one at openIdx (string aware). */
function findClosing(str, openIdx) {
  const open = str[openIdx];
  const close = { '(': ')', '[': ']', '{': '}' }[open];
  let depth = 0;
  let quote = null;
  for (let i = openIdx; i < str.length; i++) {
    const c = str[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return i;
  }
  return -1;
}

/** Splits "a, [b, c], 'd,e'" on top-level commas. */
function splitArgs(src) {
  const args = [];
  let buf = '';
  let depth = 0;
  let quote = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      buf += c;
      if (c === '\\') buf += src[++i] ?? '';
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    if ('([{'.includes(c)) depth++;
    if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) {
      args.push(buf.trim());
      buf = '';
      continue;
    }
    buf += c;
  }
  if (buf.trim()) args.push(buf.trim());
  return args;
}

const ESCAPES = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };

/** Decodes a quoted JS string literal ('..', "..", `..` without ${}) without eval. */
function unquote(s) {
  const inner = s.slice(1, -1);
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = inner[++i];
    if (n === undefined) break;
    if (n === 'u' && /^[0-9a-fA-F]{4}$/.test(inner.slice(i + 1, i + 5))) {
      out += String.fromCharCode(parseInt(inner.slice(i + 1, i + 5), 16));
      i += 4;
    } else {
      out += ESCAPES[n] ?? n;
    }
  }
  return out;
}

/** Parses a JS literal without evaluating code. Returns {ok, value}. */
function parseLiteral(src) {
  const s = String(src).trim();
  if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(s)) return { ok: true, value: Number(s) };
  if (s === 'true' || s === 'false') return { ok: true, value: s === 'true' };
  if (s === 'null') return { ok: true, value: null };
  if (/^(['"])(?:[^\\]|\\.)*\1$/s.test(s) || (/^`[^`$]*`$/s.test(s))) {
    try {
      return { ok: true, value: unquote(s) };
    } catch {
      return { ok: false };
    }
  }
  if (s.startsWith('[') || s.startsWith('{')) {
    try {
      return { ok: true, value: JSON.parse(s) };
    } catch {
      try {
        const json = s
          .replace(/'((?:[^'\\]|\\.)*)'/g, (m, inner) => JSON.stringify(inner.replace(/\\'/g, "'")))
          .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
          .replace(/,\s*([\]}])/g, '$1');
        return { ok: true, value: JSON.parse(json) };
      } catch {
        return { ok: false };
      }
    }
  }
  return { ok: false };
}

function parseRegexLiteral(src) {
  const m = /^\/((?:[^/\\\n]|\\.)+)\/([gimsuy]*)$/.exec(String(src).trim());
  if (!m || m[1].length > 300) return null;
  try {
    new RegExp(m[1], m[2]); // validate only
  } catch {
    return null;
  }
  return { source: m[1], flags: m[2].replace(/g/g, '') };
}

/** Parses ".a.b[0]['c']" into ['a','b',0,'c']; returns null if not a pure property path. */
function parsePath(src) {
  const path = [];
  const re = /\.([A-Za-z_$][\w$]*)|\[(\d+)\]|\[\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*\]/y;
  let pos = 0;
  while (pos < src.length) {
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m) return null;
    if (m[1] !== undefined) path.push(m[1]);
    else if (m[2] !== undefined) path.push(Number(m[2]));
    else path.push(unquote(m[3]));
    pos = re.lastIndex;
  }
  return path;
}

// ---------------------------------------------------------------------------
// Subject resolution (what is being asserted on)
// ---------------------------------------------------------------------------

function resolveSubject(expr, aliases) {
  const e = expr.trim();
  if (/^(pm\.response\.code|responseCode\.code)$/.test(e)) return { kind: 'status' };
  if (/^pm\.response\.status$/.test(e)) return { kind: 'statusText' };
  if (/^(pm\.response\.responseTime|responseTime)$/.test(e)) return { kind: 'responseTime' };
  if (/^(pm\.response\.text\(\)|responseBody)$/.test(e)) return { kind: 'body' };

  const header = /^(?:pm\.response\.headers\.get|postman\.getResponseHeader)\(\s*(['"`][^'"`]*['"`])\s*\)$/.exec(e);
  if (header) return { kind: 'header', name: unquote(header[1]) };

  const json = /^(pm\.response\.json\(\)|JSON\.parse\(\s*(?:responseBody|pm\.response\.text\(\))\s*\))(.*)$/.exec(e);
  if (json) {
    const path = parsePath(json[2]);
    if (path) return { kind: 'json', path };
  }

  const alias = /^([A-Za-z_$][\w$]*)(.*)$/.exec(e);
  if (alias && aliases.has(alias[1])) {
    const base = aliases.get(alias[1]);
    if (!alias[2]) return base;
    const path = parsePath(alias[2]);
    if (path && base.kind === 'json') return { kind: 'json', path: [...base.path, ...path] };
    if (path && path.length === 1 && path[0] === 'length' && (base.kind === 'body' || base.kind === 'header')) {
      return { ...base, lengthOf: true };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Statement conversion
// ---------------------------------------------------------------------------

/**
 * Splits a chai chain such as ".to.be.an('array').that.is.not.empty" into
 * assertion segments: [{method:'an', args:["'array'"]}, {method:'empty', negate:true}].
 * Like chai, a ".not" flag applies to everything after it.
 */
function parseChainSegments(chain) {
  const s = chain.trim();
  const segments = [];
  let words = [];
  let negate = false;
  const pushWords = (args, called) => {
    const meaningful = words.filter((w) => w !== 'not' && !LANGUAGE_CHAINS.has(w));
    // Terminal words in the middle of a chain (".to.exist.and.be.a('x')") are assertions too.
    meaningful.slice(0, -1).filter((w) => TERMINAL_OPS.has(w)).forEach((w) => segments.push({ words, negate, method: w, args: null, called: false }));
    const method = meaningful[meaningful.length - 1];
    if (method) segments.push({ words, negate, method, args, called });
    words = [];
  };
  let i = 0;
  while (i < s.length) {
    if (s[i] === '.') {
      const m = /^\.([A-Za-z_$][\w$]*)/.exec(s.slice(i));
      if (!m) throw new Unsupported('assertion chain not recognised');
      words.push(m[1]);
      if (m[1] === 'not') negate = true;
      i += m[0].length;
    } else if (s[i] === '(') {
      const end = findClosing(s, i);
      if (end === -1) throw new Unsupported('unbalanced parentheses in assertion');
      pushWords(splitArgs(s.slice(i + 1, end)), true);
      i = end + 1;
    } else if (/\s/.test(s[i])) {
      i++;
    } else {
      throw new Unsupported('assertion chain not recognised');
    }
  }
  if (words.length) pushWords(null, false);
  if (!segments.length) throw new Unsupported('assertion chain has no assertion');
  return segments;
}

function parseChain(chain) {
  const segments = parseChainSegments(chain);
  if (segments.length !== 1) throw new Unsupported('compound response assertions are not supported');
  return segments[0];
}

function literalArg(src) {
  const lit = parseLiteral(src);
  if (!lit.ok) throw new Unsupported(`argument "${src}" is not a literal value`);
  return lit.value;
}

/** pm.expect(<subject>)<chain>  -> one or more assertions */
function convertExpect(stmt, aliases) {
  const open = stmt.indexOf('(');
  const close = findClosing(stmt, open);
  if (close === -1) throw new Unsupported('unbalanced parentheses');
  const subject = resolveSubject(stmt.slice(open + 1, close), aliases);
  if (!subject) throw new Unsupported(`cannot determine what "${stmt.slice(open + 1, close).trim()}" refers to`);
  return parseChainSegments(stmt.slice(close + 1)).map((segment) => convertExpectSegment(subject, segment));
}

function convertExpectSegment(subject, { negate, method, args, called }) {
  if (TERMINAL_OPS.has(method) && !called) return { subject, op: method, negate };
  const op = METHOD_OPS[method];
  if (!op) throw new Unsupported(`assertion ".${method}" is not supported`);
  if (!called || !args || (args.length === 0 && ARGLESS_OPS.has(op))) throw new Unsupported(`".${method}" needs an argument`);

  if (op === 'match') {
    const regex = parseRegexLiteral(args[0]);
    if (!regex) throw new Unsupported('only simple regular expression literals are supported in .match()');
    return { subject, op, expected: regex, negate };
  }
  if (op === 'property') {
    const name = literalArg(args[0]);
    return args.length > 1
      ? { subject, op, expected: { name, value: literalArg(args[1]), hasValue: true }, negate }
      : { subject, op, expected: { name, hasValue: false }, negate };
  }
  if (op === 'type') {
    const t = String(literalArg(args[0])).toLowerCase();
    if (!['array', 'object', 'string', 'number', 'boolean', 'null', 'undefined'].includes(t)) throw new Unsupported(`type "${t}" not supported`);
    return { subject, op, expected: t, negate };
  }
  if (op === 'oneOf') {
    const list = literalArg(args[0]);
    if (!Array.isArray(list)) throw new Unsupported('.oneOf() expects an array literal');
    return { subject, op, expected: list, negate };
  }
  const expected = literalArg(args[0]);
  if (['above', 'below', 'least', 'most', 'length'].includes(op) && typeof expected !== 'number') {
    throw new Unsupported(`.${method}() expects a number`);
  }
  return { subject, op, expected, negate };
}

/** pm.response.to.<...> */
function convertResponseAssertion(stmt) {
  const { negate, words, method, args, called } = parseChain(stmt.slice('pm.response'.length));
  if (method === 'status' && called) {
    const value = literalArg(args[0]);
    if (typeof value === 'number') return { subject: { kind: 'status' }, op: 'eq', expected: value, negate };
    return { subject: { kind: 'statusText' }, op: 'eq', expected: String(value), negate };
  }
  if (STATUS_SHORTCUTS[method] && !called) return { subject: { kind: 'status' }, ...STATUS_SHORTCUTS[method], negate };
  if (method === 'header' && called) {
    const name = String(literalArg(args[0]));
    return args.length > 1
      ? { subject: { kind: 'header', name }, op: 'eq', expected: String(literalArg(args[1])), negate }
      : { subject: { kind: 'header', name }, op: 'exist', negate };
  }
  if ((method === 'json' && !called) || (method === 'jsonBody' && called && args.length === 0)) {
    return { subject: { kind: 'body' }, op: 'isJson', negate };
  }
  if (method === 'jsonBody' && called) {
    const pathStr = String(literalArg(args[0]));
    const path = pathStr.split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p));
    return args.length > 1
      ? { subject: { kind: 'json', path }, op: 'eq', expected: literalArg(args[1]), negate }
      : { subject: { kind: 'json', path }, op: 'exist', negate };
  }
  if (method === 'body' && called) {
    return { subject: { kind: 'body' }, op: 'eq', expected: String(literalArg(args[0])), negate };
  }
  if (method === 'include' && called) {
    return { subject: { kind: 'body' }, op: 'include', expected: String(literalArg(args[0])), negate };
  }
  if (method === 'responseTime') throw new Unsupported('use pm.expect(pm.response.responseTime)…');
  throw new Unsupported(`response assertion "${words.join('.')}" is not supported`);
}

/** Value expression for variable extraction. */
function convertValueSource(src, aliases) {
  const lit = parseLiteral(src);
  if (lit.ok) return { from: 'literal', value: lit.value };
  const subject = resolveSubject(src, aliases);
  if (subject && ['json', 'header', 'status', 'body', 'responseTime'].includes(subject.kind) && !subject.lengthOf) {
    return { from: subject.kind, ...(subject.path ? { path: subject.path } : {}), ...(subject.name ? { name: subject.name } : {}) };
  }
  const replaceIn = /^pm\.variables\.replaceIn\(\s*(['"`][^'"`]*['"`])\s*\)$/.exec(src.trim());
  if (replaceIn) return { from: 'literal', value: unquote(replaceIn[1]) };
  const stringify = /^JSON\.stringify\((.*)\)$/.exec(src.trim());
  if (stringify) {
    const inner = convertValueSource(stringify[1], aliases);
    if (inner.from === 'json') return { ...inner, stringify: true };
  }
  throw new Unsupported(`value "${src.trim()}" cannot be extracted without running the script`);
}

function convertSet(stmt, aliases) {
  let m = /^pm\.(\w+)\.(set|unset)\(([\s\S]*)\)$/.exec(stmt);
  let scope;
  let action;
  let argSrc;
  if (m) {
    [, scope, action, argSrc] = m;
    if (!SET_SCOPES.has(scope)) throw new Unsupported(`pm.${scope}.${action} is not supported`);
  } else {
    m = /^postman\.(setEnvironmentVariable|setGlobalVariable|clearEnvironmentVariable|clearGlobalVariable)\(([\s\S]*)\)$/.exec(stmt);
    if (!m) return null;
    scope = /Global/.test(m[1]) ? 'globals' : 'environment';
    action = /^clear/.test(m[1]) ? 'unset' : 'set';
    argSrc = m[2];
  }
  const args = splitArgs(argSrc);
  const name = literalArg(args[0]);
  if (typeof name !== 'string') throw new Unsupported('variable name must be a string literal');
  if (action === 'unset') return { scope, name, action: 'unset' };
  if (args.length < 2) throw new Unsupported('set() needs a value');
  return { scope, name, action: 'set', source: convertValueSource(args[1], aliases) };
}

function convertAlias(stmt, aliases) {
  const m = /^(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*([\s\S]+)$/.exec(stmt);
  if (!m) return false;
  const subject = resolveSubject(m[2], aliases);
  if (!subject) throw new Unsupported(`variable "${m[1]}" is computed by code that cannot be converted`);
  aliases.set(m[1], subject);
  return true;
}

/** Legacy: tests["name"] = <subject> === <literal>; */
function convertLegacyTests(stmt, aliases) {
  const m = /^tests\[\s*(['"`][^'"`]*['"`])\s*\]\s*=\s*([\s\S]+)$/.exec(stmt);
  if (!m) return null;
  const title = unquote(m[1]);
  const expr = m[2].trim();
  const cmp = /^([\s\S]+?)\s*(===|==|!==|!=|<=|>=|<|>)\s*([\s\S]+)$/.exec(expr);
  if (cmp) {
    const subject = resolveSubject(cmp[1], aliases);
    if (!subject) throw new Unsupported('legacy tests[] expression not recognised');
    const value = literalArg(cmp[3]);
    const ops = { '===': ['eq', false], '==': ['eq', false], '!==': ['eq', true], '!=': ['eq', true], '<': ['below', false], '>': ['above', false], '<=': ['most', false], '>=': ['least', false] };
    const [op, negate] = ops[cmp[2]];
    return { title, assertion: { subject, op, expected: value, negate } };
  }
  const has = /^responseBody\.has\(\s*(['"`][^'"`]*['"`])\s*\)$/.exec(expr);
  if (has) return { title, assertion: { subject: { kind: 'body' }, op: 'include', expected: unquote(has[1]), negate: false } };
  throw new Unsupported('legacy tests[] expression not recognised');
}

const PM_TEST_OPENER = /^pm\.test\(\s*(['"`])((?:[^\\]|\\.)*?)\1\s*,\s*(?:async\s+)?(?:function\s*\w*\s*\(\s*\)|\(\s*\)\s*=>)\s*/s;

function processStatements(statements, ctx, group) {
  for (const raw of statements) {
    const stmt = raw.replace(/\s*\n\s*/g, ' ').replace(/;+$/, '').trim();
    if (!stmt) continue;
    try {
      const opener = PM_TEST_OPENER.exec(raw.trim());
      if (opener) {
        const title = opener[2].replace(/\\(.)/g, '$1');
        const rest = raw.trim().slice(opener[0].length);
        let body;
        if (rest.startsWith('{')) {
          const end = findClosing(rest, 0);
          if (end === -1) throw new Unsupported('pm.test body is not balanced');
          body = rest.slice(1, end);
        } else {
          body = rest.replace(/\)\s*;?\s*$/, '');
        }
        const g = { title, source: ctx.source, assertions: [], partial: false };
        ctx.groups.push(g);
        processStatements(splitStatements(body), ctx, g);
        continue;
      }
      if (/^['"]use strict['"]$/.test(stmt) || /^console\.\w+\(/.test(stmt)) {
        ctx.ignored.push({ source: ctx.source, code: stmt, reason: 'logging / directive has no effect on results' });
        continue;
      }
      if (convertAlias(stmt, ctx.aliases)) continue;
      const set = convertSet(stmt, ctx.aliases);
      if (set) {
        ctx.extractions.push({ ...set, sourceScript: ctx.source, code: stmt });
        continue;
      }
      const legacy = convertLegacyTests(stmt, ctx.aliases);
      if (legacy) {
        ctx.groups.push({ title: legacy.title, source: ctx.source, assertions: [{ ...legacy.assertion, code: stmt }], partial: false });
        continue;
      }
      let assertions = null;
      if (stmt.startsWith('pm.expect(')) assertions = convertExpect(stmt, ctx.aliases);
      else if (stmt.startsWith('pm.response.to.')) assertions = [convertResponseAssertion(stmt)];
      if (!assertions) {
        const reason = /^(if|for|while|switch|try)\b/.test(stmt)
          ? 'control flow (if/for/try) is not converted'
          : /^pm\.sendRequest\b/.test(stmt)
            ? 'pm.sendRequest is not supported'
            : /^(postman|pm)\.setNextRequest\b/.test(stmt)
              ? 'setNextRequest workflows are not supported; requests run in collection order'
              : 'statement not recognised';
        throw new Unsupported(reason);
      }
      for (const assertion of assertions) assertion.code = stmt;
      if (group) group.assertions.push(...assertions);
      else ctx.groups.push({ title: assertions.map(describeAssertion).join('; '), source: ctx.source, assertions, partial: false });
    } catch (err) {
      if (!(err instanceof Unsupported) && !(err instanceof SyntaxError)) throw err;
      if (group) group.partial = true;
      ctx.unsupported.push({ source: ctx.source, test: group ? group.title : null, code: stmt.slice(0, 300), reason: err.message });
    }
  }
}

/**
 * Converts the test scripts attached to a request (collection → folder → request order).
 * @param {{source: string, code: string}[]} scripts
 */
function convertTestScripts(scripts) {
  const ctx = { groups: [], extractions: [], unsupported: [], ignored: [], aliases: new Map(), source: '' };
  for (const script of scripts || []) {
    ctx.source = script.source;
    ctx.aliases = new Map();
    processStatements(splitStatements(script.code), ctx, null);
  }
  // A pm.test that ended up with no convertible assertions is still worth reporting.
  for (const g of ctx.groups) {
    if (g.assertions.length === 0 && !g.partial) {
      ctx.unsupported.push({ source: g.source, test: g.title, code: '', reason: 'pm.test contains no convertible assertions' });
    }
  }
  const { aliases, source, ...result } = ctx;
  result.groups = result.groups.filter((g) => g.assertions.length > 0);
  return result;
}

/** Pre-request scripts: only literal variable assignments are converted. */
function convertPrerequestScripts(scripts) {
  const sets = [];
  const unsupported = [];
  const ignored = [];
  for (const script of scripts || []) {
    for (const raw of splitStatements(script.code)) {
      const stmt = raw.replace(/\s*\n\s*/g, ' ').replace(/;+$/, '').trim();
      if (!stmt) continue;
      try {
        if (/^console\.\w+\(/.test(stmt)) {
          ignored.push({ source: script.source, code: stmt, reason: 'logging has no effect on results' });
          continue;
        }
        const set = convertSet(stmt, new Map());
        if (!set || (set.action === 'set' && set.source.from !== 'literal')) {
          throw new Unsupported(set ? 'pre-request values must be literals' : 'statement not recognised');
        }
        sets.push({ ...set, sourceScript: script.source, code: stmt });
      } catch (err) {
        if (!(err instanceof Unsupported) && !(err instanceof SyntaxError)) throw err;
        unsupported.push({ source: script.source, code: stmt.slice(0, 300), reason: err.message });
      }
    }
  }
  return { sets, unsupported, ignored };
}

function describeSubject(s) {
  switch (s.kind) {
    case 'status': return 'Status code';
    case 'statusText': return 'Status text';
    case 'responseTime': return 'Response time';
    case 'header': return `Header "${s.name}"${s.lengthOf ? ' length' : ''}`;
    case 'body': return `Response body${s.lengthOf ? ' length' : ''}`;
    case 'json': return s.path.length ? `JSON ${formatPath(s.path)}` : 'JSON body';
    default: return 'Value';
  }
}

function formatPath(path) {
  return path.map((p, i) => (typeof p === 'number' ? `[${p}]` : /^[A-Za-z_$][\w$]*$/.test(p) ? `${i ? '.' : ''}${p}` : `[${JSON.stringify(p)}]`)).join('');
}

function describeAssertion(a) {
  const not = a.negate ? 'not ' : '';
  const v = (x) => JSON.stringify(x);
  const what = describeSubject(a.subject);
  switch (a.op) {
    case 'eq': return `${what} ${not}equals ${v(a.expected)}`;
    case 'between': return `${what} is ${not}between ${a.expected[0]} and ${a.expected[1]}`;
    case 'oneOf': return `${what} is ${not}one of ${v(a.expected)}`;
    case 'include': return `${what} ${not}includes ${v(a.expected)}`;
    case 'property': return `${what} ${not}has property ${v(a.expected.name)}${a.expected.hasValue ? ` = ${v(a.expected.value)}` : ''}`;
    case 'type': return `${what} is ${not}of type ${a.expected}`;
    case 'length': return `${what} ${not}has length ${a.expected}`;
    case 'above': return `${what} is ${not}above ${a.expected}`;
    case 'below': return `${what} is ${not}below ${a.expected}`;
    case 'least': return `${what} is ${not}at least ${a.expected}`;
    case 'most': return `${what} is ${not}at most ${a.expected}`;
    case 'match': return `${what} ${not}matches /${a.expected.source}/${a.expected.flags}`;
    case 'isJson': return `Response body is ${not}JSON`;
    default: return `${what} is ${not}${a.op}`;
  }
}

module.exports = {
  convertTestScripts,
  convertPrerequestScripts,
  describeAssertion,
  formatPath,
  splitStatements,
  parseLiteral,
  parsePath,
};
