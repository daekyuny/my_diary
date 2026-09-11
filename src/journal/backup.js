import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import {
  makeRevision,
  newEntry,
  validateRevision,
  imageFileName,
  localDate,
  markdown,
} from '../model.js';
export function parseArchive(bytes) {
  let total = 0;
  const files = unzipSync(bytes, {
    filter(info) {
      total += info.originalSize;
      if (total > 300 * 1024 * 1024)
        throw new Error('압축 해제 용량이 300MB를 넘습니다. 파일을 나누어 가져와주세요.');
      return true;
    },
  });
  const revisions = [],
    assets = new Map();
  if (files['diary.json']) {
    const manifest = JSON.parse(strFromU8(files['diary.json']));
    if (
      manifest.format !== 'my-diary' ||
      manifest.version !== 1 ||
      !Array.isArray(manifest.revisions)
    )
      throw new Error('지원하지 않는 일기 백업입니다.');
    for (const raw of manifest.revisions) {
      const r = validateRevision(raw);
      delete r.sheetSaved;
      delete r.driveId;
      delete r.remoteKnown;
      delete r.entry.removedImages;
      for (const image of r.entry.images) {
        const data = files[`attachments/${imageFileName(image)}`];
        if (!data) throw new Error(`사진 원본 누락: ${image.name}`);
        delete image.driveId;
        delete image.thumbnail;
        assets.set(image.id, { ...image, blob: new Blob([data], { type: image.type }) });
      }
      revisions.push(r);
    }
  } else {
    for (const [path, data] of Object.entries(files)) {
      if (!path.endsWith('.json')) continue;
      let note;
      try {
        note = JSON.parse(strFromU8(data));
      } catch {
        continue;
      }
      if (
        !Array.isArray(note.labels) ||
        !note.labels.some((label) => label.name === 'My Diary') ||
        note.isTrashed
      )
        continue;
      const timestamp = Number(note.createdTimestampUsec) / 1000;
      const date = new Date(timestamp);
      if (!Number.isFinite(date.getTime()))
        throw new Error(`Keep 날짜를 읽을 수 없습니다: ${path}`);
      const e = newEntry(localDate(date));
      const dated = /^\s*(\d{4}-\d{2}-\d{2})(?:\s|$)/.exec(note.title || '');
      e.date = dated?.[1] || e.date;
      e.title = note.title || '';
      e.body =
        note.textContent ||
        note.listContent?.map((item) => `${item.isChecked ? '☑' : '☐'} ${item.text}`).join('\n') ||
        '';
      e.tags = note.labels.map((label) => label.name).filter((name) => name !== 'My Diary');
      e.source = { format: 'google-keep', path, createdTimestampUsec: note.createdTimestampUsec };
      e.archived = Boolean(note.isArchived);
      e.pinned = Boolean(note.isPinned);
      for (const attachment of note.attachments || []) {
        const name = attachment.filePath;
        const parent = path.slice(0, path.lastIndexOf('/') + 1);
        const asset = files[parent + name] || files[name];
        if (!asset) throw new Error(`Keep 첨부 원본 누락: ${name}`);
        const type = attachment.mimetype || attachment.mimeType;
        if (!/^image\/(jpeg|png|webp|gif)$/.test(type))
          throw new Error(`지원하지 않는 Keep 첨부: ${name}. 원본 ZIP을 보존해주세요.`);
        const image = { id: crypto.randomUUID(), name: name.split('/').pop(), type };
        e.images.push(image);
        assets.set(image.id, { ...image, blob: new Blob([asset], { type }) });
      }
      revisions.push(makeRevision(e));
    }
    if (!revisions.length) throw new Error('My Diary 라벨이 있는 Keep 메모를 찾지 못했습니다.');
  }
  revisions.forEach((r) => {
    if (r.entry.body.length > 120000) throw new Error('12만 자를 넘는 기록은 나누어 가져와주세요.');
  });
  return { revisions, assets: [...assets.values()] };
}
export async function stableKeepIds(revisions) {
  for (const r of revisions)
    if (r.entry.source?.format === 'google-keep') {
      const key = JSON.stringify([r.entry.source.path, r.entry.source.createdTimestampUsec]);
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
      const id = Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
      r.entry.id = `keep-${id}`;
      r.id = `keep-${id}`;
    }
  return revisions;
}
export async function makeBackup(revisions, assetBlob) {
  const files = {},
    portable = revisions.map((r) => {
      const { sheetSaved, summary, row, ...rest } = r;
      return rest;
    });
  files['diary.json'] = strToU8(
    JSON.stringify({ format: 'my-diary', version: 1, revisions: portable }, null, 2),
  );
  const assets = new Map(
    revisions.flatMap((r) => r.entry.images).map((image) => [image.id, image]),
  );
  for (const image of assets.values())
    files[`attachments/${imageFileName(image)}`] = new Uint8Array(
      await (await assetBlob(image)).arrayBuffer(),
    );
  for (const r of revisions) files[`history/${r.id}.md`] = strToU8(markdown(r.entry));
  return new Blob([zipSync(files, { level: 0 })], { type: 'application/zip' });
}
