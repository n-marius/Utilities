// Offline-Grundkarte aus Natural Earth (gemeinfrei, data/basemap.json, ca. 2 MB):
// Land, Staatsgrenzen, Verwaltungsgrenzen, Seen, Flüsse, Orte, Gradnetz.
// Wird als Canvas-GridLayer UNTER den Online-Kacheln gezeichnet: Sind Kacheln vorhanden
// (online oder zwischengespeichert), verdecken sie die Grundkarte; fehlen sie, bleibt diese sichtbar.

let dataPromise = null;

function decode(flat) {
  const out = new Float64Array(flat.length);
  let x = 0, y = 0;
  for (let i = 0; i < flat.length; i += 2) {
    x += flat[i]; y += flat[i + 1];
    out[i] = x / 1000; out[i + 1] = y / 1000;
  }
  return out;
}

function bbox(parts) {
  let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
  for (const p of parts) {
    for (let i = 0; i < p.length; i += 2) {
      if (p[i] < x0) x0 = p[i];
      if (p[i] > x1) x1 = p[i];
      if (p[i + 1] < y0) y0 = p[i + 1];
      if (p[i + 1] > y1) y1 = p[i + 1];
    }
  }
  return [x0, y0, x1, y1];
}

function loadData() {
  if (!dataPromise) {
    dataPromise = fetch(new URL('../../data/basemap.json', import.meta.url))
      .then(r => { if (!r.ok) throw new Error('Grundkarte nicht ladbar'); return r.json(); })
      .then(raw => {
        const feat = (parts, extra) => { const p = parts.map(decode); return { parts: p, bb: bbox(p), ...extra }; };
        return {
          countries: raw.countries.map(([name, minLabel, lx, ly, parts]) => feat(parts, { name, minLabel, lx, ly })),
          admin1: raw.admin1.map(([minZoom, parts]) => feat(parts, { minZoom })),
          lakes: raw.lakes.map(([name, minZoom, parts]) => feat(parts, { name, minZoom })),
          rivers: raw.rivers.map(([name, minZoom, parts]) => feat(parts, { name, minZoom })),
          places: raw.places.map(([name, minZoom, x, y, pop, cap]) => ({ name, minZoom, lon: x / 1000, lat: y / 1000, pop, cap }))
        };
      })
      .catch(e => { dataPromise = null; throw e; });
  }
  return dataPromise;
}

function colors() {
  const cs = getComputedStyle(document.documentElement);
  const v = n => cs.getPropertyValue(n).trim();
  return {
    water: v('--bm-water'), land: v('--bm-land'), border: v('--bm-border'), admin: v('--bm-admin'),
    river: v('--bm-river'), text: v('--bm-text'), halo: v('--bm-halo'), grid: v('--bm-grid'),
    font: v('--font') || 'sans-serif'
  };
}

const MAXLAT = 85.0511;
const projX = (lon, scale) => (lon + 180) / 360 * scale;
function projY(lat, scale) {
  const l = Math.max(-MAXLAT, Math.min(MAXLAT, lat)) * Math.PI / 180;
  return (1 - Math.log(Math.tan(l) + 1 / Math.cos(l)) / Math.PI) / 2 * scale;
}
function unprojY(y, scale) {
  const n = Math.PI - 2 * Math.PI * y / scale;
  return Math.atan(Math.sinh(n)) * 180 / Math.PI;
}

/** Gradnetz-Abstand je Zoomstufe (Grad). */
function gridStep(z) {
  if (z <= 2) return 30;
  if (z <= 4) return 10;
  if (z <= 6) return 5;
  if (z <= 8) return 1;
  if (z <= 10) return 0.5;
  if (z <= 12) return 0.1;
  return 0.05;
}

function drawTile(canvas, coords, size, data, c) {
  const z = coords.z;
  const n = 2 ** z;
  const scale = size * n;
  const wx = ((coords.x % n) + n) % n;
  const ox = wx * size, oy = coords.y * size;
  const dpr = canvas.width / size;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Tile-Grenzen in Grad (mit Rand für Beschriftungen und Linienbreiten)
  const pad = 96;
  const lon0 = (ox - pad) / scale * 360 - 180, lon1 = (ox + size + pad) / scale * 360 - 180;
  const lat1 = unprojY(oy - pad, scale), lat0 = unprojY(oy + size + pad, scale);
  const hit = bb => !(bb[2] < lon0 || bb[0] > lon1 || bb[3] < lat0 || bb[1] > lat1);
  const X = lon => projX(lon, scale) - ox;
  const Y = lat => projY(lat, scale) - oy;
  const path = (p, close) => {
    ctx.moveTo(X(p[0]), Y(p[1]));
    for (let i = 2; i < p.length; i += 2) ctx.lineTo(X(p[i]), Y(p[i + 1]));
    if (close) ctx.closePath();
  };

  ctx.fillStyle = c.water;
  ctx.fillRect(0, 0, size, size);

  // Land
  ctx.beginPath();
  for (const f of data.countries) if (hit(f.bb)) for (const p of f.parts) path(p, true);
  ctx.fillStyle = c.land;
  ctx.fill('evenodd');

  // Seen
  ctx.beginPath();
  for (const f of data.lakes) if (f.minZoom <= z + 2 && hit(f.bb)) for (const p of f.parts) path(p, true);
  ctx.fillStyle = c.water;
  ctx.fill('evenodd');

  // Flüsse
  ctx.beginPath();
  for (const f of data.rivers) if (f.minZoom <= z + 2 && hit(f.bb)) for (const p of f.parts) path(p, false);
  ctx.strokeStyle = c.river;
  ctx.lineWidth = z < 6 ? 0.6 : 1.1;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Gradnetz
  const step = gridStep(z);
  ctx.beginPath();
  for (let lon = Math.ceil(lon0 / step) * step; lon <= lon1; lon += step) {
    const x = Math.round(X(lon)) + 0.5;
    ctx.moveTo(x, 0); ctx.lineTo(x, size);
  }
  for (let lat = Math.ceil(lat0 / step) * step; lat <= lat1; lat += step) {
    const y = Math.round(Y(lat)) + 0.5;
    ctx.moveTo(0, y); ctx.lineTo(size, y);
  }
  ctx.strokeStyle = c.grid;
  ctx.lineWidth = 1;
  ctx.stroke();

  // Verwaltungsgrenzen (Bundesländer, Provinzen)
  if (z >= 4) {
    ctx.beginPath();
    for (const f of data.admin1) if (f.minZoom <= z + 1 && hit(f.bb)) for (const p of f.parts) path(p, false);
    ctx.strokeStyle = c.admin;
    ctx.lineWidth = 0.8;
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Staatsgrenzen und Küsten
  ctx.beginPath();
  for (const f of data.countries) if (hit(f.bb)) for (const p of f.parts) path(p, true);
  ctx.strokeStyle = c.border;
  ctx.lineWidth = z < 4 ? 0.6 : 1;
  ctx.stroke();

  // Beschriftungen (je Zoomstufe global ohne Überlappung vorausgewählt, damit sie über Kachelgrenzen passen)
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  for (const l of labelsFor(data, z, size, c.font)) {
    const x = l.x - ox, y = l.y - oy;
    if (x < -260 || x > size + 260 || y < -20 || y > size + 20) continue;
    if (l.dot) {
      ctx.beginPath();
      ctx.arc(x, y, l.cap ? 2.6 : 2, 0, Math.PI * 2);
      ctx.fillStyle = c.text;
      ctx.fill();
    }
    ctx.font = l.font;
    ctx.textAlign = l.align;
    ctx.strokeStyle = c.halo;
    ctx.lineWidth = 3;
    const tx = l.dot ? x + 5 : x;
    ctx.strokeText(l.text, tx, y);
    ctx.fillStyle = c.text;
    ctx.fillText(l.text, tx, y);
  }
}

const labelCache = new Map();
let measureCtx = null;

/** Beschriftungen einer Zoomstufe: nach Rang sortiert, gierig ohne Überlappung platziert. */
function labelsFor(data, z, size, fontFamily) {
  const key = z + '|' + fontFamily;
  if (labelCache.has(key)) return labelCache.get(key);
  measureCtx = measureCtx || document.createElement('canvas').getContext('2d');
  const scale = size * 2 ** z;
  const cand = [];
  for (const f of data.countries) {
    if (!f.name || f.minLabel > z + 1.5) continue;
    cand.push({ rank: f.minLabel - 10, text: f.name.toUpperCase(), lon: f.lx, lat: f.ly, dot: false,
      font: `600 ${z < 4 ? 9 : 11}px ${fontFamily}`, align: 'center' });
  }
  for (const p of data.places) {
    if (p.minZoom > z + 0.5) continue;
    const big = p.pop > 1e6 || p.cap;
    cand.push({ rank: p.minZoom - (p.cap ? 2 : 0) - Math.log10(p.pop + 10) / 10, text: p.name, lon: p.lon, lat: p.lat, dot: true, cap: !!p.cap,
      font: `${big ? 600 : 500} ${big ? 11.5 : 10.5}px ${fontFamily}`, align: 'left' });
  }
  cand.sort((a, b) => a.rank - b.rank);
  const cell = 64, grid = new Map(), placed = [];
  const cellsOf = (x0, y0, x1, y1) => {
    const out = [];
    for (let i = Math.floor(x0 / cell); i <= Math.floor(x1 / cell); i++)
      for (let j = Math.floor(y0 / cell); j <= Math.floor(y1 / cell); j++) out.push(i + ',' + j);
    return out;
  };
  for (const c of cand) {
    const x = projX(c.lon, scale), y = projY(c.lat, scale);
    measureCtx.font = c.font;
    const w = measureCtx.measureText(c.text).width;
    const m = 4;
    const box = c.dot ? [x - 4 - m, y - 8 - m, x + 5 + w + m, y + 8 + m] : [x - w / 2 - m, y - 8 - m, x + w / 2 + m, y + 8 + m];
    const keys = cellsOf(...box);
    let free = true;
    outer: for (const k of keys) {
      for (const o of grid.get(k) || []) {
        if (!(box[2] < o[0] || box[0] > o[2] || box[3] < o[1] || box[1] > o[3])) { free = false; break outer; }
      }
    }
    if (!free) continue;
    for (const k of keys) { if (!grid.has(k)) grid.set(k, []); grid.get(k).push(box); }
    placed.push({ ...c, x, y });
  }
  labelCache.set(key, placed);
  return placed;
}

/** Leaflet-Ebene mit der Offline-Grundkarte. Benötigt eine Pane 'basemap'. */
export function offlineBaseLayer() {
  const L = window.L;
  const Layer = L.GridLayer.extend({
    createTile(coords, done) {
      const size = this.getTileSize().x;
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size * dpr;
      canvas.style.width = canvas.style.height = size + 'px';
      loadData()
        .then(data => { drawTile(canvas, coords, size, data, colors()); done(null, canvas); })
        .catch(err => done(err, canvas));
      return canvas;
    }
  });
  const layer = new Layer({ pane: 'basemap', maxZoom: 19, maxNativeZoom: 19, keepBuffer: 1, updateWhenIdle: true });
  const mq = matchMedia('(prefers-color-scheme: dark)');
  const onTheme = () => layer.redraw();
  layer.on('add', () => mq.addEventListener('change', onTheme));
  layer.on('remove', () => mq.removeEventListener('change', onTheme));
  return layer;
}
