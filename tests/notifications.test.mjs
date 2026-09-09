import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { dueReminders, validateSchedule, deviceKey } from '../worker/index.js';
import {
  base64,
  bytes,
  concat,
  hkdf,
  encryptPayload,
  validEndpoint,
  vapidAuthorization,
} from '../worker/push.js';

const base = { daily: true, time: '21:00', timezone: 'Asia/Seoul', events: [], sent: {} };
test('daily reminders respect timezone, delivery window, and deduplication', () => {
  assert.equal(dueReminders(base, new Date('2026-09-09T11:59:00Z')).length, 0);
  assert.equal(dueReminders(base, new Date('2026-09-09T12:04:00Z')).length, 1);
  assert.equal(dueReminders(base, new Date('2026-09-09T12:16:00Z')).length, 0);
  assert.equal(
    dueReminders({ ...base, sent: { 'daily:2026-09-09': true } }, new Date('2026-09-09T12:04:00Z'))
      .length,
    0,
  );
  assert.equal(dueReminders({ ...base, daily: false }, new Date('2026-09-09T12:04:00Z')).length, 0);
});

test('event reminders do not fire early, repeat, or deliver stale events', () => {
  const event = { id: 'abc', at: '2026-09-09T05:10:00Z', date: '2026-09-09' };
  const config = { ...base, daily: false, events: [event] };
  assert.equal(dueReminders(config, new Date('2026-09-09T05:09:00Z')).length, 0);
  assert.equal(dueReminders(config, new Date('2026-09-09T05:12:00Z')).length, 1);
  assert.equal(dueReminders(config, new Date('2026-09-09T06:00:00Z')).length, 0);
  const sent = { [`event:${event.id}:${event.at}`]: '2026-09-09T05:12:00Z' };
  assert.equal(dueReminders({ ...config, sent }, new Date('2026-09-09T05:13:00Z')).length, 0);
});

test('push endpoints cannot target arbitrary or local servers', () => {
  assert.equal(validEndpoint('https://web.push.apple.com/QH/foo'), true);
  assert.equal(validEndpoint('https://fcm.googleapis.com/fcm/send/id'), true);
  for (const url of [
    'http://web.push.apple.com/id',
    'https://web.push.apple.com.attacker.com/id',
    'https://127.0.0.1/id',
    'https://user@web.push.apple.com/id',
    'https://web.push.apple.com:8443/id',
  ])
    assert.equal(validEndpoint(url), false);
});

test('encrypted Web Push payload can be independently decrypted by the subscriber', async () => {
  const receiver = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
  const receiverPublic = new Uint8Array(await crypto.subtle.exportKey('raw', receiver.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const subscription = {
    endpoint: 'https://web.push.apple.com/test',
    keys: { p256dh: base64(receiverPublic), auth: base64(auth) },
  };
  const payload = {
    title: '일정이 끝났어요',
    body: '한 줄 남기기',
    url: 'https://diary.example/?date=2026-09-09',
  };
  const encrypted = await encryptPayload(subscription, payload);
  const salt = encrypted.slice(0, 16);
  const keySize = encrypted[20];
  const senderPublic = encrypted.slice(21, 21 + keySize);
  assert.equal(new DataView(encrypted.buffer).getUint32(16), 4096);
  const senderKey = await crypto.subtle.importKey(
    'raw',
    senderPublic,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const secret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: senderKey }, receiver.privateKey, 256),
  );
  const material = await hkdf(
    secret,
    auth,
    concat(bytes('WebPush: info\0'), receiverPublic, senderPublic),
    32,
  );
  const key = await crypto.subtle.importKey(
    'raw',
    await hkdf(material, salt, bytes('Content-Encoding: aes128gcm\0'), 16),
    'AES-GCM',
    false,
    ['decrypt'],
  );
  const nonce = await hkdf(material, salt, bytes('Content-Encoding: nonce\0'), 12);
  const plaintext = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, encrypted.slice(21 + keySize)),
  );
  assert.equal(plaintext.at(-1), 2);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(plaintext.slice(0, -1))), payload);
  assert.equal(
    validateSchedule({ ...base, subscription }).subscription.endpoint,
    subscription.endpoint,
  );
  assert.throws(() => validateSchedule({ ...base, subscription, time: '25:00' }));
});

test('VAPID signature verifies with the public key and scopes to the push service', async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const env = {
    VAPID_PRIVATE_KEY: jwk.d,
    VAPID_PUBLIC_KEY: base64(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))),
    VAPID_SUBJECT: 'mailto:owner@example.com',
  };
  const auth = await vapidAuthorization('https://web.push.apple.com/test', env);
  const jwt = auth.match(/t=([^,]+)/)[1];
  const [header, payload, signature] = jwt.split('.');
  assert.equal(JSON.parse(Buffer.from(payload, 'base64url')).aud, 'https://web.push.apple.com');
  assert.equal(
    await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      pair.publicKey,
      Buffer.from(signature, 'base64url'),
      bytes(`${header}.${payload}`),
    ),
    true,
  );
});

test('notification API requires both allowed origin and owner token', async () => {
  const env = {
    APP_ORIGIN: 'https://diary.example',
    OWNER_TOKEN: 'a'.repeat(40),
    VAPID_PUBLIC_KEY: 'public',
  };
  const request = (origin, token) =>
    new Request('https://worker.example/config', {
      headers: { Origin: origin, Authorization: `Bearer ${token}` },
    });
  assert.equal(
    (await worker.fetch(request('https://attacker.example', env.OWNER_TOKEN), env)).status,
    403,
  );
  assert.equal((await worker.fetch(request(env.APP_ORIGIN, 'wrong'), env)).status, 401);
  assert.equal((await worker.fetch(request(env.APP_ORIGIN, env.OWNER_TOKEN), env)).status, 200);
  assert.notEqual(
    await deviceKey('https://web.push.apple.com/a'),
    await deviceKey('https://web.push.apple.com/b'),
  );
});
