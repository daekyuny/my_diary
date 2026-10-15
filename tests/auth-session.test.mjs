import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seal, unseal, open, cookie } from '../server/session.js';
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

test('first offline grant without a scope field still returns a session', async () => {
  const result = response();
  await handleAuth(request('/auth/code'), result, {
    secret: 'test',
    fetch: async () =>
      Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }),
  });
  assert.equal(result.code, 200);
  assert.equal(result.body.access_token, 'access');
});

test('OAuth failures identify configuration errors without exposing provider details', async () => {
  for (const reason of [
    'invalid_client',
    'unauthorized_client',
    'redirect_uri_mismatch',
    'invalid_grant',
    'unexpected',
  ]) {
    const result = response();
    await handleAuth(request('/auth/code'), result, {
      secret: 'private-secret',
      fetch: async () =>
        Response.json(
          { error: reason, error_description: 'private-provider-detail' },
          { status: 400 },
        ),
    });
    assert.equal(result.code, reason === 'invalid_grant' ? 401 : 502);
    if (reason !== 'unexpected') assert.ok(result.body.error.includes(reason));
    assert.ok(!JSON.stringify(result.body).includes('private-'));
  }
});

test('session rejections report why without revealing the cookie', () => {
  const secret = 'test-only-server-secret';
  assert.equal(open('', secret).reason, 'empty');
  assert.equal(open('not-a-session', secret).reason, 'undecryptable');
  assert.equal(open(seal({ expires: 2000 }, secret), secret, 1000).reason, 'malformed');
  const expired = open(seal({ refresh: 'r', expires: 2000 }, secret), secret, 3000);
  assert.deepEqual(expired, { reason: 'expired', expires: 2000 });
  assert.equal(open(seal({ refresh: 'r', expires: 2000 }, secret), secret, 1000).data.refresh, 'r');
});

test('refresh without a usable cookie logs the cookie state but not its value', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const secret = 'test-only-server-secret';
  for (const [cookieHeader, session, cookies] of [
    ['', 'missing', 0],
    ['other=1; __session=private-garbage', 'undecryptable', 1],
    ['__session=; __session=private-second', 'empty', 2],
  ]) {
    const result = response();
    await handleAuth(request('/auth/token', cookieHeader), result, { secret });
    assert.equal(result.code, 401);
    const [label, detail] = warn.mock.calls.at(-1).arguments;
    assert.equal(label, 'diary_auth_session_rejected');
    assert.equal(detail.session, session);
    assert.equal(detail.cookies, cookies);
    assert.ok(!JSON.stringify(detail).includes('private-'));
  }
});

test('Google refusals and new grants are logged with their reason and grant lifetime', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const info = t.mock.method(console, 'info', () => {});
  const secret = 'test-only-server-secret';
  const valid = `__session=${seal({ refresh: 'r', expires: Date.now() + 60000 }, secret)}`;
  await handleAuth(request('/auth/token', valid), response(), {
    secret,
    fetch: async () =>
      Response.json(
        { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
        { status: 400 },
      ),
  });
  assert.equal(warn.mock.calls[0].arguments[1].description, 'Token has been expired or revoked.');
  await handleAuth(request('/auth/code', '__session=stale'), response(), {
    secret,
    fetch: async () =>
      Response.json({
        access_token: 'a',
        refresh_token: 'r',
        refresh_token_expires_in: 86400,
        expires_in: 3600,
      }),
  });
  const [label, detail] = info.mock.calls[0].arguments;
  assert.equal(label, 'diary_auth_granted');
  assert.equal(detail.previous.session, 'undecryptable');
  assert.equal(detail.refreshExpiresIn, 86400);
});
