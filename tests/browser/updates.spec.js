import { test, expect } from '@playwright/test';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';

test.use({ serviceWorkers: 'allow' });
// A real HTTP origin and real workers: route mocks cannot intercept SW downloads.
async function fixture() {
  const bundle = await build({
    entryPoints: ['src/journal/app.js'],
    bundle: true,
    format: 'esm',
    write: false,
  });
  let version = 'test-v1';
  const root = process.cwd();
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      res.setHeader('Cache-Control', 'no-store');
      if (pathname === '/vendor/journal-app.js') {
        res.setHeader('Content-Type', 'text/javascript');
        return res.end(bundle.outputFiles[0].contents);
      }
      if (pathname === '/version.json') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ version }));
      }
      if (pathname === '/config.json') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ googleClientId: '', authServer: false }));
      }
      const file =
        pathname === '/'
          ? '/index.html'
          : pathname === '/vendor/fflate.js'
            ? '/node_modules/fflate/esm/browser.js'
            : pathname;
      const target = path.resolve(root, '.' + file);
      if (!target.startsWith(root + path.sep)) throw new Error('path');
      let body = await readFile(target);
      if (file === '/index.html')
        body = Buffer.from(body.toString().replace('__DIARY_BUILD__', version));
      if (file === '/sw.js')
        body = Buffer.from(
          body.toString().replace('my-diary-shell-v1', `my-diary-shell-${version}`),
        );
      res.setHeader(
        'Content-Type',
        {
          '.js': 'text/javascript',
          '.html': 'text/html',
          '.css': 'text/css',
          '.json': 'application/json',
          '.svg': 'image/svg+xml',
          '.png': 'image/png',
          '.webmanifest': 'application/manifest+json',
        }[path.extname(file)] || 'application/octet-stream',
      );
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    deploy(value) {
      version = value;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
async function settings(page) {
  await page
    .locator(
      (await page.locator('#open-settings').isVisible()) ? '#open-settings' : '#mobile-settings',
    )
    .click();
}

test('installed app checks updates on resume and preserves unsaved text before applying', async ({
  page,
}, info) => {
  const site = await fixture();
  try {
    await page.route('https://accounts.google.com/**', (r) => r.abort());
    await page.goto(site.url);
    await expect(page.locator('#quick-entry')).toBeEnabled();
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    await expect(page.locator('#update-status')).toHaveText('최신 버전입니다.');
    await settings(page);
    await expect(page.locator('#app-version')).toHaveText('test-v1');
    await page.locator('#close-settings').click();
    await page.locator('#quick-entry').click();
    await page.locator('#entry-title').fill('업데이트 전 작성 중');
    await page.locator('#entry-body').fill('아직 저장을 누르지 않은 내용');
    site.deploy('test-v2');
    // Resume after the one-minute automatic check throttle.
    await page.evaluate(() => {
      const now = Date.now;
      Date.now = () => now() + 61000;
      window.dispatchEvent(new Event('pageshow'));
    });
    await expect(page.locator('#editor-dialog [data-apply-update]')).toBeVisible({
      timeout: 25000,
    });
    await page.screenshot({ path: `artifacts/update-editor-${info.project.name}.png` });
    // A local storage failure must leave the editor intact and prevent navigation.
    await page.evaluate(() => {
      window.originalTransaction = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (names, mode, ...rest) {
        if (mode === 'readwrite') throw new Error('기기 저장 공간 부족');
        return window.originalTransaction.call(this, names, mode, ...rest);
      };
    });
    await page.locator('#editor-dialog [data-apply-update]').click();
    await expect(page.locator('#toast')).toContainText('업데이트를 적용하지 않았습니다');
    await expect(page.locator('#entry-body')).toHaveValue('아직 저장을 누르지 않은 내용');
    await expect(page.locator('#app-version')).toHaveText('test-v1');
    await page.evaluate(() => {
      IDBDatabase.prototype.transaction = window.originalTransaction;
    });
    await page.locator('#editor-dialog [data-apply-update]').click();
    await expect(page.locator('#quick-entry')).toBeEnabled();
    await expect(page.locator('.record')).toContainText('업데이트 전 작성 중');
    await settings(page);
    await expect(page.locator('#app-version')).toHaveText('test-v2');
    await expect(page.locator('#update-banner')).not.toBeVisible();
    await page.locator('#check-update').click();
    await expect(page.locator('#update-status')).toHaveText('최신 버전입니다.');
    await page.locator('#close-settings').click();
    await page.locator('.record').click();
    await expect(page.locator('#reading-body')).toContainText('아직 저장을 누르지 않은 내용');
  } finally {
    await page.goto('about:blank');
    await site.close();
  }
});

test('manual update discovers a new build and offline checks keep the current app usable', async ({
  page,
  context,
  browserName,
}, info) => {
  const site = await fixture();
  try {
    await page.route('https://accounts.google.com/**', (r) => r.abort());
    await page.goto(site.url);
    await expect(page.locator('#update-status')).toHaveText('최신 버전입니다.');
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    site.deploy('test-v2');
    await settings(page);
    await page.locator('#check-update').click();
    await expect(page.locator('#apply-update')).toBeVisible({ timeout: 25000 });
    await page.locator('#close-settings').click();
    await expect(page.locator('#update-banner')).toBeVisible();
    await page.screenshot({ path: `artifacts/update-banner-${info.project.name}.png` });
    if (browserName === 'chromium') {
      await context.setOffline(true);
      await settings(page);
      await page.locator('#check-update').click();
      await expect(page.locator('#update-status')).toContainText('인터넷 연결');
      await context.setOffline(false);
    }
  } finally {
    await page.goto('about:blank');
    await site.close();
  }
});
