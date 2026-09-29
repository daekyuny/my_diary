import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppDataRepository, openRepository } from '../src/journal/appdata.js';
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
const json = (value) => new Blob([JSON.stringify(value)], { type: 'application/json' });
// Mirror what the former Sheets migration wrote: one seed per diary plus a root listing them.
async function setup(revisions = [], retentionDays = 30) {
  const io = memory();
  const seeds = [];
  for (const r of revisions)
    seeds.push({ id: await io.write('sheet', 'seed', r.id, json(r)), entryId: r.entry.id });
  await io.write(
    'sheet',
    'root',
    'ready',
    json({ format: 'my-diary-private-v1', seeds, retentionDays }),
  );
  const repo = await openRepository('sheet', { io });
  return { io, repo };
}
test('opening requires a root and migrated seeds load with their retention setting', async () => {
  await assert.rejects(openRepository('sheet', { io: memory() }), /연결 또는 이전/);
  const r = makeRevision({ ...newEntry(), body: '이전한 일기' });
  const { repo } = await setup([r], 90);
  const [saved] = await repo.list();
  assert.equal(saved.entry.body, '이전한 일기');
  assert.equal(saved.sheetSaved, true);
  assert.equal(repo.retentionDays, 90);
});
test('reload reuses immutable JSON while discovering new revisions and purge markers', async () => {
  const first = makeRevision(newEntry());
  const { io } = await setup([first]);
  const cached = new Map();
  const cacheStore = {
    async load() {
      return [...cached].map(([id, revision]) => ({ id, revision }));
    },
    async put(id, revision) {
      cached.set(id, revision);
    },
    async prune(ids) {
      for (const id of cached.keys()) if (!ids.has(id)) cached.delete(id);
    },
  };
  const reads = [];
  const read = io.read.bind(io);
  io.read = async (id) => {
    reads.push(id);
    return read(id);
  };
  await new AppDataRepository('sheet', io, { cacheStore }).list();
  const seedId = [...cached.keys()][0];
  reads.length = 0;
  const refreshed = new AppDataRepository('sheet', io, { cacheStore });
  assert.equal((await refreshed.list())[0].id, first.id);
  assert.ok(!reads.includes(seedId));
  const newer = makeRevision({ ...first.entry, body: 'another device' }, [first.id]);
  const newId = await io.write('sheet', 'revision', newer.id, new Blob([JSON.stringify(newer)]));
  assert.equal((await refreshed.list())[0].entry.body, 'another device');
  assert.equal(reads.filter((id) => id === newId).length, 1);
  await io.write('sheet', 'purge', first.entry.id, new Blob(['{}']));
  assert.deepEqual(await refreshed.list(), []);
  assert.equal(cached.size, 0);
});
test('cold loading bounds parallel reads and survives unavailable local cache', async () => {
  const revisions = Array.from({ length: 20 }, () => makeRevision(newEntry()));
  const { io } = await setup(revisions);
  const read = io.read.bind(io);
  let active = 0,
    peak = 0;
  io.read = async (id) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return read(id);
  };
  const unavailable = async () => {
    throw new Error('cache unavailable');
  };
  const repo = new AppDataRepository('sheet', io, {
    cacheStore: { load: unavailable, put: unavailable, prune: unavailable },
  });
  assert.equal((await repo.list()).length, 20);
  assert.ok(peak > 1 && peak <= 6);
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
