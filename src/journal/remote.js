import * as store from '../storage.js';
import { recentIds } from './cache.js';
// Load the full body of a summary-only revision from the connected repository.
export async function hydrateRevision(repository, revision) {
  if (!revision.summary) return revision;
  if (!repository) throw new Error('이 기기에 아직 본문이 없습니다. Google에 연결해 불러와주세요.');
  const full = await repository.read(revision);
  await store.put('revisions', full);
  return full;
}
// Merge the repository listing into the device store without overwriting pending local edits.
// Recent diaries are fetched in full; older ones stay as summaries unless open or drafted here.
export async function pullRemote(repository, { activeEntryId = null } = {}) {
  const remote = await repository.list();
  const local = new Map((await store.all('revisions')).map((r) => [r.id, r]));
  const current = new Set(remote.map((r) => r.id));
  for (const r of local.values())
    if (r.sheetSaved && !current.has(r.id)) await store.remove('revisions', r.id);
  for (const revision of remote) {
    const existing = local.get(revision.id);
    if (existing && JSON.stringify(existing) === JSON.stringify(revision)) continue;
    const pending = [...local.values()].find(
      (r) => r.entry.id === revision.entry.id && !r.sheetSaved,
    );
    if (pending && pending.id !== revision.id) continue;
    await store.mergeRemoteRevision(
      existing &&
        !existing.summary &&
        !repository.private &&
        !revision.conflict &&
        !existing.conflict
        ? { ...existing, sheetSaved: true, row: revision.row, tab: revision.tab }
        : revision,
    );
  }
  const recent = recentIds(remote);
  const missing = remote.filter(
    (r) => !repository.private && recent.has(r.id) && (!local.has(r.id) || local.get(r.id).summary),
  );
  for (let i = 0; i < missing.length; i += 20) {
    const full = await repository.readMany(missing.slice(i, i + 20));
    for (const revision of full) await store.mergeRemoteRevision(revision);
  }
  const drafts = new Set((await store.all('drafts')).map((d) => d.entry.id));
  for (const revision of remote) {
    if (
      !repository.private &&
      !recent.has(revision.id) &&
      activeEntryId !== revision.entry.id &&
      !drafts.has(revision.entry.id)
    )
      await store.mergeRemoteRevision(revision);
  }
}
