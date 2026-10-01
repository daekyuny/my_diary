// Attachment size policy. Pure functions so the rules can be unit tested.
export const PHOTO_LIMIT = 10 * 1024 * 1024;
// Phone photos are re-encoded, so a larger camera original is still accepted.
export const CAMERA_LIMIT = 40 * 1024 * 1024;
// Videos are stored as recorded; Drive app data counts against the Google account quota.
export const VIDEO_LIMIT = 200 * 1024 * 1024;
export const OPTIMIZED_SIDE = 2048;
export const OPTIMIZED_QUALITY = 0.85;

// Camera formats are optimized by default; PNG screenshots and GIF animations keep their bytes.
export function optimizes(type, mode = 'optimized') {
  return mode !== 'original' && /^image\/(jpeg|webp)$/.test(type);
}
export function fitWithin(width, height, side) {
  const scale = Math.min(1, side / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}
