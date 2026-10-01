import { expect } from '@playwright/test';
import { createHash } from 'node:crypto';
const scope = 'https://www.googleapis.com/auth/drive.appdata';
export async function mock(context, state) {
  await context.addInitScript((scope) => {
    window.diaryUploadBodies = [];
    const original = window.fetch.bind(window);
    window.fetch = async (input, options) => {
      if (String(input).includes('/upload/drive/v3/files') && options?.body instanceof Blob)
        window.diaryUploadBodies.push(Array.from(new Uint8Array(await options.body.arrayBuffer())));
      return original(input, options);
    };
    window.google = {
      accounts: {
        oauth2: {
          hasGrantedAllScopes: () => true,
          initTokenClient: (options) => ({
            requestAccessToken: () =>
              options.callback({ access_token: 'mock', expires_in: 3600, scope }),
          }),
        },
      },
    };
  }, scope);
  await context.route('https://accounts.google.com/**', (r) => r.abort());
  await context.route(/^https:\/\/www\.googleapis\.com\//, async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    const send = (json) => route.fulfill({ json });
    state.calls.push(`${request.method()} ${url.pathname}`);
    if (url.pathname === '/drive/v3/about')
      return send({ user: { permissionId: 'owner', emailAddress: 'test@example.com' } });
    if (url.pathname === '/drive/v3/changes/startPageToken')
      return send({ startPageToken: String(state.log.length) });
    if (url.pathname === '/drive/v3/changes') {
      const token = Number(url.searchParams.get('pageToken'));
      if (!Number.isInteger(token) || token > state.log.length)
        return route.fulfill({ status: 410, json: { error: { message: 'stale token' } } });
      return send({
        newStartPageToken: String(state.log.length),
        changes: state.log.slice(token).map((id) => {
          const file = state.files.get(id);
          const { bytes, ...meta } = file || {};
          return { fileId: id, removed: !file, file: file ? meta : undefined };
        }),
      });
    }
    if (url.pathname === '/drive/v3/files') {
      expect(request.method()).toBe('GET');
      if (url.searchParams.get('spaces') !== 'appDataFolder') return send({ files: [] });
      const q = url.searchParams.get('q');
      const ns = /key='namespace' and value='([^']+)'/.exec(q)?.[1];
      const kind = /key='kind' and value='([^']+)'/.exec(q)?.[1];
      return send({
        files: [...state.files.values()]
          .filter(
            (f) =>
              (!ns || f.appProperties.namespace === ns) && (!kind || f.appProperties.kind === kind),
          )
          .map(({ bytes, ...f }) => f),
      });
    }
    if (url.pathname === '/upload/drive/v3/files' && url.searchParams.has('upload_id')) {
      // Resumable chunk: 308 until the last byte arrives, then the file like a multipart upload.
      const captured = await request.frame().evaluate(() => window.diaryUploadBodies.shift());
      const session = state.sessions.get(url.searchParams.get('upload_id'));
      const range = /bytes (\d+)-(\d+)\/(\d+)/.exec(request.headers()['content-range']);
      expect(Number(range[1])).toBe(session.bytes.length);
      session.bytes = Buffer.concat([
        session.bytes,
        request.postDataBuffer() || Buffer.from(captured),
      ]);
      if (session.bytes.length < Number(range[3])) return route.fulfill({ status: 308 });
      const id = `private-${++state.next}`;
      state.files.set(id, {
        ...session.metadata,
        id,
        createdTime: new Date().toISOString(),
        bytes: session.bytes,
      });
      state.log.push(id);
      return send({ id, sha256Checksum: createHash('sha256').update(session.bytes).digest('hex') });
    }
    if (
      url.pathname === '/upload/drive/v3/files' &&
      url.searchParams.get('uploadType') === 'resumable'
    ) {
      const metadata = JSON.parse(request.postData());
      expect(metadata.parents).toEqual(['appDataFolder']);
      const uploadId = String(state.sessions.size + 1);
      metadata.mimeType = request.headers()['x-upload-content-type'];
      state.sessions.set(uploadId, { metadata, bytes: Buffer.alloc(0) });
      return route.fulfill({
        json: {},
        headers: {
          location: `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=${uploadId}`,
          'access-control-expose-headers': 'Location',
        },
      });
    }
    if (url.pathname === '/upload/drive/v3/files') {
      // Consume every attempt, including failures, to keep WebKit's Blob capture aligned.
      const captured = await request.frame().evaluate(() => window.diaryUploadBodies.shift());
      if (state.failWrites)
        return route.fulfill({ status: 503, json: { error: { message: 'retry upload' } } });
      const boundary = request.headers()['content-type'].split('boundary=')[1];
      const parts = (request.postDataBuffer() || Buffer.from(captured))
        .toString('binary')
        .split(`--${boundary}`);
      const metadata = JSON.parse(
        Buffer.from(parts[1].split('\r\n\r\n')[1].trim(), 'binary').toString(),
      );
      expect(metadata.parents).toEqual(['appDataFolder']);
      const bytes = Buffer.from(parts[2].slice(parts[2].indexOf('\r\n\r\n') + 4, -2), 'binary');
      const id = `private-${++state.next}`;
      state.files.set(id, { ...metadata, id, createdTime: new Date().toISOString(), bytes });
      state.log.push(id);
      return send({ id, sha256Checksum: createHash('sha256').update(bytes).digest('hex') });
    }
    if (url.pathname.startsWith('/drive/v3/files/')) {
      const id = url.pathname.split('/').at(-1);
      if (request.method() === 'DELETE') {
        state.files.delete(id);
        state.log.push(id);
        return send({});
      }
      const file = state.files.get(id);
      if (!file) return route.fulfill({ status: 404, json: { error: { message: 'missing' } } });
      return route.fulfill({
        body: file.bytes,
        contentType:
          file.mimeType || (file.name.startsWith('asset') ? 'image/png' : 'application/json'),
      });
    }
    throw new Error(`Unexpected ${request.method()} ${url}`);
  });
}
export const state = () => ({
  files: new Map(),
  log: [],
  next: 0,
  calls: [],
  sessions: new Map(),
});
// Pre-populate a repository the way the former Sheets migration left it: seeds plus a root.
export function seedRepository(state, revision, namespace = 'private-personal') {
  const put = (kind, key, value) => {
    const id = `private-${++state.next}`;
    state.files.set(id, {
      id,
      name: `${kind}-${key}`,
      parents: ['appDataFolder'],
      appProperties: { format: 'my-diary-private-v1', namespace, kind, key },
      createdTime: new Date().toISOString(),
      bytes: Buffer.from(JSON.stringify(value)),
    });
    state.log.push(id);
    return id;
  };
  const seed = put('seed', revision.id, revision);
  put('root', 'ready', {
    format: 'my-diary-private-v1',
    seeds: [{ id: seed, entryId: revision.entry.id }],
    retentionDays: 30,
  });
  return seed;
}
export async function connect(page, fresh) {
  await page.goto('/');
  await expect(page.locator('#banner-connect')).toBeEnabled();
  await page.locator('#banner-connect').click();
  if (fresh) await page.locator('#create-repository').click();
  await expect(page.locator('#connection')).toHaveText('클라우드 연결됨');
}

export function device(testInfo) {
  const { viewport, isMobile, hasTouch, deviceScaleFactor, userAgent } = testInfo.project.use;
  return { viewport, isMobile, hasTouch, deviceScaleFactor, userAgent, serviceWorkers: 'block' };
}
