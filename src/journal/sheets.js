import * as google from '../google.js';
import { newEntry, validateRevision, entryGroups } from '../model.js';

export const TABS = ['일기', '추가항목', '일정', '설정'];
export const HEADERS = [
  [
    '수정 ID',
    '일기 ID',
    '이전 수정 ID',
    '저장 시각',
    '일기 날짜',
    '제목',
    '미리보기',
    '태그',
    '고정',
    '보관',
    '본문 1',
    '본문 2',
    '본문 3',
    '본문 4',
  ],
  ['수정 ID', '항목', '값'],
  ['수정 ID', '일정 ID', '일정 데이터'],
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
        String(Boolean(e.archived)),
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
        archived: row[9] === 'true',
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
    this.index = decodeIndex(rows);
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
  async save(revision) {
    if (!this.tabs) await this.prepare();
    // Recheck before retries. Duplicate acknowledgements are also deduplicated by revision ID.
    await this.list();
    if (this.index.some((item) => item.id === revision.id)) return;
    const data = encodeRevision(revision);
    const requests = data.flatMap((rows, i) =>
      rows.length
        ? [
            {
              appendCells: {
                sheetId: this.tabs[i],
                rows: rows.map(cells),
                fields: 'userEnteredValue',
              },
            },
          ]
        : [],
    );
    await json(`sheets/v4/spreadsheets/${this.id}:batchUpdate`, post({ requests }));
    this.cache.set(revision.id, { ...revision, sheetSaved: true });
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
  return new SheetsRepository(spreadsheet.id);
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
