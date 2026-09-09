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
export const all = (store) => run(store, 'readonly', (table) => table.getAll());
export const get = (store, id) => run(store, 'readonly', (table) => table.get(id));
export const put = (store, value) => run(store, 'readwrite', (table) => table.put(value));
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
