// Immutable cloud JSON only. Scope by OAuth client, Google account and repository;
// never mix this disposable cache with drafts, pending saves or photo originals.
export function revisionCache(scope) {
  let opening;
  async function run(mode, action) {
    opening ||= new Promise((resolve, reject) => {
      const request = indexedDB.open(`my-diary-cloud-cache-${scope}`, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('files', { keyPath: 'id' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const db = await opening;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('files', mode);
      const request = action(tx.objectStore('files'));
      tx.oncomplete = () => resolve(request?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  return {
    load: () => run('readonly', (files) => files.getAll()),
    put: (id, revision) => run('readwrite', (files) => files.put({ id, revision })),
    prune: (ids) =>
      run('readwrite', (files) => {
        const request = files.openKeyCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          if (!ids.has(cursor.key)) files.delete(cursor.key);
          cursor.continue();
        };
      }),
  };
}
