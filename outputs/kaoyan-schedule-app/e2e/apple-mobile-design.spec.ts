import { expect, test } from '@playwright/test';

const IPHONE_USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';

test('Apple mobile hub is touch-safe, focused and free of horizontal overflow', async ({ browser, baseURL }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: IPHONE_USER_AGENT,
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  await page.goto(`${baseURL}/?hub=1`);
  await expect(page.locator('html')).toHaveClass(/apple-mobile-web/);
  await expect(page.getByRole('heading', { name: '把今天做好' })).toBeVisible();
  await expect(page.locator('.web-app-mobile-nav')).toBeVisible();
  await expect(page.locator('.command-launcher')).toBeHidden();

  const layout = await page.evaluate(() => ({
    viewport: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
    navButtons: [...document.querySelectorAll<HTMLElement>('.web-app-mobile-nav button')].map((button) => {
      const rect = button.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    }),
  }));
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewport);
  expect(layout.bodyWidth).toBeLessThanOrEqual(layout.viewport);
  expect(layout.navButtons).toHaveLength(5);
  for (const button of layout.navButtons) {
    expect(button.width).toBeGreaterThanOrEqual(44);
    expect(button.height).toBeGreaterThanOrEqual(44);
  }
  await context.close();
});

test('desktop hub keeps the established desktop presentation', async ({ page }) => {
  await page.goto('/?hub=1');
  await expect(page.locator('html')).not.toHaveClass(/apple-mobile-web/);
  await expect(page.locator('.web-app-nav')).toBeVisible();
  await expect(page.locator('.hub-mobile-context')).toBeHidden();
});
