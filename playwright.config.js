/** @type {import('@playwright/test').PlaywrightTestConfig} */
const config = {
  testDir: './e2e',
  use: {
    headless: true,
    browserName: 'chromium'
  }
};
module.exports = config;
