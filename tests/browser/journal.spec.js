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
  if ((await page.locator('#save').isVisible()) && (await page.locator('#save').isEnabled())) {
    await page.locator('#save').click();
  } else await page.locator('#close-editor').click();
  await expect(page.locator('#editor-dialog')).not.toBeVisible();
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
  await expect(page.locator('#editor-dialog')).not.toBeVisible();
  await page.locator('#search').fill('아침');
  await expect(page.locator('.record')).toHaveCount(1);
  await page.locator('#search').fill('<script>');
  await expect(page.locator('.empty')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('reading and editing show the same Korean date and the date picker stays labelled', async ({
  page,
}) => {
  await newEntry(page);
  await page.getByLabel('일기 날짜').fill('2026-08-07');
  await expect(page.locator('#entry-date-label')).toHaveText('2026년 8월 7일 금요일');
  await page.locator('#entry-title').fill('날짜 표기');
  await saveClose(page);
  await page.locator('.record').click();
  await expect(page.locator('#reading-date')).toHaveText('2026년 8월 7일 금요일');
  await page.locator('#edit-entry').click();
  await expect(page.locator('#entry-date-label')).toHaveText('2026년 8월 7일 금요일');
  const label = await page.locator('.editor-date').boundingBox();
  const input = await page.locator('#entry-date').boundingBox();
  expect(input.width).toBeCloseTo(label.width, 0);
  expect(label.height).toBeGreaterThanOrEqual(44);
});

test('reading mode steps through the shown list, hides the count and follows the text size', async ({
  page,
}, info) => {
  await page.evaluate(async () => {
    const model = await import('/src/model.js'),
      store = await import('/src/storage.js');
    await store.openStore('sheets-local');
    for (const [date, title] of [
      ['2026-09-03', '셋째 날'],
      ['2026-09-02', '둘째 날'],
      ['2026-09-01', '첫째 날'],
    ])
      await store.put(
        'revisions',
        model.makeRevision({ ...model.newEntry(date), title, body: `${title}의 본문` }),
      );
  });
  await page.reload();
  await expect(page.locator('.record')).toHaveCount(3);
  await page.locator('.record').first().click();
  await expect(page.locator('#reading-title')).toHaveText('셋째 날');
  await expect(page.locator('#entry-position')).toHaveText('1 / 3');
  await expect(page.locator('#prev-entry')).toBeDisabled();
  await expect(page.locator('#word-count')).toBeHidden();
  await page.locator('#next-entry').click();
  await expect(page.locator('#reading-title')).toHaveText('둘째 날');
  await expect(page.locator('#next-entry')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#reading-title')).toHaveText('첫째 날');
  await expect(page.locator('#next-entry')).toBeDisabled();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#reading-title')).toHaveText('둘째 날');
  if (info.project.name === 'mobile-chromium') {
    // A left swipe turns to the next diary, as in a book.
    await page.locator('#reading-body').dispatchEvent('touchstart', {
      touches: [{ identifier: 1, clientX: 300, clientY: 300 }],
      changedTouches: [{ identifier: 1, clientX: 300, clientY: 300 }],
    });
    await page.locator('#reading-body').dispatchEvent('touchend', {
      touches: [],
      changedTouches: [{ identifier: 1, clientX: 120, clientY: 310 }],
    });
    await expect(page.locator('#reading-title')).toHaveText('첫째 날');
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('#reading-title')).toHaveText('둘째 날');
  }
  // Editing pins the diary in place: arrows move the caret instead of the page.
  await page.locator('#edit-entry').click();
  await expect(page.locator('#word-count')).toBeVisible();
  await expect(page.locator('#prev-entry')).toBeHidden();
  await page.locator('#entry-body').press('ArrowRight');
  await expect(page.locator('#entry-title')).toHaveValue('둘째 날');
  await page.locator('#close-editor').click();
  await expect(page.locator('#editor-dialog')).not.toBeVisible();
  // The search narrows what the arrows walk through.
  await page.locator('#search').fill('첫째');
  await expect(page.locator('.record')).toHaveCount(1);
  await page.locator('.record').click();
  await expect(page.locator('#entry-position')).toHaveText('1 / 1');
  await expect(page.locator('#next-entry')).toBeDisabled();
  const normal = await page
    .locator('#reading-body')
    .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  await page.locator('#close-editor').click();
  await expect(page.locator('#editor-dialog')).not.toBeVisible();
  const card = () =>
    page
      .locator('.record p')
      .first()
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const cardBefore = await card();
  await settings(page);
  const preview = () =>
    page.locator('.text-size-preview').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const before = await preview();
  await page.locator('#text-size [data-size=large]').click();
  // The choice shows at once in the preview line and in the list behind the dialog.
  expect(await preview()).toBeGreaterThan(before);
  await expect(page.locator('#text-size [value=large]')).toBeChecked();
  await page.locator('#close-settings').click();
  expect(await card()).toBeGreaterThan(cardBefore);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-text-size', 'large');
  await page.locator('.record').first().click();
  const large = await page
    .locator('#reading-body')
    .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(large).toBeGreaterThan(normal);
  await page.locator('#edit-entry').click();
  expect(
    await page.locator('#entry-body').evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
  ).toBe(large);
});

test('calendar names the month in Korean, marks days with badges and reveals the picked day', async ({
  page,
}) => {
  await page.evaluate(async () => {
    const model = await import('/src/model.js'),
      store = await import('/src/storage.js');
    await store.openStore('sheets-local');
    for (const [date, title] of [
      ['2026-08-07', '아침'],
      ['2026-08-07', '저녁'],
      ['2026-08-28', '월말'],
    ])
      await store.put('revisions', model.makeRevision({ ...model.newEntry(date), title }));
  });
  await page.reload();
  await page.getByRole('button', { name: '캘린더 보기', exact: true }).click();
  await page.getByLabel('캘린더 월').fill('2026-08');
  await expect(page.locator('#calendar-month-label')).toHaveText('2026년 8월');
  await expect(page.locator('[data-day="2026-08-07"] .day-mark')).toHaveText('2');
  await expect(page.locator('[data-day="2026-08-28"] .day-mark')).toHaveClass(/dot/);
  await expect(page.locator('[data-day="2026-08-28"]')).toHaveAttribute(
    'aria-label',
    '2026년 8월 28일 금요일, 일기 1개',
  );
  await expect(page.locator('[data-day="2026-08-03"] .day-mark')).toHaveCount(0);
  const cell = await page.locator('[data-day="2026-08-07"]').boundingBox();
  const mark = await page.locator('[data-day="2026-08-07"] .day-mark').boundingBox();
  expect(mark.y + mark.height).toBeLessThanOrEqual(cell.y + cell.height);
  await page.getByRole('button', { name: '다음 달' }).click();
  await expect(page.locator('#calendar-month-label')).toHaveText('2026년 9월');
  await page.getByRole('button', { name: '이전 달' }).click();
  await page.locator('[data-day="2026-08-28"]').click();
  await expect(page.locator('.record')).toHaveCount(1);
  await expect(page.locator('.record')).toBeInViewport({ ratio: 0.9 });
  const nav = await page.locator('.bottom-nav').boundingBox();
  if (nav)
    expect(
      (await page.locator('.record').boundingBox()).y +
        (await page.locator('.record').boundingBox()).height,
    ).toBeLessThanOrEqual(nav.y);
});

test('search marks matches in cards and scrolls the opened diary to the first match', async ({
  page,
}) => {
  await page.evaluate(async () => {
    const model = await import('/src/model.js'),
      store = await import('/src/storage.js');
    await store.openStore('sheets-local');
    const body = `${'오늘도 평범한 하루였다.\n'.repeat(60)}저녁에는 <b>호숫가</b>를 걸었다. https://example.com/호숫가 링크도 남긴다.`;
    await store.put(
      'revisions',
      model.makeRevision({ ...model.newEntry('2026-09-20'), title: '긴 하루', body }),
    );
    await store.put(
      'revisions',
      model.makeRevision({ ...model.newEntry('2026-09-21'), title: '다른 날', body: '짧은 글' }),
    );
  });
  await page.reload();
  await page.locator('#search').fill('호숫가');
  await expect(page.locator('.record')).toHaveCount(1);
  await expect(page.locator('.record p')).toContainText('…저녁에는 <b>호숫가</b>');
  await expect(page.locator('.record p mark').first()).toHaveText('호숫가');
  await expect(page.locator('.record b')).toHaveCount(0);
  await page.locator('.record').click();
  const first = page.locator('#reading-body mark').first();
  await expect(first).toHaveText('호숫가');
  await expect(first).toBeInViewport();
  // The URL stays one working link even though the query appears inside it.
  await expect(page.locator('#reading-body a')).toHaveCount(1);
  await expect(page.locator('#reading-body a mark')).toHaveText('호숫가');
  await expect(page.locator('#reading-body b')).toHaveCount(0);
  await page.locator('#close-editor').click();
  await expect(page.locator('#editor-dialog')).not.toBeVisible();
  await page.locator('#search').fill('');
  await page.locator('.record').last().click();
  await expect(page.locator('#reading-body mark')).toHaveCount(0);
});

test('theme follows the system unless the device setting forces light or dark', async ({
  page,
}, info) => {
  const background = () =>
    page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
  const light = await background();
  await page.emulateMedia({ colorScheme: 'dark' });
  const dark = await background();
  expect(dark).not.toBe(light);
  await newEntry(page);
  await page.locator('#entry-title').fill('밤에 쓰는 일기');
  await page.locator('#entry-body').fill('어두운 화면에서도 글자가 잘 보인다.');
  await saveClose(page);
  await page.screenshot({ path: `artifacts/journal-dark-${info.project.name}.png` });
  await page.locator('.record').click();
  await page.screenshot({ path: `artifacts/journal-reading-dark-${info.project.name}.png` });
  await page.locator('#close-editor').click();
  await expect(page.locator('#editor-dialog')).not.toBeVisible();
  await settings(page);
  await expect(page.locator('#theme')).toHaveValue('system');
  await page.locator('#theme').selectOption('light');
  expect(await background()).toBe(light);
  await expect(page.locator('meta[name=theme-color][media*=dark]')).toHaveAttribute(
    'content',
    '#f6f5f0',
  );
  await page.locator('#close-settings').click();
  // The saved choice applies before the app script runs, so a reload never flashes.
  await page.emulateMedia({ colorScheme: 'light' });
  await settings(page);
  await page.locator('#theme').selectOption('dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await background()).toBe(dark);
  await settings(page);
  await expect(page.locator('#theme')).toHaveValue('dark');
  await page.locator('#theme').selectOption('system');
  await expect(page.locator('html')).not.toHaveAttribute('data-theme');
  expect(await background()).toBe(light);
});

test('focus rings stay inside fields, iOS skips input zoom and the settings close stays in reach', async ({
  page,
}, info) => {
  const mobile = info.project.name === 'mobile-chromium';
  // The iPhone user agent gets maximum-scale so tapping a small field does not zoom the page.
  expect(await page.locator('meta[name=viewport]').getAttribute('content')).toContain(
    mobile ? 'maximum-scale=1' : 'viewport-fit',
  );
  if (!mobile)
    expect(await page.locator('meta[name=viewport]').getAttribute('content')).not.toContain(
      'maximum-scale',
    );
  if (!mobile) {
    await expect(page.locator('#search-shortcut')).toHaveText('Ctrl K');
    await expect(page.locator('#search-shortcut')).toHaveAttribute('title', /검색 바로가기/);
  }
  await page.locator('#search').focus();
  expect(await page.locator('#search').evaluate((el) => getComputedStyle(el).outlineStyle)).toBe(
    'none',
  );
  expect(
    await page.locator('.search').evaluate((el) => getComputedStyle(el).borderTopColor),
  ).not.toBe(await page.locator('.filters').evaluate((el) => getComputedStyle(el).borderTopColor));
  await newEntry(page);
  await page.locator('#entry-tags').focus();
  expect(
    await page.locator('#entry-tags').evaluate((el) => getComputedStyle(el).outlineOffset),
  ).toBe('-2px');
  await page.locator('#entry-title').fill('포커스');
  await saveClose(page);
  // Closing a diary must not leave a ring on <main> (Safari focuses it when the card is gone).
  await page.locator('#main').focus();
  expect(await page.locator('#main').evaluate((el) => getComputedStyle(el).outlineStyle)).toBe(
    'none',
  );
  await settings(page);
  await page.locator('#settings-dialog').evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect(page.locator('#close-settings')).toBeInViewport();
  await page.screenshot({ path: `artifacts/settings-scrolled-${info.project.name}.png` });
  await page.locator('#close-settings').click();
  await expect(page.locator('#settings-dialog')).not.toBeVisible();
});

test('custom fields are removed from settings and the editor', async ({ page }) => {
  await settings(page);
  await expect(page.locator('#new-definition')).toHaveCount(0);
  await expect(page.locator('#repository-details')).toBeVisible();
  await page.locator('#close-settings').click();
  await newEntry(page);
  await expect(page.locator('#add-field')).toHaveCount(0);
});

test('pin and archive remain editable and body HTML never executes', async ({ page }) => {
  await newEntry(page);
  await page.locator('#entry-title').fill('기억');
  await page.locator('#entry-body').fill('<img src=x onerror="window.hacked=1">');
  await page.locator('#pin-entry').click();
  await saveClose(page);
  await page.locator('.record').click();
  await page.locator('#edit-entry').click();
  await expect(page.locator('#pin-entry')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#archive-entry').click();
  await saveClose(page);
  await expect(page.locator('.record')).toHaveCount(0);
  await page.locator('[data-collection=archive]:visible').click();
  await page.locator('.record').click();
  await page.locator('#edit-entry').click();
  await page.locator('#archive-entry').click();
  await saveClose(page);
  await expect(page.locator('.record')).toHaveCount(0);
  expect(await page.evaluate(() => window.hacked)).toBeUndefined();
});

test('reading mode moves a diary to the trash with an undo toast and cards have no delete button', async ({
  page,
}) => {
  page.on('dialog', (dialog) => {
    throw new Error(`unexpected browser dialog: ${dialog.message()}`);
  });
  await newEntry(page);
  await page.locator('#entry-title').fill('지울 기록');
  await saveClose(page);
  await expect(page.locator('.record')).toHaveCount(1);
  await expect(page.locator('[data-delete-entry], .record-delete')).toHaveCount(0);
  await page.locator('.record').click();
  await expect(page.locator('#entry-reading')).toBeVisible();
  await expect(page.locator('#archive-entry')).toBeVisible();
  await expect(page.locator('#archive-entry')).toHaveText(/삭제하기/);
  await page.locator('#archive-entry').click();
  await expect(page.locator('#editor-dialog')).not.toBeVisible();
  await expect(page.locator('.record')).toHaveCount(0);
  await expect(page.locator('#toast')).toContainText('휴지통으로 이동했습니다');
  await page.locator('#toast .toast-action').click();
  await expect(page.locator('#toast')).toContainText('복원했습니다');
  await expect(page.locator('.record')).toHaveCount(1);
  await page.locator('.record').click();
  await page.locator('#archive-entry').click();
  await expect(page.locator('.record')).toHaveCount(0);
  await page.locator('[data-collection=archive]:visible').click();
  await expect(page.locator('.record')).toHaveCount(1);
  await page.locator('.record').click();
  await expect(page.locator('#archive-entry')).toHaveText(/복원하기/);
  await page.locator('#archive-entry').click();
  await expect(page.locator('#editor-dialog')).not.toBeVisible();
  await expect(page.locator('.record')).toHaveCount(0);
  await page.locator('[data-collection=journal]:visible').click();
  await expect(page.locator('.record')).toHaveCount(1);
});

test('today prompt shows only until today has a diary and trash purge asks in-app', async ({
  page,
}) => {
  page.on('dialog', (dialog) => {
    throw new Error(`unexpected browser dialog: ${dialog.message()}`);
  });
  await expect(page.locator('#quick-entry')).toBeVisible();
  await expect(page.locator('#quick-label')).toHaveText('오늘 기록 남기기');
  await newEntry(page);
  await page.locator('#entry-title').fill('오늘의 기록');
  await saveClose(page);
  await expect(page.locator('#quick-entry')).toBeHidden();
  await page.locator('[data-collection=archive]:visible').click();
  await expect(page.locator('#quick-entry')).toBeHidden();
  await page.locator('[data-collection=journal]:visible').click();
  await page.getByRole('button', { name: '캘린더 보기', exact: true }).click();
  await expect(page.locator('#quick-entry')).toBeHidden();
  await page.locator('#calendar-month').fill('2026-08');
  await page.locator('[data-day="2026-08-07"]').click();
  await expect(page.locator('#quick-entry')).toBeVisible();
  await expect(page.locator('#quick-label')).toHaveText('8월 7일에 새 기록 남기기');
  await settings(page);
  await page.locator('#purge-trash').click();
  await expect(page.locator('#confirm-message')).toContainText('완전 삭제할까요');
  await page.locator('#confirm-cancel').click();
  await expect(page.locator('#small-dialog')).not.toBeVisible();
  await page.locator('#purge-trash').click();
  await page.locator('#confirm-accept').click();
  await expect(page.locator('#toast')).toContainText('완전 삭제했습니다');
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
  // The first record must be fully visible on the first screen, above the bottom nav, even
  // with the connect banner and the today prompt both showing.
  await expect(page.locator('#connect-banner')).toBeVisible();
  await expect(page.locator('#quick-entry')).toBeVisible();
  const first = await page.locator('.record').first().boundingBox();
  const nav = await page.locator('.bottom-nav').boundingBox();
  expect(first.y + first.height).toBeLessThanOrEqual(nav?.y ?? page.viewportSize().height);
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
  await page.locator('#edit-entry').click();
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
  await expect(page.locator('#editor-dialog')).not.toBeVisible();
  await page.locator('.record').click();
  await expect(page.locator('#entry-reading')).toBeVisible();
  await page.locator('#edit-entry').click();
  await expect(page.locator('#save')).toBeDisabled();
  await page.locator('#entry-body').fill('저장하지 않을 변경');
  await page.waitForTimeout(1600);
  await expect(page.locator('#save')).toBeEnabled();
  // The confirmation is an in-app dialog, never a browser confirm().
  page.on('dialog', (dialog) => {
    throw new Error(`unexpected browser dialog: ${dialog.message()}`);
  });
  await page.locator('#close-editor').click();
  await expect(page.locator('#small-dialog')).toBeVisible();
  await expect(page.locator('#confirm-message')).toContainText('저장하지 않은');
  await page.locator('#confirm-cancel').click();
  await expect(page.locator('#small-dialog')).not.toBeVisible();
  await expect(page.locator('#editor-dialog')).toBeVisible();
  await page.locator('#close-editor').click();
  await page.locator('#confirm-accept').click();
  await expect(page.locator('#editor-dialog')).not.toBeVisible();
  await page.locator('.record').click();
  await page.locator('#edit-entry').click();
  await expect(page.locator('#entry-body')).toHaveValue('');
  await page.locator('#entry-title').fill('다른 제목');
  await page.locator('#entry-title').fill('저장한 제목');
  await expect(page.locator('#save')).toBeDisabled();
});

test('existing diaries open for reading with an accessible edit action and no attachment filename', async ({
  page,
}, info) => {
  await newEntry(page);
  await page.locator('#entry-title').fill('차분히 읽는 하루');
  await page
    .locator('#entry-body')
    .fill('기억하고 싶은 내용을 먼저 읽습니다.\n수정은 버튼을 눌러 시작합니다.');
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    canvas.getContext('2d').fillRect(0, 0, 320, 180);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  await page.locator('#photo-input').setInputFiles({
    name: 'private-name.png',
    mimeType: 'image/png',
    buffer: Buffer.from(bytes),
  });
  await expect(page.locator('.photo-preview img')).toBeVisible();
  await saveClose(page);
  await page.locator('.record').click();
  await expect(page.locator('#reading-title')).toHaveText('차분히 읽는 하루');
  await expect(page.locator('#entry-body')).not.toBeVisible();
  await expect(page.locator('[data-remove-photo]')).toHaveCount(0);
  await expect(page.locator('#photos figcaption')).toHaveCount(0);
  await expect(page.locator('#edit-entry')).toBeFocused();
  await page.screenshot({ path: `artifacts/journal-reading-${info.project.name}.png` });
  await page.locator('#edit-entry').click();
  await expect(page.locator('#entry-title')).toBeFocused();
  await expect(page.locator('[data-remove-photo]')).toBeVisible();
  const button = await page.locator('[data-remove-photo]').boundingBox();
  const image = await page.locator('.photo-preview').boundingBox();
  expect(button.y).toBeGreaterThanOrEqual(image.y + image.height);
  expect(button.height).toBe(36);
  await expect(page.locator('#save')).toBeDisabled();
  await page.locator('#add-event').click();
  await page.locator('[data-event-title]').fill('모바일에서도 읽기 쉬운 일정 제목');
  const titleBox = await page.locator('[data-event-title]').boundingBox();
  const removeBox = await page.locator('[data-remove-event]').boundingBox();
  expect(titleBox.height).toBe(44);
  expect(removeBox.x).toBeGreaterThanOrEqual(titleBox.x + titleBox.width);
  expect(removeBox.height).toBe(40);
});
