import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newEntry, makeRevision, entryGroups } from '../src/model.js';
import { encodeRevision, decodeIndex } from '../src/journal/sheets.js';
import { visibleGroups, validateDefinition, cards, escape } from '../src/journal/views.js';
import { parseArchive } from '../src/journal/backup.js';
import { zipSync, strToU8 } from 'fflate';

test('sheet records split long bodies and keep metadata inline without custom fields', () => {
  const e = {
    ...newEntry('2026-08-07'),
    title: '=IMPORTXML("x")',
    body: '가'.repeat(90001),
    fields: [{ id: 'place', name: '장소', value: '서울' }],
  };
  const r = makeRevision(e),
    encoded = encodeRevision(r),
    decoded = decodeIndex(encoded[0]);
  assert.equal(encoded[0][0].slice(10, 14).join(''), e.body);
  assert.equal(decoded[0].entry.title, e.title);
  assert.equal(decoded[0].summary, true);
  assert.deepEqual(encoded[1], []);
  assert.equal(JSON.parse(encoded[0][0][14]).fields, undefined);
  assert.throws(() => encodeRevision(makeRevision({ ...e, body: 'a'.repeat(120001) })));
});
test('duplicate retry IDs produce one revision while concurrent edits remain separate heads', () => {
  const first = makeRevision(newEntry());
  const a = makeRevision({ ...first.entry, body: 'PC' }, [first.id]);
  const b = makeRevision({ ...first.entry, body: '모바일' }, [first.id]);
  const rows = [first, a, a, b].map((r) => encodeRevision(r)[0][0]);
  const index = decodeIndex(rows);
  assert.equal(index.length, 3);
  assert.equal(entryGroups(index)[0].heads.length, 2);
});
test('views filter the same data by date, labels and archive', () => {
  const revisions = [
    makeRevision({
      ...newEntry('2026-08-07'),
      title: '산책',
      fields: [{ id: 'x', name: '장소', value: '서울' }],
    }),
    makeRevision({ ...newEntry('2026-08-08'), title: '보관', archived: true }),
  ];
  const groups = entryGroups(revisions);
  assert.equal(visibleGroups(groups, { query: '산책' }).length, 1);
  assert.equal(visibleGroups(groups, { collection: 'archive' })[0].latest.entry.title, '보관');
  assert.equal(visibleGroups(groups, { day: '2026-08-08' }).length, 0);
  assert.equal(visibleGroups(groups, { month: '2026-08' }).length, 1);
  assert.ok(
    !cards(
      entryGroups([makeRevision({ ...newEntry(), title: '<img src=x>', body: '<script>' })]),
      'list',
    ).includes('<img src=x>'),
  );
  assert.equal(escape('"'), '&quot;');
});
test('field definitions validate input kinds and require options for select', () => {
  assert.throws(() => validateDefinition({ name: '', type: 'text' }));
  assert.throws(() => validateDefinition({ name: '날씨', type: 'select', options: [] }));
  assert.equal(validateDefinition({ id: 'a', name: '장소', type: 'text' }).id, 'a');
});
test('Keep import filters My Diary and preserves source without reading the private project ZIP', () => {
  const bytes = zipSync({
    'Takeout/Keep/a.json': strToU8(
      JSON.stringify({
        title: '2026-08-07 하루',
        textContent: '산책',
        createdTimestampUsec: 1786089600000000,
        labels: [{ name: 'My Diary' }, { name: '여행' }],
      }),
    ),
    'Takeout/Keep/b.json': strToU8(JSON.stringify({ title: '쇼핑', labels: [] })),
  });
  const result = parseArchive(bytes);
  assert.equal(result.revisions.length, 1);
  assert.equal(result.revisions[0].entry.date, '2026-08-07');
  assert.deepEqual(result.revisions[0].entry.tags, ['여행']);
});

import { recentIds } from '../src/journal/cache.js';
test('recent cache follows diary date rather than modification time and excludes trash', () => {
  const old = makeRevision(newEntry('2000-01-01'));
  const recent = makeRevision(newEntry('2026-01-01'));
  old.savedAt = '2099-01-01T00:00:00Z';
  assert.deepEqual([...recentIds([old, recent], 1)], [recent.id]);
  recent.entry.deletedAt = '2026-01-02T00:00:00Z';
  assert.deepEqual([...recentIds([old, recent], 1)], [old.id]);
});
