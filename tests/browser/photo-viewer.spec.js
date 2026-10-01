import { test, expect } from '@playwright/test';

test.use({ serviceWorkers: 'block' });
async function open(page) {
  await page.route('https://accounts.google.com/**', (r) => r.abort());
  await page.goto('/');
  await expect(page.locator('#quick-entry')).toBeEnabled();
  await page.locator('#quick-entry').click();
  // Attaching while the editor is still opening is ignored, so wait until it is ready.
  await expect(page.locator('#entry-title')).toBeFocused();
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 2400;
    canvas.height = 1600;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#516d82';
    ctx.fillRect(0, 0, 2400, 1600);
    ctx.fillStyle = '#edc689';
    ctx.fillRect(400, 300, 900, 600);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  await page
    .locator('#photo-input')
    .setInputFiles({ name: 'landscape.png', mimeType: 'image/png', buffer: Buffer.from(bytes) });
  await page.locator('[data-open-photo]').click();
  await expect(page.locator('#photo-dialog .original-photo')).toBeVisible();
}
const action = (page, name) => page.locator(`[data-photo-action="${name}"]`);
const transform = (page) =>
  page.locator('#photo-dialog img').evaluate((img) => {
    const matrix = new DOMMatrix(getComputedStyle(img).transform);
    return { scale: matrix.a, x: matrix.e, y: matrix.f };
  });

test('photo viewer fits, zooms to original pixels, pans, expands and closes', async ({
  page,
}, info) => {
  await open(page);
  const fit = await transform(page);
  expect(fit.scale).toBeLessThan(1);
  await action(page, 'in').click();
  expect((await transform(page)).scale).toBeGreaterThan(fit.scale);
  await action(page, 'actual').click();
  await expect(page.locator('.photo-zoom')).toHaveText('100%');
  await expect(action(page, 'in')).toBeDisabled();
  const stage = await page.locator('.photo-stage').boundingBox();
  const before = await transform(page);
  await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
  await page.mouse.down();
  await page.mouse.move(stage.x + stage.width / 2 + 70, stage.y + stage.height / 2 + 40, {
    steps: 5,
  });
  await page.mouse.up();
  const after = await transform(page);
  expect(after.x).toBeGreaterThan(before.x + 50);
  expect(after.y).toBeGreaterThan(before.y + 20);
  await action(page, 'out').click();
  expect((await transform(page)).scale).toBeLessThan(1);
  await action(page, 'fit').click();
  await expect(action(page, 'out')).toBeDisabled();
  if (await action(page, 'expand').isVisible()) {
    const before = await page.locator('#photo-dialog').boundingBox();
    await action(page, 'expand').click();
    await expect
      .poll(async () => (await page.locator('#photo-dialog').boundingBox()).width)
      .toBeGreaterThan(before.width);
    await action(page, 'expand').click();
  }
  await page.screenshot({ path: `artifacts/photo-viewer-${info.project.name}.png` });
  await action(page, 'close').click();
  await expect(page.locator('#photo-dialog')).not.toBeVisible();
  await expect(page.locator('#editor-dialog')).toBeVisible();
  await page.locator('[data-open-photo]').click();
  await expect(page.locator('#photo-dialog img')).toBeVisible();
  await expect(action(page, 'out')).toBeDisabled();
});

test('photo viewer fullscreen exits cleanly and unsupported fullscreen fills viewport', async ({
  page,
}) => {
  await open(page);
  await action(page, 'fullscreen').click();
  await expect(action(page, 'fullscreen')).toHaveAttribute('aria-pressed', 'true');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          Boolean(document.fullscreenElement) ||
          document.querySelector('.photo-viewer').classList.contains('screen-fallback'),
      ),
    )
    .toBe(true);
  await action(page, 'fullscreen').click();
  await expect(action(page, 'fullscreen')).toHaveAttribute('aria-pressed', 'false');
  await page.locator('.photo-viewer').evaluate((frame) => {
    frame.requestFullscreen = () => Promise.reject(new Error('not supported'));
  });
  await action(page, 'fullscreen').click();
  await expect(page.locator('.photo-viewer')).toHaveClass(/screen-fallback/);
  const bounds = await page.locator('.photo-viewer').boundingBox();
  expect(Math.round(bounds.width)).toBe(page.viewportSize().width);
  expect(Math.round(bounds.height)).toBe(page.viewportSize().height);
  await action(page, 'close').click();
  await expect(page.locator('#photo-dialog')).not.toBeVisible();
  expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
});

test('photo viewer pinch zoom and two-finger pan preserve bounds and refit after rotation', async ({
  page,
}) => {
  await open(page);
  const before = await transform(page);
  await page.locator('.photo-stage').evaluate((stage) => {
    // Synthetic pointer streams exercise the same multi-touch handler in both engines.
    const capture = stage.setPointerCapture;
    stage.setPointerCapture = () => {};
    const rect = stage.getBoundingClientRect();
    const cx = rect.left + rect.width / 2,
      cy = rect.top + rect.height / 2;
    const send = (type, id, x, y) =>
      stage.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          pointerType: 'touch',
          pointerId: id,
          clientX: cx + x,
          clientY: cy + y,
        }),
      );
    send('pointerdown', 1, -30, 0);
    send('pointerdown', 2, 30, 0);
    send('pointermove', 1, -90, 0);
    send('pointermove', 2, 90, 0);
    send('pointerup', 1, -90, 0);
    send('pointerup', 2, 90, 0);
    stage.setPointerCapture = capture;
  });
  expect((await transform(page)).scale).toBeGreaterThan(before.scale * 2);
  await action(page, 'actual').click();
  const panStart = await transform(page);
  await page.locator('.photo-stage').evaluate((stage) => {
    const capture = stage.setPointerCapture;
    stage.setPointerCapture = () => {};
    const rect = stage.getBoundingClientRect();
    const send = (type, id, x, y) =>
      stage.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          pointerType: 'touch',
          pointerId: id,
          clientX: rect.left + 100 + x,
          clientY: rect.top + 100 + y,
        }),
      );
    send('pointerdown', 1, 0, 0);
    send('pointerdown', 2, 80, 0);
    send('pointermove', 1, 0, 50);
    send('pointermove', 2, 80, 50);
    send('pointercancel', 1, 0, 50);
    send('pointercancel', 2, 80, 50);
    stage.setPointerCapture = capture;
  });
  expect((await transform(page)).y).toBeGreaterThan(panStart.y + 20);
  await action(page, 'fit').click();
  await page.setViewportSize({ width: 844, height: 390 });
  await expect
    .poll(async () => {
      const stage = await page.locator('.photo-stage').boundingBox();
      return Math.abs(
        (await transform(page)).scale - Math.min(1, stage.width / 2400, stage.height / 1600),
      );
    })
    .toBeLessThan(0.001);
});

test('arrow keys pan the open photo instead of turning to another diary', async ({ page }) => {
  await open(page);
  await action(page, 'close').click();
  await page.locator('#entry-title').fill('사진 있는 날');
  await page.locator('#save').click();
  await expect(page.locator('#editor-dialog')).not.toBeVisible();
  await page.evaluate(async () => {
    const model = await import('/src/model.js'),
      store = await import('/src/storage.js');
    await store.openStore('sheets-local');
    await store.put(
      'revisions',
      model.makeRevision({ ...model.newEntry('2000-01-01'), title: '오래전 하루' }),
    );
  });
  await page.reload();
  await expect(page.locator('.record')).toHaveCount(2);
  await page.locator('.record').first().click();
  await expect(page.locator('#next-entry')).toBeEnabled();
  await page.locator('[data-open-photo]').click();
  await expect(page.locator('#photo-dialog .original-photo')).toBeVisible();
  await action(page, 'actual').click();
  await page.locator('.photo-stage').focus();
  await page.keyboard.press('ArrowRight');
  await action(page, 'close').click();
  await expect(page.locator('#reading-title')).toHaveText('사진 있는 날');
});

// A JPEG with an EXIF orientation tag, as phones save portrait photos.
async function cameraJPEG(page, width, height, orientation = 1) {
  const bytes = await page.evaluate(
    async ([width, height]) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      for (let x = 0; x < width; x += 50)
        for (let y = 0; y < height; y += 50) {
          ctx.fillStyle = `hsl(${(x * 7 + y * 3) % 360} 60% 50%)`;
          ctx.fillRect(x, y, 50, 50);
        }
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 1));
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    },
    [width, height],
  );
  const tiff = [0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1];
  const exif = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff, 0, orientation, 0, 0, 0, 0, 0, 0];
  const app1 = [0xff, 0xe1, (exif.length + 2) >> 8, (exif.length + 2) & 255, ...exif];
  return Buffer.from([...bytes.slice(0, 2), ...app1, ...bytes.slice(2)]);
}
const storedPhoto = (page) =>
  page.evaluate(async () => {
    const store = await import('/src/storage.js');
    await store.openStore('sheets-local');
    const asset = (await store.all('assets')).find((a) => !a.id.endsWith('-thumbnail'));
    const bitmap = await createImageBitmap(asset.blob);
    return {
      type: asset.type,
      blobType: asset.blob.type,
      size: asset.blob.size,
      width: bitmap.width,
      height: bitmap.height,
      bytes: Array.from(new Uint8Array(await asset.blob.arrayBuffer()).slice(0, 64)),
    };
  });

test('camera photos are stored at 2048px upright, unless the original setting is chosen', async ({
  page,
}) => {
  await page.route('https://accounts.google.com/**', (r) => r.abort());
  await page.goto('/');
  await expect(page.locator('#quick-entry')).toBeEnabled();
  // Orientation 6: stored landscape, shown portrait.
  const photo = await cameraJPEG(page, 3000, 1000, 6);
  await page.locator('#quick-entry').click();
  // Attaching while the editor is still opening is ignored, so wait until it is ready.
  await expect(page.locator('#entry-title')).toBeFocused();
  await page
    .locator('#photo-input')
    .setInputFiles({ name: 'IMG_0001.jpg', mimeType: 'image/jpeg', buffer: photo });
  await expect(page.locator('.photo-preview img')).toBeVisible();
  const optimized = await storedPhoto(page);
  expect(optimized).toMatchObject({ type: 'image/jpeg', width: 683, height: 2048 });
  expect(optimized.size).toBeLessThan(photo.length);
  await page.locator('#close-editor').click();
  await page.locator('#confirm-accept').click();
  await page.evaluate(async () => {
    const store = await import('/src/storage.js');
    await store.openStore('sheets-local');
    for (const asset of await store.all('assets')) await store.remove('assets', asset.id);
  });
  const settingsButton = (await page.locator('#open-settings').isVisible())
    ? '#open-settings'
    : '#mobile-settings';
  await page.locator(settingsButton).click();
  await expect(page.locator('#photo-quality')).toHaveValue('optimized');
  await page.locator('#photo-quality').selectOption('original');
  await page.locator('#close-settings').click();
  await page.locator('#quick-entry').click();
  // Attaching while the editor is still opening is ignored, so wait until it is ready.
  await expect(page.locator('#entry-title')).toBeFocused();
  await page
    .locator('#photo-input')
    .setInputFiles({ name: 'IMG_0002.jpg', mimeType: 'image/jpeg', buffer: photo });
  await expect(page.locator('.photo-preview img')).toBeVisible();
  const original = await storedPhoto(page);
  expect(original.size).toBe(photo.length);
  expect(original.bytes).toEqual(Array.from(photo.subarray(0, 64)));
});
