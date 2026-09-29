import * as store from '../storage.js';
import { uploadPhoto } from './photos.js';
// Group pending revisions into requests of at most `count` items and roughly `bytes` payload.
export function batches(pending, { count = 20, bytes = 500000 } = {}) {
  const result = [];
  for (let offset = 0; offset < pending.length;) {
    const batch = [];
    let size = 0;
    while (offset < pending.length && batch.length < count) {
      const length = new TextEncoder().encode(JSON.stringify(pending[offset])).length;
      if (batch.length && size + length > bytes) break;
      size += length;
      batch.push(pending[offset++]);
    }
    result.push(batch);
  }
  return result;
}
// Attach Drive ids to removed photos so the repository can clean up the originals.
async function describeRemovedImages(revision) {
  for (const removed of revision.entry.removedImages || []) {
    const original = await store.get('assets', removed.id);
    removed.driveId ||= original?.driveId;
    const thumb = await store.get('assets', removed.thumbnail?.id || `${removed.id}-thumbnail`);
    if (thumb?.driveId)
      removed.thumbnail = {
        id: thumb.id,
        name: thumb.name,
        type: thumb.type,
        driveId: thumb.driveId,
      };
  }
}
// Upload photos, then save the batch. A conflict is recorded on the local revision and rethrown.
export async function pushBatch(repository, batch, progress = () => {}) {
  for (const revision of batch) {
    for (const image of revision.entry.images)
      await uploadPhoto(image, `${repository.id}:${revision.entry.id}`);
    await describeRemovedImages(revision);
    await store.acknowledgeRevision(revision);
  }
  progress();
  try {
    await repository.saveMany(batch);
  } catch (error) {
    if (error.conflict) {
      const revision = batch.find((r) => r.id === error.localId);
      await store.acknowledgeRevision({ ...revision, conflict: error.conflict });
    }
    throw error;
  }
  for (const revision of batch) {
    delete revision.entry.removedImages;
    await store.acknowledgeRevision({ ...revision, sheetSaved: true, remoteKnown: true });
  }
}
