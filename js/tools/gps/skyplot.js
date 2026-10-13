// Himmelsdiagramm (Polarplot Azimut/Elevation) als SVG-Markup.
// Systeme unterscheiden sich nur über Form/Füllung, Farbe kommt aus currentColor/CSS-Variablen.

const C = 150, R = 128;

const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

/** Symbol eines Systems an (x, y) mit Größe s. */
export function symbol(sys, x, y, s = 5) {
  const f = 'class="gps-sym-f"', o = 'class="gps-sym-o"';
  switch (sys) {
    case 'gps': return `<circle cx="${x}" cy="${y}" r="${s}" ${f}/>`;
    case 'gal': {
      const k = s * 1.25;
      return `<path d="M${x} ${y - k}L${x + k * 0.95} ${y + k * 0.7}H${x - k * 0.95}Z" ${f}/>`;
    }
    case 'glo': {
      const k = s * 0.85;
      return `<rect x="${x - k}" y="${y - k}" width="${2 * k}" height="${2 * k}" ${o}/>`;
    }
    default: {
      const k = s * 1.2;
      return `<path d="M${x} ${y - k}L${x + k} ${y}L${x} ${y + k}L${x - k} ${y}Z" ${o}/>`;
    }
  }
}

/** Kleines Legendensymbol als eigenständiges SVG. */
export function legendIcon(sys) {
  return `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">${symbol(sys, 8, 8, 5)}</svg>`;
}

const xy = (az, el) => {
  const r = R * (90 - Math.max(0, el)) / 90, a = az * Math.PI / 180;
  return [C + r * Math.sin(a), C - r * Math.cos(a)];
};

/**
 * Diagramm-Markup. list: [{sys, label, az, el}], mask: Elevationsmaske (Grad).
 * Satelliten zwischen 0° und Maske werden blass gezeichnet.
 */
export function skyplotSVG(list, mask = 5) {
  const p = [];
  p.push(`<svg viewBox="0 0 300 300" class="gps-sky-svg" role="img" aria-label="Himmelsdiagramm der berechneten Satellitenstände">`);
  // Raster
  p.push(`<circle cx="${C}" cy="${C}" r="${R}" class="gps-grid-h"/>`);
  for (const el of [30, 60]) p.push(`<circle cx="${C}" cy="${C}" r="${R * (90 - el) / 90}" class="gps-grid"/>`);
  if (mask > 0) p.push(`<circle cx="${C}" cy="${C}" r="${R * (90 - mask) / 90}" class="gps-grid gps-grid-mask"/>`);
  for (let az = 0; az < 180; az += 30) {
    const [x1, y1] = xy(az, 0), [x2, y2] = xy(az + 180, 0);
    p.push(`<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" class="gps-grid${az % 90 ? ' gps-grid-minor' : ''}"/>`);
  }
  for (const el of [30, 60]) p.push(`<text x="${C + 3}" y="${C - R * (90 - el) / 90 - 3}" class="gps-grid-t">${el}°</text>`);
  // Himmelsrichtungen
  const dirs = [['N', 0], ['O', 90], ['S', 180], ['W', 270]];
  for (const [t, az] of dirs) {
    const a = az * Math.PI / 180, r = R + 12;
    p.push(`<text x="${(C + r * Math.sin(a)).toFixed(1)}" y="${(C - r * Math.cos(a) + 4).toFixed(1)}" text-anchor="middle" class="gps-dir">${t}</text>`);
  }
  // Satelliten (tiefe zuerst, damit hohe obenauf liegen)
  const vis = list.filter(s => s.el >= 0).sort((a, b) => a.el - b.el);
  for (const s of vis) {
    const [x, y] = xy(s.az, s.el);
    const low = s.el < mask;
    const right = x < C + R - 26;
    p.push(`<g class="gps-sat${low ? ' is-low' : ''}">${symbol(s.sys, +x.toFixed(1), +y.toFixed(1), 4.6)}` +
      `<text x="${(x + (right ? 7 : -7)).toFixed(1)}" y="${(y + 3).toFixed(1)}" text-anchor="${right ? 'start' : 'end'}" class="gps-sat-t">${esc(s.label)}</text></g>`);
  }
  p.push('</svg>');
  return p.join('');
}
