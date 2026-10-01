import * as store from '../storage.js';
import { uploadPrivateAsset } from './appdata.js';
import * as google from '../google.js';
import {
  PHOTO_LIMIT,
  CAMERA_LIMIT,
  OPTIMIZED_SIDE,
  OPTIMIZED_QUALITY,
  optimizes,
  fitWithin,
} from './media.js';

// Prefer the device copy; otherwise download from Drive and keep thumbnails cached locally.
export async function assetBlob(image) {
  const asset = await store.get('assets', image.id);
  if (asset?.blob) return asset.blob;
  if (!image.driveId) throw new Error(`이미지 원본을 찾을 수 없습니다: ${image.name}`);
  const blob = await google.downloadAsset(image.driveId);
  if (image.storage !== 'appDataFolder' || image.id.endsWith('-thumbnail'))
    await store.put('assets', { ...image, blob, accessedAt: Date.now() });
  return blob;
}
// Draws an image (already rotated by its EXIF orientation, as browsers decode it) into a JPEG
// whose longer side is at most `side` pixels.
async function scaledJPEG(blob, side, quality) {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const { width, height } = fitWithin(image.naturalWidth, image.naturalHeight, side);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    const result = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    return { blob: result, resized: width < image.naturalWidth };
  } finally {
    URL.revokeObjectURL(url);
  }
}
export async function makeThumbnail(blob, id) {
  const { blob: thumbnail } = await scaledJPEG(blob, 480, 0.78);
  if (!thumbnail) throw new Error('사진 미리보기를 만들지 못했습니다.');
  const result = { id: `${id}-thumbnail`, name: `${id}-thumbnail.jpg`, type: 'image/jpeg' };
  await store.put('assets', { ...result, blob: thumbnail });
  return result;
}
// Re-encodes camera photos to 2048px JPEG; keeps the original when that would not save bytes.
async function optimizedPhoto(file) {
  const { blob, resized } = await scaledJPEG(file, OPTIMIZED_SIDE, OPTIMIZED_QUALITY);
  if (!blob || (!resized && blob.size >= file.size)) return file;
  return blob;
}
const EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};
export async function createPhoto(file, mode = 'optimized') {
  const optimize = optimizes(file.type, mode);
  if (!EXTENSIONS[file.type] || file.size > (optimize ? CAMERA_LIMIT : PHOTO_LIMIT))
    throw new Error(
      optimize
        ? '사진은 40MB 이하만 첨부할 수 있습니다.'
        : '사진은 JPG, PNG, WebP, GIF 형식으로 10MB 이하만 첨부할 수 있습니다.',
    );
  const blob = optimize ? await optimizedPhoto(file) : file;
  if (blob.size > PHOTO_LIMIT)
    throw new Error('최적화한 사진이 10MB를 넘습니다. 원본 크기를 줄여 다시 첨부해주세요.');
  const id = crypto.randomUUID();
  const type = blob.type || file.type;
  const image = { id, name: `${id}-original.${EXTENSIONS[type]}`, type, managedName: true };
  image.thumbnail = await makeThumbnail(blob, id);
  await store.put('assets', { ...image, blob });
  return image;
}
export async function previewBlob(image) {
  if (image.thumbnail) return assetBlob(image.thumbnail);
  // Old attachments acquire a local preview lazily; saving the diary uploads it.
  const thumbnail = await makeThumbnail(await assetBlob(image), image.id);
  return assetBlob(thumbnail);
}
export async function uploadPhoto(image, owner) {
  if (!image.thumbnail) image.thumbnail = await makeThumbnail(await assetBlob(image), image.id);
  for (const part of [image, image.thumbnail]) {
    if (part.driveId && part.storage === 'appDataFolder' && part.appOwner === owner) continue;
    const asset =
      (await store.get('assets', part.id)) ||
      (part.driveId ? { ...part, blob: await assetBlob(part) } : null);
    if (!asset) throw new Error('사진 파일을 찾지 못했습니다.');
    asset.driveId = await uploadPrivateAsset(asset, owner);
    asset.storage = 'appDataFolder';
    await store.put('assets', asset);
    part.driveId = asset.driveId;
    part.storage = 'appDataFolder';
    part.appOwner = owner;
  }
}
export const photoIds = (images = []) =>
  images.flatMap((image) => [image.id, image.thumbnail?.id].filter(Boolean));
export async function cleanLocalPhotos(currentImages = []) {
  const records = [...(await store.all('revisions')), ...(await store.all('drafts'))];
  const kept = new Set(
    photoIds([...records.flatMap((r) => r.entry.images || []), ...currentImages]),
  );
  const pending = new Set(
    photoIds(records.filter((r) => !r.sheetSaved).flatMap((r) => r.entry.images || [])),
  );
  const privateSaved = new Set(
    records
      .filter((r) => r.sheetSaved)
      .flatMap((r) =>
        (r.entry.images || []).flatMap((image) =>
          [image, image.thumbnail]
            .filter((part) => part?.storage === 'appDataFolder' && part.driveId)
            .map((part) => part.id),
        ),
      ),
  );
  let cacheBytes = 0;
  const assets = (await store.all('assets')).sort(
    (a, b) => (b.accessedAt || 0) - (a.accessedAt || 0),
  );
  for (const asset of assets) {
    const uploaded =
      (asset.storage === 'appDataFolder' && asset.driveId) || privateSaved.has(asset.id);
    const thumbnail = asset.id.endsWith('-thumbnail');
    if (uploaded && thumbnail) cacheBytes += asset.blob?.size || 0;
    if (
      !kept.has(asset.id) ||
      (uploaded && !pending.has(asset.id) && (!thumbnail || cacheBytes > 20 * 1024 * 1024))
    )
      await store.remove('assets', asset.id);
  }
}
