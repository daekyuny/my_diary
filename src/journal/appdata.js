import * as google from '../google.js';
import { validateRevision, entryGroups, makeRevision } from '../model.js';
import { expired } from './current.js';

const FORMAT = 'my-diary-private-v1';
const jsonBlob = (value) => new Blob([JSON.stringify(value)], { type: 'application/json' });
const quote = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
export const driveStore = {
  async list(namespace, kind) {
    let pageToken = '';
    const files = [];
    do {
      const q = [`trashed = false`, `appProperties has { key='format' and value='${FORMAT}' }`];
      if (namespace)
        q.push(`appProperties has { key='namespace' and value='${quote(namespace)}' }`);
      if (kind) q.push(`appProperties has { key='kind' and value='${quote(kind)}' }`);
      const params = new URLSearchParams({
        spaces: 'appDataFolder',
        q: q.join(' and '),
        fields: 'nextPageToken,files(id,name,appProperties,createdTime)',
        pageSize: '1000',
        ...(pageToken ? { pageToken } : {}),
      });
      const data = await (await google.request(`drive/v3/files?${params}`)).json();
      files.push(...data.files);
      pageToken = data.nextPageToken;
    } while (pageToken);
    return files.sort((a, b) =>
      `${a.createdTime}:${a.id}`.localeCompare(`${b.createdTime}:${b.id}`),
    );
  },
  async read(id) {
    return (await google.request(`drive/v3/files/${encodeURIComponent(id)}?alt=media`)).blob();
  },
  async write(namespace, kind, key, blob) {
    const boundary = `diary_${crypto.randomUUID()}`;
    const metadata = {
      name: `${kind}-${key}`,
      parents: ['appDataFolder'],
      appProperties: { format: FORMAT, namespace, kind, key },
    };
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${blob.type || 'application/octet-stream'}\r\n\r\n`,
      blob,
      `\r\n--${boundary}--`,
    ]);
    const file = await (
      await google.request('upload/drive/v3/files?uploadType=multipart&fields=id,sha256Checksum', {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body,
      })
    ).json();
    // Verify the stored bytes: prefer the checksum Drive returns, otherwise read the file back.
    const stored = file.sha256Checksum?.toLowerCase() || (await digest(await this.read(file.id)));
    if (stored !== (await digest(blob)))
      throw new Error('클라우드 저장 검증에 실패했습니다. 기존 데이터는 보존되어 있습니다.');
    return file.id;
  },
  async remove(id) {
    await google.request(`drive/v3/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
};
async function digest(blob) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
const readJSON = async (io, id) => JSON.parse(await (await io.read(id)).text());
function portable(revision) {
  const result = structuredClone(revision);
  for (const key of ['summary', 'row', 'tab', 'sheetSaved', 'remoteKnown', 'conflict', 'driveId'])
    delete result[key];
  delete result.entry.removedImages;
  validateRevision(result);
  if (result.entry.body.length > 120000)
    throw new Error('일기 한 편은 12만 자까지 저장할 수 있습니다. 나누어 기록해주세요.');
  return result;
}
export class AppDataRepository {
  constructor(id, io = driveStore, { cacheStore, progress = () => {} } = {}) {
    this.id = id;
    this.io = io;
    this.index = [];
    this.retentionDays = 30;
    this.migrated = true;
    this.private = true;
    this.cache = new Map();
    this.cacheStore = cacheStore;
    this.progress = progress;
  }
  async prepare(roots) {
    roots ||= await this.io.list(this.id, 'root');
    if (!roots.length) throw new Error('앱 전용 저장소 연결 또는 이전이 필요합니다.');
    this.root = await readJSON(this.io, roots[0].id);
    if (this.root.format !== FORMAT) throw new Error('지원하지 않는 저장소 형식입니다.');
  }
  // `maxAge` reuses a listing fetched within that many milliseconds instead of asking Drive again.
  async list({ maxAge = 0 } = {}) {
    if (this.files && Date.now() - this.listedAt < maxAge) return this.index;
    if (!this.root) await this.prepare();
    const files = await this.io.list(this.id);
    this.listedAt = Date.now();
    const tombstones = files.filter((f) => f.appProperties.kind === 'purge');
    this.purged = new Set(tombstones.map((f) => f.appProperties.key));
    this.files = files;
    const unique = new Map();
    const selected = (this.root.seeds || []).filter((seed) => !this.purged.has(seed.entryId));
    const readable = new Map(
      [...files.filter((f) => f.appProperties.kind === 'revision'), ...selected].map((f) => [
        f.id,
        f,
      ]),
    );
    if (!this.cacheLoaded) {
      // Cache failures must never prevent cloud access or acknowledge pending edits.
      for (const item of (await this.cacheStore?.load().catch(() => [])) || []) {
        try {
          if (readable.has(item.id)) this.cache.set(item.id, validateRevision(item.revision));
        } catch {
          /* Invalid cache entries are downloaded again. */
        }
      }
      this.cacheLoaded = true;
    }
    const missing = [...readable.values()].filter((f) => !this.cache.has(f.id));
    let next = 0,
      completed = 0,
      failed = false;
    if (missing.length) this.progress(`일기 불러오는 중 0/${missing.length}`);
    // Bound concurrency instead of adding one network round trip per diary in series.
    const workers = await Promise.allSettled(
      Array.from({ length: Math.min(6, missing.length) }, async () => {
        while (!failed && next < missing.length) {
          const file = missing[next++];
          try {
            const revision = validateRevision(await readJSON(this.io, file.id));
            this.cache.set(file.id, revision);
            await this.cacheStore?.put(file.id, revision).catch(() => {});
            this.progress(`일기 불러오는 중 ${++completed}/${missing.length}`);
          } catch (error) {
            failed = true;
            throw error;
          }
        }
      }),
    );
    const failure = workers.find((worker) => worker.status === 'rejected');
    if (failure) throw failure.reason;
    for (const file of readable.values()) {
      const revision = this.cache.get(file.id);
      if (!this.purged.has(revision.entry.id)) unique.set(revision.id, revision);
    }
    const retained = new Set(
      [...readable.keys()].filter((id) => !this.purged.has(this.cache.get(id).entry.id)),
    );
    for (const id of this.cache.keys()) if (!retained.has(id)) this.cache.delete(id);
    await this.cacheStore?.prune(retained).catch(() => {});
    this.progress('');
    this.versions = [...unique.values()];
    this.rebuildIndex();
    const settings = files.filter((f) => f.appProperties.kind === 'retention');
    this.retentionDays = settings.length
      ? (await readJSON(this.io, settings.at(-1).id)).days
      : this.root.retentionDays;
    return this.index;
  }
  rebuildIndex() {
    this.index = entryGroups(this.versions).map((group) => {
      const result = { ...structuredClone(group.latest), sheetSaved: true, remoteKnown: true };
      if (group.heads.length > 1) {
        result.conflict = {
          ...structuredClone(group.heads[1]),
          sheetSaved: true,
          remoteKnown: true,
        };
        result.cloudConflict = true;
      }
      return result;
    });
  }
  async backupRevisions() {
    await this.list();
    return entryGroups(this.versions).flatMap((g) => structuredClone(g.heads));
  }
  async read(r) {
    if (!r.summary) return structuredClone(r);
    const found = (await this.list()).find((v) => v.id === r.id);
    if (!found) throw new Error('일기 원문이 변경되었습니다. 다시 불러와주세요.');
    return structuredClone(found);
  }
  async readMany(rs) {
    const result = [];
    for (const r of rs) result.push(await this.read(r));
    return result;
  }
  save(r) {
    return this.saveMany([r]);
  }
  // One listing per batch; written revisions extend the in-memory index directly so callers
  // see them without another round trip. The next list() reconciles with other devices.
  async saveMany(rs) {
    await this.list();
    for (const r of rs) {
      if (this.purged.has(r.entry.id))
        throw new Error('이 일기는 다른 기기에서 완전 삭제되었습니다.');
      if (this.versions.some((v) => v.id === r.id)) continue;
      const value = portable(r);
      for (const image of value.entry.images) {
        for (const part of [image, image.thumbnail].filter(Boolean)) {
          if (part.storage !== 'appDataFolder' || part.appOwner !== `${this.id}:${r.entry.id}`)
            throw new Error('사진을 앱 전용 저장소에 먼저 저장해야 합니다.');
        }
      }
      // Immutable revisions preserve simultaneous/offline edits, without a read/write lock.
      if (r.baseRevision && !value.parents.includes(r.baseRevision))
        value.parents.push(r.baseRevision);
      if (!value.parents.length) {
        const prior = this.index.find((v) => v.entry.id === r.entry.id);
        if (prior && r.remoteKnown) value.parents.push(prior.id);
      }
      const id = await this.io.write(this.id, 'revision', value.id, jsonBlob(value));
      this.files.push({
        id,
        appProperties: { format: FORMAT, namespace: this.id, kind: 'revision', key: value.id },
      });
      this.cache.set(id, value);
      await this.cacheStore?.put(id, value).catch(() => {});
      this.versions.push(value);
      this.rebuildIndex();
    }
  }
  async resolve(revision, copy) {
    const resolved = makeRevision(revision.conflict.entry, [revision.id, revision.conflict.id]);
    await this.saveMany([copy, resolved]);
    return { ...resolved, sheetSaved: true, remoteKnown: true };
  }
  async saveRetention(days) {
    if (![0, 7, 30, 90, 365].includes(days))
      throw new Error('올바른 휴지통 보관 기간을 선택해주세요.');
    await this.io.write(this.id, 'retention', crypto.randomUUID(), jsonBlob({ days }));
    this.retentionDays = days;
  }
  async purge(days) {
    await this.list({ maxAge: 15000 });
    const ids = this.index
      .filter((r) => !r.conflict && expired(r.entry, days))
      .map((r) => r.entry.id);
    for (const id of ids) await this.io.write(this.id, 'purge', id, jsonBlob({ id }));
    // Repeat interrupted deletion on subsequent runs; tombstones block offline resurrection.
    const doomed = new Set([...this.purged, ...ids]);
    if (!doomed.size) return [];
    for (const file of this.files.filter((f) =>
      ['revision', 'seed'].includes(f.appProperties.kind),
    )) {
      const revision = this.cache.get(file.id) || (await readJSON(this.io, file.id));
      if (doomed.has(revision.entry.id)) {
        try {
          await this.io.remove(file.id);
        } catch (error) {
          if (error.status !== 404) throw error;
        }
        this.cache.delete(file.id);
      }
    }
    for (const id of doomed) {
      for (const file of await this.io.list(`${this.id}:${id}`, 'asset')) {
        try {
          await this.io.remove(file.id);
        } catch (error) {
          if (error.status !== 404) throw error;
        }
      }
    }
    return [...doomed];
  }
}

// Open an existing appdata repository. Its root lists the seed files copied from the
// former Sheets storage; those seeds stay readable so migrated diaries remain available.
export async function openRepository(
  id,
  { io = driveStore, progress = () => {}, cacheStore } = {},
) {
  const repository = new AppDataRepository(id, io, { cacheStore, progress });
  await repository.prepare();
  return repository;
}
export async function findRepositories() {
  const roots = await driveStore.list(null, 'root');
  const byId = new Map(
    roots.map((f) => [
      f.appProperties.namespace,
      { id: f.appProperties.namespace, name: 'My Diary · 앱 전용 저장소' },
    ]),
  );
  return [...byId.values()];
}
export async function createRepository() {
  const id = 'private-personal';
  if (!(await driveStore.list(id, 'root')).length)
    await driveStore.write(
      id,
      'root',
      'ready',
      jsonBlob({ format: FORMAT, seeds: [], retentionDays: 30 }),
    );
  const repository = new AppDataRepository(id);
  await repository.prepare();
  return repository;
}
export async function uploadPrivateAsset(asset, owner) {
  if (!owner) throw new Error('사진 저장소가 연결되지 않았습니다.');
  const key = await digest(asset.blob);
  const files = await driveStore.list(owner, 'asset');
  const existing = files.find((f) => f.appProperties.key === key);
  return existing?.id || driveStore.write(owner, 'asset', key, asset.blob);
}
