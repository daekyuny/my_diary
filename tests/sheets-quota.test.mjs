import test from 'node:test';
import assert from 'node:assert/strict';
import { createSheetsQuota } from '../src/sheets-quota.js';

test('Sheets limits concurrent requests in separate read and write windows', async () => {
  let time = 0;
  const waits = [];
  const quota = createSheetsQuota({
    now: () => time,
    sleep: async (ms) => {
      waits.push(ms);
      time += ms;
    },
  });
  await Promise.all(Array.from({ length: 45 }, () => quota.reserve('POST')));
  await quota.reserve('GET');
  assert.deepEqual(waits, []);
  await Promise.all(Array.from({ length: 46 }, () => quota.reserve('POST')));
  assert.deepEqual(waits, [61000, 61000]);
});

test('quota retries respect Retry-After and stop without retrying ambiguous failures', async () => {
  const waits = [];
  const quota = createSheetsQuota({ sleep: async (ms) => waits.push(ms) });
  assert.equal(
    await quota.retry(new Response('', { status: 429, headers: { 'Retry-After': '90' } }), 0),
    true,
  );
  assert.equal(waits[0], 90000);
  assert.equal(await quota.retry(new Response('', { status: 429 }), 6), false);
  assert.equal(await quota.retry(new Response('', { status: 503 }), 0), false);
  assert.equal(waits.length, 1);
});
