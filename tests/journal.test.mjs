import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newEntry, makeRevision, entryGroups } from '../src/model.js';
import { visibleGroups, validateDefinition, cards, escape } from '../src/journal/views.js';
import { parseArchive } from '../src/journal/backup.js';
import { zipSync, strToU8 } from 'fflate';

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
