import { parseRevision, revisionFile, imageFileName, calendarEvent } from './model.js';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
let token = '';
let expiresAt = 0;
let scopes = '';
let folderId = '';
let clientId = '';
export function useFolder(id) {
  folderId = id;
}
export function configureGoogle(id) {
  clientId = id;
}
export function connected() {
  return Boolean(token) && Date.now() < expiresAt;
}
export function hasCalendar() {
  return connected() && scopes.split(' ').includes(CALENDAR_SCOPE);
}
export function disconnect() {
  token = '';
  scopes = '';
  folderId = '';
  expiresAt = 0;
}

export function authorize(calendar = false) {
  if (!clientId)
    return Promise.reject(new Error('설정에서 Google OAuth 클라이언트 ID를 입력해주세요.'));
  if (!globalThis.google?.accounts?.oauth2)
    return Promise.reject(
      new Error(
        'Google 로그인 모듈을 불러오지 못했습니다. 인터넷 연결을 확인하고 새로고침해주세요.',
      ),
    );
  return new Promise((resolve, reject) => {
    const wanted = [DRIVE_SCOPE, ...(calendar ? [CALENDAR_SCOPE] : [])];
    google.accounts.oauth2
      .initTokenClient({
        client_id: clientId,
        scope: wanted.join(' '),
        callback(response) {
          if (response.error || !response.access_token)
            return reject(new Error('Google 연결이 취소되었거나 거부되었습니다.'));
          if (!google.accounts.oauth2.hasGrantedAllScopes(response, ...wanted))
            return reject(new Error('요청한 권한을 허용해야 연결할 수 있습니다.'));
          token = response.access_token;
          expiresAt = Date.now() + (response.expires_in - 60) * 1000;
          scopes = response.scope;
          folderId = '';
          resolve();
        },
        error_callback() {
          reject(new Error('로그인 창이 닫혔습니다. 팝업을 허용하고 다시 연결해주세요.'));
        },
      })
      .requestAccessToken({ prompt: connected() ? '' : 'select_account' });
  });
}

export async function request(path, options = {}) {
  if (!connected()) throw new Error('Google 연결이 필요합니다. 초안은 기기에 남아 있습니다.');
  const response = await fetch(`https://www.googleapis.com/${path}`, {
    ...options,
    headers: { ...options.headers, Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    if (response.status === 401) {
      disconnect();
      throw new Error('Google 연결이 만료되었습니다. 다시 연결해주세요.');
    }
    const detail = await response.json().catch(() => ({}));
    throw new Error(
      `Google 요청 실패 (${response.status}): ${detail.error?.message || '잠시 후 다시 시도해주세요.'}`,
    );
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
    upload(imageFileName(asset), asset.blob, { kind: 'asset', assetId: asset.id }, parent)
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
