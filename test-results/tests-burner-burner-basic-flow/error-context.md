# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tests/burner.spec.js >> burner basic flow
- Location: tests/burner.spec.js:3:1

# Error details

```
Test timeout of 30000ms exceeded.
```

```
Error: expect(locator).toBeVisible() failed

Locator: getByText('Solana Burner')
Expected: visible
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 15000ms
  - waiting for getByText('Solana Burner')

```

# Page snapshot

```yaml
- generic [ref=e1]:
  - generic [ref=e2]:
    - banner [ref=e3]:
      - link "wallet-checker" [ref=e4] [cursor=pointer]:
        - /url: /groups
        - text: wallet-checker
      - navigation [ref=e6]:
        - link "Groups" [ref=e7] [cursor=pointer]:
          - /url: /groups
        - link "Burner" [ref=e8] [cursor=pointer]:
          - /url: /burner
        - link "Preview" [ref=e9] [cursor=pointer]:
          - /url: /preview
        - button "Logout" [ref=e11] [cursor=pointer]
    - main:
      - generic [ref=e13]:
        - img "VictoryLabs" [ref=e14]
        - generic [ref=e15]:
          - heading "Access Required" [level=1] [ref=e16]
          - paragraph [ref=e17]: Sign in with your passphrase to enter the control plane.
        - generic [ref=e19]:
          - textbox "enter passphrase" [active] [ref=e21]
          - button "Enter" [disabled] [ref=e22]: →
  - alert [ref=e24]
```

# Test source

```ts
  1  | const { test, expect } = require('@playwright/test');
  2  | 
  3  | test('burner basic flow', async ({ page }) => {
  4  |   page.on('console', msg => console.log('[console]', msg.type(), msg.text()));
  5  |   page.on('pageerror', err => console.log('[pageerror]', err.message));
  6  | 
  7  |   await page.goto('https://wallet.victorylabs.app/login', {
  8  |     waitUntil: 'domcontentloaded',
  9  |   });
  10 | 
  11 |   const passInput = page.getByPlaceholder(/enter passphrase/i);
  12 |   await expect(passInput).toBeVisible({ timeout: 10000 });
  13 |   await passInput.fill('beta');
  14 | 
  15 |   await page.keyboard.press('Enter');
  16 | 
  17 |   await page.waitForURL(/\/(groups|burner)/, { timeout: 15000 }).catch(() => {});
  18 | 
  19 |   await page.goto('https://wallet.victorylabs.app/burner', {
  20 |     waitUntil: 'domcontentloaded',
  21 |   });
  22 | 
> 23 |   await expect(page.getByText('Solana Burner')).toBeVisible({ timeout: 15000 });
     |                                                 ^ Error: expect(locator).toBeVisible() failed
  24 | 
  25 |   console.log('Burner page loaded');
  26 | });
  27 | 
```