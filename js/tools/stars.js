// Sternennavigation: Position aus Peilungen markanter Sterne und Planeten (Höhe + Azimut), ohne GPS.
// Messungen aller Objekte stehen in einer Tabelle und gehen gemeinsam in die Ortsbestimmung ein
// (gleichzeitige Peilungen verschiedener Objekte schneiden sich als Höhenstandlinien).

import { h, svg, seg, fmt } from '../lib/ui.js';
import { load, save } from '../lib/store.js';
import { mountFix } from './astro/fixui.js';
import { STARS, CONSTELLATIONS, PLANETS, PLANET_COLOR } from './astro/catalog.js';
import { planetInfo, visibility } from './astro/ephem.js';

const STYLE = `
.stars-pick { display: flex; flex-direction: column; gap: 10px; }
.stars-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.stars-opt { appearance: none; border: 1px solid var(--line); background: var(--surface); color: var(--text);
  border-radius: var(--radius); padding: 8px 8px 10px; display: flex; flex-direction: column; align-items: center; gap: 4px;
  min-height: 44px; text-align: center; }
.stars-opt.is-active { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft) inset; }
.stars-opt svg { width: 100%; height: 76px; }
.stars-opt .n { font-size: 14px; font-weight: 500; }
.stars-opt .t { font-size: 12px; color: var(--text-2); }
.stars-opt.is-active .t { color: var(--accent); font-weight: 600; }
.stars-opt .x { font-size: 11px; color: var(--text-2); line-height: 1.35; }
.stars-opt .x b { font-weight: 600; color: var(--text); }
.stars-opt svg.pl { height: 40px; }
.stars-cap { font-size: 12px; color: var(--text-2); padding: 0 4px; line-height: 1.4; }
.stars-nb { fill: var(--text-2); font: 500 7px var(--font); }
.stars-nb-ar { fill: none; stroke: var(--text-2); stroke-width: .8; stroke-linecap: round; stroke-linejoin: round; }
.stars-ecl { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 10px 10px 8px; }
.stars-ecl svg { width: 100%; height: auto; display: block; }
.stars-ecl .ax { stroke: var(--line-strong); stroke-width: 1; }
.stars-ecl .glare { fill: var(--accent-soft); }
.stars-ecl .sun { fill: none; stroke: var(--text-2); stroke-width: 1.2; }
.stars-ecl .pl { fill: var(--text); }
.stars-ecl .pl.sel { fill: var(--accent); }
.stars-ecl .lb { fill: var(--text); font: 500 9px var(--font); }
.stars-ecl .lb.sel { fill: var(--accent); font-weight: 600; }
.stars-ecl .ax-t { fill: var(--text-2); font: 8px var(--font); }
.stars-ecl p { margin: 6px 2px 0; font-size: 12px; color: var(--text-2); line-height: 1.4; }
.stars-line { stroke: var(--line-strong); stroke-width: .8; fill: none; }
.stars-dot { fill: var(--text-2); }
.stars-target { fill: var(--accent); }
.stars-ring { fill: none; stroke: var(--accent); stroke-width: .8; }
.stars-lbl { fill: var(--accent); font: 600 6.5px var(--font); }
.stars-pl-body { fill: var(--surface-2); stroke: var(--text-2); stroke-width: 1.2; }
.stars-pl-mark { fill: none; stroke: var(--text-2); stroke-width: 1.1; stroke-linecap: round; }
.stars-pl-fill { fill: var(--text-3); }
`;

const STAR_AIM_ICON = `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
<path d="M47 4l1.8 5.2 5.2 1.8-5.2 1.8L47 18l-1.8-5.2-5.2-1.8 5.2-1.8z"/>
<rect x="17" y="24" width="16" height="30" rx="3" transform="rotate(38 25 39)"/>
<path d="M31 30l10-12" stroke-dasharray="2 3"/></svg>`;

const SHORT = { umi: 'Kl. Wagen', uma: 'Gr. Wagen', cas: 'Kassiop.', ori: 'Orion', cru: 'Kreuz', sco: 'Skorpion', cen: 'Zentaur', car: 'Kiel' };
const HINT = {
  umi: 'Polaris am Deichselende, < 1° vom Himmelsnordpol',
  uma: '5× Abstand Merak→Dubhe führt zu Polaris',
  cas: '„W“ gegenüber dem Großen Wagen, Polaris dazwischen',
  ori: 'Gürtel zeigt nach links unten zu Sirius, rechts oben zu Aldebaran',
  cru: 'Längsachse 4,5× verlängert → Himmelssüdpol',
  sco: 'Antares rötlich, „Herz“ des Skorpions',
  cen: 'α/β Cen sind die Zeiger zum Kreuz des Südens',
  car: 'Canopus: zweithellster Stern des Himmels'
};

const D = Math.PI / 180;
const unit = (ra, dec) => [Math.cos(dec * D) * Math.cos(ra * D), Math.cos(dec * D) * Math.sin(ra * D), Math.sin(dec * D)];
/** Schwerpunktrichtung eines Sternbilds als {ra, dec}. */
function centerOf(c) {
  const m = [0, 0, 0];
  for (const k of c.stars) { const v = unit(STARS[k].ra, STARS[k].dec); m[0] += v[0]; m[1] += v[1]; m[2] += v[2]; }
  return { ra: Math.atan2(m[1], m[0]) / D, dec: Math.atan2(m[2], Math.hypot(m[0], m[1])) / D };
}
/** Positionswinkel (Nord über Ost, Grad) und Abstand von a nach b. */
function posAngle(a, b) {
  const da = (b.ra - a.ra) * D, d1 = a.dec * D, d2 = b.dec * D;
  const pa = Math.atan2(Math.sin(da), Math.cos(d1) * Math.tan(d2) - Math.sin(d1) * Math.cos(da)) / D;
  const sep = Math.acos(Math.max(-1, Math.min(1, Math.sin(d1) * Math.sin(d2) + Math.cos(d1) * Math.cos(d2) * Math.cos(da)))) / D;
  return { pa, sep };
}

/**
 * Sternbild als SVG: gnomonische Projektion um den Schwerpunkt, Himmelspol oben
 * (Nord: Norden oben, Osten links; Süd: um 180° gedreht, Süden oben). Am Rand Pfeile zu den
 * anderen Sternbildern derselben Halbkugel (Positionswinkel aus den Katalogkoordinaten).
 */
function constellationSvg(c, all, southUp) {
  const vs = c.stars.map(k => unit(STARS[k].ra, STARS[k].dec));
  const m = [0, 1, 2].map(i => vs.reduce((t, x) => t + x[i], 0));
  const n0 = Math.hypot(...m); const ctr = m.map(x => x / n0);
  const east = [-ctr[1], ctr[0], 0]; const ne = Math.hypot(...east) || 1;
  const e = east.map(x => x / ne);
  const north = [ctr[1] * e[2] - ctr[2] * e[1], ctr[2] * e[0] - ctr[0] * e[2], ctr[0] * e[1] - ctr[1] * e[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const f = southUp ? -1 : 1;
  const raw = vs.map(x => { const z = dot(x, ctr); return [-f * dot(x, e) / z, f * dot(x, north) / z]; });
  const xs = raw.map(p => p[0]), ys = raw.map(p => p[1]);
  const W = 120, H = 92, PX = 14, PY = 16;
  const sx = Math.max(...xs) - Math.min(...xs), sy = Math.max(...ys) - Math.min(...ys);
  const sc = Math.min((W - 2 * PX) / (sx || 1), (H - 2 * PY) / (sy || 1));
  const ox = (W - sx * sc) / 2 - Math.min(...xs) * sc, oy = (H - sy * sc) / 2 + Math.max(...ys) * sc;
  const pos = {};
  c.stars.forEach((k, i) => { pos[k] = [ox + raw[i][0] * sc, oy - raw[i][1] * sc]; });
  let out = `<svg viewBox="0 0 ${W} ${H}" aria-hidden="true">`;
  for (const [a, b] of c.lines) out += `<line class="stars-line" x1="${pos[a][0].toFixed(1)}" y1="${pos[a][1].toFixed(1)}" x2="${pos[b][0].toFixed(1)}" y2="${pos[b][1].toFixed(1)}"/>`;
  for (const k of c.stars) {
    const r = Math.max(1.1, Math.min(4.2, 3.4 - 0.75 * STARS[k].v));
    const [x, y] = pos[k];
    if (k === c.target) {
      out += `<circle class="stars-ring" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(r + 2.6).toFixed(1)}"/>`;
      out += `<circle class="stars-target" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}"/>`;
      const anchor = x > W * 0.62 ? 'end' : x < W * 0.38 ? 'start' : 'middle';
      const ly = y > H - 22 ? y - r - 4 : y + r + 8.5;
      out += `<text class="stars-lbl" x="${x.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${anchor}">${STARS[k].name}</text>`;
    } else {
      out += `<circle class="stars-dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}"/>`;
    }
  }
  // Nachbarn: je eine Ecke mit Pfeil exakt in Richtung des Positionswinkels, Kurzname und Abstand.
  // Ecke nach bester Richtungsübereinstimmung (gierig), damit sich nichts überlappt.
  const cc = centerOf(c);
  const corners = [
    { x: 6, y: 7, dir: [-1, -1], anchor: 'start' }, { x: W - 6, y: 7, dir: [1, -1], anchor: 'end' },
    { x: 6, y: H - 5, dir: [-1, 1], anchor: 'start' }, { x: W - 6, y: H - 5, dir: [1, 1], anchor: 'end' }
  ];
  const nbs = all.filter(o => o.id !== c.id).map(o => {
    const { pa, sep } = posAngle(cc, centerOf(o));
    return { o, sep, dx: -f * Math.sin(pa * D), dy: -f * Math.cos(pa * D) };
  });
  const pairs = [];
  nbs.forEach((n, i) => corners.forEach((k, j) => pairs.push({ i, j, s: (n.dx * k.dir[0] + n.dy * k.dir[1]) })));
  pairs.sort((a, b) => b.s - a.s);
  const usedN = new Set(), usedC = new Set();
  for (const pr of pairs) {
    if (usedN.has(pr.i) || usedC.has(pr.j)) continue;
    usedN.add(pr.i); usedC.add(pr.j);
    const n = nbs[pr.i], k = corners[pr.j];
    const ax = k.x, ay = k.y - 2;
    const ang = Math.atan2(n.dy, n.dx);
    const tip = [ax + 3 * Math.cos(ang), ay + 3 * Math.sin(ang)], tail = [ax - 3 * Math.cos(ang), ay - 3 * Math.sin(ang)];
    const hd = (da) => `${(tip[0] - 2.4 * Math.cos(ang + da)).toFixed(1)},${(tip[1] - 2.4 * Math.sin(ang + da)).toFixed(1)}`;
    out += `<path class="stars-nb-ar" d="M${tail[0].toFixed(1)},${tail[1].toFixed(1)} L${tip[0].toFixed(1)},${tip[1].toFixed(1)} M${hd(0.55)} L${tip[0].toFixed(1)},${tip[1].toFixed(1)} L${hd(-0.55)}"/>`;
    const tx = k.anchor === 'start' ? ax + 5.5 : ax - 5.5;
    out += `<text class="stars-nb" x="${tx.toFixed(1)}" y="${k.y.toFixed(1)}" text-anchor="${k.anchor}">${SHORT[n.o.id]} ${Math.round(n.sep)}°</text>`;
  }
  return out + '</svg>';
}

/** Schematische Planetensymbole. */
const PLANET_SVG = {
  venus: '<svg class="pl" viewBox="0 0 100 76" aria-hidden="true"><circle class="stars-pl-body" cx="50" cy="38" r="20"/><path class="stars-pl-mark" d="M38 30c8-4 16-4 24 0M36 42c9 4 19 4 28 0"/></svg>',
  mars: '<svg class="pl" viewBox="0 0 100 76" aria-hidden="true"><circle class="stars-pl-body" cx="50" cy="38" r="15"/><circle class="stars-pl-fill" cx="45" cy="34" r="4"/><circle class="stars-pl-fill" cx="55" cy="44" r="2.6"/></svg>',
  jupiter: '<svg class="pl" viewBox="0 0 100 76" aria-hidden="true"><circle class="stars-pl-body" cx="50" cy="38" r="24"/><path class="stars-pl-mark" d="M29 28h42M27 36h46M27 42h46M30 50h40"/><ellipse class="stars-pl-fill" cx="58" cy="46" rx="4.5" ry="2.4"/></svg>',
  saturn: '<svg class="pl" viewBox="0 0 100 76" aria-hidden="true"><ellipse class="stars-pl-mark" cx="50" cy="38" rx="36" ry="10" transform="rotate(-14 50 38)"/><circle class="stars-pl-body" cx="50" cy="38" r="16"/><path class="stars-pl-mark" d="M17 47c20-9 46-17 66-18" transform="rotate(0)"/></svg>'
};

export function mount(body, ctx) {
  if (!document.getElementById('style-stars')) document.head.append(h('style#style-stars', STYLE));
  const st = Object.assign({ mode: 'north', north: 'umi', south: 'cru', planet: 'jupiter' }, load('stars:pick', {}));

  const grid = h('div.stars-grid');
  const cap = h('div.stars-cap');
  const ecl = h('div.stars-ecl');
  let tNow = Date.now(), lastKey = '';
  const modeSeg = seg([
    { value: 'north', label: 'Nordhalbkugel' },
    { value: 'south', label: 'Südhalbkugel' },
    { value: 'planets', label: 'Planeten' }
  ], st.mode, v => { st.mode = v; save('stars:pick', st); render(); });
  const el = h('div.stars-pick', modeSeg, cap, grid, ecl);

  function render() {
    grid.textContent = '';
    ecl.textContent = '';
    ecl.hidden = st.mode !== 'planets';
    if (st.mode === 'planets') {
      cap.textContent = 'Ortsunabhängig berechnet für den Messzeitpunkt (Geräteuhr bzw. Datum/Zeit-Einstellung). Sternbild über die ekliptikale Länge genähert.';
      const info = PLANETS.map(p => ({ ...p, ...planetInfo(p.id, tNow) }));
      const rank = info.slice().sort((a, b) => a.mag - b.mag).map(p => p.id);
      for (const p of info) {
        const vis = visibility(p.elong);
        const b = h('button.stars-opt', { type: 'button', onclick: () => { st.planet = p.id; save('stars:pick', st); render(); } },
          svg(PLANET_SVG[p.id]), h('span.n', p.name),
          h('span.x', h('b', `${fmt(p.mag, 1)} mag`), ` · ${PLANET_COLOR[p.id]} · Rang ${rank.indexOf(p.id) + 1}`),
          h('span.x', `${p.zodiac}` + (p.near && p.near.sep < 20 ? ` · ${fmt(p.near.sep, 0)}° von ${p.near.name}` : '')),
          h('span.x', `${vis}` + (Math.abs(p.elong) >= 15 ? ` · ${fmt(Math.abs(p.elong), 0)}° ${p.elong > 0 ? 'östl.' : 'westl.'}` : '')));
        if (st.planet === p.id) b.classList.add('is-active');
        grid.append(b);
      }
      ecl.append(eclipticSchema(info, rank),
        h('p', 'Jupiter ist stets deutlich heller als Saturn. Helligkeit nach Mallama & Hilton (2018), Abweichung zu JPL Horizons ≤ 0,1 mag.'));
    } else {
      cap.textContent = st.mode === 'north'
        ? 'Ansicht mit Himmelsnordpol oben (Osten links). Pfeile: Richtung und Abstand zu den anderen Sternbildern.'
        : 'Ansicht mit Himmelssüdpol oben (Osten rechts). Pfeile: Richtung und Abstand zu den anderen Sternbildern.';
      const all = CONSTELLATIONS[st.mode];
      for (const c of all) {
        const b = h('button.stars-opt', { type: 'button', onclick: () => { st[st.mode] = c.id; save('stars:pick', st); render(); } },
          svg(constellationSvg(c, all, st.mode === 'south')), h('span.n', c.name), h('span.t', STARS[c.target].name), h('span.x', HINT[c.id]));
        if (st[st.mode] === c.id) b.classList.add('is-active');
        grid.append(b);
      }
    }
  }

  /** Ekliptikband: Sonne in der Mitte, Planeten nach Elongation (links östlich = Abend, rechts westlich = Morgen). */
  function eclipticSchema(info, rank) {
    const W = 340, H = 92, cx = W / 2, y0 = 46, k = (W / 2 - 14) / 180;
    const x = el => cx - el * k;
    let o = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Lage der Planeten zur Sonne">`;
    o += `<rect class="glare" x="${x(15)}" y="${y0 - 16}" width="${30 * k}" height="32" rx="4"/>`;
    o += `<line class="ax" x1="10" y1="${y0}" x2="${W - 10}" y2="${y0}"/>`;
    for (const t of [-90, 90]) o += `<line class="ax" x1="${x(t)}" y1="${y0 - 4}" x2="${x(t)}" y2="${y0 + 4}"/>`;
    o += `<circle class="sun" cx="${cx}" cy="${y0}" r="6"/><circle class="sun" cx="${cx}" cy="${y0}" r="2"/>`;
    o += `<text class="ax-t" x="${cx}" y="10" text-anchor="middle">Sonne (±15°: nicht sichtbar)</text>`;
    o += `<text class="ax-t" x="12" y="${H - 4}">← östlich · Abendhimmel</text>`;
    o += `<text class="ax-t" x="${W - 12}" y="${H - 4}" text-anchor="end">westlich · Morgenhimmel →</text>`;
    o += `<text class="ax-t" x="12" y="10">Gegenseite</text><text class="ax-t" x="${W - 12}" y="10" text-anchor="end">Gegenseite</text>`;
    const sorted = info.slice().sort((a, b) => b.elong - a.elong);
    sorted.forEach((p, i) => {
      const r = Math.max(2.2, Math.min(6.5, 4 - 0.8 * p.mag));
      const sel = p.id === st.planet ? ' sel' : '';
      const px = x(p.elong);
      const up = i % 2 === 0;
      o += `<circle class="pl${sel}" cx="${px.toFixed(1)}" cy="${y0}" r="${r.toFixed(1)}"/>`;
      o += `<text class="lb${sel}" x="${px.toFixed(1)}" y="${up ? y0 - 11 : y0 + 17}" text-anchor="middle">${rank.indexOf(p.id) + 1}. ${p.name}</text>`;
    });
    return svg(o + '</svg>');
  }

  render();

  function current() {
    if (st.mode === 'planets') {
      const p = PLANETS.find(x => x.id === st.planet) || PLANETS[0];
      return { body: 'planet:' + p.id, name: p.name };
    }
    const c = CONSTELLATIONS[st.mode].find(x => x.id === st[st.mode]) || CONSTELLATIONS[st.mode][0];
    return { body: 'star:' + c.target, name: STARS[c.target].name };
  }

  /** Messzeitpunkt aus der Datum/Zeit-Einstellung; Planetenangaben einmal pro Minute erneuern. */
  function onTime(ms) {
    tNow = ms;
    const key = st.mode + Math.floor(ms / 60000);
    if (st.mode === 'planets' && key !== lastKey) { lastKey = key; render(); }
  }

  return mountFix(body, ctx, {
    key: 'stars',
    objectColumn: true,
    picker: { el, current, onTime },
    aimIcon: STAR_AIM_ICON,
    hint: o => `Gerät hochkant halten, Oberkante auf ${o.name} ausrichten`,
    note: () => 'Über die Oberkante peilen wie über Kimme und Korn, beide Augen offen. Nachtmodus (dunkle Darstellung) schont die Dunkeladaption.',
    footExtra: 'Sternörter: Katalog J2000 (SIMBAD) mit Eigenbewegung und Präzession; Nutation und Aberration (zusammen ≤ 0,01°) vernachlässigt. ' +
      'Planeten: JPL-Näherungsbahnen (Standish), Abweichung gegenüber JPL Horizons ≤ 0,1°. Mehrere Objekte zur selben Zeit schneiden sich als Höhenstandlinien.'
  });
}
