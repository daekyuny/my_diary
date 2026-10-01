import { test } from 'node:test';
import assert from 'node:assert/strict';
import { optimizes, fitWithin } from '../src/journal/media.js';

test('camera photos are optimized by default while screenshots and animations keep their bytes', () => {
  assert.equal(optimizes('image/jpeg'), true);
  assert.equal(optimizes('image/webp', 'optimized'), true);
  assert.equal(optimizes('image/jpeg', 'original'), false);
  assert.equal(optimizes('image/png'), false);
  assert.equal(optimizes('image/gif'), false);
});

test('optimized photos keep their aspect ratio within the longer side', () => {
  assert.deepEqual(fitWithin(4032, 3024, 2048), { width: 2048, height: 1536 });
  assert.deepEqual(fitWithin(1000, 3000, 2048), { width: 683, height: 2048 });
  assert.deepEqual(fitWithin(800, 600, 2048), { width: 800, height: 600 });
});
