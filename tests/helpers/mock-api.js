'use strict';
/**
 * Tiny local API used by the end-to-end test. It simulates login -> token,
 * create -> id chaining, bearer/API-key auth, a 404, a 401 and a 500.
 * All credentials here are synthetic test values.
 */
const http = require('node:http');

const TEST_USER = { username: 'qa_user', password: 'S3cr3t-Pass!' };
const ISSUED_TOKEN = 'tok_TEST_7f3a9c1e5b2d4a60';
const API_KEY = 'live-key-ABC123456';

function startMockApi() {
  const items = new Map();
  let nextId = 100;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const json = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(body === undefined ? '' : JSON.stringify(body));
      };
      const url = new URL(req.url, 'http://localhost');
      const authed = req.headers.authorization === `Bearer ${ISSUED_TOKEN}`;

      if (req.method === 'POST' && url.pathname === '/login') {
        let body = {};
        try {
          body = JSON.parse(raw || '{}');
        } catch {
          return json(400, { error: 'bad json' });
        }
        if (body.username === TEST_USER.username && body.password === TEST_USER.password) {
          return json(200, { token: ISSUED_TOKEN, refreshToken: 'refresh_TEST_99887766', expiresIn: 3600 });
        }
        return json(401, { error: 'invalid credentials' });
      }
      if (url.pathname === '/boom') return json(500, { error: 'simulated server failure' });
      if (url.pathname === '/apikey') {
        return req.headers['x-api-key'] === API_KEY ? json(200, { ok: true }) : json(403, { error: 'bad key' });
      }
      if (url.pathname.startsWith('/items')) {
        if (!authed) return json(401, { error: 'missing or invalid token' });
        const id = url.pathname.split('/')[2];
        if (req.method === 'POST' && !id) {
          const item = { id: nextId++, ...JSON.parse(raw || '{}') };
          items.set(String(item.id), item);
          return json(201, item);
        }
        if (req.method === 'GET' && id) return items.has(id) ? json(200, items.get(id)) : json(404, { error: 'not found' });
        if (req.method === 'DELETE' && id) {
          items.delete(id);
          res.writeHead(204);
          return res.end();
        }
      }
      return json(404, { error: 'no route' });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });
}

module.exports = { startMockApi, TEST_USER, ISSUED_TOKEN, API_KEY };
