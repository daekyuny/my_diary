import { createSheetsQuota } from './sheets-quota.js';
const sheetsQuota = createSheetsQuota({
  notify: (delay) =>
    globalThis.dispatchEvent?.(new CustomEvent('sheets-quota-wait', { detail: { delay } })),
});
import { parseRevision, revisionFile, imageFileName, calendarEvent } from './model.js';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
let token = '';
let expiresAt = 0;
let scopes = '';
let folderId = '';
let clientId = '';
let authServer = false;
let refreshing;
const SESSION_KEY = 'my-diary-google-access';
export function useFolder(id) {
  folderId = id;
}
export function configureGoogle(id, persistent = false) {
  clientId = id;
  authServer = persistent;
  if (!token) {
    try {
      const saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
      if (
        saved?.clientId === id &&
        saved.expiresAt > Date.now() &&
        (!persistent || saved.authServer === true)
      ) {
        ({ token, expiresAt, scopes } = saved);
      }
    } catch {}
  }
}
function remember() {
  try {
    sessionStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ clientId, token, expiresAt, scopes, authServer }),
    );
  } catch {}
}
function accept(response) {
  token = response.access_token;
  expiresAt = Date.now() + (response.expires_in - 60) * 1000;
  scopes = response.scope || scopes;
  remember();
}
async function authCall(action, body = {}) {
  const response = await fetch(`/auth/${action}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Diary-Auth': '1' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Google 연결을 복원하지 못했습니다.');
  return result;
}
export async function restoreSession() {
  if (connected()) return true;
  if (!authServer) return false;
  refreshing ||= authCall('token')
    .then((response) => {
      accept(response);
      return true;
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

export function connected() {
  return Boolean(token) && Date.now() < expiresAt;
}
export function hasCalendar() {
  return connected() && scopes.split(' ').includes(CALENDAR_SCOPE);
}
export function disconnect() {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {}
  if (authServer) authCall('logout').catch(() => {});
  token = '';
  scopes = '';
  folderId = '';
  expiresAt = 0;
}

export function authorize(calendar = false) {
  if (authServer) return authorizeCode(calendar);
  if (!clientId)
    return Promise.reject(new Error('설정에서 Google OAuth 클라이언트 ID를 입력해주세요.'));
  if (!globalThis.google?.accounts?.oauth2)
    return Promise.reject(
      new Error(
        'Google 로그인 모듈을 불러오지 못했습니다. 인터넷 연결을 확인하고 새로고침해주세요.',
      ),
    );
  return new Promise((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => {
      finished = true;
      reject(
        new Error('Google 로그인 응답을 받지 못했습니다. 로그인 창을 확인한 뒤 다시 연결해주세요.'),
      );
    }, 90000);
    const wanted = [DRIVE_SCOPE, ...(calendar ? [CALENDAR_SCOPE] : [])];
    google.accounts.oauth2
      .initTokenClient({
        client_id: clientId,
        scope: wanted.join(' '),
        callback(response) {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          if (response.error || !response.access_token)
            return reject(new Error('Google 연결이 취소되었거나 거부되었습니다.'));
          if (!google.accounts.oauth2.hasGrantedAllScopes(response, ...wanted))
            return reject(new Error('요청한 권한을 허용해야 연결할 수 있습니다.'));
          token = response.access_token;
          expiresAt = Date.now() + (response.expires_in - 60) * 1000;
          scopes = response.scope;
          remember();
          folderId = '';
          resolve();
        },
        error_callback() {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          reject(new Error('로그인 창이 닫혔습니다. 팝업을 허용하고 다시 연결해주세요.'));
        },
      })
      .requestAccessToken({ prompt: connected() ? '' : 'select_account' });
  });
}

export async function request(path, options = {}, retried = false, quotaAttempt = 0) {
  if (path.startsWith('sheets/')) await sheetsQuota.reserve(options.method || 'GET');
  if (!connected()) await restoreSession();
  if (!connected())
    throw new Error('Google 연결이 필요합니다. 저장한 기록은 기기에 남아 있습니다.');
  const url = path.startsWith('sheets/')
    ? `https://sheets.googleapis.com/${path.slice(7)}`
    : `https://www.googleapis.com/${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  let response;
  try {
    response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: { ...options.headers, Authorization: `Bearer ${token}` },
    });
    // Include response-body transfer in the deadline, not only the response headers.
    await response.clone().arrayBuffer();
  } catch (error) {
    if (controller.signal.aborted)
      throw new Error(
        'Google 응답이 30초 동안 없어 중단했습니다. 기기 기록은 남아 있습니다. 네트워크를 확인하고 다시 연결해주세요.',
      );
    throw error;
  } finally {
    clearTimeout(timer);
  }

  if (path.startsWith('sheets/') && (await sheetsQuota.retry(response, quotaAttempt)))
    return request(path, options, retried, quotaAttempt + 1);
  if (!response.ok) {
    if (response.status === 401 && authServer && !retried) {
      token = '';
      expiresAt = 0;
      await restoreSession();
      return request(path, options, true);
    }
    if (response.status === 401) {
      disconnect();
      throw new Error('Google 연결이 만료되었습니다. 다시 연결해주세요.');
    }
    const detail = await response.json().catch(() => ({}));
    const error = new Error(
      `Google 요청 실패 (${response.status}): ${detail.error?.message || '잠시 후 다시 시도해주세요.'}`,
    );
    error.status = response.status;
    throw error;
  }
  return response;
}

export async function identity() {
  return (
    await (
      await request('drive/v3/about?fields=user(permissionId,emailAddress,displayName)')
    ).json()
  ).user;
}

async function listFiles(query) {
  let pageToken = '';
  const files = [];
  do {
    const params = new URLSearchParams({
      q: query,
      fields: 'nextPageToken,files(id,name,appProperties)',
      pageSize: '1000',
      ...(pageToken ? { pageToken } : {}),
    });
    const result = await (await request(`drive/v3/files?${params}`)).json();
    files.push(...result.files);
    pageToken = result.nextPageToken;
  } while (pageToken);
  return files;
}

async function findOrCreateFolder(name, query, parents) {
  const folders = await listFiles(
    `trashed = false and mimeType = 'application/vnd.google-apps.folder' and ${query}`,
  );
  if (folders.length) return folders[0].id;
  const result = await request('drive/v3/files?fields=id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      ...(parents ? { parents } : {}),
      appProperties: { myDiary: 'v1', kind: name },
    }),
  });
  return (await result.json()).id;
}

export async function ensureFolder() {
  folderId ||= await findOrCreateFolder(
    'My Diary',
    "appProperties has { key='myDiary' and value='v1' } and appProperties has { key='kind' and value='My Diary' }",
  );
  return folderId;
}

async function upload(name, blob, properties, parent) {
  const boundary = `diary_${crypto.randomUUID()}`;
  const metadata = { name, parents: [parent], appProperties: { myDiary: 'v1', ...properties } };
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${blob.type || 'application/octet-stream'}\r\n\r\n`,
    blob,
    `\r\n--${boundary}--`,
  ]);
  return (
    await (
      await request('upload/drive/v3/files?uploadType=multipart&fields=id', {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body,
      })
    ).json()
  ).id;
}

export async function remoteRevisions() {
  await ensureFolder();
  // Search all app-owned revision files: simultaneous first-run folder creation cannot hide data.
  return listFiles(
    "trashed = false and appProperties has { key='myDiary' and value='v1' } and appProperties has { key='kind' and value='revision' }",
  );
}
export async function downloadRevision(id) {
  return parseRevision(
    await (await request(`drive/v3/files/${encodeURIComponent(id)}?alt=media`)).text(),
  );
}
export async function downloadAsset(id) {
  return (await request(`drive/v3/files/${encodeURIComponent(id)}?alt=media`)).blob();
}

export async function uploadAsset(asset) {
  const parent = await findOrCreateFolder(
    'attachments',
    `'${await ensureFolder()}' in parents and name = 'attachments'`,
    [folderId],
  );
  const existing = await listFiles(
    `trashed = false and appProperties has { key='assetId' and value='${asset.id}' }`,
  );
  return (
    existing[0]?.id ||
    upload(
      asset.managedName || asset.id.endsWith('-thumbnail') ? asset.name : imageFileName(asset),
      asset.blob,
      { kind: 'asset', assetId: asset.id },
      parent,
    )
  );
}
export async function uploadRevision(revision) {
  const existing = await listFiles(
    `trashed = false and appProperties has { key='revisionId' and value='${revision.id}' }`,
  );
  return (
    existing[0]?.id ||
    upload(
      `${revision.entry.date}_${revision.id}.md`,
      new Blob([revisionFile(revision)], { type: 'text/markdown' }),
      { kind: 'revision', revisionId: revision.id },
      await ensureFolder(),
    )
  );
}

export async function calendars() {
  let pageToken = '';
  const items = [];
  do {
    const response = await (
      await request(
        `calendar/v3/users/me/calendarList?${new URLSearchParams({ maxResults: '250', ...(pageToken ? { pageToken } : {}) })}`,
      )
    ).json();
    items.push(...response.items);
    pageToken = response.nextPageToken;
  } while (pageToken);
  return items;
}

export async function events(calendarId, from, to) {
  let pageToken = '';
  const items = [];
  do {
    const params = new URLSearchParams({
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '2500',
      ...(pageToken ? { pageToken } : {}),
    });
    const response = await (
      await request(`calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`)
    ).json();
    items.push(
      ...(response.items || [])
        .filter((event) => event.status !== 'cancelled')
        .map((event) => calendarEvent(event, calendarId)),
    );
    pageToken = response.nextPageToken;
  } while (pageToken);
  return items;
}

function authorizeCode(calendar) {
  if (!clientId || !globalThis.google?.accounts?.oauth2?.initCodeClient)
    return Promise.reject(new Error('Google 로그인 모듈을 확인하고 새로고침해주세요.'));
  return new Promise((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => {
      finished = true;
      reject(new Error('Google 로그인 창을 확인한 뒤 다시 연결해주세요.'));
    }, 90000);
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      error ? reject(error) : resolve();
    };
    globalThis.google.accounts.oauth2
      .initCodeClient({
        client_id: clientId,
        scope: [DRIVE_SCOPE, ...(calendar ? [CALENDAR_SCOPE] : [])].join(' '),
        ux_mode: 'popup',
        prompt: 'consent',
        callback: (response) => {
          if (finished) return;
          if (!response.code || response.error)
            return finish(new Error('Google 연결이 취소되었습니다.'));
          authCall('code', { code: response.code })
            .then((result) => {
              if (!finished) {
                accept(result);
                folderId = '';
                finish();
              }
            })
            .catch(finish);
        },
        error_callback: () => finish(new Error('로그인 창을 열지 못했습니다. 다시 연결해주세요.')),
      })
      .requestCode();
  });
}
