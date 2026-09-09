import { writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
  'sign',
  'verify',
]);
const privateKey = await crypto.subtle.exportKey('jwk', pair.privateKey);
const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString(
  'base64url',
);
await writeFile(
  new URL('../worker/.dev.vars', import.meta.url),
  `VAPID_PUBLIC_KEY=${publicKey}\nVAPID_PRIVATE_KEY=${privateKey.d}\nOWNER_TOKEN=${randomBytes(32).toString('base64url')}\n`,
  { mode: 0o600, flag: 'wx' },
);
console.log(
  'Created worker/.dev.vars (private, excluded from git). Never include it in the web build.',
);
