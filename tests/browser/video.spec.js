import { test, expect } from '@playwright/test';
import { mock, state, connect, device } from './appdata-helpers.js';

test.use({ serviceWorkers: 'block' });
// Records a short WebM clip from an animated canvas, as a phone camera file stands in.
async function recordClip(page) {
  return Buffer.from(
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 180;
      const ctx = canvas.getContext('2d');
      const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: 'video/webm' });
      const chunks = [];
      recorder.ondataavailable = (e) => chunks.push(e.data);
      const done = new Promise((resolve) => (recorder.onstop = resolve));
      recorder.start();
      for (let frame = 0; frame < 24; frame++) {
        ctx.fillStyle = `hsl(${frame * 15} 70% 50%)`;
        ctx.fillRect(0, 0, 320, 180);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(160, 0, 160, 180);
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      recorder.stop();
      await done;
      return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()));
    }),
  );
}

test('videos attach with a frame preview, play in their own viewer and count on cards', async ({
  page,
}, info) => {
  await page.route('https://accounts.google.com/**', (r) => r.abort());
  await page.goto('/');
  await expect(page.locator('#quick-entry')).toBeEnabled();
  // Linux WebKit has no MediaRecorder to make a playable clip; the iPhone is checked by hand.
  test.skip(!(await page.evaluate(() => 'MediaRecorder' in window)), 'no MediaRecorder');
  const clip = await recordClip(page);
  await page.locator('#quick-entry').click();
  // Attaching while the editor is still opening is ignored, so wait until it is ready.
  await expect(page.locator('#entry-title')).toBeFocused();
  await page.locator('#entry-title').fill('움직이는 하루');
  await page
    .locator('#photo-input')
    .setInputFiles({ name: 'clip.webm', mimeType: 'video/webm', buffer: clip });
  await expect(page.locator('.video-preview img')).toBeVisible();
  await expect(page.locator('.video-preview')).toHaveAttribute('aria-label', '동영상 재생');
  // The preview is a real frame (coloured left half), not the dark play-mark placeholder.
  const corner = await page.locator('.video-preview img').evaluate(async (img) => {
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return [...ctx.getImageData(10, 10, 1, 1).data.slice(0, 3)];
  });
  expect(corner).not.toEqual([43, 51, 45]);
  expect(Math.max(...corner) - Math.min(...corner)).toBeGreaterThan(40);
  await page.locator('#save').click();
  await expect(page.locator('#editor-dialog')).not.toBeVisible();
  await expect(page.locator('.record [aria-label="동영상 1개"]')).toBeVisible();
  await page.locator('.record').click();
  await page.locator('.video-preview').click();
  const video = page.locator('#video-dialog video');
  await expect(video).toBeVisible();
  await expect.poll(() => video.evaluate((el) => el.readyState)).toBeGreaterThanOrEqual(1);
  await expect(page.locator('#video-dialog .photo-download')).toBeVisible();
  await page.screenshot({ path: `artifacts/video-viewer-${info.project.name}.png` });
  // Arrow keys belong to the player while it is open.
  await page.keyboard.press('ArrowRight');
  await page.locator('[data-video-action="close"]').click();
  await expect(page.locator('#video-dialog')).not.toBeVisible();
  await expect(page.locator('#reading-title')).toHaveText('움직이는 하루');
  await expect(video).not.toHaveAttribute('src');
});

test('a video this browser cannot decode keeps a placeholder and stays downloadable', async ({
  page,
}) => {
  await page.route('https://accounts.google.com/**', (r) => r.abort());
  await page.goto('/');
  await expect(page.locator('#quick-entry')).toBeEnabled();
  await page.locator('#quick-entry').click();
  // Attaching while the editor is still opening is ignored, so wait until it is ready.
  await expect(page.locator('#entry-title')).toBeFocused();
  await page.locator('#photo-input').setInputFiles({
    name: 'IMG_0001.MOV',
    mimeType: 'video/quicktime',
    buffer: Buffer.alloc(4096, 7),
  });
  await expect(page.locator('.video-preview img')).toBeVisible({ timeout: 20000 });
  await page.locator('.video-preview').click();
  await expect(page.locator('#video-dialog .photo-status')).toContainText('재생할 수 없는 형식');
  await expect(page.locator('#video-dialog .photo-download')).toBeVisible();
});

test('unsupported attachment types are refused with a message', async ({ page }) => {
  await page.route('https://accounts.google.com/**', (r) => r.abort());
  await page.goto('/');
  await expect(page.locator('#quick-entry')).toBeEnabled();
  await page.locator('#quick-entry').click();
  // Attaching while the editor is still opening is ignored, so wait until it is ready.
  await expect(page.locator('#entry-title')).toBeFocused();
  await page
    .locator('#photo-input')
    .setInputFiles({ name: 'clip.avi', mimeType: 'video/x-msvideo', buffer: Buffer.alloc(10) });
  await expect(page.locator('#toast')).toContainText('MP4, WebM, MOV');
  await expect(page.locator('#photos figure')).toHaveCount(0);
});

test('private storage uploads videos with a resumable upload and downloads them on open', async ({
  browser,
}, testInfo) => {
  const data = state();
  const context = await browser.newContext(device(testInfo));
  try {
    await mock(context, data);
    const page = await context.newPage();
    await connect(page, true);
    // Any bytes do: the upload path does not decode the video, and chunking is unit tested.
    const clip = Buffer.alloc(300 * 1024, 7);
    await page.locator('#quick-entry').click();
    // Attaching while the editor is still opening is ignored, so wait until it is ready.
    await expect(page.locator('#entry-title')).toBeFocused();
    await page.locator('#entry-title').fill('클라우드 동영상');
    await page
      .locator('#photo-input')
      .setInputFiles({ name: 'clip.mp4', mimeType: 'video/mp4', buffer: clip });
    await expect(page.locator('.video-preview img')).toBeVisible();
    await page.locator('#save').click();
    await expect(page.locator('#editor-dialog')).not.toBeVisible();
    await expect(page.locator('#connection')).toHaveText('클라우드 연결됨');
    const assets = [...data.files.values()].filter((f) => f.appProperties.kind === 'asset');
    expect(assets).toHaveLength(2);
    const original = assets.find((f) => f.mimeType === 'video/mp4');
    expect(original.bytes.equals(clip)).toBe(true);
    expect(data.calls.filter((c) => c.startsWith('PUT /upload'))).toHaveLength(1);
    // The local original is released after upload; opening the video downloads it again.
    const cached = await page.evaluate(async () => {
      const store = await import('/src/storage.js');
      const settings = JSON.parse(localStorage.getItem('my-diary-sheets-settings'));
      await store.openStore(`sheets-owner-${settings.sheets.owner}`);
      return (await store.all('assets')).map((a) => a.id);
    });
    expect(cached.every((id) => id.endsWith('-thumbnail'))).toBe(true);
    await page.locator('.record').click();
    const download = data.calls.length;
    await page.locator('.video-preview').click();
    // The original comes back from Drive; these bytes are not playable, so it is offered as a file.
    await expect(page.locator('#video-dialog .photo-download')).toBeVisible();
    await expect(page.locator('#video-dialog .photo-status')).toContainText('재생할 수 없는 형식');
    expect(data.calls.slice(download)).toContain(`GET /drive/v3/files/${original.id}`);
  } finally {
    await context.close();
  }
});
