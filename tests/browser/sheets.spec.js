import { zipSync, strToU8 } from 'fflate';
import { test, expect } from '@playwright/test';
const scope = 'https://www.googleapis.com/auth/drive.file';
// Route mocked API requests directly; service worker fetches bypass WebKit interception.
async function mock(context, state) {
  await context.addInitScript((scope) => {
    // WebKit interception omits Blob bodies; inspect the real serialized payload before fetch.
    window.diaryTestUploadBodies = [];
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, options) => {
      if (String(input).includes('/upload/drive/v3/files') && options?.body instanceof Blob)
        window.diaryTestUploadBodies.push(await options.body.text());
      return originalFetch(input, options);
    };
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
      body = request.headers()['content-type']?.includes('multipart')
        ? null
        : request.postDataJSON();
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
    if (url.pathname.startsWith('/upload/drive/v3/files')) {
      const captured = await request.frame().evaluate(() => window.diaryTestUploadBodies.shift());
      const metadata = JSON.parse(
        (request.postData() ?? captured).split('\r\n\r\n')[1].split('\r\n--')[0],
      );
      state.uploads ||= [];
      const id = `asset-${state.uploads.length + 1}`;
      state.uploads.push({ id, ...metadata });
      return send({ id });
    }
    if (/^\/drive\/v3\/files\/asset-/.test(url.pathname)) {
      const id = url.pathname.split('/').at(-1);
      if (request.method() === 'DELETE') {
        if (state.failDeletes) return send({ error: { message: '사진 삭제 실패' } }, 503);
        (state.deleted ||= []).push(id);
        return send({});
      }
      (state.downloads ||= []).push(id);
      return route.fulfill({
        contentType: 'image/png',
        body: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=',
          'base64',
        ),
      });
    }
    if (
      url.pathname === '/drive/v3/files' &&
      request.method() === 'GET' &&
      url.searchParams.get('q').includes('assetId')
    ) {
      const id = /value='([^']+)'/.exec(url.searchParams.get('q'))?.[1];
      return send({
        files: (state.uploads || []).filter((item) => item.appProperties.assetId === id),
      });
    }
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
      state.writeRequests = (state.writeRequests || 0) + 1;
      if (state.quotaOnce) {
        state.quotaOnce = false;
        return send({ error: { message: 'Write quota exceeded' } }, 429);
      }
      if (
        state.failInitialize &&
        body.requests.some((r) => r.addSheet && r.addSheet.properties.title !== '__MyDiaryLock')
      )
        return send({ error: { message: 'Sheets API 초기 설정 실패' } }, 403);
      const isSave = body.requests.some(
        (r) =>
          (r.appendCells?.sheetId === 100 &&
            r.appendCells.rows[0].values[0].userEnteredValue.stringValue !== '저장 식별자') ||
          r.updateCells?.start?.sheetId === 100,
      );
      if (isSave && state.holdWrites) {
        state.waitingForWrite = true;
        await new Promise((resolve) => (state.releaseWrite = resolve));
      }
      if (isSave && state.failAfterTwenty && (state.tabs['일기']?.rows.length || 0) >= 21)
        return send({ error: { message: 'Partial import interrupted' } }, 503);
      if (isSave && state.failWrites) return send({ error: { message: '잠시 저장 실패' } }, 503);
      if (
        body.requests.some(
          (r) =>
            r.addSheet &&
            (state.tabs[r.addSheet.properties.title] ||
              Object.values(state.tabs).some((tab) => tab.id === r.addSheet.properties.sheetId)),
        )
      )
        return send({ error: { message: 'Sheet already exists' } }, 400);
      for (const r of body.requests) {
        if (r.deleteSheet) {
          if (r.deleteSheet.sheetId === 0) state.defaultDeleted = true;
          else {
            const title = Object.keys(state.tabs).find(
              (name) => state.tabs[name].id === r.deleteSheet.sheetId,
            );
            expect(title).toBe('__MyDiaryLock');
            delete state.tabs[title];
          }
        }
        if (r.deleteDimension) {
          const { sheetId, startIndex, endIndex } = r.deleteDimension.range;
          Object.values(state.tabs)
            .find((t) => t.id === sheetId)
            .rows.splice(startIndex, endIndex - startIndex);
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
  await expect(page.locator('#editor-dialog')).not.toBeVisible();
  await expect(page.locator('#connection')).toHaveText('Sheets 연결됨');
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
    await second.locator('#edit-entry').click();
    await second.locator('#entry-body').fill('=SUM(1,2) 수정한 내용');
    await saveClose(second);
    expect(populated(state)).toHaveLength(1);
    expect(populated(state)[0][10]).toBe('=SUM(1,2) 수정한 내용');
    await first.locator('#sync').click();
    await first.locator('.record').click();
    await first.locator('#edit-entry').click();
    await expect(first.locator('#entry-body')).toHaveValue('=SUM(1,2) 수정한 내용');
    await first.locator('#entry-body').fill('실패 후 재전송');
    state.failWrites = true;
    await first.locator('#save').click();
    await expect(first.locator('#toast')).toContainText('저장 실패');
    state.failWrites = false;
    await expect(first.locator('#editor-dialog')).not.toBeVisible();
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
    await expect.poll(() => populated(state).length).toBe(0);
    await expect.poll(() => state.tabs['휴지통'].rows.slice(1).filter((r) => r[0]).length).toBe(1);
    await page.locator('[data-collection=archive]:visible').click();
    await expect(page.locator('.record')).toHaveCount(1);
    await page.locator('[data-delete-entry]').click();
    await expect(page.locator('.record')).toHaveCount(0);
    await expect.poll(() => state.tabs['휴지통'].rows.slice(1).filter((r) => r[0]).length).toBe(0);
    await page.locator('[data-collection=journal]:visible').click();
    await expect(page.locator('.record')).toHaveCount(1);
    await page.locator('[data-delete-entry]').click();
    await expect(page.locator('#connection')).toHaveText('Sheets 연결됨');
    await expect.poll(() => state.tabs['휴지통'].rows.slice(1).filter((r) => r[0]).length).toBe(1);
    await settings(page);
    await page.locator('#trash-days').selectOption('0');
    await page.locator('#save-retention').click();
    await expect(page.locator('#save-retention')).toBeEnabled();
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('#purge-trash').click();
    await expect(page.locator('#toast')).toContainText('1개 일기');
    await expect.poll(() => populated(state).length).toBe(0);
    expect(state.tabs['추가항목'].rows.slice(1).filter((r) => r[0])).toHaveLength(0);
    await second.locator('#sync').click();
    await expect(second.locator('.record')).toHaveCount(0);
    await expect.poll(() => populated(state).length).toBe(0);
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
    await page.locator('#edit-entry').click();
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

test('distinct diaries stay contiguous and editing keeps focus through scheduled sync', async ({
  browser,
}) => {
  const state = { exists: false, tabs: {} };
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await mock(context, state);
  try {
    const page = await context.newPage();
    await page.clock.install();
    await setup(page);
    for (const title of ['첫 일기', '둘째 일기']) {
      await page.locator('#quick-entry').click();
      await page.locator('#entry-title').fill(title);
      await saveClose(page);
      await expect(page.locator('#editor-dialog')).not.toBeVisible();
    }
    state.tabs['일기'].rows.splice(1, 0, ...Array.from({ length: 55 }, () => []));
    await page.reload();
    await expect(page.locator('#connection')).toHaveText('Sheets 연결됨');
    await expect.poll(() => state.tabs['일기'].rows.length).toBe(3);
    expect(populated(state).map((r) => r[5])).toEqual(['첫 일기', '둘째 일기']);
    await settings(page);
    await expect(page.locator('#settings-connect')).toBeDisabled();
    await page.locator('#close-settings').click();
    await page.locator('.record').first().click();
    await page.locator('#edit-entry').click();
    await page.locator('#entry-body').fill('계속 입력 중');
    await page.locator('#entry-body').evaluate((el) => el.setSelectionRange(2, 4));
    await page.clock.fastForward(75000);
    await expect(page.locator('#entry-body')).toBeFocused();
    expect(
      await page.locator('#entry-body').evaluate((el) => [el.selectionStart, el.selectionEnd]),
    ).toEqual([2, 4]);
    await expect(page.locator('#entry-body')).toHaveValue('계속 입력 중');
    expect(populated(state).every((r) => !r[10])).toBe(true);
    await saveClose(page);
  } finally {
    await context.close();
  }
});

test('attachments use separate previews, load originals on demand and delete both after saving removal', async ({
  browser,
}) => {
  const state = { exists: false, tabs: {} };
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await mock(context, state);
  try {
    const page = await context.newPage();
    await setup(page);
    await page.locator('#quick-entry').click();
    await page.locator('#entry-title').fill('사진 일기');
    const bytes = await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 1600;
      canvas.height = 900;
      canvas.getContext('2d').fillRect(0, 0, 1600, 900);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    });
    await page.locator('#photo-input').setInputFiles({
      name: 'private-original-name.png',
      mimeType: 'image/png',
      buffer: Buffer.from(bytes),
    });
    await expect(page.locator('.photo-preview img')).toBeVisible();
    expect(await page.locator('.photo-preview img').evaluate((el) => el.naturalWidth)).toBe(480);
    await saveClose(page);
    expect(state.uploads).toHaveLength(2);
    expect(state.uploads[0].name).toMatch(/^[\w-]+-original\.png$/);
    expect(state.uploads[1].name).toMatch(/^[\w-]+-thumbnail\.jpg$/);
    const second = await browser.newContext({ serviceWorkers: 'block' });
    await mock(second, state);
    try {
      const other = await second.newPage();
      await other.goto('/');
      await expect(other.locator('#banner-connect')).toBeEnabled();
      await other.locator('#banner-connect').click();
      await expect(other.locator('.record')).toHaveCount(1);
      await other.locator('.record').click();
      await other.locator('#edit-entry').click();
      await expect(other.locator('.photo-preview img')).toBeVisible();
      expect(state.downloads).toEqual([state.uploads[1].id]);
      await other.locator('[data-open-photo]').click();
      await expect(other.locator('.original-photo')).toBeVisible();
      expect(state.downloads).toEqual([state.uploads[1].id, state.uploads[0].id]);
      await other.locator('#close-small').click();
      await other.locator('[data-remove-photo]').click();
      expect(state.deleted || []).toHaveLength(0);
      other.once('dialog', (dialog) => dialog.accept());
      await other.locator('#close-editor').click();
      await other.locator('.record').click();
      await other.locator('#edit-entry').click();
      await expect(other.locator('.photo-preview img')).toBeVisible();
      await other.locator('[data-remove-photo]').click();
      state.failDeletes = true;
      await other.locator('#save').click();
      await expect(other.locator('#toast')).toContainText('사진 삭제 실패');
      state.failDeletes = false;
      await expect(other.locator('#editor-dialog')).not.toBeVisible();
      await other.locator('#sync').click();
      await expect(other.locator('#connection')).toHaveText('Sheets 연결됨');
      expect(state.deleted).toEqual([state.uploads[0].id, state.uploads[1].id]);
    } finally {
      await second.close();
    }
  } finally {
    await context.close();
  }
});

test('simultaneous device cleanup cannot delete rows shifted by the other device', async ({
  browser,
}) => {
  const state = { exists: false, tabs: {} };
  const contexts = await Promise.all([
    browser.newContext({ serviceWorkers: 'block' }),
    browser.newContext({ serviceWorkers: 'block' }),
  ]);
  try {
    for (const context of contexts) await mock(context, state);
    const [a, b] = await Promise.all(contexts.map((context) => context.newPage()));
    await setup(a);
    await a.locator('#quick-entry').click();
    await a.locator('#entry-title').fill('양쪽에서 보존할 기록');
    await saveClose(a);
    await b.goto('/');
    await expect(b.locator('#banner-connect')).toBeEnabled();
    await b.locator('#banner-connect').click();
    await expect(b.locator('.record')).toBeEnabled();
    state.tabs['일기'].rows.splice(1, 0, ...Array.from({ length: 55 }, () => []));
    await Promise.all([a.reload(), b.reload()]);
    await Promise.all(
      [a, b].map(async (page) => {
        await expect(page.locator('#toast')).toContainText('같은 Google 계정');
        await expect(page.locator('.record')).toBeEnabled();
        await expect(page.locator('.record')).toContainText('양쪽에서 보존할 기록');
      }),
    );
    expect(state.tabs['일기'].rows).toHaveLength(2);
    expect(state.tabs.__MyDiaryLock).toBeUndefined();
  } finally {
    for (const context of contexts) await context.close();
  }
});

test('save returns to the list before upload and a newer edit survives the earlier acknowledgement', async ({
  browser,
}) => {
  const state = { exists: false, tabs: {} };
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await mock(context, state);
  try {
    const page = await context.newPage();
    await setup(page);
    await page.locator('#quick-entry').click();
    await page.locator('#entry-title').fill('저장 중인 일기');
    await page.locator('#entry-body').fill('첫 내용');
    state.holdWrites = true;
    await page.locator('#save').click();
    await expect(page.locator('#editor-dialog')).not.toBeVisible();
    await expect.poll(() => state.waitingForWrite).toBe(true);
    await expect(page.locator('#quick-entry')).toBeEnabled();
    await page.locator('.record').click();
    await expect(page.locator('#entry-reading')).toBeVisible();
    await expect(page.locator('#entry-body')).not.toBeVisible();
    await expect(page.locator('#reading-body')).toHaveText('첫 내용');
    await page.locator('#edit-entry').click();
    await page.locator('#entry-body').fill('뒤이어 수정한 최신 내용');
    await page.locator('#save').click();
    await expect(page.locator('#editor-dialog')).not.toBeVisible();
    state.holdWrites = false;
    state.releaseWrite();
    await expect(page.locator('#toast')).toContainText('Google Sheets에 저장했습니다.');
    await expect(page.locator('#connection')).toHaveText('Sheets 연결됨');
    expect(populated(state)).toHaveLength(1);
    expect(populated(state)[0][10]).toBe('뒤이어 수정한 최신 내용');
    await page.reload();
    await page.locator('.record').click();
    await expect(page.locator('#reading-body')).toHaveText('뒤이어 수정한 최신 내용');
  } finally {
    state.holdWrites = false;
    state.releaseWrite?.();
    await context.close();
  }
});

test('large ZIP saves in batches and resumes after a quota response without duplicates', async ({
  browser,
}) => {
  const state = { exists: false, tabs: {} };
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await mock(context, state);
  try {
    const page = await context.newPage();
    await setup(page);
    const files = Object.fromEntries(
      Array.from({ length: 61 }, (_, i) => [
        `Keep/${i}.json`,
        strToU8(
          JSON.stringify({
            title: `가져온 일기 ${i}`,
            textContent: `본문 ${i}`,
            labels: [{ name: 'My Diary' }],
            createdTimestampUsec: 1700000000000000 + i * 1000000,
          }),
        ),
      ]),
    );
    const archive = {
      name: 'keep.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(zipSync(files)),
    };
    const before = state.writeRequests;
    state.quotaOnce = true;
    await page.locator('#import-input').setInputFiles(archive);
    await expect(page.locator('#connection')).toHaveText('Sheets 연결됨', { timeout: 20000 });
    expect(state.tabs['일기'].rows.filter((r) => r[0]).length).toBe(62);
    expect(state.writeRequests - before).toBeLessThanOrEqual(18);
    await page.locator('#import-input').setInputFiles(archive);
    await expect(page.locator('#connection')).toHaveText('Sheets 연결됨');
    expect(state.tabs['일기'].rows.filter((r) => r[0]).length).toBe(62);
  } finally {
    await context.close();
  }
});

test('partially imported ZIP resumes the remaining local records after reload', async ({
  browser,
}) => {
  const state = { exists: false, tabs: {} };
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await mock(context, state);
  try {
    const page = await context.newPage();
    await setup(page);
    state.failAfterTwenty = true;
    const files = Object.fromEntries(
      Array.from({ length: 25 }, (_, i) => [
        `Keep/${i}.json`,
        strToU8(
          JSON.stringify({
            title: `재개 일기 ${i}`,
            textContent: `본문 ${i}`,
            labels: [{ name: 'My Diary' }],
            createdTimestampUsec: 1700000000000000 + i * 1000000,
          }),
        ),
      ]),
    );
    await page.locator('#import-input').setInputFiles({
      name: 'keep.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(zipSync(files)),
    });
    await expect(page.locator('#connection')).toHaveText('클라우드 저장 대기');
    expect(state.tabs['일기'].rows.filter((r) => r[0]).length).toBe(21);
    if (!(await page.locator('#settings-dialog').isVisible())) await settings(page);
    await expect(page.locator('#cloud-error')).toContainText('Partial import interrupted');
    await expect(page.locator('#cloud-error')).toBeVisible();
    await expect(page.locator('#sync-progress')).toContainText('기기에 보관');
    await expect(page.locator('#resume-sync')).toBeEnabled();
    const writes = state.writeRequests;
    await page.locator('#resume-sync').click();
    await expect.poll(() => state.writeRequests).toBeGreaterThan(writes);
    await expect(page.locator('#resume-sync')).toBeEnabled();
    state.failAfterTwenty = false;
    await page.reload();
    await expect(page.locator('#connection')).toHaveText('Sheets 연결됨');
    const rows = state.tabs['일기'].rows.slice(1).filter((r) => r[0]);
    expect(rows.length).toBe(25);
    expect(new Set(rows.map((r) => r[0])).size).toBe(25);
  } finally {
    await context.close();
  }
});
