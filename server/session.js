import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
const key = (secret) => createHash('sha256').update(`my-diary-session:${secret}`).digest();
export function seal(value, secret) {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key(secret), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url');
}
// Returns `{ data }` for a usable session, otherwise `{ reason }` so rejections can be logged.
export function open(value, secret, now = Date.now()) {
  if (!value) return { reason: 'empty' };
  let data;
  try {
    const bytes = Buffer.from(value, 'base64url');
    const cipher = createDecipheriv('aes-256-gcm', key(secret), bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(12, 28));
    data = JSON.parse(
      Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString(),
    );
  } catch {
    return { reason: 'undecryptable' };
  }
  if (typeof data?.refresh !== 'string') return { reason: 'malformed' };
  if (!(data.expires > now)) return { reason: 'expired', expires: data.expires };
  return { data };
}
export function unseal(value, secret, now = Date.now()) {
  return open(value, secret, now).data ?? null;
}
export function cookie(value, maxAge = 15552000) {
  // Firebase Hosting forwards only the reserved __session cookie to Functions.
  return `__session=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
