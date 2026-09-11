import * as google from '../google.js';
import { validateRevision, entryGroups, makeRevision } from '../model.js';
import { expired } from './current.js';
import { SheetsRepository, findSheets } from './sheets.js';

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
      await google.request('upload/drive/v3/files?uploadType=multipart&fields=id', {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body,
      })
    ).json();
    // Read-after-write verification also detects incomplete uploads before cutover.
    if ((await digest(await this.read(file.id))) !== (await digest(blob)))
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
  constructor(id, io = driveStore) {
    this.id = id;
    this.io = io;
    this.index = [];
    this.retentionDays = 30;
    this.migrated = true;
    this.private = true;
    this.cache = new Map();
  }
  async prepare() {
    const roots = await this.io.list(this.id, 'root');
    if (!roots.length) throw new Error('앱 전용 저장소 연결 또는 이전이 필요합니다.');
    this.root = await readJSON(this.io, roots[0].id);
    if (this.root.format !== FORMAT) throw new Error('지원하지 않는 저장소 형식입니다.');
  }
  async list() {
    if (!this.root) await this.prepare();
    const files = await this.io.list(this.id);
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
    for (const file of readable.values()) {
      if (!this.cache.has(file.id))
        this.cache.set(file.id, validateRevision(await readJSON(this.io, file.id)));
      const revision = this.cache.get(file.id);
      if (!this.purged.has(revision.entry.id)) unique.set(revision.id, revision);
    }
    this.versions = [...unique.values()];
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
    const settings = files.filter((f) => f.appProperties.kind === 'retention');
    this.retentionDays = settings.length
      ? (await readJSON(this.io, settings.at(-1).id)).days
      : this.root.retentionDays;
    return this.index;
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
  async saveMany(rs) {
    for (const r of rs) await this.save(r);
  }
  async save(r) {
    await this.list();
    if (this.purged.has(r.entry.id))
      throw new Error('이 일기는 다른 기기에서 완전 삭제되었습니다.');
    if (this.versions.some((v) => v.id === r.id)) return;
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
    await this.io.write(this.id, 'revision', value.id, jsonBlob(value));
    await this.list();
    if (this.purged.has(r.entry.id))
      throw new Error(
        '저장 중 다른 기기에서 일기가 완전 삭제되었습니다. 기기 수정본은 보존했습니다.',
      );
  }
  async resolve(revision, copy) {
    await this.save(copy);
    const resolved = makeRevision(revision.conflict.entry, [revision.id, revision.conflict.id]);
    await this.save(resolved);
    return { ...resolved, sheetSaved: true, remoteKnown: true };
  }
  async saveRetention(days) {
    if (![0, 7, 30, 90, 365].includes(days))
      throw new Error('올바른 휴지통 보관 기간을 선택해주세요.');
    await this.io.write(this.id, 'retention', crypto.randomUUID(), jsonBlob({ days }));
    this.retentionDays = days;
  }
  async purge(days) {
    await this.list();
    const ids = this.index
      .filter((r) => !r.conflict && expired(r.entry, days))
      .map((r) => r.entry.id);
    for (const id of ids) await this.io.write(this.id, 'purge', id, jsonBlob({ id }));
    // Repeat interrupted deletion on subsequent runs; tombstones block offline resurrection.
    const doomed = new Set([...this.purged, ...ids]);
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

// A read-only snapshot: never initialize, compact, or otherwise change the source sheet.
export async function sheetSnapshot(id) {
  const source = new SheetsRepository(id);
  const meta = await (
    await google.request(`sheets/v4/spreadsheets/${id}?fields=sheets.properties`)
  ).json();
  const titles = new Set(meta.sheets.map((s) => s.properties.title));
  if (['일기', '설정', '일정'].some((title) => !titles.has(title)))
    throw new Error('기존 시트의 필수 탭이 없습니다. 원본을 확인한 후 다시 이전해주세요.');
  const ranges = ["'설정'!A1:B", "'일기'!A2:O", "'휴지통'!A2:O", "'일정'!A2:C", "'추가항목'!A2:C"];
  const present = ranges.filter((r) => titles.has(r.split("'")[1]));
  const data = await source.values(present);
  const [settings, rows, trash, events, extraRows] = ranges.map(
    (r) => data[present.indexOf(r)] || [],
  );
  if (!settings.some((r) => r[0] === 'format' && r[1] === 'my-diary-sheets-v1'))
    throw new Error('My Diary 시트 형식이 아닙니다.');
  const { decodeIndex } = await import('./sheets.js');
  const result = [];
  for (const row of [...rows, ...trash]) {
    if (!row[0]) continue;
    const base = decodeIndex([row])[0];
    const extra = row[14]
      ? JSON.parse(row[14])
      : JSON.parse(extraRows.find((r) => r[0] === row[0] && r[1] === '@app')?.[2] || '{}');
    const full = {
      ...base,
      entry: {
        ...base.entry,
        ...extra,
        body: row
          .slice(10, 14)
          .map((v) => v || '')
          .join(''),
        events: extra.events || events.filter((e) => e[0] === row[0]).map((e) => JSON.parse(e[2])),
      },
    };
    result.push(portable(full));
  }
  return {
    revisions: entryGroups(result).map((g) => g.latest),
    retentionDays: Number(settings.filter((r) => r[0] === 'trashDays').at(-1)?.[1] ?? 30),
  };
}
export async function migrateRepository(
  id,
  { io = driveStore, snapshot = sheetSnapshot, progress = () => {} } = {},
) {
  const repository = new AppDataRepository(id, io);
  if ((await io.list(id, 'root')).length) {
    await repository.prepare();
    return repository;
  }
  const initial = await snapshot(id);
  const snapshotHash = await digest(jsonBlob(initial));
  const seeds = [];
  const existing = await io.list(null, 'asset');
  const assets = new Map(
    existing.map((f) => [`${f.appProperties.namespace}:${f.appProperties.key}`, f.id]),
  );
  for (let i = 0; i < initial.revisions.length; i++) {
    progress(`일기와 사진 이전 중 ${i + 1}/${initial.revisions.length}`);
    const revision = portable(initial.revisions[i]);
    for (const image of revision.entry.images) {
      for (const part of [image, image.thumbnail].filter(Boolean)) {
        if (!part.driveId) throw new Error(`이전할 사진 파일 정보가 없습니다: ${part.name}`);
        const owner = `${id}:${revision.entry.id}`;
        const original = await io.read(part.driveId);
        const key = await digest(original);
        let target = assets.get(`${owner}:${key}`);
        if (!target || (await digest(await io.read(target))) !== (await digest(original))) {
          target = await io.write(owner, 'asset', key, original);
          assets.set(`${owner}:${key}`, target);
        }
        part.driveId = target;
        part.storage = 'appDataFolder';
        part.appOwner = owner;
      }
    }
    seeds.push({
      id: await io.write(id, 'seed', revision.id, jsonBlob(revision)),
      entryId: revision.entry.id,
    });
  }
  if ((await digest(jsonBlob(await snapshot(id)))) !== snapshotHash)
    throw new Error(
      '이전 중 기존 시트가 변경되었습니다. 다른 기기 작업을 마친 뒤 다시 연결해주세요. 기존 데이터는 보존했습니다.',
    );
  await io.write(
    id,
    'root',
    'ready',
    jsonBlob({ format: FORMAT, seeds, retentionDays: initial.retentionDays, sourceSheet: id }),
  );
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
  for (const file of await findSheets())
    if (!byId.has(file.id)) byId.set(file.id, { ...file, name: `${file.name} · 이전할 기존 시트` });
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
