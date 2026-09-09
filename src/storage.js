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
