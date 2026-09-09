import { zipSync, unzipSync, strToU8, strFromU8 } from '/vendor/fflate.js';
import { validateRevision, revisionFile, markdown, entryGroups, imageFileName } from './model.js';
import * as storage from './storage.js';
import { assetBlob } from './sync.js';

export async function exportBackup() {
  const revisions = await storage.all('revisions');
  const files = {};
  const manifest = {
    format: 'my-diary',
    version: 1,
    exportedAt: new Date().toISOString(),
    revisions: revisions.map(({ driveId, ...revision }) => revision),
  };
  files['diary.json'] = strToU8(JSON.stringify(manifest, null, 2));
  for (const { latest } of entryGroups(revisions))
    files[`${latest.entry.date}_${latest.entry.id}.md`] = strToU8(markdown(latest.entry));
  for (const revision of revisions)
    files[`history/${revision.id}.md`] = strToU8(
      revisionFile(revision).replaceAll('](attachments/', '](../attachments/'),
    );
  const images = new Map(
    revisions.flatMap((revision) => revision.entry.images).map((image) => [image.id, image]),
  );
  for (const image of images.values())
    files[`attachments/${imageFileName(image)}`] = new Uint8Array(
      await (await assetBlob(image)).arrayBuffer(),
    );
  files['README.txt'] = strToU8(
    'My Diary 백업\n날짜별 .md: 일반 Markdown 일기. attachments/: 사진 원본.\ndiary.json: 앱 복원용 전체 버전. history/: 모든 수정 버전.\n충돌한 버전도 diary.json과 history에 모두 포함됩니다.\n',
  );
  return new Blob([zipSync(files, { level: 0 })], { type: 'application/zip' });
}

export async function importBackup(file) {
  if (file.size > 100 * 1024 * 1024)
    throw new Error('첫 버전은 100MB 이하 백업을 가져올 수 있습니다.');
  let total = 0;
  const files = unzipSync(new Uint8Array(await file.arrayBuffer()), {
    filter(info) {
      total += info.originalSize;
      if (total > 250 * 1024 * 1024) throw new Error('압축 해제 용량이 너무 큽니다.');
      return true;
    },
  });
  if (!files['diary.json']) throw new Error('My Diary ZIP 백업을 선택해주세요.');
  const manifest = JSON.parse(strFromU8(files['diary.json']));
  if (
    manifest.format !== 'my-diary' ||
    manifest.version !== 1 ||
    !Array.isArray(manifest.revisions)
  )
    throw new Error('지원하지 않는 백업 형식입니다.');
  const revisions = manifest.revisions.map(validateRevision);
  const images = new Map(
    revisions.flatMap((revision) => revision.entry.images).map((image) => [image.id, image]),
  );
  // Validate the entire archive before writing anything.
  for (const image of images.values())
    if (!files[`attachments/${imageFileName(image)}`])
      throw new Error(`백업에 사진이 빠져 있습니다: ${image.name}`);
  for (const image of images.values()) {
    const { driveId, ...portable } = image;
    if (!(await storage.get('assets', image.id)))
      await storage.put('assets', {
        ...portable,
        blob: new Blob([files[`attachments/${imageFileName(image)}`]], { type: image.type }),
      });
  }
  let count = 0;
  for (const revision of revisions) {
    if (await storage.get('revisions', revision.id)) continue;
    delete revision.driveId;
    for (const image of revision.entry.images) delete image.driveId;
    await storage.put('revisions', revision);
    count++;
  }
  return count;
}
