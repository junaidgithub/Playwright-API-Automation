'use strict';
/**
 * Redaction helpers. Anything that ends up in logs, attachments or reports passes
 * through here so tokens, passwords and API keys are never written in plain text.
 */
const MASK = '***REDACTED***';

const SENSITIVE_EXACT = new Set(['auth', 'pin', 'pwd', 'key', 'jwt', 'sid', 'otp']);
const SENSITIVE_SUFFIXES = [
  'password', 'passwd', 'passphrase', 'secret', 'token', 'apikey', 'authorization',
  'cookie', 'credential', 'credentials', 'privatekey', 'accesskey', 'signature',
  'sessionid', 'session', 'cvv', 'ssn', 'cardnumber',
];

// Values registered at runtime (resolved tokens, secrets file entries, ...).
const knownSecrets = new Set();

function isSensitiveKey(key) {
  if (typeof key !== 'string') return false;
  const k = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!k) return false;
  return SENSITIVE_EXACT.has(k) || SENSITIVE_SUFFIXES.some((s) => k.endsWith(s));
}

function registerSecret(value) {
  if (value === undefined || value === null) return;
  const s = String(value);
  // Very short values (e.g. "1") would mask unrelated text, so they are not tracked.
  if (s.length >= 4) knownSecrets.add(s);
}

function clearSecrets() {
  knownSecrets.clear();
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactString(input) {
  if (input === undefined || input === null) return input;
  let out = String(input);
  // Longest first so overlapping secrets are fully masked.
  const secrets = [...knownSecrets].sort((a, b) => b.length - a.length);
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.replace(new RegExp(escapeRegExp(secret), 'g'), MASK);
  }
  // Scheme + credential-looking value (must contain a digit or symbol, so "Basic Protected" stays readable).
  out = out.replace(/\b(Bearer|Basic|Digest)\s+(?=[A-Za-z0-9._~+/=-]*[0-9._~+/=-])[A-Za-z0-9._~+/=-]{6,}/gi, `$1 ${MASK}`);
  out = out.replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, MASK);
  // key=value / "key": "value" pairs with sensitive names.
  out = out.replace(/([?&;\s"']?)([A-Za-z0-9_.-]+)(["']?\s*[:=]\s*["']?)([^"'&\s,;}]+)/g, (m, pre, key, sep, val) =>
    isSensitiveKey(key) && val !== MASK && !/^(Bearer|Basic|Digest|Token)$/i.test(val) ? `${pre}${key}${sep}${MASK}` : m);
  return out;
}

function redactUrl(url) {
  if (!url) return url;
  try {
    const u = new URL(url);
    if (u.password) u.password = 'REDACTED';
    for (const key of [...u.searchParams.keys()]) {
      if (isSensitiveKey(key)) u.searchParams.set(key, MASK);
    }
    return redactString(u.toString().replace(/REDACTED@/, `${MASK}@`));
  } catch {
    return redactString(url);
  }
}

/** Deep-copies a value, masking sensitive keys and known secret strings. */
function redactValue(value, depth = 0) {
  if (depth > 25) return '[depth limit]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSensitiveKey(k) && v !== null && v !== '' ? MASK : redactValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    out[k] = isSensitiveKey(k) ? MASK : redactString(String(v));
  }
  return out;
}

/** Redacts a text body: JSON bodies are redacted structurally, others textually. */
function redactBody(text, limit = 4000) {
  if (text === undefined || text === null) return text;
  let out;
  try {
    out = JSON.stringify(redactValue(JSON.parse(text)), null, 2);
  } catch {
    out = redactString(String(text));
  }
  if (limit > 0 && out.length > limit) out = `${out.slice(0, limit)}\n… [truncated, ${out.length - limit} more characters]`;
  return out;
}

module.exports = {
  MASK,
  isSensitiveKey,
  registerSecret,
  clearSecrets,
  redactString,
  redactUrl,
  redactValue,
  redactHeaders,
  redactBody,
};
