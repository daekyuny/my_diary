import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeKeep, KEEP_PROBE_URL } from '../src/keep-probe-core.js';

test('probe uses a single read-only minimal request and never returns note data or tokens', async () => {
  const result = await probeKeep('secret', async (url, options) => {
    assert.equal(url, KEEP_PROBE_URL);
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.Authorization, 'Bearer secret');
    return new Response(JSON.stringify({ notes: [{ name: 'notes/private-id' }] }));
  });
  assert.equal(result.success, true);
  assert.equal(result.foundNote, true);
  assert.ok(!JSON.stringify(result).includes('private-id'));
  assert.ok(!JSON.stringify(result).includes('secret'));
});
test('empty successful note list is still API access success', async () => {
  assert.equal((await probeKeep('token', async () => new Response('{}'))).success, true);
});
test('permission failures retain diagnostic reasons without claiming unsupported account', async () => {
  const result = await probeKeep(
    'secret',
    async () =>
      new Response(
        JSON.stringify({
          error: {
            status: 'PERMISSION_DENIED',
            message: 'secret denied',
            details: [{ reason: 'SERVICE_DISABLED', metadata: { unused: 'secret' } }],
          },
        }),
        { status: 403 },
      ),
  );
  assert.equal(result.success, false);
  assert.deepEqual(result.reasons, ['SERVICE_DISABLED']);
  assert.ok(!JSON.stringify(result).includes('secret'));
});
test('non-JSON success is not mistaken for API access', async () => {
  assert.equal(
    (await probeKeep('token', async () => new Response('<html>login</html>'))).success,
    false,
  );
});
