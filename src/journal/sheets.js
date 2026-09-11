import * as google from '../google.js';
import { withSheetLock } from './sheet-lock.js';
import { newEntry, validateRevision } from '../model.js';
import { entryGroups, expired } from './current.js';

export const TABS = ['일기', '추가항목', '일정', '설정', '휴지통'];
export const HEADERS = [
  [
    '저장 식별자',
    '일기 ID',
    '연결 정보',
    '저장 시각',
    '일기 날짜',
    '제목',
    '미리보기',
    '태그',
    '고정',
    '삭제 시각',
    '본문 1',
    '본문 2',
    '본문 3',
    '본문 4',
    '앱 연결 정보',
  ],
  ['저장 식별자', '항목', '값'],
  ['저장 식별자', '일정 ID', '일정 데이터'],
  ['이름', '값'],
];
HEADERS.push([...HEADERS[0]]);
const json = async (path, options) => (await google.request(path, options)).json();
const post = (body) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const cells = (values) => ({
  values: values.map((value) => ({ userEnteredValue: { stringValue: String(value ?? '') } })),
});
export function encodeRevision(revision) {
  validateRevision(revision);
  const e = revision.entry;
  if (e.body.length > 120000)
    throw new Error('일기 한 편은 12만 자까지 저장할 수 있습니다. 나누어 기록해주세요.');
  const chunks = Array.from({ length: 4 }, (_, i) => e.body.slice(i * 30000, (i + 1) * 30000));
  // Keep attachment and event metadata with its diary so detail reads need one row.
  const extra = Object.fromEntries(
    Object.entries(e).filter(
      ([key]) =>
        !['id', 'date', 'title', 'body', 'tags', 'pinned', 'archived', 'fields'].includes(key),
    ),
  );
  const result = [
    [
      [
        revision.id,
        e.id,
        JSON.stringify(revision.parents),
        revision.savedAt,
        e.date,
        e.title,
        e.body.slice(0, 160),
        JSON.stringify(e.tags),
        String(Boolean(e.pinned)),
        e.deletedAt || '',
        ...chunks,
        JSON.stringify(extra),
      ],
    ],
    [],
    e.events.map((event) => [revision.id, event.key, JSON.stringify(event)]),
  ];
  if (result.flat(2).some((value) => String(value).length > 45000))
    throw new Error('사진 연결 정보 또는 일정 한 개의 내용이 너무 깁니다.');
  return result;
}
export function decodeIndex(rows) {
  const unique = new Map();
  rows.forEach((row, i) => {
    if (!row[0]) return;
    const revision = {
      schemaVersion: 1,
      id: row[0],
      parents: JSON.parse(row[2] || '[]'),
      savedAt: row[3],
      entry: {
        ...newEntry(row[4]),
        id: row[1],
        title: row[5] || '',
        body: row[6] || '',
        tags: JSON.parse(row[7] || '[]'),
        pinned: row[8] === 'true',
        archived: Boolean(row[9] && !['true', 'false'].includes(row[9])),
        deletedAt: row[9] && !['true', 'false'].includes(row[9]) ? row[9] : '',
      },
      row: i + 2,
      sheetSaved: true,
      summary: true,
    };
    validateRevision(revision);
    unique.set(revision.id, revision);
  });
  return [...unique.values()];
}
export class SheetsRepository {
  constructor(id) {
    this.id = id;
    this.tabs = null;
    this.index = [];
    this.cache = new Map();
    this.retentionDays = 30;
    this.rawIndex = [];
  }
  get url() {
    return `https://docs.google.com/spreadsheets/d/${this.id}/edit#gid=${this.tabs?.[0] ?? 100}`;
  }
  async values(ranges) {
    const query = new URLSearchParams({ valueRenderOption: 'UNFORMATTED_VALUE' });
    ranges.forEach((range) => query.append('ranges', range));
    return (
      await json(`sheets/v4/spreadsheets/${this.id}/values:batchGet?${query}`)
    ).valueRanges.map((range) => range.values || []);
  }
  async prepare() {
    const data = await json(`sheets/v4/spreadsheets/${this.id}?fields=sheets.properties`);
    this.properties = data.sheets.map((s) => s.properties);
    this.tabs = TABS.map(
      (title) => data.sheets.find((sheet) => sheet.properties.title === title)?.properties.sheetId,
    );
    if ([0, 2, 3].some((i) => this.tabs[i] === undefined))
      throw new Error(
        'My Diary 시트의 필수 탭을 찾지 못했습니다. 설정에서 올바른 파일을 선택해주세요.',
      );
    const [settings] = await this.values(["'설정'!A1:B"]);
    this.migrated = settings.some((r) => r[0] === 'inlineMetadata' && r[1] === 'v2');
    if (!settings.some((row) => row[0] === 'format' && row[1] === 'my-diary-sheets-v1'))
      throw new Error('My Diary 형식으로 만든 시트가 아닙니다. 다른 파일에는 기록하지 않습니다.');
    if (this.tabs[4] === undefined) {
      try {
        await initializeSheet(this.id);
      } catch (error) {
        const latest = await json(`sheets/v4/spreadsheets/${this.id}?fields=sheets.properties`);
        if (!latest.sheets.some((sheet) => sheet.properties.title === '휴지통')) throw error;
      }
      this.tabs = null;
      await this.prepare();
    }
  }
  async migrate() {
    if (!this.tabs) await this.prepare();
    if (this.migrated) return;
    await withSheetLock(this.id, async (renew) => {
      this.renewLease = renew;
      try {
        await this.prepare();
        if (this.migrated) return;
        // Existing grids may have exactly 14 columns.
        await this.write(
          [0, 4]
            .filter(
              (tab) =>
                (this.properties.find((p) => p.sheetId === this.tabs[tab])?.gridProperties
                  ?.columnCount || 0) < 15,
            )
            .map((tab) => ({
              updateSheetProperties: {
                properties: { sheetId: this.tabs[tab], gridProperties: { columnCount: 15 } },
                fields: 'gridProperties.columnCount',
              },
            })),
        );
        const [diaries, trash, events, legacy = []] = await this.values([
          "'일기'!A2:O",
          "'휴지통'!A2:O",
          "'일정'!A2:C",
          ...(this.tabs[1] === undefined ? [] : ["'추가항목'!A2:C"]),
        ]);
        const extras = new Map(
          legacy.filter((r) => r[1] === '@app').map((r) => [r[0], JSON.parse(r[2] || '{}')]),
        );
        const requests = [];
        for (const [rows, tab] of [
          [diaries, 0],
          [trash, 4],
        ]) {
          requests.push({
            updateCells: {
              start: { sheetId: this.tabs[tab], rowIndex: 0, columnIndex: 14 },
              rows: [cells(['앱 연결 정보'])],
              fields: 'userEnteredValue',
            },
          });
          rows.forEach((row, i) => {
            if (!row[0] || row[14]) return;
            const extra = {
              ...extras.get(row[0]),
              events: events.filter((e) => e[0] === row[0]).map((e) => JSON.parse(e[2])),
            };
            delete extra.fields;
            requests.push({
              updateCells: {
                start: { sheetId: this.tabs[tab], rowIndex: i + 1, columnIndex: 14 },
                rows: [cells([JSON.stringify(extra)])],
                fields: 'userEnteredValue',
              },
            });
          });
        }
        for (let i = 0; i < requests.length; i += 20) await this.write(requests.slice(i, i + 20));
        await this.write([
          {
            appendCells: {
              sheetId: this.tabs[3],
              rows: [cells(['inlineMetadata', 'v2'])],
              fields: 'userEnteredValue',
            },
          },
        ]);
        this.migrated = true;
      } finally {
        this.renewLease = null;
      }
    });
  }
  async list() {
    if (!this.tabs) await this.prepare();
    const [rows, settings, trash] = await this.values([
      "'일기'!A2:J",
      "'설정'!A2:B",
      "'휴지통'!A2:J",
    ]);
    this.retentionDays = Number(settings.filter((r) => r[0] === 'trashDays').at(-1)?.[1] ?? 30);
    this.rawRows = rows;
    this.rawIndex = [
      [rows, 0],
      [trash, 4],
    ].flatMap(([values, tab]) =>
      values.flatMap((row, i) => decodeIndex([row]).map((r) => ({ ...r, row: i + 2, tab }))),
    );
    this.index = entryGroups(this.rawIndex).map((g) => g.latest);
    return this.index;
  }
  async read(revision) {
    if (!revision.summary) return revision;
    if (this.cache.has(revision.id)) return structuredClone(this.cache.get(revision.id));
    const [rows] = await this.values([
      `'${TABS[revision.tab || 0]}'!A${revision.row}:O${revision.row}`,
    ]);
    if (rows[0]?.[0] !== revision.id) {
      await this.list();
      const found = this.index.find((item) => item.id === revision.id);
      if (!found) throw new Error('일기가 시트에서 이동되거나 삭제되었습니다. 다시 불러와주세요.');
      return this.read(found);
    }
    return this.decodeFull(revision, rows[0]);
  }
  decodeFull(revision, row) {
    const result = structuredClone(revision),
      e = result.entry;
    e.body = Array.from({ length: 4 }, (_, i) => row[10 + i] || '').join('');
    const extra = JSON.parse(row[14] || '{}');
    for (const key of [
      'images',
      'weather',
      'source',
      'calendarTemplate',
      'removedEventKeys',
      'events',
    ])
      if (extra[key] !== undefined) e[key] = extra[key];
    e.fields = [];
    delete result.summary;
    validateRevision(result);
    this.cache.set(result.id, result);
    return structuredClone(result);
  }
  async readMany(revisions) {
    if (!revisions.length) return [];
    const values = await this.values(
      revisions.map((r) => `'${TABS[r.tab || 0]}'!A${r.row}:O${r.row}`),
    );
    const result = [];
    for (let i = 0; i < revisions.length; i++) {
      if (values[i]?.[0]?.[0] === revisions[i].id)
        result.push(this.decodeFull(revisions[i], values[i][0]));
      else result.push(await this.read(revisions[i]));
    }
    return result;
  }
  async write(requests) {
    if (requests.length) {
      if (this.renewLease) await this.renewLease();
      await json(`sheets/v4/spreadsheets/${this.id}:batchUpdate`, post({ requests }));
    }
    this.cache.clear();
  }
  clearRow(tab, row, width) {
    return {
      updateCells: {
        range: {
          sheetId: this.tabs[tab],
          startRowIndex: row - 1,
          endRowIndex: row,
          startColumnIndex: 0,
          endColumnIndex: width,
        },
        fields: 'userEnteredValue',
      },
    };
  }
  async compact() {
    return withSheetLock(this.id, async (renew) => {
      this.renewLease = renew;
      try {
        return await this._compact();
      } finally {
        this.renewLease = null;
      }
    });
  }
  async _compact() {
    await this.list();
    await this.write(
      HEADERS.flatMap((header, i) =>
        i === 1
          ? []
          : [
              {
                updateCells: {
                  start: { sheetId: this.tabs[i], rowIndex: 0, columnIndex: 0 },
                  rows: [cells(header)],
                  fields: 'userEnteredValue',
                },
              },
            ],
      ),
    );
    const keep = new Set(this.index.map((r) => r.id));
    const keepRows = new Set(this.index.map((r) => `${r.tab}:${r.row}`));
    const obsolete = this.rawIndex.filter((r) => !keepRows.has(`${r.tab}:${r.row}`));
    if (obsolete.length) {
      const ids = new Set(obsolete.filter((r) => !keep.has(r.id)).map((r) => r.id));
      const [events] = await this.values(["'일정'!A2:C"]);
      const fields = [];
      const requests = obsolete.map((r) => this.clearRow(r.tab || 0, r.row, 15));
      [fields, events].forEach((rows, i) =>
        rows.forEach((r, j) => {
          if (ids.has(r[0])) requests.push(this.clearRow(i + 1, j + 2, 3));
        }),
      );
      await this.write(requests);
    }
    // Move legacy trashed rows without changing their IDs or child metadata.
    const moving = this.index.filter((r) => r.tab !== (r.entry.deletedAt ? 4 : 0));
    const moves = [];
    for (const r of moving) {
      const full = await this.read(r);
      moves.push({
        appendCells: {
          sheetId: this.tabs[full.entry.deletedAt ? 4 : 0],
          rows: encodeRevision(full)[0].map(cells),
          fields: 'userEnteredValue',
        },
      });
      moves.push(this.clearRow(r.tab || 0, r.row, 15));
    }
    await this.write(moves);
    await this.cleanupAttachments();
    await this.removeBlankRows();
    // Only the empty default tab is disposable; never delete a tab containing user data.
    const meta = await json(`sheets/v4/spreadsheets/${this.id}?fields=sheets.properties`);
    const defaults = meta.sheets.filter((s) => ['Sheet1', '시트1'].includes(s.properties.title));
    for (const sheet of defaults) {
      const [rows] = await this.values([`'${sheet.properties.title}'`]);
      if (!rows.some((r) => r.some((v) => v !== '' && v != null)))
        await this.write([{ deleteSheet: { sheetId: sheet.properties.sheetId } }]);
    }
    await this.list();
  }
  async removeBlankRows() {
    const tabs = [0, 2, 4];
    const values = await this.values(
      tabs.map((tab) => `'${TABS[tab]}'!A2:${tab === 0 || tab === 4 ? 'O' : 'C'}`),
    );
    const requests = [];
    values.forEach((rows, i) => {
      // Delete contiguous empty ranges from bottom to top so remaining row addresses stay valid.
      for (let end = rows.length; end > 0;) {
        if (rows[end - 1].some((v) => v !== '' && v != null)) {
          end--;
          continue;
        }
        let start = end - 1;
        while (start > 0 && !rows[start - 1].some((v) => v !== '' && v != null)) start--;
        requests.push({
          deleteDimension: {
            range: {
              sheetId: this.tabs[tabs[i]],
              dimension: 'ROWS',
              startIndex: start + 1,
              endIndex: end + 1,
            },
          },
        });
        end = start;
      }
    });
    await this.write(requests);
  }
  async cleanupAttachments() {
    const values = await this.values(["'일기'!O2:O", "'휴지통'!O2:O"]);
    const records = values.flatMap((rows, t) =>
      rows.map((row, i) => ({ i, tab: t ? 4 : 0, extra: JSON.parse(row[0] || '{}') })),
    );
    const referenced = new Set(
      records.flatMap(({ extra }) =>
        (extra?.images || [])
          .flatMap((image) => [image.driveId, image.thumbnail?.driveId])
          .filter(Boolean),
      ),
    );
    const updates = [];
    for (const { i, tab, extra } of records) {
      if (!extra?.removedImages?.length) continue;
      for (const image of extra.removedImages) {
        if (this.renewLease) await this.renewLease();
        for (const id of [image.driveId, image.thumbnail?.driveId].filter(Boolean)) {
          if (referenced.has(id)) continue;
          try {
            await google.request(`drive/v3/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
          } catch (error) {
            if (error.status !== 404) throw error;
          }
        }
      }
      delete extra.removedImages;
      updates.push({
        updateCells: {
          start: { sheetId: this.tabs[tab], rowIndex: i + 1, columnIndex: 14 },
          rows: [cells([JSON.stringify(extra)])],
          fields: 'userEnteredValue',
        },
      });
    }
    await this.write(updates);
  }
  async saveMany(revisions) {
    if (revisions.length === 1) return this.save(revisions[0]);
    if (new Set(revisions.map((r) => r.entry.id)).size !== revisions.length) {
      for (const revision of revisions) await this.save(revision);
      return;
    }
    return withSheetLock(this.id, async (renew) => {
      this.renewLease = renew;
      try {
        if (!this.tabs) await this.prepare();
        await this.list();
        const existing = new Set(this.rawIndex.map((r) => r.entry.id));
        const fresh = [];
        for (const revision of revisions) {
          if (existing.has(revision.entry.id) || revision.remoteKnown) await this._save(revision);
          else {
            fresh.push(revision);
            existing.add(revision.entry.id);
          }
        }
        const requests = fresh.flatMap((revision) =>
          encodeRevision(revision).flatMap((rows, tab) =>
            rows.length
              ? [
                  {
                    appendCells: {
                      sheetId: this.tabs[tab === 0 && revision.entry.deletedAt ? 4 : tab],
                      rows: rows.map(cells),
                      fields: 'userEnteredValue',
                    },
                  },
                ]
              : [],
          ),
        );
        await this.write(requests);
      } finally {
        this.renewLease = null;
      }
    });
  }
  async save(revision) {
    return withSheetLock(this.id, async (renew) => {
      this.renewLease = renew;
      try {
        return await this._save(revision);
      } finally {
        this.renewLease = null;
      }
    });
  }
  async _save(revision) {
    if (!this.tabs) await this.prepare();
    await this.list();
    if (this.index.some((r) => r.id === revision.id)) {
      if (revision.entry.removedImages?.length) await this.cleanupAttachments();
      return;
    }
    const previous = this.rawIndex.filter((r) => r.entry.id === revision.entry.id);
    if (!previous.length && revision.remoteKnown)
      throw new Error('이 일기는 다른 기기에서 완전 삭제되었습니다. 다시 저장할 수 없습니다.');
    const latest = entryGroups(previous).map((g) => g.latest)[0];
    if (
      revision.remoteKnown &&
      latest &&
      latest.id !== revision.baseRevision &&
      !revision.parents.includes(latest.id)
    ) {
      const error = new Error(
        '같은 일기가 다른 기기에서도 수정되었습니다. 이 기기 수정본은 보존했습니다. 해당 일기를 열어 수정 충돌을 확인해주세요.',
      );
      error.localId = revision.id;
      error.conflict = await this.read(latest);
      throw error;
    }
    const data = encodeRevision(revision);
    const target = revision.entry.deletedAt ? 4 : 0;
    const requests = [];
    const ids = new Set(previous.map((r) => r.id));
    const [events] = await this.values(["'일정'!A2:C"]);
    const fields = [];
    const slots = [
      previous.filter((r) => r.tab === target).map((r) => r.row),
      ...[fields, events].map((rows) => rows.flatMap((r, i) => (ids.has(r[0]) ? [i + 2] : []))),
    ];
    data.forEach((rows, tab) => {
      const actualTab = tab === 0 ? target : tab;
      rows.forEach((row, i) => {
        if (slots[tab][i])
          requests.push({
            updateCells: {
              start: { sheetId: this.tabs[actualTab], rowIndex: slots[tab][i] - 1, columnIndex: 0 },
              rows: [cells(row)],
              fields: 'userEnteredValue',
            },
          });
        else
          requests.push({
            appendCells: {
              sheetId: this.tabs[actualTab],
              rows: [cells(row)],
              fields: 'userEnteredValue',
            },
          });
      });
      for (const row of slots[tab].slice(rows.length))
        requests.push(this.clearRow(actualTab, row, tab === 0 ? 15 : 3));
    });
    for (const r of previous.filter((r) => r.tab !== target))
      requests.push(this.clearRow(r.tab, r.row, 15));
    await this.write(requests);
    if (revision.entry.removedImages?.length) await this.cleanupAttachments();
    if (requests.some((r) => r.updateCells?.range)) await this.removeBlankRows();
  }
  async saveRetention(days) {
    if (![0, 7, 30, 90, 365].includes(days))
      throw new Error('올바른 휴지통 보관 기간을 선택해주세요.');
    await this.write([
      {
        appendCells: {
          sheetId: this.tabs[3],
          rows: [cells(['trashDays', String(days)])],
          fields: 'userEnteredValue',
        },
      },
    ]);
    this.retentionDays = days;
  }
  async purge(days) {
    await this.list();
    if (!this.index.some((r) => expired(r.entry, days))) return [];
    return withSheetLock(this.id, async (renew) => {
      this.renewLease = renew;
      try {
        return await this._purge(days);
      } finally {
        this.renewLease = null;
      }
    });
  }
  async _purge(days) {
    await this.list();
    const ids = new Set(this.index.filter((r) => expired(r.entry, days)).map((r) => r.entry.id));
    const doomed = this.rawIndex.filter((r) => ids.has(r.entry.id));
    if (!doomed.length) return [];
    const tokens = new Set(doomed.map((r) => r.id));
    const [events, active, trash] = await this.values([
      "'일정'!A2:C",
      "'일기'!O2:O",
      "'휴지통'!O2:O",
    ]);
    const metadata = new Map(
      this.rawIndex.map((r) => [
        r.id,
        JSON.parse((r.tab === 4 ? trash : active)[r.row - 2]?.[0] || '{}'),
      ]),
    );
    const photos = (ids) =>
      [...ids].flatMap((id) => {
        const e = metadata.get(id) || {};
        return [...(e.images || []), ...(e.removedImages || [])]
          .flatMap((image) => [image.driveId, image.thumbnail?.driveId])
          .filter(Boolean);
      });
    const shared = new Set(photos(this.rawIndex.filter((r) => !tokens.has(r.id)).map((r) => r.id)));
    for (const id of new Set(photos(tokens))) {
      if (!shared.has(id)) {
        if (this.renewLease) await this.renewLease();
        try {
          await google.request(`drive/v3/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
        } catch (error) {
          if (error.status !== 404) throw error;
        }
      }
    }
    const fields = [];
    const requests = doomed.map((r) => this.clearRow(r.tab || 0, r.row, 15));
    [fields, events].forEach((rows, tab) =>
      rows.forEach((r, i) => {
        if (tokens.has(r[0])) requests.push(this.clearRow(tab + 1, i + 2, 3));
      }),
    );
    await this.write(requests);
    await this.removeBlankRows();
    return [...ids];
  }
}
export async function findSheets() {
  const query =
    "trashed = false and mimeType = 'application/vnd.google-apps.spreadsheet' and appProperties has { key='myDiaryStore' and value='sheets-v1' }";
  return listFiles(query);
}
async function listFiles(q) {
  const files = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({
      q,
      fields: 'nextPageToken,files(id,name,parents)',
      pageSize: '1000',
      ...(pageToken ? { pageToken } : {}),
    });
    const data = await json(`drive/v3/files?${params}`);
    files.push(...data.files);
    pageToken = data.nextPageToken;
  } while (pageToken);
  return files;
}
export async function createSheet() {
  // Recover an already-created file after a failed initialization without creating another.
  const existing = await findSheets();
  if (existing.length) throw new Error('이미 My Diary 시트가 있습니다. 목록에서 연결해주세요.');
  const folders = await listFiles(
    "trashed = false and mimeType = 'application/vnd.google-apps.folder' and name = 'My Diary' and 'me' in owners",
  );
  if (folders.length > 1)
    throw new Error(
      'My Diary 폴더가 여러 개입니다. 사용할 폴더만 이 이름으로 남긴 후 다시 시도해주세요.',
    );
  const folder =
    folders[0] ||
    (await json(
      'drive/v3/files?fields=id',
      post({
        name: 'My Diary',
        mimeType: 'application/vnd.google-apps.folder',
        appProperties: { myDiary: 'v1', kind: 'My Diary' },
      }),
    ));
  google.useFolder(folder.id);
  const spreadsheet = await json(
    'drive/v3/files?fields=id',
    post({
      name: 'My Diary',
      mimeType: 'application/vnd.google-apps.spreadsheet',
      parents: [folder.id],
      appProperties: { myDiaryStore: 'sheets-v1' },
    }),
  );
  await initializeSheet(spreadsheet.id);
  const repository = new SheetsRepository(spreadsheet.id);
  await repository.prepare();
  await repository.migrate();
  await repository.compact();
  return repository;
}
export async function initializeSheet(id) {
  const meta = await json(`sheets/v4/spreadsheets/${id}?fields=sheets.properties`);
  // Only fill absent tabs. Never overwrite existing rows, including a partially initialized file.
  const requests = [];
  const used = new Set(meta.sheets.map((sheet) => sheet.properties.sheetId));
  TABS.forEach((title, i) => {
    if (i === 1) return;
    const existing = meta.sheets?.find((sheet) => sheet.properties.title === title);
    if (existing) return;
    let sheetId = 100 + i;
    while (used.has(sheetId)) sheetId++;
    used.add(sheetId);
    requests.push({
      addSheet: {
        properties: {
          sheetId,
          title,
          gridProperties: {
            rowCount: 1000,
            columnCount: i === 0 || i === 4 ? 15 : 3,
            frozenRowCount: 1,
          },
        },
      },
    });
    requests.push({
      appendCells: {
        sheetId,
        rows: [cells(HEADERS[i]), ...(i === 3 ? [cells(['format', 'my-diary-sheets-v1'])] : [])],
        fields: 'userEnteredValue',
      },
    });
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.9, green: 0.94, blue: 0.89 },
            textFormat: { bold: true },
          },
        },
        fields: 'userEnteredFormat',
      },
    });
  });
  if (requests.length) await json(`sheets/v4/spreadsheets/${id}:batchUpdate`, post({ requests }));
}
export { entryGroups };
