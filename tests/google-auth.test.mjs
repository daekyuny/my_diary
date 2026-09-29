import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as google from '../src/google.js';

// Node has no sessionStorage; google.js guards every access, so the flows run unchanged here.
test('auth server code flow stores the token and reports appdata access', async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return {
      ok: true,
      json: async () => ({ access_token: 'access', expires_in: 3600, scope: google.APPDATA_SCOPE }),
    };
  };
  globalThis.google = {
    accounts: {
      oauth2: {
        initCodeClient: (options) => ({ requestCode: () => options.callback({ code: 'code-1' }) }),
      },
    },
  };
  google.configureGoogle('client', true);
  await google.authorize();
  assert.equal(google.connected(), true);
  assert.equal(google.hasAppData(), true);
  assert.deepEqual(calls, ['/auth/code']);
  google.disconnect();
  assert.equal(google.connected(), false);
});

test('token client flow requests only appdata and optional calendar scopes', async () => {
  let requested;
  globalThis.google = {
    accounts: {
      oauth2: {
        hasGrantedAllScopes: () => true,
        initTokenClient: (options) => {
          requested = options.scope;
          return {
            requestAccessToken: () =>
              options.callback({ access_token: 'a', expires_in: 3600, scope: options.scope }),
          };
        },
      },
    },
  };
  google.configureGoogle('client', false);
  await google.authorize(true);
  assert.equal(requested, `${google.APPDATA_SCOPE} ${google.CALENDAR_SCOPE}`);
  assert.equal(google.hasAppData(), true);
  assert.equal(google.hasCalendar(), true);
});
