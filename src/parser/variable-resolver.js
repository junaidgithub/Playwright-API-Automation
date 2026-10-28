'use strict';
/**
 * Resolves Postman {{variable}} placeholders using an ordered list of scopes.
 *
 * Precedence (highest first) used by this tool:
 *   1. runtime     – values set while the suite runs (pm.*.set extractions, login tokens)
 *   2. overrides   – PM_VAR_<name> environment variables / dashboard overrides
 *   3. environment – an uploaded Postman environment file
 *   4. folder      – variables declared on folders (nearest folder wins)
 *   5. collection  – collection-level variables
 * Postman dynamic variables ({{$guid}}, {{$timestamp}}, ...) are generated on demand.
 */
const crypto = require('node:crypto');

const VARIABLE_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;
const MAX_DEPTH = 10;

const DYNAMIC_VARIABLES = {
  $guid: () => crypto.randomUUID(),
  $randomUUID: () => crypto.randomUUID(),
  $timestamp: () => String(Math.floor(Date.now() / 1000)),
  $isoTimestamp: () => new Date().toISOString(),
  $randomInt: () => String(crypto.randomInt(0, 1001)),
  $randomAlphaNumeric: () => crypto.randomBytes(1).toString('hex').slice(0, 1),
  $randomEmail: () => `user${crypto.randomInt(100000, 999999)}@example.com`,
  $randomFirstName: () => ['Alex', 'Sam', 'Jordan', 'Taylor', 'Casey'][crypto.randomInt(0, 5)],
  $randomLastName: () => ['Smith', 'Khan', 'Lee', 'Garcia', 'Brown'][crypto.randomInt(0, 5)],
  $randomBoolean: () => String(crypto.randomInt(0, 2) === 1),
};

/** Converts Postman variable arrays ({key,value,disabled}) or plain objects into a Map. */
function toVariableMap(source) {
  const map = new Map();
  if (!source) return map;
  if (Array.isArray(source)) {
    for (const v of source) {
      if (!v || v.disabled === true || typeof v.key !== 'string') continue;
      map.set(v.key, v.value === undefined || v.value === null ? '' : v.value);
    }
  } else if (source instanceof Map) {
    for (const [k, v] of source) map.set(k, v);
  } else if (typeof source === 'object') {
    for (const [k, v] of Object.entries(source)) map.set(k, v);
  }
  return map;
}

class VariableResolver {
  /** @param {{name: string, values: any}[]} scopes ordered highest precedence first */
  constructor(scopes = []) {
    this.scopes = scopes.map((s) => ({ name: s.name, values: toVariableMap(s.values) }));
    this.unresolved = new Set();
  }

  lookup(name) {
    for (const scope of this.scopes) {
      if (scope.values.has(name)) return { found: true, value: scope.values.get(name), scope: scope.name };
    }
    if (Object.prototype.hasOwnProperty.call(DYNAMIC_VARIABLES, name)) {
      return { found: true, value: DYNAMIC_VARIABLES[name](), scope: 'dynamic' };
    }
    return { found: false };
  }

  has(name) {
    return this.lookup(name).found;
  }

  /** Replaces every {{name}} in a string. Unknown variables are left untouched and recorded. */
  resolveString(input, depth = 0) {
    if (typeof input !== 'string' || !input.includes('{{')) return input;
    if (depth >= MAX_DEPTH) return input;
    let changed = false;
    const out = input.replace(VARIABLE_PATTERN, (match, rawName) => {
      const name = rawName.trim();
      const hit = this.lookup(name);
      if (!hit.found) {
        this.unresolved.add(name);
        return match;
      }
      changed = true;
      const value = hit.value;
      return typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
    });
    return changed ? this.resolveString(out, depth + 1) : out;
  }

  /** Deep-resolves strings inside objects/arrays (used for parsed JSON bodies). */
  resolveDeep(value) {
    if (typeof value === 'string') return this.resolveString(value);
    if (Array.isArray(value)) return value.map((v) => this.resolveDeep(v));
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[this.resolveString(k)] = this.resolveDeep(v);
      return out;
    }
    return value;
  }
}

/** Lists variable names referenced in any string. */
function findVariableReferences(input) {
  const names = new Set();
  if (typeof input !== 'string') return names;
  for (const m of input.matchAll(VARIABLE_PATTERN)) names.add(m[1].trim());
  return names;
}

module.exports = { VariableResolver, toVariableMap, findVariableReferences, DYNAMIC_VARIABLES, VARIABLE_PATTERN };
