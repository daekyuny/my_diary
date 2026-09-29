// Immutable cloud JSON plus the last file listing and change token. Scope by OAuth client,
// Google account and repository; never mix this disposable cache with drafts, pending saves
// or photo originals.
export function revisionCache(scope) {
  let opening;
  async function run(store, mode, action) {
    opening ||= new Promise((resolve, reject) => {
      const request = indexedDB.open(`my-diary-cloud-cache-${scope}`, 2);
      request.onupgradeneeded = () => {
        for (const name of ['files', 'meta'])
          if (!request.result.objectStoreNames.contains(name))
            request.result.createObjectStore(name, { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const db = await opening;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const request = action(tx.objectStore(store));
      tx.oncomplete = () => resolve(request?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  return {
    load: () => run('files', 'readonly', (files) => files.getAll()),
    put: (id, revision) => run('files', 'readwrite', (files) => files.put({ id, revision })),
    prune: (ids) =>
      run('files', 'readwrite', (files) => {
        const request = files.openKeyCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          if (!ids.has(cursor.key)) files.delete(cursor.key);
          cursor.continue();
        };
      }),
    loadListing: () => run('meta', 'readonly', (meta) => meta.get('listing')),
    saveListing: (value) =>
      run('meta', 'readwrite', (meta) => meta.put({ ...value, id: 'listing' })),
  };
}
