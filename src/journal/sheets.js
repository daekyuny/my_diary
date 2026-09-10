import * as google from '../google.js';
import { newEntry, validateRevision } from '../model.js';
import { entryGroups, expired } from './current.js';

export const TABS = ['일기', '추가항목', '일정', '설정'];
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
  ],
  ['저장 식별자', '항목', '값'],
  ['저장 식별자', '일정 ID', '일정 데이터'],
  ['이름', '값'],
];
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
  const fields = (e.fields || []).map((field) => [
    revision.id,
    `field:${field.id || field.name}`,
    JSON.stringify(field),
  ]);
  // Separate metadata rows keep the body readable in Sheets and preserve attachments/import details.
  const extra = Object.fromEntries(
    Object.entries(e).filter(
      ([key]) =>
        !['id', 'date', 'title', 'body', 'tags', 'pinned', 'archived', 'fields', 'events'].includes(
          key,
        ),
    ),
  );
  fields.push([revision.id, '@app', JSON.stringify(extra)]);
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
      ],
    ],
    fields,
    e.events.map((event) => [revision.id, event.key, JSON.stringify(event)]),
  ];
  if (result.flat(2).some((value) => String(value).length > 45000))
    throw new Error('추가 항목 또는 일정 한 개의 내용이 너무 깁니다.');
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
    this.settings = [];
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
    this.tabs = TABS.map(
      (title) => data.sheets.find((sheet) => sheet.properties.title === title)?.properties.sheetId,
    );
    if (this.tabs.some((id) => id === undefined))
      throw new Error(
        'My Diary 시트의 필수 탭을 찾지 못했습니다. 설정에서 올바른 파일을 선택해주세요.',
      );
    const [settings] = await this.values(["'설정'!A1:B3"]);
    if (!settings.some((row) => row[0] === 'format' && row[1] === 'my-diary-sheets-v1'))
      throw new Error('My Diary 형식으로 만든 시트가 아닙니다. 다른 파일에는 기록하지 않습니다.');
  }
  async list() {
    if (!this.tabs) await this.prepare();
    const [rows, settings] = await this.values(["'일기'!A2:J", "'설정'!A2:B"]);
    this.settings = [
      ...new Map(
        settings
          .filter((row) => row[0]?.startsWith('field:'))
          .map((row) => [row[0], JSON.parse(row[1])]),
      ).values(),
    ];
    this.retentionDays = Number(settings.filter((r) => r[0] === 'trashDays').at(-1)?.[1] ?? 30);
    this.rawRows = rows;
    this.rawIndex = rows.flatMap((row, i) => decodeIndex([row]).map((r) => ({ ...r, row: i + 2 })));
    this.index = entryGroups(this.rawIndex).map((g) => g.latest);
    return this.index;
  }
  async read(revision) {
    if (!revision.summary) return revision;
    if (this.cache.has(revision.id)) return structuredClone(this.cache.get(revision.id));
    const [rows, fields, events] = await this.values([
      `'일기'!A${revision.row}:N${revision.row}`,
      "'추가항목'!A2:C",
      "'일정'!A2:C",
    ]);
    if (rows[0]?.[0] !== revision.id) {
      await this.list();
      const found = this.index.find((item) => item.id === revision.id);
      if (!found) throw new Error('일기가 시트에서 이동되거나 삭제되었습니다. 다시 불러와주세요.');
      return this.read(found);
    }
    const result = structuredClone(revision),
      e = result.entry;
    e.body = Array.from({ length: 4 }, (_, i) => rows[0][10 + i] || '').join('');
    e.fields = [];
    for (const row of fields.filter((row) => row[0] === revision.id)) {
      if (row[1] === '@app') {
        const extra = JSON.parse(row[2] || '{}');
        for (const key of ['images', 'weather', 'source', 'calendarTemplate', 'removedEventKeys'])
          if (extra[key] !== undefined) e[key] = extra[key];
      } else if (row[1].startsWith('field:')) e.fields.push(JSON.parse(row[2]));
      else e.fields.push({ id: row[1], name: row[1], value: row[2] || '' });
    }
    e.events = events.filter((row) => row[0] === revision.id).map((row) => JSON.parse(row[2]));
    delete result.summary;
    validateRevision(result);
    this.cache.set(result.id, result);
    return structuredClone(result);
  }
  async saveField(field) {
    if (!this.tabs) await this.prepare();
    await json(
      `sheets/v4/spreadsheets/${this.id}:batchUpdate`,
      post({
        requests: [
          {
            appendCells: {
              sheetId: this.tabs[3],
              rows: [cells([`field:${field.id}`, JSON.stringify(field)])],
              fields: 'userEnteredValue',
            },
          },
        ],
      }),
    );
  }
  async write(requests) {
    if (requests.length)
      await json(`sheets/v4/spreadsheets/${this.id}:batchUpdate`, post({ requests }));
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
    await this.list();
    await this.write(
      HEADERS.map((header, i) => ({
        updateCells: {
          start: { sheetId: this.tabs[i], rowIndex: 0, columnIndex: 0 },
          rows: [cells(header)],
          fields: 'userEnteredValue',
        },
      })),
    );
    const keep = new Set(this.index.map((r) => r.id));
    const keepRows = new Set(this.index.map((r) => r.row));
    const obsolete = this.rawIndex.filter((r) => !keepRows.has(r.row));
    if (obsolete.length) {
      const ids = new Set(obsolete.filter((r) => !keep.has(r.id)).map((r) => r.id));
      const [fields, events] = await this.values(["'추가항목'!A2:C", "'일정'!A2:C"]);
      const requests = obsolete.map((r) => this.clearRow(0, r.row, 14));
      [fields, events].forEach((rows, i) =>
        rows.forEach((r, j) => {
          if (ids.has(r[0])) requests.push(this.clearRow(i + 1, j + 2, 3));
        }),
      );
      await this.write(requests);
    }
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
  async save(revision) {
    if (!this.tabs) await this.prepare();
    await this.list();
    if (this.index.some((r) => r.id === revision.id)) return;
    const previous = this.rawIndex.filter((r) => r.entry.id === revision.entry.id);
    if (!previous.length && revision.remoteKnown)
      throw new Error('이 일기는 다른 기기에서 완전 삭제되었습니다. 다시 저장할 수 없습니다.');
    const data = encodeRevision(revision);
    const requests = [];
    const ids = new Set(previous.map((r) => r.id));
    const [fields, events] = await this.values(["'추가항목'!A2:C", "'일정'!A2:C"]);
    const slots = [
      previous.map((r) => r.row),
      ...[fields, events].map((rows) => rows.flatMap((r, i) => (ids.has(r[0]) ? [i + 2] : []))),
    ];
    data.forEach((rows, tab) => {
      rows.forEach((row, i) => {
        if (slots[tab][i])
          requests.push({
            updateCells: {
              start: { sheetId: this.tabs[tab], rowIndex: slots[tab][i] - 1, columnIndex: 0 },
              rows: [cells(row)],
              fields: 'userEnteredValue',
            },
          });
        else
          requests.push({
            appendCells: {
              sheetId: this.tabs[tab],
              rows: [cells(row)],
              fields: 'userEnteredValue',
            },
          });
      });
      for (const row of slots[tab].slice(rows.length))
        requests.push(this.clearRow(tab, row, tab === 0 ? 14 : 3));
    });
    await this.write(requests);
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
    const ids = new Set(this.index.filter((r) => expired(r.entry, days)).map((r) => r.entry.id));
    const doomed = this.rawIndex.filter((r) => ids.has(r.entry.id));
    const tokens = new Set(doomed.map((r) => r.id));
    const [fields, events] = await this.values(["'추가항목'!A2:C", "'일정'!A2:C"]);
    const photos = (rows) =>
      rows
        .filter((r) => r[1] === '@app')
        .flatMap((r) => JSON.parse(r[2] || '{}').images || [])
        .map((image) => image.driveId)
        .filter(Boolean);
    const shared = new Set(photos(fields.filter((r) => !tokens.has(r[0]))));
    for (const id of new Set(photos(fields.filter((r) => tokens.has(r[0]))))) {
      if (!shared.has(id)) {
        try {
          await google.request(`drive/v3/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
        } catch (error) {
          if (error.status !== 404) throw error;
        }
      }
    }
    const requests = doomed.map((r) => this.clearRow(0, r.row, 14));
    [fields, events].forEach((rows, tab) =>
      rows.forEach((r, i) => {
        if (tokens.has(r[0])) requests.push(this.clearRow(tab + 1, i + 2, 3));
      }),
    );
    await this.write(requests);
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
  await repository.compact();
  return repository;
}
export async function initializeSheet(id) {
  const meta = await json(`sheets/v4/spreadsheets/${id}?fields=sheets.properties`);
  // Only fill absent tabs. Never overwrite existing rows, including a partially initialized file.
  const requests = [];
  TABS.forEach((title, i) => {
    const existing = meta.sheets?.find((sheet) => sheet.properties.title === title);
    if (existing) return;
    const sheetId = 100 + i;
    requests.push({
      addSheet: {
        properties: {
          sheetId,
          title,
          gridProperties: { rowCount: 1000, columnCount: i === 0 ? 14 : 3, frozenRowCount: 1 },
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
