import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  connectionLabel,
  repositoryDetails,
  saveStateLabel,
  pageTitle,
  quickLabel,
  characterCount,
  dateLabel,
  monthLabel,
} from '../src/journal/labels.js';
import {
  readingDetailsHTML,
  eventsHTML,
  eventTime,
  repositoryOptionsHTML,
  quickEntryVisible,
  cards,
} from '../src/journal/views.js';
import { batches } from '../src/journal/cloud-sync.js';
import { nextRevision } from '../src/journal/current.js';
import { ownerKey } from '../src/journal/settings.js';
import { newEntry, makeRevision } from '../src/model.js';

test('connection label prefers work in progress, then offline, then repository state', () => {
  const base = { working: false, onLine: true, connected: true, repository: {}, pending: 0 };
  assert.equal(connectionLabel({ ...base, working: true }), '저장·연결 중…');
  assert.equal(connectionLabel({ ...base, onLine: false }), '오프라인 · 기기 저장');
  assert.equal(connectionLabel(base), '클라우드 연결됨');
  assert.equal(connectionLabel({ ...base, pending: 2 }), '클라우드 저장 대기');
  assert.equal(connectionLabel({ ...base, repository: null }), '저장소 연결 필요 · 기기 저장');
  assert.equal(
    connectionLabel({
      ...base,
      connected: false,
      repository: null,
      account: { permissionId: 'p' },
    }),
    'Google 재연결 필요',
  );
  assert.equal(connectionLabel({ ...base, connected: false, repository: null }), '기기에 저장');
});

test('date labels spell out year, month, day and weekday in Korean', () => {
  assert.equal(dateLabel('2026-09-29'), '2026년 9월 29일 화요일');
  assert.equal(dateLabel('2024-02-29'), '2024년 2월 29일 목요일');
  assert.equal(dateLabel('2026-01-04'), '2026년 1월 4일 일요일');
  assert.equal(monthLabel('2026-09'), '2026년 9월');
});

test('repository details count cloud diaries and trash separately', () => {
  const repository = {
    id: 'repo-1',
    index: [{ entry: { deletedAt: '' } }, { entry: { deletedAt: '2026-01-01' } }, { entry: {} }],
  };
  assert.equal(
    repositoryDetails(repository, 1, false),
    '저장소 ID: repo-1 · 클라우드 일기 2개 · 휴지통 1개 · 이 기기 저장 대기 1개 · 재연결 후 최신 개수 확인',
  );
  assert.match(repositoryDetails(null, 0, true), /연결된 저장소 없음/);
});

test('save state label reflects dirty edits, conflicts, cloud and device saves', () => {
  assert.equal(saveStateLabel({ dirty: true }), '저장하지 않은 변경');
  assert.equal(saveStateLabel({ conflicted: true }), '다른 기기 수정 확인');
  assert.equal(saveStateLabel({ cloudSaved: true, activeRevision: 'r' }), '✓ 클라우드 저장 완료');
  assert.equal(saveStateLabel({ activeRevision: 'r' }), '✓ 기기에 저장');
  assert.equal(saveStateLabel({}), '새 기록');
  assert.equal(pageTitle('journal', 'calendar'), '날짜로 보는 기록');
  assert.equal(pageTitle('archive', 'list'), '삭제한 기록');
  assert.equal(quickLabel('calendar', '2026-09-29'), '2026-09-29에 새 기록 남기기');
  assert.equal(quickLabel('list', ''), '오늘 기록 남기기');
  assert.equal(characterCount('a'.repeat(1234)), '1,234자');
});

test('today prompt hides once today has a diary, in other collections, and cards carry no delete button', () => {
  const group = (date, archived = false) => ({
    latest: { entry: { ...newEntry(date), archived }, sheetSaved: true },
    heads: [],
  });
  const today = '2026-09-30',
    base = { collection: 'journal', view: 'list', day: '', today };
  assert.equal(quickEntryVisible([], base), true);
  assert.equal(quickEntryVisible([group('2026-09-29')], base), true);
  assert.equal(quickEntryVisible([group(today)], base), false);
  assert.equal(quickEntryVisible([group(today, true)], base), true);
  assert.equal(quickEntryVisible([], { ...base, collection: 'archive' }), false);
  assert.equal(quickEntryVisible([], { ...base, collection: 'pinned' }), false);
  assert.equal(quickEntryVisible([group(today)], { ...base, view: 'calendar' }), false);
  assert.equal(
    quickEntryVisible([group(today)], { ...base, view: 'calendar', day: '2026-09-01' }),
    true,
  );
  const html = cards([group(today)], 'list');
  assert.match(html, /class="record"/);
  assert.doesNotMatch(html, /data-delete-entry|record-delete/);
});

test('editor HTML escapes user content and hides events when the template is off', () => {
  const entry = {
    ...newEntry('2026-09-29'),
    tags: ['<b>'],
    events: [{ key: 'k', title: '<script>', note: '"q"', location: '', allDay: true, start: '' }],
  };
  const reading = readingDetailsHTML(entry);
  assert.match(reading, /#&lt;b&gt;/);
  assert.match(reading, /&lt;script&gt;/);
  assert.doesNotMatch(reading, /<script>/);
  assert.match(eventsHTML(entry), /data-remove-event="0"/);
  assert.match(eventsHTML(entry), /&quot;q&quot;/);
  assert.equal(eventsHTML({ ...entry, calendarTemplate: false }), '');
  assert.equal(readingDetailsHTML({ ...entry, tags: [], calendarTemplate: false }), '');
  assert.equal(eventTime({ allDay: true }), '종일');
  assert.equal(eventTime({ allDay: false, start: '' }), '');
  assert.equal(
    repositoryOptionsHTML([{ id: 'abcdefghijkl', name: 'A<' }]),
    '<option value="abcdefghijkl">A&lt; · efghijkl</option>',
  );
});

test('sync batches cap the item count and stop before exceeding the byte budget', () => {
  const small = Array.from({ length: 45 }, (_, i) => ({ id: String(i) }));
  assert.deepEqual(
    batches(small).map((b) => b.length),
    [20, 20, 5],
  );
  const big = { id: 'big', body: 'x'.repeat(400000) };
  const grouped = batches([big, big, { id: 'tiny' }]);
  assert.deepEqual(
    grouped.map((b) => b.length),
    [1, 2],
  );
  assert.deepEqual(batches([]), []);
});

test('next revision chains to the last cloud revision or the pending base', () => {
  const entry = newEntry('2026-09-29');
  const cloud = { ...makeRevision(entry), sheetSaved: true };
  const chained = nextRevision(entry, [cloud.id], cloud);
  assert.equal(chained.baseRevision, cloud.id);
  assert.equal(chained.remoteKnown, true);
  const local = { ...makeRevision(entry, [cloud.id]), baseRevision: cloud.id };
  const again = nextRevision(entry, [local.id], local);
  assert.equal(again.baseRevision, cloud.id);
  assert.equal(again.remoteKnown, false);
  const fresh = nextRevision(entry, [], undefined);
  assert.equal(fresh.baseRevision, undefined);
  assert.equal(fresh.remoteKnown, false);
});

test('owner key separates accounts, repositories and pre-login records', () => {
  assert.equal(ownerKey(null, {}), 'sheets-local');
  assert.equal(ownerKey({ permissionId: 'p1' }, {}), 'sheets-p1-unassigned');
  assert.equal(ownerKey({ permissionId: 'p1' }, { sheets: { p1: 'repo' } }), 'sheets-p1-repo');
});
