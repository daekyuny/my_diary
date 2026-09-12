import { test, expect } from '@playwright/test';
import { edit } from './helpers.js';

test.use({ serviceWorkers: 'block' });

for (const legacy of [false, true]) {
  test(`body URLs open in a new tab and preserve plain text (${legacy ? 'legacy' : 'journal'})`, async ({
    page,
    context,
  }, info) => {
    await page.route('https://accounts.google.com/**', (route) => route.abort());
    await context.route('https://example.com/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<title>Linked page</title>' }),
    );
    await page.goto(legacy ? '/legacy.html' : '/');
    if (legacy) await edit(page);
    else {
      await expect(page.locator('#new-entry')).toBeEnabled();
      await page.locator('#quick-entry').click();
    }
    const body = [
      '오늘 찾은 주소: https://example.com/diary?q=hello&lang=ko#memo',
      '참고 (http://example.org/path). www.example.net',
      '괄호 https://example.com/wiki/Test_(example).',
      '긴 주소 https://example.com/' + 'a'.repeat(160),
      '<img src=x onerror="window.hacked=1"> javascript:alert(1) https://',
    ].join('\n');
    await page.locator('#entry-title').fill('다시 찾아볼 곳');
    await page.locator('#entry-body').fill(body);
    await page.locator('#save').click();
    if (!legacy) await expect(page.locator('#editor-dialog')).not.toBeVisible();
    await page.reload();
    if (!legacy) await page.locator('.record').click();
    const reading = page.locator(legacy ? '.preview-body' : '#reading-body');
    await expect(reading).toHaveText(body);
    const links = reading.locator('a');
    await expect(links).toHaveCount(5);
    await expect(links.nth(1)).toHaveAttribute('href', 'http://example.org/path');
    await expect(links.nth(2)).toHaveAttribute('href', 'https://www.example.net/');
    await expect(links.nth(3)).toHaveAttribute('href', 'https://example.com/wiki/Test_(example)');
    for (const link of await links.all()) {
      await expect(link).toHaveAttribute('target', '_blank');
      await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    }
    await expect(reading.locator('img, script')).toHaveCount(0);
    expect(await page.evaluate(() => window.hacked)).toBeUndefined();
    expect(await reading.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    const originalUrl = page.url();
    const opened = context.waitForEvent('page');
    await links.first().click();
    const tab = await opened;
    await expect(tab).toHaveURL('https://example.com/diary?q=hello&lang=ko#memo');
    expect(await tab.evaluate(() => window.opener)).toBeNull();
    expect(page.url()).toBe(originalUrl);
    await tab.close();
    if (!legacy) await page.screenshot({ path: `artifacts/body-links-${info.project.name}.png` });
    await page.locator('#edit-entry').click();
    await expect(page.locator('#entry-body')).toHaveValue(body);
  });
}
