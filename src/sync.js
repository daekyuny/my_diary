import * as storage from './storage.js';
import * as google from './google.js';

export async function syncDrive(progress = () => {}) {
  const files = await google.remoteRevisions();
  const known = new Map((await storage.all('revisions')).map((r) => [r.id, r]));
  let downloaded = 0;
  for (const file of files) {
    const id = file.appProperties?.revisionId;
    if (known.get(id)?.driveId) continue;
    const revision = await google.downloadRevision(file.id);
    await storage.put('revisions', { ...revision, driveId: file.id });
    known.set(revision.id, revision);
    downloaded++;
    progress(`드라이브에서 ${downloaded}개 버전 불러오는 중…`);
  }
  const pending = (await storage.all('revisions')).filter((r) => !r.driveId);
  let uploaded = 0;
  for (const revision of pending) {
    for (const image of revision.entry.images) {
      if (image.driveId) continue;
      const asset = await storage.get('assets', image.id);
      if (!asset)
        throw new Error(`사진 원본을 찾을 수 없습니다: ${image.name}. 백업에서 복원해주세요.`);
      if (!asset.driveId) {
        asset.driveId = await google.uploadAsset(asset);
        await storage.put('assets', asset);
      }
      image.driveId = asset.driveId;
    }
    const driveId = await google.uploadRevision(revision);
    await storage.put('revisions', { ...revision, driveId });
    uploaded++;
    progress(`드라이브에 ${uploaded}/${pending.length}개 버전 저장 중…`);
  }
  return { uploaded, downloaded, folderId: await google.ensureFolder() };
}

export async function assetBlob(image) {
  const asset = await storage.get('assets', image.id);
  if (asset?.blob) return asset.blob;
  if (!image.driveId) throw new Error(`이미지 원본을 찾을 수 없습니다: ${image.name}`);
  const blob = await google.downloadAsset(image.driveId);
  await storage.put('assets', { ...image, blob });
  return blob;
}
