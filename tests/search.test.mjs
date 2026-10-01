import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchRanges, highlightHTML, excerpt } from '../src/journal/search.js';
import { cards, visibleGroups } from '../src/journal/views.js';
import { newEntry, makeRevision } from '../src/model.js';

test('matches use the list filter folding and map back to the original characters', () => {
  assert.deepEqual(matchRanges('오늘 １２３ 걸음', '123'), [[3, 6]]);
  assert.deepEqual(matchRanges('Walk and WALK', 'walk'), [
    [0, 4],
    [9, 13],
  ]);
  // Decomposed Hangul (as some exports store it) still matches the composed query.
  assert.deepEqual(matchRanges('가 가', '가'), [
    [0, 2],
    [3, 4],
  ]);
  assert.deepEqual(matchRanges('본문', ''), []);
});

test('highlights escape diary text and wrap only the matches', () => {
  assert.equal(highlightHTML('a<b>Café</b>', 'café'), 'a&lt;b&gt;<mark>Café</mark>&lt;/b&gt;');
  assert.equal(highlightHTML('<script>', 'zzz'), '&lt;script&gt;');
  assert.equal(highlightHTML('a & b', '&'), 'a <mark>&amp;</mark> b');
});

test('previews start at the sentence holding a far match and keep near matches whole', () => {
  const body = `${'앞부분 이야기. '.repeat(10)}오후에는 공원에서 산책을 했다.`;
  assert.equal(excerpt(body, '산책'), '…오후에는 공원에서 산책을 했다.');
  assert.equal(excerpt('짧은 산책', '산책'), '짧은 산책');
  assert.equal(excerpt(body, ''), body);
});

test('cards mark the query in titles and previews only while searching', () => {
  const entry = {
    ...newEntry('2026-09-29'),
    title: '저녁 산책',
    body: `${'긴 이야기. '.repeat(10)}강가를 따라 산책했다.`,
  };
  const groups = [{ latest: makeRevision(entry), heads: [] }];
  const shown = visibleGroups(groups, { query: '산책' });
  const html = cards(shown, 'list', true, '산책');
  assert.match(html, /<h2>저녁 <mark>산책<\/mark><\/h2>/);
  assert.match(html, /<p>…강가를 따라 <mark>산책<\/mark>했다\.<\/p>/);
  assert.doesNotMatch(cards(shown, 'list'), /<mark>/);
});
