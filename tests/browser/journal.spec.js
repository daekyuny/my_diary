import { test, expect } from '@playwright/test';

test.use({ serviceWorkers: 'block' });
test.beforeEach(async ({ page }) => {
  await page.route('https://accounts.google.com/**', (r) => r.abort());
  await page.goto('/');
  await expect(page.locator('#new-entry')).toBeEnabled();
});
const settings = async (page) => {
  await page
    .locator(
      (await page.locator('#open-settings').isVisible()) ? '#open-settings' : '#mobile-settings',
    )
    .click();
};
const saveClose = async (page) => {
  if (await page.locator('#save').isEnabled()) {
    await page.locator('#save').click();
    await expect(page.locator('#save')).toBeDisabled();
  }
  await page.locator('#close-editor').click();
};
const newEntry = async (page) => {
  await page.locator('#quick-entry').click();
  await expect(page.locator('#editor-dialog')).toBeVisible();
};

test('responsive journal writes separate same-day entries, searches and switches all views', async ({
  page,
}) => {
  for (const title of ['아침 산책', '저녁의 기록']) {
    await newEntry(page);
    await page.locator('#entry-date').fill('2026-08-07');
    await page.locator('#entry-title').fill(title);
    await page.locator('#entry-body').fill('오늘 기록한 숫자 12345');
    await page.locator('#entry-tags').fill('일상, 산책');
    await saveClose(page);
    await expect(page.locator('#editor-dialog')).not.toBeVisible();
  }
  await expect(page.locator('.record')).toHaveCount(2);
  await page.reload();
  await expect(page.locator('.record')).toHaveCount(2);
  await page.getByRole('button', { name: '카드 보기', exact: true }).click();
  await expect(page.locator('#records')).toHaveClass('records board');
  await page.getByRole('button', { name: '캘린더 보기', exact: true }).click();
  await page.locator('#calendar-month').fill('2026-08');
  await page.locator('[data-day="2026-08-07"]').click();
  await expect(page.locator('.record')).toHaveCount(2);
  await page.locator('#quick-entry').click();
  await expect(page.locator('#entry-date')).toHaveValue('2026-08-07');
  await page.locator('#close-editor').click();
  await page.locator('#search').fill('아침');
  await expect(page.locator('.record')).toHaveCount(1);
  await page.locator('#search').fill('<script>');
  await expect(page.locator('.empty')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('field settings add, rename and hide definitions while retaining historical values', async ({
  page,
}) => {
  await settings(page);
  await expect(page.locator('#create-sheet')).toBeVisible();
  await expect(page.locator('#sheet-help')).toContainText('Google 로그인');
  await page.locator('#new-definition').click();
  await page.locator('#definition-name').fill('장소');
  await page.locator('#definition-form button[type=submit]').click();
  await expect(page.locator('#small-dialog')).not.toBeVisible();
  await page.locator('#close-settings').click();
  await newEntry(page);
  await page.locator('#entry-title').fill('항목이 있는 일기');
  await page.locator('#add-field').click();
  await page.locator('[data-add-field]').click();
  await page.locator('[data-field-value]').fill('서울');
  await saveClose(page);
  await settings(page);
  await page.locator('[data-edit-definition]').click();
  await page.locator('#definition-name').fill('방문한 곳');
  await page.locator('#definition-type').selectOption('number');
  await page.locator('#definition-form button[type=submit]').click();
  await expect(page.locator('#small-dialog')).not.toBeVisible();
  await page.locator('[data-hide-definition]').click();
  await expect(page.locator('.definition')).toContainText('숨김');
  await page.locator('#close-settings').click();
  await page.locator('.record').click();
  await expect(page.locator('#fields label')).toHaveText('방문한 곳');
  await expect(page.locator('[data-field-value]')).toHaveValue('서울');
  await saveClose(page);
  await page.reload();
  await page.locator('.record').click();
  await expect(page.locator('[data-field-value]')).toHaveValue('서울');
});

test('pin and archive remain editable and body HTML never executes', async ({ page }) => {
  await newEntry(page);
  await page.locator('#entry-title').fill('기억');
  await page.locator('#entry-body').fill('<img src=x onerror="window.hacked=1">');
  await page.locator('#pin-entry').click();
  await saveClose(page);
  await page.locator('.record').click();
  await expect(page.locator('#pin-entry')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#archive-entry').click();
  await saveClose(page);
  await expect(page.locator('.record')).toHaveCount(0);
  await page.locator('[data-collection=archive]:visible').click();
  await page.locator('.record').click();
  await page.locator('#archive-entry').click();
  await saveClose(page);
  await expect(page.locator('.record')).toHaveCount(0);
  expect(await page.evaluate(() => window.hacked)).toBeUndefined();
});

test('journal design captures populated list, cards, calendar and editor', async ({
  page,
}, info) => {
  await page.evaluate(async () => {
    const model = await import('/src/model.js'),
      store = await import('/src/storage.js');
    await store.openStore('sheets-local');
    for (const item of [
      {
        date: '2026-09-10',
        title: '조금 느리게 걸어도 괜찮은 하루',
        body: '점심을 먹고 늘 지나치던 골목으로 걸어갔다.\n작은 책방 앞에서 잠시 멈췄다. 서두르지 않으니 보이는 것들이 있었다.',
        tags: ['일상', '산책'],
        pinned: true,
      },
      {
        date: '2026-09-09',
        title: '오랜만에 나눈, 오래 남을 이야기',
        body: '지수와 저녁을 먹으며 각자의 요즘을 나눴다.\n별것 아닌 이야기에도 함께 웃을 수 있다는 게 참 좋았다.',
        tags: ['사람', '감사'],
      },
      {
        date: '2026-09-08',
        title: '다시, 한 페이지부터',
        body: '미뤄두었던 책을 펼쳤다. 오늘 마음에 남은 문장.\n“작은 일을 꾸준히 하는 것이 나를 만든다.”',
        tags: ['독서', '기록'],
      },
      {
        date: '2026-09-07',
        title: '비가 그친 오후의 공기',
        body: '창문을 열자 선선한 바람이 들어왔다.\n따뜻한 커피 한 잔과 좋아하는 음악. 이런 시간이 필요했다.',
        tags: ['일상'],
      },
    ])
      await store.put(
        'revisions',
        model.makeRevision({ ...model.newEntry(item.date), ...item, fields: [] }),
      );
  });
  await page.reload();
  await expect(page.locator('.record')).toHaveCount(4);
  await page.screenshot({
    path: `artifacts/journal-list-${info.project.name}.png`,
    fullPage: true,
  });
  await page.getByRole('button', { name: '카드 보기', exact: true }).click();
  await page.screenshot({
    path: `artifacts/journal-board-${info.project.name}.png`,
    fullPage: true,
  });
  await page.getByRole('button', { name: '캘린더 보기', exact: true }).click();
  await page.locator('#calendar-month').fill('2026-09');
  await page.screenshot({
    path: `artifacts/journal-calendar-${info.project.name}.png`,
    fullPage: true,
  });
  await page.locator('.record').first().click();
  await expect(page.locator('#editor-dialog')).toBeVisible();
  await page.screenshot({
    path: `artifacts/journal-editor-${info.project.name}.png`,
    fullPage: false,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('manual save stays disabled until changed and closing unsaved edits asks for confirmation', async ({
  page,
}) => {
  await newEntry(page);
  await expect(page.locator('#save')).toBeDisabled();
  await page.locator('#entry-title').fill('저장한 제목');
  await page.locator('#save').click();
  await expect(page.locator('#editor-dialog')).toBeVisible();
  await expect(page.locator('#save')).toBeDisabled();
  await page.locator('#entry-body').fill('저장하지 않을 변경');
  await page.waitForTimeout(1600);
  await expect(page.locator('#save')).toBeEnabled();
  page.once('dialog', (dialog) => {
    expect(dialog.message()).toContain('저장하지 않은');
    return dialog.dismiss();
  });
  await page.locator('#close-editor').click();
  await expect(page.locator('#editor-dialog')).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#close-editor').click();
  await page.locator('.record').click();
  await expect(page.locator('#entry-body')).toHaveValue('');
  await page.locator('#entry-title').fill('다른 제목');
  await page.locator('#entry-title').fill('저장한 제목');
  await expect(page.locator('#save')).toBeDisabled();
});
