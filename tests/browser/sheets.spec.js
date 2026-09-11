// Regression coverage for the transition from mutable Sheets to private Drive data.
import { test, expect } from '@playwright/test';
import { newEntry, makeRevision } from '../../src/model.js';
import { mock, state, connect, device } from './appdata-helpers.js';

test('private storage migration failure preserves source and resumes after reconnect', async ({
  browser,
}, testInfo) => {
  const data = state();
  data.legacy = makeRevision({ ...newEntry(), title: '실패해도 보존', body: '시트 원본' });
  data.failWrites = true;
  const context = await browser.newContext(device(testInfo));
  try {
    await mock(context, data);
    const page = await context.newPage();
    await page.goto('/');
    await page.locator('#banner-connect').click();
    await expect(page.locator('#toast')).toContainText('retry upload');
    expect([...data.files.values()].some((f) => f.appProperties.kind === 'root')).toBe(false);
    expect(data.legacy.entry.body).toBe('시트 원본');
    data.failWrites = false;
    await page.locator('#select-sheet').click();
    await expect(page.locator('#connection')).toHaveText('클라우드 연결됨');
    await expect(page.locator('.record')).toContainText('실패해도 보존');
    expect(data.calls.filter((c) => c.includes('/v4/')).every((c) => c.startsWith('GET'))).toBe(
      true,
    );
  } finally {
    await context.close();
  }
});

test('private storage migration copies photos without deleting visible Drive originals', async ({
  browser,
}, testInfo) => {
  const data = state();
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=',
    'base64',
  );
  for (const id of ['old-photo', 'old-thumb'])
    data.files.set(id, {
      id,
      name: 'asset-photo',
      appProperties: { namespace: 'legacy', kind: 'legacy' },
      bytes,
    });
  data.legacy = makeRevision({
    ...newEntry(),
    title: '사진 이전',
    images: [
      {
        id: 'photo',
        name: 'photo.png',
        type: 'image/png',
        driveId: 'old-photo',
        thumbnail: {
          id: 'photo-thumbnail',
          name: 'thumb.png',
          type: 'image/png',
          driveId: 'old-thumb',
        },
      },
    ],
  });
  const context = await browser.newContext(device(testInfo));
  try {
    await mock(context, data);
    const page = await context.newPage();
    await connect(page, false);
    await page.locator('.record').click();
    await expect(page.locator('#photos img')).toBeVisible();
    await page.locator('[data-open-photo]').click();
    await expect(page.locator('.original-photo')).toBeVisible();
    expect(data.files.has('old-photo')).toBe(true);
    expect(data.files.has('old-thumb')).toBe(true);
    const seed = [...data.files.values()].find((f) => f.appProperties.kind === 'seed');
    const image = JSON.parse(seed.bytes).entry.images[0];
    expect(image.storage).toBe('appDataFolder');
    expect(image.driveId).not.toBe('old-photo');
    const oldCacheCleared = await page.evaluate(async () => {
      const store = await import('/src/storage.js');
      const { cleanLocalPhotos } = await import('/src/journal/photos.js');
      await store.openStore('sheets-owner-old-sheet');
      await store.put('assets', {
        id: 'photo',
        driveId: 'old-photo',
        blob: new Blob(['old cache']),
      });
      await cleanLocalPhotos();
      return !(await store.get('assets', 'photo'));
    });
    expect(oldCacheCleared).toBe(true);
  } finally {
    await context.close();
  }
});
