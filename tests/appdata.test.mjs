import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppDataRepository, migrateRepository } from '../src/journal/appdata.js';
import { newEntry, makeRevision } from '../src/model.js';

function memory() {
  const files = new Map();
  let count = 0;
  return {
    files,
    async list(namespace, kind) {
      return [...files.values()].filter(
        (f) =>
          (!namespace || f.appProperties.namespace === namespace) &&
          (!kind || f.appProperties.kind === kind),
      );
    },
    async read(id) {
      if (!files.has(id)) throw new Error(`Missing ${id}`);
      return files.get(id).blob;
    },
    async write(namespace, kind, key, blob) {
      const id = `f${++count}`;
      files.set(id, { id, appProperties: { namespace, kind, key }, blob });
      return id;
    },
    async remove(id) {
      files.delete(id);
    },
  };
}
async function setup(revisions = []) {
  const io = memory();
  const snapshot = async () => ({ revisions, retentionDays: 30 });
  const repo = await migrateRepository('sheet', { io, snapshot });
  return { io, repo, snapshot };
}
test('migration preserves diary contents, metadata and source while copying original and thumbnail', async () => {
  const io = memory();
  const photo = await io.write('old', 'original', 'p', new Blob(['original']));
  const thumb = await io.write('old', 'original', 't', new Blob(['thumbnail']));
  const r = makeRevision({
    ...newEntry(),
    body: '일기',
    images: [
      {
        id: 'photo',
        name: 'p.jpg',
        type: 'image/jpeg',
        driveId: photo,
        thumbnail: { id: 'photo-thumbnail', name: 't.jpg', type: 'image/jpeg', driveId: thumb },
      },
    ],
  });
  const snapshot = async () => ({ revisions: [r], retentionDays: 90 });
  const repo = await migrateRepository('sheet', { io, snapshot });
  const [saved] = await repo.list();
  assert.equal(saved.entry.body, r.entry.body);
  assert.equal(repo.retentionDays, 90);
  assert.notEqual(saved.entry.images[0].driveId, photo);
  assert.equal(await (await io.read(saved.entry.images[0].driveId)).text(), 'original');
  assert.equal(saved.entry.images[0].appOwner, `sheet:${r.entry.id}`);
  assert.equal(r.entry.images[0].driveId, photo);
  assert.ok(io.files.has(photo));
  const before = io.files.size;
  await migrateRepository('sheet', {
    io,
    snapshot: () => {
      throw new Error('must not reread source');
    },
  });
  assert.equal(io.files.size, before);
});
test('changed source does not commit migration and a retry recovers', async () => {
  const io = memory();
  const r = makeRevision(newEntry());
  let reads = 0;
  await assert.rejects(
    migrateRepository('sheet', {
      io,
      snapshot: async () => ({
        revisions: [{ ...r, entry: { ...r.entry, body: String(++reads) } }],
        retentionDays: 30,
      }),
    }),
    /변경/,
  );
  assert.equal((await io.list('sheet', 'root')).length, 0);
  const repo = await migrateRepository('sheet', {
    io,
    snapshot: async () => ({ revisions: [r], retentionDays: 30 }),
  });
  assert.equal((await repo.list()).length, 1);
});
test('concurrent devices preserve both edits and resolving keeps a separate copy', async () => {
  const first = makeRevision(newEntry());
  const { repo: a, io } = await setup([first]);
  const b = new AppDataRepository('sheet', io);
  const left = makeRevision({ ...first.entry, body: 'PC' }, [first.id]);
  const right = makeRevision({ ...first.entry, body: 'phone' }, [first.id]);
  await Promise.all([a.save(left), b.save(right)]);
  const [conflicted] = await a.list();
  assert.ok(conflicted.cloudConflict);
  assert.deepEqual(
    new Set([conflicted.entry.body, conflicted.conflict.entry.body]),
    new Set(['PC', 'phone']),
  );
  const copy = makeRevision({ ...conflicted.entry, id: crypto.randomUUID() });
  await a.resolve(conflicted, copy);
  const result = await b.list();
  assert.equal(result.length, 2);
  assert.ok(result.every((r) => !r.conflict));
  assert.deepEqual(new Set(result.map((r) => r.entry.body)), new Set(['PC', 'phone']));
});
test('retry after lost acknowledgement is idempotent', async () => {
  const { repo } = await setup();
  const r = makeRevision(newEntry());
  await repo.save(r);
  await repo.save(r);
  assert.equal((await repo.list()).length, 1);
  assert.equal(repo.versions.length, 1);
});
test('purge removes owned bytes and revisions, keeps source and blocks offline resurrection', async () => {
  const r = makeRevision({ ...newEntry(), deletedAt: '2020-01-01T00:00:00Z' });
  const { repo, io } = await setup([r]);
  const owned = await io.write(`sheet:${r.entry.id}`, 'asset', 'photo', new Blob(['photo']));
  const other = await io.write('another', 'asset', 'photo', new Blob(['other']));
  assert.deepEqual(await repo.purge(30), [r.entry.id]);
  assert.equal((await repo.list()).length, 0);
  assert.ok(!io.files.has(owned));
  assert.ok(io.files.has(other));
  await assert.rejects(repo.save(makeRevision({ ...r.entry, body: 'stale' }, [r.id])), /완전 삭제/);
});

test('backup roundtrip keeps all conflicting text and resets remote attachment ownership', async () => {
  const { makeBackup, parseArchive } = await import('../src/journal/backup.js');
  const r = makeRevision({
    ...newEntry(),
    body: 'first',
    images: [
      {
        id: 'image',
        name: 'x.jpg',
        type: 'image/jpeg',
        driveId: 'remote',
        storage: 'appDataFolder',
        appOwner: 'old',
      },
    ],
  });
  const second = makeRevision({ ...r.entry, body: 'second' });
  const archive = await makeBackup(
    [{ ...r, conflict: second, cloudConflict: true }],
    async () => new Blob(['photo']),
  );
  const result = parseArchive(new Uint8Array(await archive.arrayBuffer()));
  assert.equal(result.revisions.length, 2);
  assert.equal(new Set(result.revisions.map((v) => v.entry.id)).size, 2);
  assert.deepEqual(
    new Set(result.revisions.map((v) => v.entry.body)),
    new Set(['first', 'second']),
  );
  assert.ok(result.revisions.every((v) => !v.conflict && !v.entry.images[0].storage));
});

test('entries exceeding the backup import limit are not published', async () => {
  const { repo, io } = await setup();
  await assert.rejects(
    repo.save(makeRevision({ ...newEntry(), body: 'a'.repeat(120001) })),
    /12만/,
  );
  assert.equal((await io.list('sheet', 'revision')).length, 0);
});
