import * as store from '../storage.js';
import * as google from '../google.js';
import { assetBlob } from '../sync.js';

export async function makeThumbnail(blob, id) {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const scale = Math.min(1, 480 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const thumbnail = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.78));
    if (!thumbnail) throw new Error('사진 미리보기를 만들지 못했습니다.');
    const result = { id: `${id}-thumbnail`, name: `${id}-thumbnail.jpg`, type: 'image/jpeg' };
    await store.put('assets', { ...result, blob: thumbnail });
    return result;
  } finally {
    URL.revokeObjectURL(url);
  }
}
export async function createPhoto(file) {
  if (file.size > 10 * 1024 * 1024 || !/^image\/(jpeg|png|webp|gif)$/.test(file.type))
    throw new Error('사진은 JPG, PNG, WebP, GIF 형식으로 10MB 이하만 첨부할 수 있습니다.');
  const id = crypto.randomUUID();
  const extension = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
  }[file.type];
  const image = { id, name: `${id}-original.${extension}`, type: file.type, managedName: true };
  image.thumbnail = await makeThumbnail(file, id);
  await store.put('assets', { ...image, blob: file });
  return image;
}
export async function previewBlob(image) {
  if (image.thumbnail) return assetBlob(image.thumbnail);
  // Old attachments acquire a local preview lazily; saving the diary uploads it.
  const thumbnail = await makeThumbnail(await assetBlob(image), image.id);
  return assetBlob(thumbnail);
}
export async function uploadPhoto(image) {
  if (!image.thumbnail) image.thumbnail = await makeThumbnail(await assetBlob(image), image.id);
  for (const part of [image, image.thumbnail]) {
    if (part.driveId) continue;
    const asset = await store.get('assets', part.id);
    if (!asset) throw new Error('사진 파일을 찾지 못했습니다.');
    asset.driveId ||= await google.uploadAsset(asset);
    await store.put('assets', asset);
    part.driveId = asset.driveId;
  }
}
export const photoIds = (images = []) =>
  images.flatMap((image) => [image.id, image.thumbnail?.id].filter(Boolean));
export async function cleanLocalPhotos(currentImages = []) {
  const records = [...(await store.all('revisions')), ...(await store.all('drafts'))];
  const kept = new Set(
    photoIds([...records.flatMap((r) => r.entry.images || []), ...currentImages]),
  );
  for (const asset of await store.all('assets'))
    if (!kept.has(asset.id)) await store.remove('assets', asset.id);
}
