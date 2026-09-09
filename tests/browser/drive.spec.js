import { test, expect } from '@playwright/test';
import { makeRevision, parseRevision, revisionFile } from '../../src/model.js';

test.use({ serviceWorkers: 'block' });

async function mockGoogle(page) {
  const files = [];
  const state = { failUpload: false, files, calendarTitle: '프로젝트 회의', calendarVisible: true };
  await page.addInitScript(() => {
    localStorage.setItem(
      'my-diary-settings',
      JSON.stringify({ googleClientId: 'test.apps.googleusercontent.com' }),
    );
    window.google = {
      accounts: {
        oauth2: {
          initTokenClient(options) {
            return {
              requestAccessToken() {
                queueMicrotask(() =>
                  options.callback({
                    access_token: 'test-token',
                    expires_in: 3600,
                    scope: options.scope,
                  }),
                );
              },
            };
          },
          hasGrantedAllScopes() {
            return true;
          },
        },
      },
    };
  });
  await page.route('https://accounts.google.com/**', (route) => route.abort());
  await page.route('https://www.googleapis.com/**', async (route) => {
    const url = new URL(route.request().url());
    expect(route.request().headers().authorization).toBe('Bearer test-token');
    if (url.pathname.endsWith('/about'))
      return route.fulfill({
        json: { user: { permissionId: 'test-owner', emailAddress: 'diary@example.com' } },
      });
    if (url.pathname.endsWith('/calendarList'))
      return route.fulfill({ json: { items: [{ id: 'primary', summary: '내 일정' }] } });
    if (url.pathname.includes('/calendars/primary/events')) {
      const start = new Date(url.searchParams.get('timeMin'));
      start.setHours(14, 0, 0, 0);
      const end = new Date(start.getTime() + 3600000);
      return route.fulfill({
        json: {
          items: state.calendarVisible
            ? [
                {
                  id: 'meeting',
                  summary: state.calendarTitle,
                  start: { dateTime: start.toISOString() },
                  end: { dateTime: end.toISOString() },
                },
              ]
            : [],
        },
      });
    }
    if (url.pathname === '/upload/drive/v3/files') {
      if (state.failUpload)
        return route.fulfill({
          status: 503,
          json: { error: { message: 'temporary test failure' } },
        });
      const body = route.request().postData();
      const metadata = JSON.parse(body.split('\r\n\r\n')[1].split('\r\n--')[0]);
      const content = body.slice(body.indexOf('---\n')).split('\r\n--')[0];
      const id = `file-${files.length + 1}`;
      files.push({ id, name: metadata.name, appProperties: metadata.appProperties, content });
      return route.fulfill({ json: { id } });
    }
    if (url.pathname === '/drive/v3/files') {
      const query = url.searchParams.get('q') || '';
      if (query.includes('mimeType'))
        return route.fulfill({ json: { files: [{ id: 'folder-id', name: 'My Diary' }] } });
      const match = query.match(/key='revisionId' and value='([^']+)'/);
      return route.fulfill({
        json: {
          files: (match
            ? files.filter((file) => file.appProperties.revisionId === match[1])
            : files
          ).map(({ content, ...metadata }) => metadata),
        },
      });
    }
    const file = files.find((file) => url.pathname === `/drive/v3/files/${file.id}`);
    if (file) return route.fulfill({ body: file.content, contentType: 'text/markdown' });
    throw new Error(`Unexpected Google request: ${route.request().method()} ${url}`);
  });
  await page.goto('/');
  await expect(page.locator('#entry-heading')).not.toBeEmpty();
  return state;
}

test('failed Drive upload remains pending, retries, and concurrent edits retain both versions', async ({
  page,
}) => {
  const state = await mockGoogle(page);
  await page.locator('#banner-connect').click();
  await expect(page.locator('#drive-status')).toContainText('연결됨');
  await page.locator('#entry-title').fill('드라이브 저장 검증');
  await page.locator('#entry-body').fill('첫 번째 원본');
  await page.locator('#save').click();
  await expect(page.locator('#save-state')).toContainText('드라이브 저장 완료');
  expect(state.files).toHaveLength(1);
  const base = parseRevision(state.files[0].content);

  state.failUpload = true;
  await page.locator('#entry-body').fill('폰에서 수정한 내용 12345');
  await page.locator('#save').click();
  await expect(page.locator('#toast')).toContainText('503');
  await expect(page.locator('#save-state')).toContainText('동기화 대기');
  expect(state.files).toHaveLength(1);

  const other = makeRevision({ ...base.entry, body: '태블릿에서 수정한 이름 김민수' }, [base.id]);
  state.files.push({
    id: 'remote-edit',
    name: 'remote.md',
    appProperties: { revisionId: other.id },
    content: revisionFile(other),
  });
  state.failUpload = false;
  await page.locator('#sync').click();
  await expect(page.locator('#conflict')).toContainText('2개');
  expect(state.files).toHaveLength(3);
  await page.locator('#compare-versions').click();
  await page.locator('#merge-versions').click();
  await expect(page.locator('#entry-body')).toHaveValue(/12345/);
  await expect(page.locator('#entry-body')).toHaveValue(/김민수/);
  await expect(page.locator('#conflict')).toBeHidden();
  expect(state.files).toHaveLength(4);
  expect(parseRevision(state.files[0].content).entry.body).toBe('첫 번째 원본');
});

test('unchanged saves and syncs reuse the Drive file while edits preserve revision history', async ({
  page,
}) => {
  const state = await mockGoogle(page);
  await page.locator('#banner-connect').click();
  await expect(page.locator('#drive-status')).toContainText('연결됨');
  await page.locator('#entry-body').fill('첫 번째 기록');
  await page.locator('#save').click();
  await expect(page.locator('#save-state')).toContainText('드라이브 저장 완료');
  expect(state.files).toHaveLength(1);
  const first = parseRevision(state.files[0].content);

  await page.locator('#save').click();
  await page.locator('#sync').click();
  await expect(page.locator('#save-state')).toContainText('드라이브 저장 완료');
  expect(state.files).toHaveLength(1);

  await page.locator('#entry-body').fill('수정한 기록');
  await expect.poll(() => state.files.length).toBe(2);
  await expect(page.locator('#save-state')).toContainText('드라이브 저장 완료');
  const second = parseRevision(state.files[1].content);
  expect(second.entry.id).toBe(first.entry.id);
  expect(second.parents).toEqual([first.id]);
  expect(state.files[1].name).not.toBe(state.files[0].name);
  expect(parseRevision(state.files[0].content).entry.body).toBe('첫 번째 기록');

  await page.locator('#save').click();
  await page.locator('#sync').click();
  await expect(page.locator('#save-state')).toContainText('드라이브 저장 완료');
  expect(state.files).toHaveLength(2);
});

test('calendar imports once, refreshes title, and preserves notes after cancellation', async ({
  page,
}) => {
  const state = await mockGoogle(page);
  await page.locator('#calendar-button').click();
  await page.locator('#authorize-calendar').click();
  await expect(page.locator('#dialog-title')).toHaveText('가져올 캘린더');
  await page.locator('input[name="calendar"]').check();
  await page.locator('#save-calendars').click();
  await expect(page.locator('.event-card')).toHaveCount(1);
  await page.locator('[data-event-note="0"]').fill('김민수 · 계약 번호 9876');
  await page.locator('[data-event-reminder="0"]').uncheck();
  await page.locator('#save').click();
  state.calendarTitle = '변경된 회의';
  await page.locator('#calendar-button').click();
  await expect(page.locator('.event-card')).toContainText('변경된 회의');
  await expect(page.locator('[data-event-note="0"]')).toHaveValue('김민수 · 계약 번호 9876');
  await expect(page.locator('[data-event-reminder="0"]')).not.toBeChecked();
  state.calendarVisible = false;
  await page.locator('#calendar-button').click();
  await expect(page.locator('.event-card')).toContainText('원본 변경/삭제');
  await expect(page.locator('[data-event-note="0"]')).toHaveValue('김민수 · 계약 번호 9876');
});

test('local drafts enter an account only through explicit migration', async ({ page }) => {
  await mockGoogle(page);
  await page.locator('#entry-body').fill('연결 전 개인 초안');
  await page.locator('#save').click();
  await page.locator('#banner-connect').click();
  await expect(page.locator('#entry-body')).toHaveValue('');
  await page.locator('#open-settings').click();
  await page.locator('#import-local').click();
  await expect(page.locator('#toast')).toContainText('가져왔습니다');
  await page.locator('#new-entry').click();
  await expect(page.locator('#entry-body')).toHaveValue('연결 전 개인 초안');
});
