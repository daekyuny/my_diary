import test from 'node:test';
import assert from 'node:assert/strict';
import {
  newEntry,
  makeRevision,
  heads,
  entryGroups,
  filterGroups,
  mergeEvents,
  calendarEvent,
  revisionFile,
  parseRevision,
  markdown,
  validDate,
  localDate,
} from '../src/model.js';

test('concurrent changes retain both branches until an explicit merge', () => {
  const entry = newEntry('2026-09-01');
  entry.body = 'first';
  const base = makeRevision(entry);
  const phone = makeRevision({ ...entry, body: 'phone: 12345' }, [base.id]);
  const tablet = makeRevision({ ...entry, body: 'tablet: 김민수' }, [base.id]);
  assert.equal(heads([base, phone, tablet]).length, 2);
  const merged = makeRevision({ ...entry, body: `${phone.entry.body}\n${tablet.entry.body}` }, [
    phone.id,
    tablet.id,
  ]);
  assert.deepEqual(
    heads([base, phone, tablet, merged]).map((r) => r.id),
    [merged.id],
  );
  assert.equal(base.entry.body, 'first');
});

test('sorting uses diary date, and search finds numbers and event notes', () => {
  const older = makeRevision({
    ...newEntry('2026-08-01'),
    body: '계약 번호 001234',
    tags: ['업무'],
  });
  const newer = makeRevision({
    ...newEntry('2026-09-01'),
    events: [{ key: 'a', title: '회의', note: '김민수' }],
  });
  older.savedAt = '2026-09-09T01:00:00Z';
  const groups = entryGroups([older, newer]);
  assert.equal(filterGroups(groups)[0].latest.entry.date, '2026-09-01');
  assert.equal(filterGroups(groups, { query: '００１２３４', tag: '업무' }).length, 1);
  assert.equal(filterGroups(groups, { query: '김민수' }).length, 1);
  assert.equal(filterGroups(groups, { from: '2026-08-02', to: '2026-08-31' }).length, 0);
});

test('refreshing or deleting a calendar event preserves the diary note and reminder choice', () => {
  const original = { key: 'work:1', title: 'old', note: '중요한 이름', remind: false };
  const [updated] = mergeEvents(
    [original],
    [{ ...original, title: 'new', note: '', remind: true }],
  );
  assert.equal(updated.title, 'new');
  assert.equal(updated.note, '중요한 이름');
  assert.equal(updated.remind, false);
  const [missing] = mergeEvents([updated], []);
  assert.equal(missing.missing, true);
  assert.equal(missing.note, '중요한 이름');
  assert.equal(mergeEvents([updated], [{ ...original, title: 'new' }]).length, 1);
});

test('calendar event identity includes calendar and recurring instance id', () => {
  const raw = {
    id: 'series_20260901',
    summary: '점심',
    start: { date: '2026-09-01' },
    end: { date: '2026-09-02' },
  };
  assert.notEqual(calendarEvent(raw, 'a').key, calendarEvent(raw, 'b').key);
  assert.equal(calendarEvent(raw, 'a').allDay, true);
});

test('portable Markdown round-trips all metadata and resolves image paths', () => {
  const entry = {
    ...newEntry('2026-09-09'),
    title: '메모',
    body: '이름 **홍길동**\n![사진](diary-image:photo-1)',
    images: [{ id: 'photo-1', name: '사진.png', type: 'image/png' }],
  };
  const revision = makeRevision(entry);
  assert.deepEqual(parseRevision(revisionFile(revision)), revision);
  assert.match(markdown(entry), /attachments\/photo-1.png/);
  assert.throws(() => parseRevision('not a backup'));
  assert.throws(() =>
    makeRevision({ ...entry, images: [{ id: '../escape', name: 'x', type: 'image/svg+xml' }] }),
  );
});

test('dates reject calendar overflow and stay local', () => {
  assert.equal(validDate('2026-02-30'), false);
  assert.equal(validDate('2024-02-29'), true);
  const local = new Date(2026, 8, 9, 0, 1);
  assert.equal(localDate(local), '2026-09-09');
});

test('invalid backup metadata is rejected before it can break rendering', () => {
  const revision = makeRevision(newEntry('2026-09-09'));
  assert.throws(() => parseRevision(revisionFile({ ...revision, id: undefined })));
  assert.throws(() => parseRevision(revisionFile({ ...revision, savedAt: 123 })));
  assert.throws(() => parseRevision(revisionFile({ ...revision, parents: [revision.id] })));
  assert.throws(() =>
    makeRevision({ ...revision.entry, weather: { date: '2026-09-09', location: null } }),
  );
});

test('calendar refresh preserves manual rows and edits and respects removed events', () => {
  const original = {
    key: 'work:1',
    title: 'Remote title',
    start: '2026-09-09T01:00:00Z',
    note: 'My note',
    remind: false,
    overrides: { title: 'My title', start: '2026-09-09T02:00:00Z' },
  };
  const manual = { key: 'manual:1', title: 'My appointment', note: '', manual: true };
  const result = mergeEvents(
    [original, manual],
    [
      { key: 'work:1', title: 'New remote title', start: '2026-09-09T03:00:00Z' },
      { key: 'work:2', title: 'Deleted appointment', note: '' },
    ],
    ['work:2'],
  );
  assert.equal(result.length, 2);
  assert.equal(result[0].title, 'My title');
  assert.equal(result[0].start, '2026-09-09T02:00:00Z');
  assert.equal(result[0].note, 'My note');
  assert.equal(result[0].remind, false);
  assert.deepEqual(result[1], manual);
  assert.equal(mergeEvents(result, [{ key: 'work:2', title: 'Restored', note: '' }]).length, 3);
});
