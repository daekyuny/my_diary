import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppDataRepository, openRepository } from '../src/journal/appdata.js';
import { newEntry, makeRevision } from '../src/model.js';

function memory() {
  const files = new Map();
  const log = [];
  let count = 0;
  return {
    files,
    log,
    async startToken() {
      return String(log.length);
    },
    async changes(token) {
      if (!/^\d+$/.test(token) || Number(token) > log.length) {
        const error = new Error('stale');
        error.stale = true;
        throw error;
      }
      return {
        changes: log.slice(Number(token)).map((id) => ({
          fileId: id,
          removed: !files.has(id),
          file: files.has(id) ? { ...files.get(id), blob: undefined } : undefined,
        })),
        token: String(log.length),
      };
    },
    async list(namespace, kind) {
      return [...files.values()].filter(
        (f) =>
          (!namespace || f.appProperties.namespace === namespace) &&
          (!kind || f.appProperties.kind === kind),
      );
    },
    async read(id) {
      if (!files.has(id)) {
        const error = new Error(`Missing ${id}`);
        error.status = 404;
        throw error;
      }
      return files.get(id).blob;
    },
    async write(namespace, kind, key, blob) {
      const id = `f${++count}`;
      files.set(id, {
        id,
        appProperties: { format: 'my-diary-private-v1', namespace, kind, key },
        createdTime: new Date(Date.now() - 60000 + count).toISOString(),
        blob,
      });
      log.push(id);
      return id;
    },
    async remove(id) {
      files.delete(id);
      log.push(id);
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
test('saving a batch lists once and extends the index without another listing', async () => {
  const first = makeRevision(newEntry());
  const { repo, io } = await setup([first]);
  const cached = new Map();
  const cacheStore = {
    async load() {
      return [];
    },
    async put(id, revision) {
      cached.set(id, revision);
    },
    async prune() {},
  };
  const counting = new AppDataRepository('sheet', io, { cacheStore });
  let lists = 0;
  for (const name of ['list', 'changes']) {
    const original = io[name].bind(io);
    io[name] = async (...args) => {
      lists++;
      return original(...args);
    };
  }
  await counting.list();
  lists = 0;
  const a = makeRevision({ ...first.entry, body: 'A' }, [first.id]);
  const b = makeRevision(newEntry());
  await counting.saveMany([a, b]);
  assert.equal(lists, 1);
  assert.deepEqual(new Set(counting.index.map((r) => r.id)), new Set([a.id, b.id]));
  assert.equal([...cached.values()].filter((r) => [a.id, b.id].includes(r.id)).length, 2);
  assert.equal((await repo.list()).length, 2);
  lists = 0;
  await counting.purge(30);
  assert.equal(lists, 0);
});
function listingCache() {
  let listing = null;
  const revisions = new Map();
  return {
    async load() {
      return [...revisions].map(([id, revision]) => ({ id, revision }));
    },
    async put(id, revision) {
      revisions.set(id, revision);
    },
    async prune(ids) {
      for (const id of revisions.keys()) if (!ids.has(id)) revisions.delete(id);
    },
    async loadListing() {
      return listing;
    },
    async saveListing(value) {
      listing = structuredClone(value);
    },
  };
}
function countRequests(io) {
  const counts = { list: 0, changes: 0, startToken: 0, read: 0 };
  for (const name of Object.keys(counts)) {
    const original = io[name].bind(io);
    io[name] = async (...args) => {
      counts[name]++;
      return original(...args);
    };
  }
  return counts;
}
test('a restored listing asks Drive for changes only and applies writes and removals', async () => {
  const first = makeRevision(newEntry());
  const { io } = await setup([first]);
  const cacheStore = listingCache();
  await new AppDataRepository('sheet', io, { cacheStore }).list();
  const counts = countRequests(io);
  const reloaded = new AppDataRepository('sheet', io, { cacheStore });
  assert.equal((await reloaded.list())[0].id, first.id);
  assert.deepEqual(counts, { list: 0, changes: 1, startToken: 0, read: 0 });
  const other = new AppDataRepository('sheet', io);
  const newer = makeRevision({ ...first.entry, body: 'other device' }, [first.id]);
  await other.save(newer);
  const doomed = makeRevision({ ...newEntry(), deletedAt: '2020-01-01T00:00:00Z' });
  await other.save(doomed);
  const reset = () => Object.assign(counts, { list: 0, changes: 0, startToken: 0, read: 0 });
  reset();
  assert.equal((await reloaded.list()).length, 2);
  assert.equal(
    reloaded.index.find((r) => r.entry.id === first.entry.id).entry.body,
    'other device',
  );
  assert.equal(counts.list, 0);
  assert.equal(counts.changes, 1);
  await other.purge(30);
  reset();
  assert.equal((await reloaded.list()).length, 1);
  assert.equal(counts.list, 0);
  const retention = await io.write(
    'sheet',
    'retention',
    'r',
    new Blob([JSON.stringify({ days: 7 })]),
  );
  await reloaded.list();
  assert.equal(reloaded.retentionDays, 7);
  assert.ok(reloaded.files.some((f) => f.id === retention));
});
test('a stale change token falls back to a full listing with a fresh token', async () => {
  const { io } = await setup([makeRevision(newEntry())]);
  const cacheStore = listingCache();
  const repo = new AppDataRepository('sheet', io, { cacheStore });
  await repo.list();
  await cacheStore.saveListing({ token: 'expired', files: repo.files, root: repo.root });
  const counts = countRequests(io);
  const reloaded = new AppDataRepository('sheet', io, { cacheStore });
  assert.equal((await reloaded.list()).length, 1);
  assert.deepEqual(counts, { list: 1, changes: 1, startToken: 1, read: 0 });
  assert.equal(reloaded.token, String(io.log.length));
  assert.equal((await cacheStore.loadListing()).token, reloaded.token);
});
test('compaction keeps every head, drops superseded revisions and seeds, and tolerates races', async () => {
  const seed = makeRevision(newEntry());
  const { repo, io } = await setup([seed]);
  const a = makeRevision({ ...seed.entry, body: 'A' }, [seed.id]);
  const b = makeRevision({ ...seed.entry, body: 'B' }, [a.id]);
  await repo.saveMany([a, b]);
  const other = makeRevision(newEntry());
  const left = makeRevision({ ...other.entry, body: 'left' }, [other.id]);
  const right = makeRevision({ ...other.entry, body: 'right' }, [other.id]);
  await repo.saveMany([other, left, right]);
  assert.equal(await repo.compact({ minAge: 3600000 }), 0);
  assert.equal(await repo.compact({ minAge: 0, now: Date.now() + 1 }), 3);
  const kinds = (await io.list('sheet')).map((f) => f.appProperties.kind);
  assert.equal(kinds.filter((k) => k === 'seed').length, 0);
  assert.equal(kinds.filter((k) => k === 'revision').length, 3);
  const fresh = new AppDataRepository('sheet', io);
  const index = await fresh.list();
  assert.equal(index.length, 2);
  assert.equal(index.find((r) => r.entry.id === seed.entry.id).entry.body, 'B');
  assert.ok(index.find((r) => r.entry.id === other.entry.id).cloudConflict);
  // A newer edit based on the surviving head is still not a conflict afterwards.
  const c = makeRevision({ ...seed.entry, body: 'C' }, [b.id]);
  await fresh.save(c);
  assert.ok(!(await fresh.list()).find((r) => r.entry.id === seed.entry.id).conflict);
  // A listing taken before another device compacted still loads by skipping missing files.
  const stale = new AppDataRepository('sheet', io);
  await stale.list();
  const victim = stale.files.find((f) => stale.cache.get(f.id)?.id === b.id);
  io.files.delete(victim.id);
  stale.cache.delete(victim.id);
  stale.files = [...stale.files];
  stale.token = null;
  io.list = async () => stale.files;
  assert.equal((await stale.list()).length, 2);
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
