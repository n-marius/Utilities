// Sternennavigation: Position aus Peilungen markanter Sterne und Planeten (Höhe + Azimut), ohne GPS.
// Messungen aller Objekte stehen in einer Tabelle und gehen gemeinsam in die Ortsbestimmung ein
// (gleichzeitige Peilungen verschiedener Objekte schneiden sich als Höhenstandlinien).

import { h, svg, seg } from '../lib/ui.js';
import { load, save } from '../lib/store.js';
import { mountFix } from './astro/fixui.js';
import { STARS, CONSTELLATIONS, PLANETS } from './astro/catalog.js';

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

/** Sternbild als SVG: gnomonische Projektion um den Schwerpunkt, Osten links (Blick zum Himmel). */
function constellationSvg(c) {
  const D = Math.PI / 180;
  const v = k => { const s = STARS[k]; const a = s.ra * D, d = s.dec * D; return [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)]; };
  const vs = c.stars.map(v);
  const m = [0, 1, 2].map(i => vs.reduce((t, x) => t + x[i], 0));
  const n0 = Math.hypot(...m); const ctr = m.map(x => x / n0);
  const east = [-ctr[1], ctr[0], 0]; const ne = Math.hypot(...east) || 1;
  const e = east.map(x => x / ne);
  const north = [ctr[1] * e[2] - ctr[2] * e[1], ctr[2] * e[0] - ctr[0] * e[2], ctr[0] * e[1] - ctr[1] * e[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const raw = vs.map(x => { const z = dot(x, ctr); return [-dot(x, e) / z, dot(x, north) / z]; });
  const xs = raw.map(p => p[0]), ys = raw.map(p => p[1]);
  const W = 100, H = 76, P = 9;
  const sx = Math.max(...xs) - Math.min(...xs), sy = Math.max(...ys) - Math.min(...ys);
  const sc = Math.min((W - 2 * P) / (sx || 1), (H - 2 * P - 6) / (sy || 1));
  const ox = (W - sx * sc) / 2 - Math.min(...xs) * sc, oy = (H - 6 - sy * sc) / 2 + Math.max(...ys) * sc;
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
      const ly = y > H - 14 ? y - r - 4 : y + r + 8.5;
      out += `<text class="stars-lbl" x="${x.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${anchor}">${STARS[k].name}</text>`;
    } else {
      out += `<circle class="stars-dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}"/>`;
    }
  }
  return out + '</svg>';
}

/** Schematische Planetensymbole. */
const PLANET_SVG = {
  venus: '<svg viewBox="0 0 100 76" aria-hidden="true"><circle class="stars-pl-body" cx="50" cy="38" r="20"/><path class="stars-pl-mark" d="M38 30c8-4 16-4 24 0M36 42c9 4 19 4 28 0"/></svg>',
  mars: '<svg viewBox="0 0 100 76" aria-hidden="true"><circle class="stars-pl-body" cx="50" cy="38" r="15"/><circle class="stars-pl-fill" cx="45" cy="34" r="4"/><circle class="stars-pl-fill" cx="55" cy="44" r="2.6"/></svg>',
  jupiter: '<svg viewBox="0 0 100 76" aria-hidden="true"><circle class="stars-pl-body" cx="50" cy="38" r="24"/><path class="stars-pl-mark" d="M29 28h42M27 36h46M27 42h46M30 50h40"/><ellipse class="stars-pl-fill" cx="58" cy="46" rx="4.5" ry="2.4"/></svg>',
  saturn: '<svg viewBox="0 0 100 76" aria-hidden="true"><ellipse class="stars-pl-mark" cx="50" cy="38" rx="36" ry="10" transform="rotate(-14 50 38)"/><circle class="stars-pl-body" cx="50" cy="38" r="16"/><path class="stars-pl-mark" d="M17 47c20-9 46-17 66-18" transform="rotate(0)"/></svg>'
};

export function mount(body, ctx) {
  if (!document.getElementById('style-stars')) document.head.append(h('style#style-stars', STYLE));
  const st = Object.assign({ mode: 'north', north: 'umi', south: 'cru', planet: 'jupiter' }, load('stars:pick', {}));

  const grid = h('div.stars-grid');
  const modeSeg = seg([
    { value: 'north', label: 'Nordhalbkugel' },
    { value: 'south', label: 'Südhalbkugel' },
    { value: 'planets', label: 'Planeten' }
  ], st.mode, v => { st.mode = v; save('stars:pick', st); render(); });
  const el = h('div.stars-pick', modeSeg, grid);

  function render() {
    grid.textContent = '';
    if (st.mode === 'planets') {
      for (const p of PLANETS) {
        const b = h('button.stars-opt', { type: 'button', onclick: () => { st.planet = p.id; save('stars:pick', st); render(); } },
          svg(PLANET_SVG[p.id]), h('span.n', p.name), h('span.t', 'Planet'));
        if (st.planet === p.id) b.classList.add('is-active');
        grid.append(b);
      }
    } else {
      for (const c of CONSTELLATIONS[st.mode]) {
        const b = h('button.stars-opt', { type: 'button', onclick: () => { st[st.mode] = c.id; save('stars:pick', st); render(); } },
          svg(constellationSvg(c)), h('span.n', c.name), h('span.t', STARS[c.target].name));
        if (st[st.mode] === c.id) b.classList.add('is-active');
        grid.append(b);
      }
    }
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

  return mountFix(body, ctx, {
    key: 'stars',
    objectColumn: true,
    picker: { el, current },
    aimIcon: STAR_AIM_ICON,
    hint: o => `Gerät hochkant halten, Oberkante auf ${o.name} ausrichten`,
    note: () => 'Über die Oberkante peilen wie über Kimme und Korn, beide Augen offen. Nachtmodus (dunkle Darstellung) schont die Dunkeladaption.',
    footExtra: 'Sternörter: Katalog J2000 (SIMBAD) mit Eigenbewegung und Präzession; Nutation und Aberration (zusammen ≤ 0,01°) vernachlässigt. ' +
      'Planeten: JPL-Näherungsbahnen (Standish), Abweichung gegenüber JPL Horizons ≤ 0,1°. Mehrere Objekte zur selben Zeit schneiden sich als Höhenstandlinien.'
  });
}
