const encoder = new TextEncoder();
export const bytes = (value) => encoder.encode(value);
export const concat = (...arrays) => {
  const output = new Uint8Array(arrays.reduce((sum, array) => sum + array.length, 0));
  let at = 0;
  for (const array of arrays) {
    output.set(array, at);
    at += array.length;
  }
  return output;
};
export const unbase64 = (value) =>
  Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0));
export const base64 = (value) =>
  btoa(String.fromCharCode(...value))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

export async function hkdf(material, salt, info, length) {
  const key = await crypto.subtle.importKey('raw', material, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8),
  );
}

export async function encryptPayload(subscription, payload) {
  const receiverPublic = unbase64(subscription.keys.p256dh);
  const receiver = await crypto.subtle.importKey(
    'raw',
    receiverPublic,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const sender = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
  const senderPublic = new Uint8Array(await crypto.subtle.exportKey('raw', sender.publicKey));
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: receiver }, sender.privateKey, 256),
  );
  const material = await hkdf(
    shared,
    unbase64(subscription.keys.auth),
    concat(bytes('WebPush: info\0'), receiverPublic, senderPublic),
    32,
  );
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    'raw',
    await hkdf(material, salt, bytes('Content-Encoding: aes128gcm\0'), 16),
    'AES-GCM',
    false,
    ['encrypt'],
  );
  const nonce = await hkdf(material, salt, bytes('Content-Encoding: nonce\0'), 12);
  const plaintext = concat(bytes(JSON.stringify(payload)), new Uint8Array([2]));
  if (plaintext.length > 3000) throw new Error('Notification payload is too large');
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, plaintext),
  );
  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096);
  return concat(salt, recordSize, new Uint8Array([senderPublic.length]), senderPublic, ciphertext);
}

export async function vapidAuthorization(endpoint, env) {
  const rawPublic = unbase64(env.VAPID_PUBLIC_KEY);
  const key = await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      x: base64(rawPublic.slice(1, 33)),
      y: base64(rawPublic.slice(33, 65)),
      d: env.VAPID_PRIVATE_KEY,
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const jwt = `${base64(bytes(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))}.${base64(bytes(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 3600, sub: env.VAPID_SUBJECT })))}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, bytes(jwt)),
  );
  return `vapid t=${jwt}.${base64(signature)}, k=${env.VAPID_PUBLIC_KEY}`;
}

export function validEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      (url.hostname === 'web.push.apple.com' ||
        url.hostname === 'fcm.googleapis.com' ||
        url.hostname === 'updates.push.services.mozilla.com')
    );
  } catch {
    return false;
  }
}

export async function sendPush(subscription, payload, env) {
  if (!validEndpoint(subscription.endpoint)) throw new Error('Unsupported push endpoint');
  const body = await encryptPayload(subscription, payload);
  const response = await fetch(subscription.endpoint, {
    method: 'POST',
    redirect: 'error',
    headers: {
      Authorization: await vapidAuthorization(subscription.endpoint, env),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '900',
      Urgency: 'normal',
    },
    body,
  });
  if (!response.ok && response.status !== 404 && response.status !== 410)
    throw new Error(`Push service returned ${response.status}`);
  return response.status;
}
