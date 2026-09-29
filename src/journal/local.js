import * as store from '../storage.js';
import { entryGroups, nextRevision } from './current.js';
// Read the device store, normalize stale flags and drop superseded revisions.
export async function loadGroups({ cancelled = () => false } = {}) {
  const revisions = await store.all('revisions');
  for (const r of revisions) {
    if (r.entry.archived && !r.entry.deletedAt) {
      r.entry.archived = false;
      await store.put('revisions', r);
    }
  }
  if (cancelled()) return null;
  const groups = entryGroups(revisions);
  const keep = new Set(groups.map((g) => g.latest.id));
  for (const r of revisions) if (!keep.has(r.id)) await store.remove('revisions', r.id);
  return groups;
}
export const pendingRevisions = async () =>
  (await store.all('revisions')).filter((r) => !r.sheetSaved && !r.summary && !r.conflict);
export const conflictedRevisions = async () =>
  (await store.all('revisions')).filter((r) => r.conflict);
// Turn interrupted drafts into saved device revisions.
export async function recoverDrafts() {
  for (const draft of await store.all('drafts')) {
    const previous = (await store.all('revisions')).find((r) => r.entry.id === draft.entry.id);
    await store.replaceCurrent(nextRevision(draft.entry, draft.parents, previous));
  }
}
// Copy records into the open store without replacing revisions that already exist there.
export async function adoptRecords({ revisions, assets }) {
  for (const asset of assets) await store.put('assets', asset);
  for (const revision of revisions)
    if (!(await store.get('revisions', revision.id))) await store.put('revisions', revision);
}
export async function snapshotStore() {
  return { revisions: await store.all('revisions'), assets: await store.all('assets') };
}
// Read another owner's store, then reopen the current one even if reading fails.
export async function collectStore(owner, currentOwner) {
  try {
    await store.openStore(owner);
    await recoverDrafts();
    return await snapshotStore();
  } finally {
    await store.openStore(currentOwner);
  }
}
export async function removeEntries(ids) {
  for (const r of await store.all('revisions'))
    if (ids.includes(r.entry.id)) await store.remove('revisions', r.id);
  for (const d of await store.all('drafts'))
    if (ids.includes(d.entry.id)) await store.remove('drafts', d.id);
}
