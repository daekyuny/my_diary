import { test, expect } from '@playwright/test';
const scope = 'https://www.googleapis.com/auth/drive.file';
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
  await context.route('https://www.googleapis.com/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      body = request.postDataJSON();
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
    if (url.pathname === '/sheets/v4/spreadsheets/sheet-one')
      return send({
        sheets: [
          { properties: { sheetId: 0, title: 'Sheet1' } },
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
      const isSave = body.requests.some(
        (r) =>
          r.appendCells?.sheetId === 100 &&
          r.appendCells.rows[0].values[0].userEnteredValue.stringValue !== '수정 ID',
      );
      if (isSave && state.failWrites) return send({ error: { message: '잠시 저장 실패' } }, 503);
      for (const r of body.requests) {
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
async function setup(page) {
  await page.goto('/');
  await expect(page.locator('#new-entry')).toBeEnabled();
  await page.locator('#banner-connect').click();
  await expect(page.locator('#sheet-options')).toBeVisible();
  await page.locator('#create-sheet').click();
  await expect(page.locator('#settings-dialog')).not.toBeVisible();
  await expect(page.locator('#connection')).toHaveText('Sheets 연결됨');
}

test('Sheets creates in My Diary, retries failed writes and makes data available on another device', async ({
  browser,
}) => {
  const state = { exists: false, tabs: {}, failWrites: false },
    a = await browser.newContext(),
    b = await browser.newContext();
  await mock(a, state);
  await mock(b, state);
  try {
    const first = await a.newPage();
    await setup(first);
    await first.locator('#quick-entry').click();
    await first.locator('#entry-title').fill('두 기기에서 보는 일기');
    await first.locator('#entry-body').fill('=SUM(1,2)도 수식이 아닌 내 기록');
    state.failWrites = true;
    await first.locator('#save').click();
    await expect(first.locator('#toast')).toContainText('저장 실패');
    await expect(first.locator('#save-state')).toContainText('기기에 저장');
    state.failWrites = false;
    await first.locator('#save').click();
    await expect(first.locator('#editor-dialog')).not.toBeVisible();
    expect(state.tabs['일기'].rows).toHaveLength(2);
    const second = await b.newPage();
    await second.goto('/');
    await expect(second.locator('#new-entry')).toBeEnabled();
    await second.locator('#banner-connect').click();
    await expect(second.locator('.record')).toContainText('두 기기에서 보는 일기');
    await second.locator('.record').click();
    await expect(second.locator('#entry-body')).toHaveValue('=SUM(1,2)도 수식이 아닌 내 기록');
    await second.locator('#entry-body').fill('다른 PC에서 수정한 본문');
    await second.locator('#save').click();
    await expect(second.locator('#editor-dialog')).not.toBeVisible();
    await first.locator('#sync').click();
    await first.locator('.record').click();
    await expect(first.locator('#entry-body')).toHaveValue('다른 PC에서 수정한 본문');
  } finally {
    await a.close();
    await b.close();
  }
});

test('simultaneous device edits preserve both branches and field definitions travel with the sheet', async ({
  browser,
}) => {
  const state = { exists: false, tabs: {}, failWrites: false },
    a = await browser.newContext(),
    b = await browser.newContext();
  await mock(a, state);
  await mock(b, state);
  try {
    const first = await a.newPage();
    await setup(first);
    await first
      .locator(
        (await first.locator('#open-settings').isVisible()) ? '#open-settings' : '#mobile-settings',
      )
      .click();
    await first.locator('#new-definition').click();
    await first.locator('#definition-name').fill('읽은 책');
    await first.locator('#definition-form button[type=submit]').click();
    await expect(first.locator('#small-dialog')).not.toBeVisible();
    await first.locator('#close-settings').click();
    await first.locator('#quick-entry').click();
    await first.locator('#entry-title').fill('동시 편집');
    await first.locator('#entry-body').fill('원본');
    await first.locator('#save').click();
    await expect(first.locator('#editor-dialog')).not.toBeVisible();
    const second = await b.newPage();
    await second.goto('/');
    await expect(second.locator('#new-entry')).toBeEnabled();
    await second.locator('#banner-connect').click();
    await expect(second.locator('.record')).toHaveCount(1);
    await second
      .locator(
        (await second.locator('#open-settings').isVisible())
          ? '#open-settings'
          : '#mobile-settings',
      )
      .click();
    await expect(second.locator('#definitions')).toContainText('읽은 책');
    await second.locator('#close-settings').click();
    await first.locator('.record').click();
    await second.locator('.record').click();
    await first.locator('#entry-body').fill('PC에서 쓴 내용');
    await first.locator('#save').click();
    await expect(first.locator('#editor-dialog')).not.toBeVisible();
    await second.locator('#entry-body').fill('다른 기기에서 쓴 내용');
    await second.locator('#save').click();
    await expect(second.locator('#editor-dialog')).not.toBeVisible();
    await second.locator('.record').click();
    await expect(second.locator('#conflict')).toBeVisible();
    await second.locator('#review-conflict').click();
    await expect(second.locator('#small-body')).toContainText('PC에서 쓴 내용');
    await expect(second.locator('#small-body')).toContainText('다른 기기에서 쓴 내용');
    await second.locator('#merge').click();
    await expect(second.locator('#small-dialog')).not.toBeVisible();
    await expect(second.locator('#entry-body')).toHaveValue(/PC에서 쓴 내용/);
    await expect(second.locator('#entry-body')).toHaveValue(/다른 기기에서 쓴 내용/);
  } finally {
    await a.close();
    await b.close();
  }
});
