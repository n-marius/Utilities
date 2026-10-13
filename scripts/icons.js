// Erzeugt die App-Icons (SVG-Quelle -> PNG via Chromium). Aufruf: node scripts/icons.js
const fs = require('fs');
const path = require('path');

function iconSVG({ rounded = true, scale = 1 } = {}) {
  const s = scale, cx = 256, cy = 256;
  const t = (v, c) => c + (v - c) * s; // um Mittelpunkt skalieren
  const rx = t(85, cx), ry = t(125, cy), rw = 342 * s, rhh = 262 * s;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <radialGradient id="bg" cx="0.28" cy="0.16" r="1.05">
      <stop offset="0" stop-color="#3468c6"/>
      <stop offset="0.45" stop-color="#1c4ba3"/>
      <stop offset="1" stop-color="#0b2a69"/>
    </radialGradient>
    <linearGradient id="needle" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#dfe4f3"/><stop offset="1" stop-color="#c9d2ea"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" ${rounded ? 'rx="112"' : ''} fill="url(#bg)"/>
  <circle cx="${cx}" cy="${cy}" r="${150 * s}" fill="none" stroke="#f4f5fb" stroke-width="${15 * s}"/>
  <g stroke="#f4f5fb" stroke-width="${7 * s}" stroke-linecap="round" stroke-opacity=".55">
    <line x1="${cx}" y1="${t(122, cy)}" x2="${cx}" y2="${t(140, cy)}"/>
    <line x1="${cx}" y1="${t(372, cy)}" x2="${cx}" y2="${t(390, cy)}"/>
    <line x1="${t(122, cx)}" y1="${cy}" x2="${t(140, cx)}" y2="${cy}"/>
    <line x1="${t(372, cx)}" y1="${cy}" x2="${t(390, cx)}" y2="${cy}"/>
  </g>
  <line x1="${t(140, cx)}" y1="${t(214, cy)}" x2="${t(372, cx)}" y2="${t(214, cy)}" stroke="#f4f5fb" stroke-opacity=".45" stroke-width="${10 * s}" stroke-linecap="round"/>
  <path d="M${cx} ${t(160, cy)} L${t(300, cx)} ${cy} L${cx} ${cy} Z" fill="#c62a22"/>
  <path d="M${cx} ${t(160, cy)} L${t(212, cx)} ${cy} L${cx} ${cy} Z" fill="#e8463a"/>
  <path d="M${t(212, cx)} ${cy} L${t(300, cx)} ${cy} L${cx} ${t(352, cy)} Z" fill="#f4f5fb" fill-opacity=".42"/>
  <circle cx="${cx}" cy="${cy}" r="${9 * s}" fill="#1c4ba3" stroke="#f4f5fb" stroke-width="${5 * s}"/>
</svg>`;
}

const out = path.join(__dirname, '..', 'icons');
fs.writeFileSync(path.join(out, 'icon.svg'), iconSVG());

(async () => {
  const { chromium } = require(process.env.PW || 'playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const jobs = [
    ['icon-512.png', 512, iconSVG({ rounded: false })],
    ['icon-192.png', 192, iconSVG({ rounded: false })],
    ['apple-touch-icon.png', 180, iconSVG({ rounded: false })],
    ['maskable-512.png', 512, iconSVG({ rounded: false, scale: 0.74 })],
    [process.env.PREVIEW || '/tmp/claude-0/icon-preview.png', 512, iconSVG()],
  ];
  for (const [name, size, svg] of jobs) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('width="512" height="512"', `width="${size}" height="${size}"`)}</body></html>`);
    await page.screenshot({ path: path.resolve(out, name), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  }
  await browser.close();
})();
