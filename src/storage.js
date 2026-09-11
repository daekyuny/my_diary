let database;
export async function openStore(owner = 'local') {
  database?.close();
  database = await new Promise((resolve, reject) => {
    const request = indexedDB.open(`my-diary-${owner}`, 1);
    request.onupgradeneeded = () => {
      for (const name of ['revisions', 'assets', 'drafts'])
        request.result.createObjectStore(name, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function run(store, mode, action) {
  return new Promise((resolve, reject) => {
    const tx = database.transaction(store, mode);
    const request = action(tx.objectStore(store));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error || request.error);
    tx.onabort = () =>
      reject(tx.error || new Error('기기에 저장하지 못했습니다. 저장공간을 확인해주세요.'));
  });
}
function restoreAsset(store, value) {
  if (store !== 'assets' || !value?.blobBytes) return value;
  const { blobBytes, blobType, ...asset } = value;
  return { ...asset, blob: new Blob([blobBytes], { type: blobType }) };
}
export const all = async (store) =>
  (await run(store, 'readonly', (table) => table.getAll())).map((value) =>
    restoreAsset(store, value),
  );
export const get = async (store, id) =>
  restoreAsset(store, await run(store, 'readonly', (table) => table.get(id)));
export async function put(store, value) {
  if (store === 'assets' && value.blob instanceof Blob) {
    // Store bytes before opening the transaction: WebKit can reject Blob/File IDB writes.
    // Readers still accept older records that contain a Blob directly.
    const { blob, ...asset } = value;
    value = { ...asset, blobBytes: await blob.arrayBuffer(), blobType: blob.type };
  }
  return run(store, 'readwrite', (table) => table.put(value));
}
export const remove = (store, id) => run(store, 'readwrite', (table) => table.delete(id));

export function readSettings() {
  try {
    return JSON.parse(localStorage.getItem('my-diary-settings') || '{}');
  } catch {
    return {};
  }
}
export function saveSettings(value) {
  localStorage.setItem('my-diary-settings', JSON.stringify(value));
}

// Commit the revision and remove its draft together, including across page reloads.
export function commitRevision(revision) {
  return new Promise((resolve, reject) => {
    const tx = database.transaction(['revisions', 'drafts'], 'readwrite');
    tx.objectStore('revisions').put(revision);
    tx.objectStore('drafts').delete(revision.entry.id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('기기에 저장하지 못했습니다.'));
  });
}

export function replaceCurrent(revision) {
  return new Promise((resolve, reject) => {
    const tx = database.transaction(['revisions', 'drafts'], 'readwrite');
    const records = tx.objectStore('revisions');
    const cursor = records.openCursor();
    cursor.onsuccess = () => {
      const item = cursor.result;
      if (item) {
        if (item.value.entry.id === revision.entry.id) item.delete();
        item.continue();
      } else records.put(revision);
    };
    tx.objectStore('drafts').delete(revision.entry.id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('기기에 저장하지 못했습니다.'));
  });
}

// A cloud acknowledgement must never replace a newer local edit of the same diary.
export function acknowledgeRevision(revision) {
  return new Promise((resolve, reject) => {
    const tx = database.transaction('revisions', 'readwrite');
    const records = tx.objectStore('revisions');
    const request = records.get(revision.id);
    request.onsuccess = () => {
      if (request.result) records.put(revision);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('저장 상태를 갱신하지 못했습니다.'));
  });
}

// Refresh may finish while a local save is committing. Check for pending edits
// inside the same transaction that installs the remote row.
export function mergeRemoteRevision(revision) {
  return new Promise((resolve, reject) => {
    const tx = database.transaction('revisions', 'readwrite');
    const records = tx.objectStore('revisions');
    const request = records.getAll();
    request.onsuccess = () => {
      const same = request.result.filter((r) => r.entry.id === revision.entry.id);
      if (same.some((r) => !r.sheetSaved)) return;
      for (const row of same) records.delete(row.id);
      records.put(revision);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('최신 기록을 반영하지 못했습니다.'));
  });
}
