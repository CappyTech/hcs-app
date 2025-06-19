/** @type {import('@playwright/test').PlaywrightTestConfig} */
const config = {
  testDir: './e2e',
  use: {
    headless: true,
    browserName: 'chromium',
    launchOptions: {
      executablePath: '/usr/bin/chromium-browser'
    }
  }
};
module.exports = config;
