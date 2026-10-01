import { test } from 'node:test';
import assert from 'node:assert/strict';
import { durationLabel } from '../src/journal/labels.js';
import { attachmentPreviewHTML, cards } from '../src/journal/views.js';
import { driveStore, UPLOAD_CHUNK } from '../src/journal/appdata.js';
import * as google from '../src/google.js';
import { createHash } from 'node:crypto';
import { newEntry, makeRevision } from '../src/model.js';
import { makeBackup, parseArchive } from '../src/journal/backup.js';

test('video length reads as minutes and seconds, with hours when needed', () => {
  assert.equal(durationLabel(7), '0:07');
  assert.equal(durationLabel(205), '3:25');
  assert.equal(durationLabel(3723), '1:02:03');
});

test('video previews carry a play mark and length, photos stay plain', () => {
  const video = attachmentPreviewHTML({ id: 'v"1', type: 'video/mp4', duration: 12 }, 'blob:x');
  assert.match(video, /video-preview/);
  assert.match(video, /aria-label="동영상 재생"/);
  assert.match(video, /0:12<\/span>/);
  assert.match(video, /data-open-photo="v&quot;1"/);
  const photo = attachmentPreviewHTML({ id: 'p', type: 'image/png' }, 'blob:y');
  assert.doesNotMatch(photo, /video/);
});

test('cards count photos and videos separately', () => {
  const entry = {
    ...newEntry('2026-09-29'),
    images: [
      { id: 'a', name: 'a', type: 'image/jpeg' },
      { id: 'b', name: 'b', type: 'video/mp4' },
      { id: 'c', name: 'c', type: 'image/png' },
    ],
  };
  const html = cards([{ latest: makeRevision(entry), heads: [] }], 'list');
  assert.match(html, /aria-label="사진 2개"/);
  assert.match(html, /aria-label="동영상 1개"/);
});

test('videos upload in resumable chunks and the checksum is verified', async () => {
  const requests = [];
  const bytes = new Uint8Array(UPLOAD_CHUNK * 2 + 1000).map((_, i) => i % 251);
  let stored = Buffer.alloc(0);
  globalThis.fetch = async (url, options) => {
    const body =
      options.body instanceof Blob
        ? new Uint8Array(await options.body.arrayBuffer())
        : options.body;
    requests.push({ url: String(url), method: options.method, headers: options.headers });
    const reply = (status, json = {}, headers = {}) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(headers),
      clone: () => ({ arrayBuffer: async () => new ArrayBuffer(0) }),
      json: async () => json,
    });
    if (String(url).includes('uploadType=resumable') && options.method === 'POST') {
      assert.equal(JSON.parse(body).appProperties.kind, 'asset');
      assert.equal(options.headers['X-Upload-Content-Type'], 'video/mp4');
      return reply(200, {}, { Location: 'https://www.googleapis.com/upload/session-1' });
    }
    stored = Buffer.concat([stored, body]);
    if (stored.length < bytes.length) return reply(308);
    const sha = createHash('sha256').update(stored).digest('hex');
    return reply(200, { id: 'file-1', sha256Checksum: sha });
  };
  globalThis.google = {
    accounts: {
      oauth2: {
        hasGrantedAllScopes: () => true,
        initTokenClient: (options) => ({
          requestAccessToken: () =>
            options.callback({ access_token: 't', expires_in: 3600, scope: google.APPDATA_SCOPE }),
        }),
      },
    },
  };
  google.configureGoogle('client', false);
  await google.authorize();
  const id = await driveStore.write('ns', 'asset', 'key', new Blob([bytes], { type: 'video/mp4' }));
  assert.equal(id, 'file-1');
  const puts = requests.filter((r) => r.method === 'PUT');
  assert.deepEqual(
    puts.map((r) => r.headers['Content-Range']),
    [
      `bytes 0-${UPLOAD_CHUNK - 1}/${bytes.length}`,
      `bytes ${UPLOAD_CHUNK}-${UPLOAD_CHUNK * 2 - 1}/${bytes.length}`,
      `bytes ${UPLOAD_CHUNK * 2}-${bytes.length - 1}/${bytes.length}`,
    ],
  );
  assert.ok(puts.every((r) => r.url === 'https://www.googleapis.com/upload/session-1'));
  assert.ok(stored.equals(Buffer.from(bytes)));
  google.disconnect();
});

test('backups carry video originals and import them back', async () => {
  const entry = {
    ...newEntry('2026-09-29'),
    title: '동영상 백업',
    images: [{ id: 'clip-1', name: 'clip-1-original.mov', type: 'video/quicktime' }],
  };
  const bytes = new Uint8Array([0, 0, 0, 20, 102, 116, 121, 112]);
  const zip = await makeBackup([makeRevision(entry)], async () => new Blob([bytes]));
  const { revisions, assets } = parseArchive(new Uint8Array(await zip.arrayBuffer()));
  assert.equal(revisions[0].entry.images[0].type, 'video/quicktime');
  assert.equal(assets[0].blob.type, 'video/quicktime');
  assert.deepEqual(new Uint8Array(await assets[0].blob.arrayBuffer()), bytes);
});
