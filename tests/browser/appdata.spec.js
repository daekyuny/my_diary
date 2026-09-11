import { test, expect } from '@playwright/test';
import { newEntry, makeRevision } from '../../src/model.js';
import { mock, state, connect, device } from './appdata-helpers.js';
test('private storage saves and restores on another device without visible Drive files', async ({
  browser,
}, testInfo) => {
  const data = state();
  const a = await browser.newContext(device(testInfo));
  const b = await browser.newContext(device(testInfo));
  try {
    await mock(a, data);
    await mock(b, data);
    const first = await a.newPage();
    await connect(first, true);
    await first.locator('#quick-entry').click();
    await first.locator('#entry-title').fill('앱 전용 일기');
    await first.locator('#entry-body').fill('다른 PC에서도 이어 씁니다');
    await first.locator('#save').click();
    await expect(first.locator('#connection')).toHaveText('클라우드 연결됨');
    const second = await b.newPage();
    await connect(second, false);
    await expect(second.locator('.record')).toContainText('앱 전용 일기');
    await second.locator('.record').click();
    await expect(second.locator('#entry-body')).toHaveValue('다른 PC에서도 이어 씁니다');
    expect(data.calls.some((c) => c.includes('/v4/'))).toBe(false);
    await first.screenshot({
      path: `artifacts/appdata-journal-${testInfo.project.name}.png`,
      fullPage: true,
    });
    const settingsButton = (await first.locator('#open-settings').isVisible())
      ? '#open-settings'
      : '#mobile-settings';
    await first.locator(settingsButton).click();
    await first.screenshot({
      path: `artifacts/appdata-settings-${testInfo.project.name}.png`,
      fullPage: true,
    });
  } finally {
    await a.close();
    await b.close();
  }
});
test('existing Sheets migrate read-only and subsequent saves use private files', async ({
  browser,
}, testInfo) => {
  const data = state();
  data.legacy = makeRevision({ ...newEntry(), title: '이전할 일기', body: '원래 본문' });
  const context = await browser.newContext(device(testInfo));
  try {
    await mock(context, data);
    const page = await context.newPage();
    await connect(page, false);
    await expect(page.locator('.record')).toContainText('이전할 일기');
    await page.locator('.record').click();
    await page.locator('#edit-entry').click();
    await page.locator('#entry-body').fill('이전 후 수정');
    await page.locator('#save').click();
    await expect(page.locator('#connection')).toHaveText('클라우드 연결됨');
    expect(data.legacy.entry.body).toBe('원래 본문');
    expect(data.calls.filter((c) => c.includes('/v4/')).every((c) => c.startsWith('GET'))).toBe(
      true,
    );
    expect([...data.files.values()].some((f) => f.appProperties.kind === 'revision')).toBe(true);
  } finally {
    await context.close();
  }
});

test('private storage concurrent edits can be kept as two diaries from the conflict dialog', async ({
  browser,
}, testInfo) => {
  const data = state();
  const a = await browser.newContext(device(testInfo));
  const b = await browser.newContext(device(testInfo));
  try {
    await mock(a, data);
    await mock(b, data);
    const first = await a.newPage();
    await connect(first, true);
    await first.locator('#quick-entry').click();
    await first.locator('#entry-title').fill('동시 수정');
    await first.locator('#entry-body').fill('기준');
    await first.locator('#save').click();
    await expect(first.locator('#connection')).toHaveText('클라우드 연결됨');
    const second = await b.newPage();
    await connect(second, false);
    for (const page of [first, second]) {
      await page.locator('.record').click();
      await page.locator('#edit-entry').click();
    }
    await first.locator('#entry-body').fill('첫 기기');
    await second.locator('#entry-body').fill('둘째 기기');
    await first.locator('#save').click();
    await expect(first.locator('#connection')).toHaveText('클라우드 연결됨');
    await second.locator('#save').click();
    await expect(second.locator('#connection')).toHaveText('클라우드 연결됨');
    await second.locator('.record').click();
    await second.locator('#resolve-conflict').click();
    await expect(second.locator('#small-body')).toContainText('첫 기기');
    await expect(second.locator('#small-body')).toContainText('둘째 기기');
    await second.locator('#keep-conflict-copy').click();
    await expect(second.locator('.record')).toHaveCount(2);
    await expect(second.locator('#connection')).toHaveText('클라우드 연결됨');
    await expect(second.locator('#cloud-error')).toBeHidden();
  } finally {
    await a.close();
    await b.close();
  }
});

test('private storage uploads photos, releases original cache and exports their bytes', async ({
  browser,
}, testInfo) => {
  const { readFile } = await import('node:fs/promises');
  const { unzipSync, strFromU8 } = await import('fflate');
  const data = state();
  const context = await browser.newContext(device(testInfo));
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=',
    'base64',
  );
  try {
    await mock(context, data);
    const page = await context.newPage();
    await connect(page, true);
    await page.locator('#quick-entry').click();
    await page.locator('#entry-title').fill('사진과 백업');
    await page
      .locator('#photo-input')
      .setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: bytes });
    await expect(page.locator('#photos img')).toBeVisible();
    await page.locator('#save').click();
    await expect(page.locator('#editor-dialog')).not.toBeVisible();
    await expect(page.locator('#connection')).toHaveText('클라우드 연결됨');
    const cached = await page.evaluate(async () => {
      const store = await import('/src/storage.js');
      const settings = JSON.parse(localStorage.getItem('my-diary-sheets-settings'));
      await store.openStore(`sheets-owner-${settings.sheets.owner}`);
      return (await store.all('assets')).map((a) => a.id);
    });
    expect(cached.every((id) => id.endsWith('-thumbnail'))).toBe(true);
    expect([...data.files.values()].filter((f) => f.appProperties.kind === 'asset')).toHaveLength(
      2,
    );
    const settings = (await page.locator('#open-settings').isVisible())
      ? '#open-settings'
      : '#mobile-settings';
    await page.locator(settings).click();
    const download = page.waitForEvent('download');
    await page.locator('#export').click();
    const files = unzipSync(await readFile(await (await download).path()));
    const manifest = JSON.parse(strFromU8(files['diary.json']));
    expect(manifest.revisions[0].entry.title).toBe('사진과 백업');
    const photo = Object.entries(files).find(([name]) => name.startsWith('attachments/'))[1];
    expect(Buffer.from(photo)).toEqual(bytes);
  } finally {
    await context.close();
  }
});
