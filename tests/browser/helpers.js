import { expect } from '@playwright/test';

export async function edit(page) {
  await expect(page.locator('#entry-date')).toBeEnabled();
  if (await page.locator('#edit-entry').isVisible()) await page.locator('#edit-entry').click();
  await expect(page.locator('#editor-fields')).toBeVisible();
}
