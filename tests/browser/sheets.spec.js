import { test, expect } from '@playwright/test';
const scope = 'https://www.googleapis.com/auth/drive.file';
// Route mocked API requests directly; service worker fetches bypass WebKit interception.
async function mock(context, state) {
  await context.addInitScript((scope) => {
    window.google = {
      accounts: {
        oauth2: {
          hasGrantedAllScopes: () => true,
          initTokenClient: (options) => ({
            requestAccessToken: () =>
              options.callback({ access_token: 'mock', expires_in: 3600, scope }),
          }),
        },
      },
    };
  }, scope);
  await context.route('https://accounts.google.com/**', (route) => route.abort());
  await context.route(/^https:\/\/(www|sheets)\.googleapis\.com\//, async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      body = request.postDataJSON();
    if (url.pathname.startsWith('/sheets/'))
      return route.fulfill({ status: 404, body: 'Invalid Sheets endpoint' });
    if (url.pathname.startsWith('/v4/')) expect(url.hostname).toBe('sheets.googleapis.com');
    if (state.stall) return;
    const send = (json, status = 200) => route.fulfill({ json, status });
    if (url.pathname === '/drive/v3/about')
      return send({
        user: {
          permissionId: 'test-owner',
          displayName: '테스트 사용자',
          emailAddress: 'diary@example.com',
        },
      });
    if (url.pathname === '/drive/v3/files' && request.method() === 'GET')
      return send({
        files: url.searchParams.get('q').includes('spreadsheet')
          ? state.exists
            ? [{ id: 'sheet-one', name: 'My Diary' }]
            : []
          : [{ id: 'folder-one', name: 'My Diary' }],
      });
    if (url.pathname === '/drive/v3/files' && request.method() === 'POST') {
      expect(body.parents).toEqual(['folder-one']);
      state.exists = true;
      return send({ id: 'sheet-one' });
    }
    if (url.pathname === '/v4/spreadsheets/sheet-one')
      return send({
        sheets: [
          ...(!state.defaultDeleted ? [{ properties: { sheetId: 0, title: 'Sheet1' } }] : []),
          ...Object.entries(state.tabs).map(([title, tab]) => ({
            properties: { title, sheetId: tab.id },
          })),
        ],
      });
    if (url.pathname.endsWith('/values:batchGet')) {
      const ranges = url.searchParams.getAll('ranges');
      const col = (letters) => [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
      return send({
        valueRanges: ranges.map((range) => {
          if (range === "'Sheet1'") return { range, values: state.defaultRows || [] };
          const match = /^'([^']+)'!([A-Z]+)(\d+):([A-Z]+)(\d+)?$/.exec(range);
          if (!match) throw Error(range);
          const [, title, start, row, end, last] = match;
          return {
            range,
            values: (state.tabs[title]?.rows || [])
              .slice(Number(row) - 1, last ? Number(last) : undefined)
              .map((values) => values.slice(col(start), col(end) + 1)),
          };
        }),
      });
    }
    if (url.pathname.endsWith(':batchUpdate')) {
      if (state.failInitialize && body.requests.some((r) => r.addSheet))
        return send({ error: { message: 'Sheets API 초기 설정 실패' } }, 403);
      const isSave = body.requests.some(
        (r) =>
          (r.appendCells?.sheetId === 100 &&
            r.appendCells.rows[0].values[0].userEnteredValue.stringValue !== '저장 식별자') ||
          r.updateCells?.start?.sheetId === 100,
      );
      if (isSave && state.failWrites) return send({ error: { message: '잠시 저장 실패' } }, 503);
      for (const r of body.requests) {
        if (r.deleteSheet) {
          expect(r.deleteSheet.sheetId).toBe(0);
          state.defaultDeleted = true;
        }
        if (r.updateCells) {
          const update = r.updateCells,
            sheetId = update.start?.sheetId ?? update.range.sheetId;
          const tab = Object.values(state.tabs).find((t) => t.id === sheetId);
          if (update.start) {
            update.rows.forEach((row, i) => {
              tab.rows[update.start.rowIndex + i] = row.values.map(
                (v) => v.userEnteredValue.stringValue,
              );
            });
          } else {
            for (let i = update.range.startRowIndex; i < update.range.endRowIndex; i++)
              tab.rows[i] = [];
          }
        }
        if (r.addSheet)
          state.tabs[r.addSheet.properties.title] = { id: r.addSheet.properties.sheetId, rows: [] };
        if (r.appendCells) {
          const tab = Object.values(state.tabs).find((t) => t.id === r.appendCells.sheetId);
          tab.rows.push(
            ...r.appendCells.rows.map((row) =>
              row.values.map((cell) => {
                expect(cell.userEnteredValue.formulaValue).toBeUndefined();
                return cell.userEnteredValue.stringValue;
              }),
            ),
          );
        }
      }
      return send({ replies: [] });
    }
    throw new Error(`Unexpected request ${request.method()} ${url}`);
  });
}

async function settings(page) {
  await page
    .locator(
      (await page.locator('#open-settings').isVisible()) ? '#open-settings' : '#mobile-settings',
    )
    .click();
}
async function setup(page) {
  await page.goto('/');
  await expect(page.locator('#new-entry')).toBeEnabled();
  await page.locator('#banner-connect').click();
  await page.locator('#create-sheet').click();
  await expect(page.locator('#connection')).toHaveText('Sheets 연결됨');
}
async function saveClose(page) {
  await page.locator('#save').click();
  await expect(page.locator('#save')).toBeDisabled();
  await page.locator('#close-editor').click();
}
const populated = (state) => (state.tabs['일기']?.rows || []).slice(1).filter((r) => r[0]);

test('one sheet row is updated, another device sees the change, and failed writes can retry', async ({
  browser,
}) => {
  const state = { exists: false, tabs: {} };
  const a = await browser.newContext({ serviceWorkers: 'block' }),
    b = await browser.newContext({ serviceWorkers: 'block' });
  await mock(a, state);
  await mock(b, state);
  try {
    const first = await a.newPage();
    await setup(first);
    expect(state.defaultDeleted).toBe(true);
    await first.locator('#quick-entry').click();
    await first.locator('#entry-title').fill('한 행의 일기');
    await first.locator('#entry-body').fill('첫 내용');
    await saveClose(first);
    const second = await b.newPage();
    await second.goto('/');
    await expect(second.locator('#new-entry')).toBeEnabled();
    await second.locator('#banner-connect').click();
    await expect(second.locator('.record')).toContainText('한 행의 일기');
    await second.locator('.record').click();
    await second.locator('#entry-body').fill('=SUM(1,2) 수정한 내용');
    await saveClose(second);
    expect(populated(state)).toHaveLength(1);
    expect(populated(state)[0][10]).toBe('=SUM(1,2) 수정한 내용');
    await first.locator('#sync').click();
    await first.locator('.record').click();
    await expect(first.locator('#entry-body')).toHaveValue('=SUM(1,2) 수정한 내용');
    await first.locator('#entry-body').fill('실패 후 재전송');
    state.failWrites = true;
    await first.locator('#save').click();
    await expect(first.locator('#toast')).toContainText('저장 실패');
    state.failWrites = false;
    await first.locator('#close-editor').click();
    await first.locator('#sync').click();
    await expect(first.locator('#connection')).toHaveText('Sheets 연결됨');
    expect(populated(state)).toHaveLength(1);
    expect(populated(state)[0][10]).toBe('실패 후 재전송');
    await first.reload();
    await expect(first.locator('#connection')).toHaveText('Sheets 연결됨');
    expect(populated(state)).toHaveLength(1);
  } finally {
    await a.close();
    await b.close();
  }
});

test('trash restores, retention purges on demand, and another device drops removed rows', async ({
  browser,
}) => {
  const state = { exists: false, tabs: {} };
  const a = await browser.newContext({ serviceWorkers: 'block' }),
    b = await browser.newContext({ serviceWorkers: 'block' });
  await mock(a, state);
  await mock(b, state);
  try {
    const page = await a.newPage();
    await setup(page);
    await page.locator('#quick-entry').click();
    await page.locator('#entry-title').fill('삭제할 일기');
    await saveClose(page);
    const second = await b.newPage();
    await second.goto('/');
    await expect(second.locator('#new-entry')).toBeEnabled();
    await second.locator('#banner-connect').click();
    await expect(second.locator('.record')).toHaveCount(1);
    await page.locator('[data-delete-entry]').click();
    await expect(page.locator('.record')).toHaveCount(0);
    await page.locator('[data-collection=archive]:visible').click();
    await expect(page.locator('.record')).toHaveCount(1);
    await page.locator('[data-delete-entry]').click();
    await expect(page.locator('.record')).toHaveCount(0);
    await page.locator('[data-collection=journal]:visible').click();
    await expect(page.locator('.record')).toHaveCount(1);
    await page.locator('[data-delete-entry]').click();
    await settings(page);
    await page.locator('#trash-days').selectOption('0');
    await page.locator('#save-retention').click();
    await expect(page.locator('#save-retention')).toBeEnabled();
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('#purge-trash').click();
    await expect(page.locator('#toast')).toContainText('1개 일기');
    expect(populated(state)).toHaveLength(0);
    expect(state.tabs['추가항목'].rows.slice(1).filter((r) => r[0])).toHaveLength(0);
    await second.locator('#sync').click();
    await expect(second.locator('.record')).toHaveCount(0);
    expect(populated(state)).toHaveLength(0);
  } finally {
    await a.close();
    await b.close();
  }
});

test('legacy history collapses to latest content and a nonempty Sheet1 is preserved', async ({
  browser,
}) => {
  const { makeRevision, newEntry } = await import('../../src/model.js');
  const { HEADERS, encodeRevision } = await import('../../src/journal/sheets.js');
  const old = makeRevision({ ...newEntry('2026-09-01'), title: '예전', body: 'old' });
  old.savedAt = '2026-09-01T00:00:00Z';
  const current = makeRevision({ ...old.entry, title: '현재', body: 'current' }, [old.id]);
  current.savedAt = '2026-09-02T00:00:00Z';
  const state = { exists: true, defaultRows: [['사용자가 쓴 내용']], tabs: {} };
  ['일기', '추가항목', '일정', '설정'].forEach(
    (title, i) => (state.tabs[title] = { id: 100 + i, rows: [HEADERS[i]] }),
  );
  state.tabs['설정'].rows.push(['format', 'my-diary-sheets-v1']);
  for (const r of [old, current])
    encodeRevision(r).forEach((rows, i) =>
      state.tabs[['일기', '추가항목', '일정'][i]].rows.push(...rows),
    );
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await mock(context, state);
  try {
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.locator('#new-entry')).toBeEnabled();
    await page.locator('#banner-connect').click();
    await expect(page.locator('.record')).toContainText('현재');
    expect(populated(state)).toHaveLength(1);
    expect(state.defaultDeleted).not.toBe(true);
    await page.locator('.record').click();
    await expect(page.locator('#entry-body')).toHaveValue('current');
  } finally {
    await context.close();
  }
});

test('server session restores after reload and refreshes an expired Google token without a popup', async ({
  browser,
}) => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const state = { exists: false, tabs: {} };
  await mock(context, state);
  let renewals = 0;
  try {
    const page = await context.newPage();
    await page.clock.install();
    await setup(page);
    await context.route('**/config.json', (route) =>
      route.fulfill({
        json: { googleClientId: 'test.apps.googleusercontent.com', authServer: true },
      }),
    );
    await context.route('**/auth/token', (route) => {
      renewals++;
      return route.fulfill({ json: { access_token: 'renewed', expires_in: 3600, scope } });
    });
    await page.evaluate(() => sessionStorage.clear());
    await page.reload();
    await expect(page.locator('#connection')).toHaveText('Sheets 연결됨');
    expect(renewals).toBe(1);
    await page.clock.fastForward(3600000);
    await expect.poll(() => renewals).toBe(2);
    await expect(page.locator('#connection')).toHaveText('Sheets 연결됨');
    expect(state.exists).toBe(true);
  } finally {
    await context.close();
  }
});
