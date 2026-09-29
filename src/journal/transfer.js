import * as store from '../storage.js';
import { localDate } from '../model.js';
import { parseArchive, stableKeepIds, makeBackup } from './backup.js';
import { assetBlob } from './photos.js';
// Import a My Diary or Keep ZIP into the device store. Returns how many records were new.
export async function importArchive(file) {
  if (file.size > 100 * 1024 * 1024) throw new Error('100MB 이하 ZIP을 선택해주세요.');
  const parsed = parseArchive(new Uint8Array(await file.arrayBuffer()));
  await stableKeepIds(parsed.revisions);
  const existing = new Set((await store.all('revisions')).map((r) => r.id));
  const fresh = parsed.revisions.filter((r) => !existing.has(r.id));
  const ids = new Set(fresh.flatMap((r) => r.entry.images).map((i) => i.id));
  for (const asset of parsed.assets) if (ids.has(asset.id)) await store.put('assets', asset);
  for (const r of fresh) await store.put('revisions', r);
  return fresh.length;
}
// Export cloud revisions when available, then anything only this device holds.
export async function exportArchive({ repository = null, hydrate }) {
  const revisions = repository ? await repository.backupRevisions() : [];
  for (const r of await store.all('revisions'))
    if (!revisions.some((saved) => saved.id === r.id)) revisions.push(await hydrate(r));
  return { blob: await makeBackup(revisions, assetBlob), name: `my-diary-${localDate()}.zip` };
}
