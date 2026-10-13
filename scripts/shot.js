// Screenshot-Hilfe für Entwicklung. Server vorher starten: python3 -m http.server 8765
// Aufruf: node scripts/shot.js "#/gps" out.png [dark] [initScript.js]
// initScript.js (optional) wird vor jedem Seitenaufbau ausgeführt (z. B. Sensor-Mocks).
const PW = process.env.PW || '/opt/node-tools/node_modules/playwright';
const { chromium } = require(PW);
const fs = require('fs');
(async () => {
  const [hash = '', out = 'shot.png', scheme = 'light', init] = process.argv.slice(2);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    colorScheme: scheme === 'dark' ? 'dark' : 'light',
    geolocation: { latitude: 48.137, longitude: 11.575, accuracy: 12 }, permissions: ['geolocation'],
    serviceWorkers: 'block'
  });
  if (init) await ctx.addInitScript({ content: fs.readFileSync(init, 'utf8') });
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));
  await page.goto('http://localhost:8765/' + hash);
  await page.waitForTimeout(Number(process.env.WAIT || 1500));
  await page.screenshot({ path: out });
  if (logs.length) console.log(logs.join('\n'));
  await browser.close();
})();
