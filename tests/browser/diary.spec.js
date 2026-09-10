import { edit } from './helpers.js';
import { test, expect } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

test.beforeEach(async ({ page }) => {
  await page.route('https://accounts.google.com/**', (route) => route.abort());
  await page.goto('/legacy.html');
  await expect(page.locator('#entry-heading')).not.toBeEmpty();
});

test('write, revise, reload, date sort and search without pretending Drive is connected', async ({
  page,
}, testInfo) => {
  await page.locator('#entry-date').fill('2026-09-08');
  await edit(page);
  await page.locator('#entry-title').fill('기억하고 싶은 이름');
  await edit(page);
  await page.locator('#entry-body').fill('김민수 · 회의 번호 001234');
  await edit(page);
  await page.locator('#entry-tags').fill('업무, 기억');
  await page.locator('#save').click();
  await expect(page.locator('#save-state')).toContainText('기기에 저장');
  await page.reload();
  await expect(page.locator('#entry-body')).toHaveValue('김민수 · 회의 번호 001234');
  await edit(page);
  await page.locator('#entry-body').fill('김민수 · 회의 번호 001234\n추가 메모');
  await page.locator('#save').click();
  await page.locator('#entry-date').fill('2026-08-01');
  await edit(page);
  await page.locator('#entry-title').fill('뒤늦게 쓴 지난 일기');
  await edit(page);
  await page.locator('#entry-body').fill('지난달 여행');
  await page.locator('#save').click();
  if (testInfo.project.name !== 'chromium') await page.locator('#back-list').click();
  await expect(page.locator('.entry-card').first()).toContainText('기억하고 싶은 이름');
  await page.locator('#search').fill('001234');
  await expect(page.locator('.entry-card')).toHaveCount(1);
  await page.locator('#search').fill('없는 내용');
  await expect(page.locator('.empty-list')).toContainText('일치하는 기록이 없어요');
  await page.locator('#search').fill('');
  await page.locator('#tag-filter').selectOption('업무');
  await expect(page.locator('.entry-card')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('photo insertion and ZIP export/import preserve image bytes and text', async ({
  page,
  context,
}, testInfo) => {
  await edit(page);
  await page.locator('#entry-title').fill('사진과 함께');
  await edit(page);
  await page.locator('#entry-body').fill('카페에서 만난 오후');
  await page.locator('#image-input').setInputFiles({
    name: 'drawing.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      'base64',
    ),
  });
  await expect(page.locator('.image-tile img')).toBeVisible();
  await page.getByRole('button', { name: '본문에 삽입' }).click();
  await expect(page.locator('#entry-body')).toHaveValue(/diary-image:/);
  await page.locator('#save').click();
  await expect(page.locator('.preview-photos .photo-thumbnail img')).toBeVisible();
  await page.locator('.preview-photos .photo-thumbnail').click();
  await expect(page.locator('#original-photo')).toBeVisible();
  await expect(page.locator('#original-photo-link')).toHaveAttribute('href', /^blob:/);
  await page.locator('#close-photo').click();
  const download = page.waitForEvent('download');
  await page.locator('#export').click();
  const file = await (await download).path();
  const fresh = await context
    .browser()
    .newContext(
      testInfo.project.name !== 'chromium' ? { viewport: { width: 390, height: 844 } } : {},
    );
  const restored = await fresh.newPage();
  await restored.route('https://accounts.google.com/**', (route) => route.abort());
  await restored.goto('/legacy.html');
  await expect(restored.locator('#entry-heading')).not.toBeEmpty();
  await restored.locator('#import-input').setInputFiles(file);
  await expect(restored.locator('#toast')).toContainText('가져왔습니다');
  await restored.locator('#new-entry').click();
  await expect(restored.locator('#entry-title')).toHaveValue('사진과 함께');
  await expect(restored.locator('.image-tile img')).toBeVisible();
  const restoredBytes = await restored.evaluate(async () => {
    const storage = await import('/src/storage.js');
    const [asset] = await storage.all('assets');
    return Array.from(new Uint8Array(await asset.blob.arrayBuffer()));
  });
  expect(Buffer.from(restoredBytes).toString('base64')).toBe(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  );
  await fresh.close();
});

test('weather is saved for the chosen diary date and location', async ({ page }) => {
  await page.route('https://geocoding-api.open-meteo.com/**', (route) =>
    route.fulfill({
      json: {
        results: [
          {
            name: '서울',
            country: '대한민국',
            latitude: 37.57,
            longitude: 126.98,
            timezone: 'Asia/Seoul',
          },
        ],
      },
    }),
  );
  await page.route('https://archive-api.open-meteo.com/**', async (route) => {
    expect(new URL(route.request().url()).searchParams.get('start_date')).toBe('2025-06-01');
    await route.fulfill({
      json: {
        daily: { weather_code: [3], temperature_2m_min: [19.2], temperature_2m_max: [27.5] },
      },
    });
  });
  await page.locator('#entry-date').fill('2025-06-01');
  await edit(page);
  await page.locator('#weather-button').click();
  await page.locator('#location-query').fill('서울');
  await page.locator('#search-location').click();
  await page.locator('.location-result').click();
  await expect(page.locator('#weather-card')).toContainText('19.2–27.5');
  await expect(page.locator('#weather-card')).toContainText('재분석 추정');
  await page.reload();
  await expect(page.locator('#weather-card')).toContainText('서울');
});

test('unconfigured services show setup and user content never executes HTML', async ({ page }) => {
  await page.route('**/config.json', (route) => route.fulfill({ json: {} }));
  await page.reload();
  await edit(page);
  await page.locator('#entry-body').fill('<img src=x onerror="window.hacked=true">');
  await page.locator('#save').click();
  await expect(page.locator('#preview')).toContainText('<img');
  expect(await page.evaluate(() => window.hacked)).toBeUndefined();
  await page.locator('#banner-connect').click();
  await expect(page.locator('#dialog-title')).toHaveText('나의 일기장 설정');
  await expect(page.locator('#setting-client')).toHaveValue('');
  await page.locator('#close-dialog').click();
  await page.locator('#preview-calendar').click();
  await expect(page.locator('#dialog-title')).toHaveText('Google 캘린더 연결');
});

test('capture first-version layout', async ({ page }, testInfo) => {
  await edit(page);
  await page.locator('#entry-title').fill('하루의 작은 조각들');
  await edit(page);
  await page
    .locator('#entry-body')
    .fill(
      '오래 기억하고 싶은 것들을 한 줄씩 남기기로 했다.\n\n오늘 배운 이름과 숫자, 지나치기 쉬운 작은 순간까지.\n완벽한 문장이 아니어도 괜찮다.',
    );
  await edit(page);
  await page.locator('#entry-tags').fill('일상, 시작');
  await page.locator('#save').click();
  await expect(page.locator('#save-state')).toContainText('기기에 저장');
  await page.locator('#toast').waitFor({ state: 'hidden' });
  await page.screenshot({ path: `artifacts/${testInfo.project.name}.png`, fullPage: true });
});

test.describe('service worker offline storage', () => {
  test.use({ serviceWorkers: 'allow' });
  test('offline shell reload keeps edits pending and recovers interrupted drafts', async ({
    page,
    context,
    browserName,
  }) => {
    test.skip(
      browserName !== 'chromium',
      'Playwright service-worker offline emulation is supported on Chromium.',
    );
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    await edit(page);
    await page.locator('#entry-title').fill('오프라인 기록');
    await edit(page);
    await page.locator('#entry-body').fill('네트워크 없이 기억한 숫자 4567');
    await page.waitForFunction(async () => {
      const storage = await import('/src/storage.js');
      return (await storage.all('drafts')).some((draft) => draft.entry.body.includes('4567'));
    });
    await context.setOffline(true);
    await page.reload();
    await expect(page.locator('#entry-body')).toHaveValue('네트워크 없이 기억한 숫자 4567');
    await edit(page);
    await page.locator('#entry-body').fill('네트워크 없이 기억한 숫자 4567 · 이어쓰기');
    await page.locator('#save').click();
    await expect(page.locator('#save-state')).toContainText('동기화 대기');
    await page.reload();
    await expect(page.locator('#entry-body')).toHaveValue(/이어쓰기/);
    await context.setOffline(false);
  });
});
