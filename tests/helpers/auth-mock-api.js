'use strict';
/**
 * Local API with realistic token auth, used by the authentication tests.
 *   POST /auth/login     {username, password} -> {data: {accessToken, refreshToken, expiresIn}}
 *   POST /auth/refresh   {refreshToken}        -> new tokens (old refresh token invalidated)
 *   GET  /secure/*       Bearer access token; a token expires after `tokenMaxUses` uses (401)
 *   GET  /basic          Basic auth
 *   GET  /keyed          X-API-Key header
 *   GET  /health         public; returns 400 if ANY Authorization header is sent
 * Every credential is a synthetic test value supplied by the test.
 */
const http = require('node:http');
const crypto = require('node:crypto');

function startAuthMockApi({ user, basic, apiKey, tokenMaxUses = Infinity }) {
  const access = new Map(); // token -> uses
  const refresh = new Set();
  const issued = [];
  const events = [];
  const stats = { loginCalls: 0, refreshCalls: 0, secureCalls: 0 };

  const issue = () => {
    const accessToken = `at_${issued.length}_${crypto.randomBytes(6).toString('hex')}`;
    const refreshToken = `rt_${issued.length}_${crypto.randomBytes(6).toString('hex')}`;
    access.set(accessToken, 0);
    refresh.add(refreshToken);
    issued.push(accessToken, refreshToken);
    return { accessToken, refreshToken, expiresIn: 3600 };
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const json = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const body = (() => {
        try {
          return JSON.parse(raw || '{}');
        } catch {
          return {};
        }
      })();
      const p = new URL(req.url, 'http://x').pathname;
      const authz = req.headers.authorization || '';

      if (req.method === 'POST' && p === '/auth/login') {
        stats.loginCalls++;
        const ok = body.username === user.username && body.password === user.password;
        events.push({ type: 'login', ok });
        return ok ? json(200, { data: issue() }) : json(401, { error: 'invalid credentials' });
      }
      if (req.method === 'POST' && p === '/auth/refresh') {
        stats.refreshCalls++;
        const ok = refresh.delete(body.refreshToken);
        events.push({ type: 'refresh', ok });
        return ok ? json(200, { data: issue() }) : json(401, { error: 'invalid refresh token' });
      }
      if (p.startsWith('/secure/')) {
        stats.secureCalls++;
        const token = authz.startsWith('Bearer ') ? authz.slice(7) : '';
        if (!access.has(token)) {
          events.push({ type: 'secure', path: p, token: token ? 'unknown' : 'none', status: 401 });
          return json(401, { error: 'invalid token' });
        }
        const uses = access.get(token) + 1;
        access.set(token, uses);
        const expired = uses > tokenMaxUses;
        events.push({ type: 'secure', path: p, token, status: expired ? 401 : 200 });
        return expired ? json(401, { error: 'token expired' }) : json(200, { path: p, owner: user.username });
      }
      if (p === '/basic') {
        const expected = `Basic ${Buffer.from(`${basic.username}:${basic.password}`).toString('base64')}`;
        return authz === expected ? json(200, { ok: true }) : json(401, { error: 'basic auth required' });
      }
      if (p === '/keyed') return req.headers['x-api-key'] === apiKey ? json(200, { ok: true }) : json(403, { error: 'bad key' });
      if (p === '/health') return authz ? json(400, { error: 'public endpoint received credentials' }) : json(200, { status: 'up' });
      return json(404, { error: 'no route' });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}`, stats, events, issued }));
  });
}

module.exports = { startAuthMockApi };
