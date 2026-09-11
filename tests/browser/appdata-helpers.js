import { expect } from '@playwright/test';
import { encodeRevision } from '../../src/journal/sheets.js';
const scope =
  'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.appdata';
export async function mock(context, state) {
  await context.addInitScript((scope) => {
    window.diaryUploadBodies = [];
    const original = window.fetch.bind(window);
    window.fetch = async (input, options) => {
      if (String(input).includes('/upload/drive/v3/files') && options?.body instanceof Blob)
        window.diaryUploadBodies.push(Array.from(new Uint8Array(await options.body.arrayBuffer())));
      return original(input, options);
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
  await context.route('https://accounts.google.com/**', (r) => r.abort());
  await context.route(/^https:\/\/(www|sheets)\.googleapis\.com\//, async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    const send = (json) => route.fulfill({ json });
    state.calls.push(`${request.method()} ${url.pathname}`);
    if (url.pathname === '/drive/v3/about')
      return send({ user: { permissionId: 'owner', emailAddress: 'test@example.com' } });
    if (url.pathname === '/drive/v3/files') {
      expect(request.method()).toBe('GET');
      if (url.searchParams.get('spaces') !== 'appDataFolder')
        return send({ files: state.legacy ? [{ id: 'old-sheet', name: 'My Diary' }] : [] });
      const q = url.searchParams.get('q');
      const ns = /key='namespace' and value='([^']+)'/.exec(q)?.[1];
      const kind = /key='kind' and value='([^']+)'/.exec(q)?.[1];
      return send({
        files: [...state.files.values()]
          .filter(
            (f) =>
              (!ns || f.appProperties.namespace === ns) && (!kind || f.appProperties.kind === kind),
          )
          .map(({ bytes, ...f }) => f),
      });
    }
    if (url.pathname === '/upload/drive/v3/files') {
      // Consume every attempt, including failures, to keep WebKit's Blob capture aligned.
      const captured = await request.frame().evaluate(() => window.diaryUploadBodies.shift());
      if (state.failWrites)
        return route.fulfill({ status: 503, json: { error: { message: 'retry upload' } } });
      const boundary = request.headers()['content-type'].split('boundary=')[1];
      const parts = (request.postDataBuffer() || Buffer.from(captured))
        .toString('binary')
        .split(`--${boundary}`);
      const metadata = JSON.parse(
        Buffer.from(parts[1].split('\r\n\r\n')[1].trim(), 'binary').toString(),
      );
      expect(metadata.parents).toEqual(['appDataFolder']);
      const bytes = Buffer.from(parts[2].slice(parts[2].indexOf('\r\n\r\n') + 4, -2), 'binary');
      const id = `private-${++state.next}`;
      state.files.set(id, { ...metadata, id, createdTime: new Date().toISOString(), bytes });
      return send({ id });
    }
    if (url.pathname.startsWith('/drive/v3/files/')) {
      const id = url.pathname.split('/').at(-1);
      if (request.method() === 'DELETE') {
        state.files.delete(id);
        return send({});
      }
      const file = state.files.get(id);
      if (!file) return route.fulfill({ status: 404, json: { error: { message: 'missing' } } });
      return route.fulfill({
        body: file.bytes,
        contentType: file.name.startsWith('asset') ? 'image/png' : 'application/json',
      });
    }
    if (url.pathname === '/v4/spreadsheets/old-sheet') {
      expect(request.method()).toBe('GET');
      return send({
        sheets: ['일기', '설정', '휴지통', '일정'].map((title) => ({ properties: { title } })),
      });
    }
    if (url.pathname === '/v4/spreadsheets/old-sheet/values:batchGet') {
      return send({
        valueRanges: url.searchParams.getAll('ranges').map((r) => ({
          values: r.startsWith("'설정'")
            ? [
                ['format', 'my-diary-sheets-v1'],
                ['trashDays', '30'],
              ]
            : r.startsWith("'일기'")
              ? [encodeRevision(state.legacy)[0][0]]
              : [],
        })),
      });
    }
    throw new Error(`Unexpected ${request.method()} ${url}`);
  });
}
export const state = () => ({ files: new Map(), next: 0, calls: [] });
export async function connect(page, fresh) {
  await page.goto('/');
  await expect(page.locator('#banner-connect')).toBeEnabled();
  await page.locator('#banner-connect').click();
  if (fresh) await page.locator('#create-sheet').click();
  await expect(page.locator('#connection')).toHaveText('클라우드 연결됨');
}

export function device(testInfo) {
  const { viewport, isMobile, hasTouch, deviceScaleFactor, userAgent } = testInfo.project.use;
  return { viewport, isMobile, hasTouch, deviceScaleFactor, userAgent, serviceWorkers: 'block' };
}
