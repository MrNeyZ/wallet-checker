const { test, expect } = require('@playwright/test');

test('burner basic flow', async ({ page }) => {
  page.on('console', msg => console.log('[console]', msg.type(), msg.text()));
  page.on('pageerror', err => console.log('[pageerror]', err.message));

  await page.goto('https://wallet.victorylabs.app/login', {
    waitUntil: 'domcontentloaded',
  });

  const passInput = page.getByPlaceholder(/enter passphrase/i);
  await expect(passInput).toBeVisible({ timeout: 10000 });
  await passInput.fill('beta');

  await page.keyboard.press('Enter');

  await page.waitForURL(/\/(groups|burner)/, { timeout: 15000 }).catch(() => {});

  await page.goto('https://wallet.victorylabs.app/burner', {
    waitUntil: 'domcontentloaded',
  });

  await expect(page.getByText('Solana Burner')).toBeVisible({ timeout: 15000 });

  console.log('Burner page loaded');
});
