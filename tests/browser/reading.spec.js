import { test, expect } from '@playwright/test';
import { edit } from './helpers.js';

test.use({ serviceWorkers: 'block' });
test.beforeEach(async ({ page }) => {
  await page.route('https://accounts.google.com/**', (route) => route.abort());
  await page.goto('/');
  await expect(page.locator('#entry-heading')).not.toBeEmpty();
});

async function list(page) {
  if (await page.locator('#back-list').isVisible()) await page.locator('#back-list').click();
}

test('saved entries open as previews with editable tags and individual schedule rows', async ({
  page,
}) => {
  await expect(page.locator('#preview')).toBeVisible();
  await expect(page.locator('#editor-fields')).toBeHidden();
  await edit(page);
  await page.locator('#entry-body').fill('읽기 화면의 본문');
  await page.locator('#entry-tags').fill('일상, 업무');
  await page.getByRole('button', { name: '업무 태그 제거', exact: true }).click();
  await page.locator('#add-event').click();
  await page.locator('[data-event-field=title]').fill('직접 기록한 점심');
  await page.locator('[data-event-field=start]').fill('12:30');
  await page.locator('[data-event-field=end]').fill('13:30');
  await page.locator('[data-event-note="0"]').fill('일정별 내용');
  await page.locator('#save').click();
  await expect(page.locator('#editor-fields')).toBeHidden();
  await expect(page.locator('.preview-body')).toHaveText('읽기 화면의 본문');
  await expect(page.locator('.preview-tags')).toHaveText('#일상');
  await expect(page.locator('.preview-event')).toContainText('12:30');
  await expect(page.locator('.preview-event')).toContainText('일정별 내용');
  await expect(page.locator('#preview textarea')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('#preview')).toBeVisible();
  await expect(page.locator('.preview-event')).toContainText('직접 기록한 점심');
  await edit(page);
  await page.locator('#remove-template').click();
  await page.locator('#save').click();
  await expect(page.locator('.preview-event')).toHaveCount(0);
  await expect(page.locator('#preview-calendar')).toBeVisible();
  await edit(page);
  await page.locator('#restore-template').click();
  await expect(page.locator('[data-event-note="0"]')).toHaveValue('일정별 내용');
  await page.locator('[data-remove-event="0"]').click();
  await page.locator('#save').click();
  await page.reload();
  await expect(page.locator('.preview-event')).toHaveCount(0);
});

test('Keep tag cleanup preserves history and calendar view opens multiple entries on the same day', async ({
  page,
}) => {
  await page.evaluate(async () => {
    const store = await import('/src/storage.js');
    const model = await import('/src/model.js');
    for (const [date, title] of [
      ['2026-08-07', '일기 시작'],
      ['2026-08-07', '그날의 일기'],
      ['2026-08-08', '다음날'],
    ]) {
      await store.put(
        'revisions',
        model.makeRevision({
          ...model.newEntry(date),
          title,
          body: `원본 ${title}`,
          tags: ['My Diary', '기억'],
          source: { format: 'google-keep' },
        }),
      );
    }
  });
  await page.reload();
  await list(page);
  await expect(page.locator('#tag-filter option')).toHaveText(['모든 태그', '기억']);
  const counts = await page.evaluate(async () => {
    const all = await (await import('/src/storage.js')).all('revisions');
    return [all.length, all.filter((r) => r.entry.tags.includes('My Diary')).length];
  });
  expect(counts).toEqual([6, 3]);
  await page.locator('#journal-view').selectOption('calendar');
  await page.locator('#calendar-month').fill('2026-08');
  await expect(page.locator('[data-calendar-date="2026-08-07"]')).toContainText('2개');
  await page.locator('[data-calendar-date="2026-08-07"]').click();
  await expect(page.locator('#preview')).toBeVisible();
  await expect(page.locator('#entry-date')).toHaveValue('2026-08-07');
  await list(page);
  await expect(page.locator('.entry-card')).toHaveCount(2);
  await page.locator('#manage-tags').click();
  await page.locator('#renamed-tag').fill('추억');
  await page.locator('#rename-tag').click();
  await expect(page.locator('#dialog')).not.toBeVisible();
  await expect(page.locator('#tag-filter option')).toHaveText(['모든 태그', '추억']);
  await page.locator('#manage-tags').click();
  await page.locator('#delete-tag').click();
  await expect(page.locator('#dialog')).not.toBeVisible();
  await expect(page.locator('#tag-filter option')).toHaveText(['모든 태그']);
  await page.reload();
  await list(page);
  await expect(page.locator('#journal-view')).toHaveValue('calendar');
  const current = await page.evaluate(async () => {
    const store = await import('/src/storage.js');
    const model = await import('/src/model.js');
    return model.entryGroups(await store.all('revisions')).map((group) => group.latest.entry);
  });
  expect(current).toHaveLength(3);
  expect(current.every((entry) => entry.tags.length === 0 && entry.body.startsWith('원본'))).toBe(
    true,
  );
});
