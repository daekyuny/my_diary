import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seal, unseal, cookie } from '../server/session.js';
test('refresh session is encrypted, authenticated and expires', () => {
  const secret = 'test-only-server-secret';
  const value = seal({ refresh: 'private-refresh-token', expires: 2000 }, secret);
  assert.ok(!value.includes('private-refresh-token'));
  assert.equal(unseal(value, secret, 1000).refresh, 'private-refresh-token');
  assert.equal(unseal(value, 'wrong-key', 1000), null);
  assert.equal(unseal(value.slice(0, -3) + 'xxx', secret, 1000), null);
  assert.equal(unseal(value, secret, 2000), null);
  assert.match(cookie(value), /HttpOnly; Secure; SameSite=Lax/);
});

import { handleAuth } from '../server/handler.js';
const origin = 'https://daekyuny-diary.web.app';
function request(path, session = '', headers = {}) {
  const values = { origin, 'x-diary-auth': '1', cookie: session, ...headers };
  return { method: 'POST', path, body: { code: 'one-use-code' }, get: (key) => values[key] };
}
function response() {
  return {
    headers: {},
    code: 200,
    set(k, v) {
      this.headers[k] = v;
      return this;
    },
    status(code) {
      this.code = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}
test('code exchange stores only an encrypted refresh cookie and refresh returns access tokens', async () => {
  const secret = 'test-only-server-secret';
  const first = response();
  await handleAuth(request('/auth/code'), first, {
    secret,
    fetch: async (url, options) => {
      assert.equal(url, 'https://oauth2.googleapis.com/token');
      assert.equal(options.body.get('redirect_uri'), origin);
      return Response.json({
        access_token: 'short-lived',
        refresh_token: 'long-lived-private',
        expires_in: 3600,
        scope: 'drive.file',
      });
    },
  });
  assert.equal(first.code, 200);
  assert.equal(first.body.refresh_token, undefined);
  assert.ok(!first.headers['Set-Cookie'].includes('long-lived-private'));
  const next = response();
  await handleAuth(request('/auth/token', first.headers['Set-Cookie'].split(';')[0]), next, {
    secret,
    fetch: async (url, options) => {
      assert.equal(options.body.get('refresh_token'), 'long-lived-private');
      return Response.json({ access_token: 'renewed', expires_in: 3600 });
    },
  });
  assert.equal(next.body.access_token, 'renewed');
  assert.equal(next.body.scope, 'drive.file');
});
test('cross-origin requests, tampered sessions and missing offline grants cannot use a session', async () => {
  const secret = 'test-only-server-secret',
    forbidden = response();
  await handleAuth(request('/auth/token', '', { origin: 'https://untrusted.example' }), forbidden, {
    secret,
    fetch: () => {
      throw Error('must not fetch');
    },
  });
  assert.equal(forbidden.code, 403);
  const invalid = response();
  await handleAuth(request('/auth/token', '__session=tampered'), invalid, { secret });
  assert.equal(invalid.code, 401);
  const noRefresh = response();
  await handleAuth(request('/auth/code'), noRefresh, {
    secret,
    fetch: async () => Response.json({ access_token: 'short-only', expires_in: 3600 }),
  });
  assert.equal(noRefresh.code, 401);
});
