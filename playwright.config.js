/** @type {import('@playwright/test').PlaywrightTestConfig} */
const config = {
  testDir: './e2e',
  use: {
    headless: true,
    browserName: 'chromium',
    launchOptions: {
      executablePath: '/root/.cache/ms-playwright/chromium-1179/chrome-linux/chrome'
    }
  }
};
module.exports = config;
