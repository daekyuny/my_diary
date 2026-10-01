import * as store from '../storage.js';
import { uploadPrivateAsset } from './appdata.js';
import * as google from '../google.js';
import {
  PHOTO_LIMIT,
  CAMERA_LIMIT,
  OPTIMIZED_SIDE,
  OPTIMIZED_QUALITY,
  VIDEO_LIMIT,
  optimizes,
  fitWithin,
} from './media.js';
import { ATTACHMENT_EXTENSIONS, isVideo } from '../model.js';

// Prefer the device copy; otherwise download from Drive and keep thumbnails cached locally.
// Video originals are large, so they get a longer deadline and are never cached.
export async function assetBlob(image) {
  const asset = await store.get('assets', image.id);
  if (asset?.blob) return asset.blob;
  if (!image.driveId) throw new Error(`첨부 원본을 찾을 수 없습니다: ${image.name}`);
  const blob = await google.downloadAsset(image.driveId, isVideo(image) ? 600000 : undefined);
  if (image.storage !== 'appDataFolder' || image.id.endsWith('-thumbnail'))
    await store.put('assets', { ...image, blob, accessedAt: Date.now() });
  return blob;
}
// Decodes a photo; browsers apply its EXIF orientation, so the pixels are already upright.
// The caller revokes `url` once the frame is drawn.
async function loadImage(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return { source: image, width: image.naturalWidth, height: image.naturalHeight, url };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}
const waitFor = (target, event, ms) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    target.addEventListener(event, () => (clearTimeout(timer), resolve()), { once: true });
    target.addEventListener('error', () => (clearTimeout(timer), reject(new Error('decode'))), {
      once: true,
    });
  });
const within = (promise, ms) =>
  Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms))]);
// Resolves once a decoded frame is on screen; Safari otherwise draws a blank canvas.
const presented = (video) =>
  within(
    new Promise((resolve) =>
      video.requestVideoFrameCallback
        ? video.requestVideoFrameCallback(() => resolve())
        : resolve(),
    ),
    1000,
  );
// A frame near the start of a video (1 s in, or halfway for shorter clips). iOS Safari only
// loads and decodes a video that is in the document, so it is attached off screen, loaded
// explicitly and, if data still does not arrive, started muted inline (always allowed).
async function loadVideoFrame(blob) {
  const url = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.preload = 'auto';
  video.style.cssText =
    'position:fixed;left:-10px;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
  document.body.append(video);
  const release = () => {
    video.removeAttribute('src');
    video.load();
    video.remove();
    URL.revokeObjectURL(url);
  };
  try {
    const loaded = waitFor(video, 'loadeddata', 6000);
    video.src = url;
    video.load();
    try {
      await loaded;
    } catch (error) {
      if (error.message !== 'timeout') throw error;
      await within(
        video.play().catch(() => {}),
        3000,
      );
      await waitFor(video, 'timeupdate', 5000);
      video.pause();
    }
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const target = duration ? Math.min(1, duration / 2) : 0;
    if (Math.abs(video.currentTime - target) > 0.05) {
      const seeked = waitFor(video, 'seeked', 5000);
      video.currentTime = target;
      await seeked;
    }
    await presented(video);
    if (!video.videoWidth) throw new Error('no frame');
    return { source: video, width: video.videoWidth, height: video.videoHeight, duration, release };
  } catch (error) {
    release();
    throw error;
  }
}
// True when every sampled pixel has the same colour: the browser drew no video frame.
function blank(canvas) {
  const sample = document.createElement('canvas');
  sample.width = sample.height = 8;
  const context = sample.getContext('2d');
  context.drawImage(canvas, 0, 0, 8, 8);
  const data = context.getImageData(0, 0, 8, 8).data;
  for (let i = 4; i < data.length; i += 4)
    if (
      Math.abs(data[i] - data[0]) +
        Math.abs(data[i + 1] - data[1]) +
        Math.abs(data[i + 2] - data[2]) >
      6
    )
      return false;
  return true;
}
// Draws a decoded source into a JPEG whose longer side is at most `side` pixels.
async function drawJPEG({ source, width, height }, side, quality, check) {
  const size = fitWithin(width, height, side);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, size.width, size.height);
  context.drawImage(source, 0, 0, size.width, size.height);
  if (check?.(canvas)) return { blob: null, resized: false };
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  return { blob, resized: size.width < width };
}
// Formats this browser cannot decode (an HEVC .mov on some PCs) still get a play-mark preview.
function videoPlaceholder() {
  const canvas = document.createElement('canvas');
  canvas.width = 480;
  canvas.height = 270;
  const context = canvas.getContext('2d');
  context.fillStyle = '#2b332d';
  context.fillRect(0, 0, 480, 270);
  context.fillStyle = '#ffffff';
  context.beginPath();
  context.moveTo(212, 100);
  context.lineTo(212, 170);
  context.lineTo(272, 135);
  context.fill();
  return { source: canvas, width: 480, height: 270 };
}
async function thumbnailFrom(blob, id) {
  const video = /^video\//.test(blob.type);
  let frame,
    duration = 0,
    thumbnail;
  if (video) {
    try {
      frame = await loadVideoFrame(blob);
      duration = frame.duration;
    } catch {
      frame = videoPlaceholder();
    }
  } else frame = await loadImage(blob);
  try {
    ({ blob: thumbnail } = await drawJPEG(
      frame,
      480,
      0.78,
      video && frame.release ? blank : undefined,
    ));
  } finally {
    if (frame.release) frame.release();
    else if (frame.url) URL.revokeObjectURL(frame.url);
  }
  // A video frame that came out as one flat colour gets the play-mark preview instead.
  if (!thumbnail && video) ({ blob: thumbnail } = await drawJPEG(videoPlaceholder(), 480, 0.78));
  if (!thumbnail) throw new Error('미리보기를 만들지 못했습니다.');
  const result = { id: `${id}-thumbnail`, name: `${id}-thumbnail.jpg`, type: 'image/jpeg' };
  await store.put('assets', { ...result, blob: thumbnail });
  return { thumbnail: result, duration };
}
export async function makeThumbnail(blob, id) {
  return (await thumbnailFrom(blob, id)).thumbnail;
}
// Re-encodes camera photos to 2048px JPEG; keeps the original when that would not save bytes.
async function optimizedPhoto(file) {
  const frame = await loadImage(file);
  try {
    const { blob, resized } = await drawJPEG(frame, OPTIMIZED_SIDE, OPTIMIZED_QUALITY);
    if (!blob || (!resized && blob.size >= file.size)) return file;
    return blob;
  } finally {
    URL.revokeObjectURL(frame.url);
  }
}
async function createPhoto(file, mode) {
  const optimize = optimizes(file.type, mode);
  if (file.size > (optimize ? CAMERA_LIMIT : PHOTO_LIMIT))
    throw new Error(
      optimize
        ? '사진은 40MB 이하만 첨부할 수 있습니다.'
        : '사진은 10MB 이하만 첨부할 수 있습니다.',
    );
  const blob = optimize ? await optimizedPhoto(file) : file;
  if (blob.size > PHOTO_LIMIT)
    throw new Error('최적화한 사진이 10MB를 넘습니다. 원본 크기를 줄여 다시 첨부해주세요.');
  return storeAttachment(blob, blob.type || file.type);
}
async function storeAttachment(blob, type) {
  const id = crypto.randomUUID();
  const item = {
    id,
    name: `${id}-original.${ATTACHMENT_EXTENSIONS[type]}`,
    type,
    managedName: true,
  };
  const { thumbnail, duration } = await thumbnailFrom(blob, id);
  item.thumbnail = thumbnail;
  if (duration) item.duration = Math.round(duration);
  await store.put('assets', { ...item, blob });
  return item;
}
// Photos (JPG, PNG, WebP, GIF) and videos (MP4, WebM, MOV) share one attachment list.
export async function createAttachment(file, mode = 'optimized') {
  if (!ATTACHMENT_EXTENSIONS[file.type])
    throw new Error(
      '사진은 JPG, PNG, WebP, GIF, 동영상은 MP4, WebM, MOV 형식만 첨부할 수 있습니다.',
    );
  if (!isVideo(file)) return createPhoto(file, mode);
  if (file.size > VIDEO_LIMIT) throw new Error('동영상은 200MB 이하만 첨부할 수 있습니다.');
  return storeAttachment(file, file.type);
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
