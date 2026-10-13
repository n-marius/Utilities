// Hangneigung: Neigung und Exposition mit dem Handy messen (Auflegen/Anpeilen),
// Lawinen-Check nach der Reduktionsmethode (W. Munter) und Tageslicht am Standort.
// Rechenkern, Begründung der Lagequelle und Quellen der Methode: slope/core.js.

import { h, svg, seg, stat, fmt, toast } from '../lib/ui.js';
import { ensureMotionPermission, hasOrientation, hasMotion, watchOrientation, watchMotion, keepAwake } from '../lib/sensors.js';
import { declination } from '../lib/magdecl.js';
import { load, save } from '../lib/store.js';
import { wrap360 } from '../lib/geo.js';
import {
  upFromEuler, upFromAccel, tiltDeg, edgePitchDeg, fallLineAzimuth, alphaFromHeading, compass16,
  steepClass, summarize, LEVELS, ERM_LIMIT, RF1, RF2, RF3, RF_FREQUENT, dangerPotential, evaluate,
  suggestRF1, suggestRF2, daylight, H_SUNSET, H_CIVIL
} from './slope/core.js';

const KEY_LIST = 'slope:list', KEY_MODE = 'slope:mode', KEY_CHECK = 'slope:check', KEY_POS = 'slope:pos', KEY_DECL = 'slope:decl';
const LIVE_MS = 500;        // Fenster Live-Anzeige
const HOLD_MS = 2000;       // Fenster „Halten“
const KEEP_MS = 3000;       // Puffer
const NO_DATA_MS = 2500;
const RECENT_MS = 12 * 3600e3; // Messungen für Vorschläge
const LIST_MAX = 100;
const POS_MAX_AGE = 30 * 60e3;

const STYLE = `
.slope-card { display: flex; flex-direction: column; gap: 14px; }
.slope-read { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; min-height: 76px; }
.slope-val { font-family: var(--font-display); font-weight: 200; font-size: 68px; line-height: .95; letter-spacing: -2px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.slope-val small { font-size: 40px; font-weight: 200; color: var(--text-2); margin-left: 1px; letter-spacing: 0; }
.slope-meta { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; padding-bottom: 6px; min-width: 0; }
.slope-state { font-size: 12.5px; color: var(--text-2); font-variant-numeric: tabular-nums; white-space: nowrap; }
.slope-cls { display: inline-flex; align-items: center; height: 26px; padding: 0 11px; border-radius: 13px; font-size: 13.5px; font-weight: 600;
  letter-spacing: .1px; white-space: nowrap; color: var(--text-2); background: var(--surface-2); border: 1px solid var(--line); }
.slope-cls.sm { height: 20px; padding: 0 8px; font-size: 11.5px; border-radius: 10px; }
.slope-cls[data-k="0"] { color: var(--ok); }
.slope-cls[data-k="1"] { color: var(--warn); background: var(--accent-soft); border-color: transparent; }
.slope-cls[data-k="2"] { color: var(--danger); background: var(--accent-soft); border-color: currentColor; }
.slope-cls[data-k="3"] { color: var(--danger); background: var(--accent-soft); border: 2px solid currentColor; font-weight: 800; }
.slope-gauge { width: 100%; height: auto; display: block; color: var(--text); overflow: visible; }
.slope-gauge .tk { stroke: var(--text-3); stroke-width: 1; }
.slope-gauge .tk.m5 { stroke: var(--text-2); stroke-width: 1.3; }
.slope-gauge .tk.m10 { stroke: var(--text); stroke-width: 1.6; }
.slope-gauge .lb { fill: var(--text-2); font-size: 12px; font-variant-numeric: tabular-nums; }
.slope-gauge .base { stroke: var(--line-strong); stroke-width: 1.5; }
.slope-gauge .band { fill: none; stroke-width: 5; }
.slope-gauge .b0 { stroke: var(--ok); opacity: .45; }
.slope-gauge .b1 { stroke: var(--warn); opacity: .75; }
.slope-gauge .b2 { stroke: var(--danger); opacity: .65; }
.slope-gauge .b3 { stroke: var(--danger); opacity: 1; }
.slope-gauge .hill { fill: var(--accent-soft); }
.slope-gauge .ridge { stroke: var(--text); stroke-width: 2.5; stroke-linecap: round; fill: none; }
.slope-gauge .tip { fill: var(--accent); }
.slope-gauge .pivot { fill: var(--text); }
.slope-gauge .ghost { stroke: var(--text-2); stroke-width: 1.4; stroke-dasharray: 4 4; fill: none; }
.slope-gauge .rose-c { fill: var(--surface); stroke: var(--line-strong); stroke-width: 1.2; }
.slope-gauge .rose-t { stroke: var(--text-3); stroke-width: 1.2; }
.slope-gauge .rose-n { fill: var(--text-2); font-size: 10px; font-weight: 700; }
.slope-gauge .rose-a { fill: var(--accent); }
.slope-gauge .idle .ridge, .slope-gauge .idle .tip { opacity: .25; }
@media (prefers-color-scheme: dark) {
  .slope-gauge .b0 { opacity: .25; } .slope-gauge .b1 { opacity: .45; } .slope-gauge .b2 { opacity: .7; } .slope-gauge .b3 { opacity: 1; }
  .slope-cls[data-k="0"] { color: var(--text-2); }
}
.slope-note { font-size: 12.5px; color: var(--text-2); line-height: 1.45; margin: 0; }
.slope-foot { font-size: 12px; color: var(--text-2); line-height: 1.5; padding: 0 4px; margin: 0; }
.slope-row-main { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.slope-row-main b { font-size: 17px; font-weight: 600; font-variant-numeric: tabular-nums; display: flex; align-items: center; gap: 8px; }
.slope-row-main span { font-size: 12px; color: var(--text-2); font-variant-numeric: tabular-nums; }
.slope-row-side { display: flex; align-items: center; gap: 2px; }
.slope-row-asp { text-align: right; font-variant-numeric: tabular-nums; }
.slope-row-asp small { display: block; font-size: 11px; color: var(--text-2); }
.slope-del { color: var(--text-3); width: 40px; margin-right: -8px; }
.slope-empty { text-align: center; color: var(--text-2); font-size: 14px; padding: 18px 12px; }
.slope-posv { font-size: 15px; font-variant-numeric: tabular-nums; }
.slope-posv small { display: block; font-size: 12px; color: var(--text-2); }
.slope-in { width: 108px; text-align: right; min-height: 38px; padding: 6px 10px; }
.slope-inrow { display: flex; align-items: center; gap: 6px; }
.slope-inrow .icon-btn { width: 38px; height: 38px; }
.slope-opts { display: flex; flex-direction: column; gap: 6px; }
.slope-opt { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; text-align: left;
  background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; min-height: 48px; color: var(--text); }
.slope-opt .t { font-size: 15px; font-weight: 500; }
.slope-opt .s { display: block; font-size: 12px; color: var(--text-2); margin-top: 2px; }
.slope-opt .f { flex: none; font-variant-numeric: tabular-nums; color: var(--text-2); font-size: 14px; font-weight: 600; }
.slope-opt.is-on { border-color: var(--accent); background: var(--accent-soft); box-shadow: inset 0 0 0 1px var(--accent); }
.slope-opt.is-on .f { color: var(--accent); }
.slope-opt.is-void { opacity: .45; }
.slope-opt.is-void .f { text-decoration: line-through; }
.slope-tog .box { flex: none; width: 22px; height: 22px; border-radius: 6px; border: 1.5px solid var(--line-strong); display: grid; place-items: center; }
.slope-tog.is-on .box { border-color: var(--accent); background: var(--accent); color: var(--on-accent); }
.slope-tog .lft { display: flex; align-items: center; gap: 12px; }
.slope-sugg { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 13px; line-height: 1.4;
  background: var(--surface-2); border-radius: 10px; padding: 8px 8px 8px 12px; color: var(--text); }
.slope-sugg .btn { min-height: 36px; padding: 6px 12px; font-size: 14px; flex: none; }
.slope-lvl-info { font-size: 14px; color: var(--text-2); }
.slope-lvl-info b { color: var(--text); font-weight: 600; }
.slope-res { display: flex; flex-direction: column; gap: 12px; }
.slope-res-top { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; }
.slope-res-v { font-family: var(--font-display); font-size: 52px; font-weight: 200; line-height: 1; letter-spacing: -1px; font-variant-numeric: tabular-nums; }
.slope-verdict { font-size: 15px; font-weight: 700; display: flex; align-items: center; gap: 6px; padding-bottom: 6px; text-align: right; }
.slope-verdict.ok { color: var(--ok); }
.slope-verdict.no { color: var(--danger); }
.slope-formula { font-family: var(--mono); font-size: 13px; background: var(--surface-2); border-radius: 8px; padding: 8px 10px; overflow-x: auto; white-space: nowrap; }
.slope-rules { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
.slope-rules li { display: flex; gap: 8px; font-size: 13.5px; line-height: 1.4; }
.slope-rules li i { flex: none; width: 18px; font-style: normal; font-weight: 700; text-align: center; }
.slope-rules li.ok i { color: var(--ok); }
.slope-rules li.no i { color: var(--danger); }
.slope-rules li.info i { color: var(--text-2); }
`;

const DEL_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';
const LOC_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/></svg>';
const CHECK_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

const pad = n => String(n).padStart(2, '0');
const hhmm = t => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmtDeg1 = v => fmt(v, 1) + '°';
const fmtSigned = v => (v >= 0 ? '+' : '−') + fmt(Math.abs(v), 1) + '°';
const fmtAsp = a => a == null ? '–' : `${compass16(a)} ${fmt(Math.round(wrap360(a)) % 360, 0)}°`;
const fmtLeft = ms => {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${pad(m % 60)} min`;
};
const fmtAge = ms => ms < 90e3 ? 'gerade eben' : ms < 3600e3 ? `vor ${Math.round(ms / 60e3)} min` : ms < 86400e3 ? `vor ${Math.round(ms / 3600e3)} h` : `vor ${Math.round(ms / 86400e3)} d`;
const parseNum = s => { const v = parseFloat(String(s).replace(',', '.').replace('−', '-')); return Number.isFinite(v) ? v : null; };

// ---------- Messinstrument (SVG) ----------
// Viertelbogen 0–60° um den Drehpunkt unten links; Hangsilhouette und Zeiger im Messwinkel.
const G = { W: 340, H: 246, px: 16, py: 232, r: 262, max: 60 };
const pt = (deg, rad) => [G.px + rad * Math.cos(deg * Math.PI / 180), G.py - rad * Math.sin(deg * Math.PI / 180)];
const f1 = v => v.toFixed(1);
function arc(a0, a1, rad) {
  const [x0, y0] = pt(a0, rad), [x1, y1] = pt(a1, rad);
  return `M${f1(x0)} ${f1(y0)}A${rad} ${rad} 0 0 0 ${f1(x1)} ${f1(y1)}`;
}

function buildGauge() {
  let ticks = '', labels = '';
  for (let d = 0; d <= G.max; d++) {
    const len = d % 10 === 0 ? 16 : d % 5 === 0 ? 11 : 6;
    const [x0, y0] = pt(d, G.r - len), [x1, y1] = pt(d, G.r);
    ticks += `<path class="tk${d % 10 === 0 ? ' m10' : d % 5 === 0 ? ' m5' : ''}" d="M${f1(x0)} ${f1(y0)}L${f1(x1)} ${f1(y1)}"/>`;
    if (d % 10 === 0) {
      const [lx, ly] = pt(d, G.r - 30);
      labels += `<text class="lb" x="${f1(lx)}" y="${f1(ly + 4)}" text-anchor="middle">${d}°</text>`;
    }
  }
  const bands = [[0, 30, 'b0'], [30, 35, 'b1'], [35, 40, 'b2'], [40, G.max, 'b3']]
    .map(([a, b, c]) => `<path class="band ${c}" d="${arc(a + (a ? 0.4 : 0), b - (b < G.max ? 0.4 : 0), G.r + 7)}"/>`).join('');
  const [bx] = pt(0, G.r + 8);
  const el = svg(`<svg class="slope-gauge" viewBox="0 0 ${G.W} ${G.H}" role="img" aria-label="Neigungsanzeige">
    <path class="base" d="M${G.px} ${G.py}H${f1(bx)}"/>
    ${bands}${ticks}${labels}
    <g class="rose" transform="translate(54 84)">
      <circle class="rose-c" r="30"/>
      <path class="rose-t" d="M0 -30v6M30 0h-5M0 30v-5M-30 0h5"/>
      <text class="rose-n" y="-13" text-anchor="middle">N</text>
      <path class="rose-a" d="M0 -26L5.5 -6L0 -9.5L-5.5 -6Z"/>
      <circle r="2" class="pivot"/>
    </g>
    <path class="ghost" d="" visibility="hidden"/>
    <g class="needle">
      <path class="hill" d=""/>
      <path class="ridge" d=""/>
      <circle class="tip" r="6"/>
    </g>
    <circle class="pivot" cx="${G.px}" cy="${G.py}" r="4"/>
  </svg>`);
  const needle = el.querySelector('.needle'), hill = el.querySelector('.hill'), ridge = el.querySelector('.ridge'), tip = el.querySelector('.tip');
  const ghost = el.querySelector('.ghost'), rose = el.querySelector('.rose'), roseA = el.querySelector('.rose-a');
  function set(deg, { idle = false, held = null, aspect = null, showRose = true } = {}) {
    const a = Math.max(0, Math.min(G.max, deg || 0));
    const [qx, qy] = pt(a, G.r - 22), [tx, ty] = pt(a, G.r);
    hill.setAttribute('d', `M${G.px} ${G.py}L${f1(qx)} ${f1(qy)}L${f1(qx)} ${G.py}Z`);
    ridge.setAttribute('d', `M${G.px} ${G.py}L${f1(tx)} ${f1(ty)}`);
    tip.setAttribute('cx', f1(tx)); tip.setAttribute('cy', f1(ty));
    needle.classList.toggle('idle', idle);
    if (held != null) {
      const [gx, gy] = pt(Math.max(0, Math.min(G.max, held)), G.r + 2);
      ghost.setAttribute('d', `M${G.px} ${G.py}L${f1(gx)} ${f1(gy)}`);
      ghost.setAttribute('visibility', 'visible');
    } else ghost.setAttribute('visibility', 'hidden');
    rose.setAttribute('visibility', showRose ? 'visible' : 'hidden');
    roseA.setAttribute('visibility', aspect == null ? 'hidden' : 'visible');
    if (aspect != null) roseA.setAttribute('transform', `rotate(${f1(aspect)})`);
  }
  return { el, set };
}

// ---------- Auswahlbausteine ----------
function options(list, value, onPick, fmtF = o => '×' + o.f) {
  const el = h('div.slope-opts', { role: 'radiogroup' });
  const btns = list.map(o => {
    const b = h('button.slope-opt', { type: 'button', role: 'radio', onclick: () => { set(o.id); onPick(o.id); } },
      h('span', h('span.t', o.label), o.sub ? h('span.s', o.sub) : null), h('span.f', fmtF(o)));
    b.dataset.id = o.id;
    el.append(b);
    return b;
  });
  function set(v) {
    el.value = v;
    for (const b of btns) { const on = b.dataset.id === v; b.classList.toggle('is-on', on); b.setAttribute('aria-checked', String(on)); }
  }
  el.set = set;
  el.markVoid = on => { for (const b of btns) b.classList.toggle('is-void', on && b.dataset.id !== 'none'); };
  set(value);
  return el;
}

function toggle(label, sub, value, onChange, right = '') {
  const box = h('span.box');
  let on = false;
  const b = h('button.slope-opt.slope-tog', { type: 'button', role: 'switch', onclick: () => { set(!on); onChange(on); } },
    h('span.lft', box, h('span', h('span.t', label), sub ? h('span.s', sub) : null)), right ? h('span.f', right) : null);
  function set(v) {
    on = !!v;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-checked', String(on));
    box.innerHTML = on ? CHECK_ICON : '';
  }
  b.set = set;
  set(value);
  return b;
}

export function mount(body, ctx) {
  if (!document.getElementById('style-slope')) document.head.append(h('style#style-slope', STYLE));

  let mode = load(KEY_MODE, 'lay') === 'sight' ? 'sight' : 'lay';
  let list = load(KEY_LIST, []);
  if (!Array.isArray(list)) list = [];
  let pos = load(KEY_POS, null);
  let manualDecl = load(KEY_DECL, null);
  const check = Object.assign({ level: 3, upper: false, rf1: 'none', rf2: 'none', frequent: false, wet: false, allAspects: false, rf3: 'none' }, load(KEY_CHECK, {}));

  let running = false, frozen = null, startedAt = 0, lastOri = 0, lastSample = 0;
  let samples = [];
  let stopOri = null, stopMot = null, releaseWake = null;
  let disposed = false;

  // ---------- Messung ----------
  const modeSeg = seg([{ value: 'lay', label: 'Auflegen' }, { value: 'sight', label: 'Anpeilen' }], mode, v => {
    mode = v; save(KEY_MODE, v); frozen = null; updateHoldBtn(); renderLive(true);
  });
  const valEl = h('div.slope-val', '–');
  const clsEl = h('span.slope-cls', { hidden: true });
  const stateEl = h('span.slope-state', 'Bereit');
  const gauge = buildGauge();
  const sAsp = stat('Exposition', '–'), sSd = stat('Streuung', '–'), sDecl = stat('Missweisung', '–');
  const stats = h('div.stats.three', sAsp.el, sSd.el, sDecl.el);
  const noData = h('div.banner.warn', { hidden: true }, 'Keine Sensordaten – dieser Browser liefert keine Lagewerte.');
  const compassNote = h('p.slope-note', { hidden: true });
  const startBtn = h('button.btn.primary', { type: 'button', onclick: toggleRun }, 'Start');
  const holdBtn = h('button.btn', { type: 'button', onclick: onHold, disabled: true }, 'Halten');
  const modeHint = h('p.slope-note');
  const card = h('div.card.slope-card', modeSeg,
    h('div.slope-read', valEl, h('div.slope-meta', clsEl, stateEl)),
    gauge.el, stats, noData, compassNote, h('div.btn-row', startBtn, holdBtn), modeHint);
  const accNote = h('p.slope-foot', 'Handy-Neigungsmessung ist typisch auf etwa 1° genau. Auf Schnee an mehreren Stellen messen – maßgebend ist die steilste Stelle in der Falllinie.');

  // Position und Missweisung
  const posV = h('span.v.slope-posv');
  const declIn = h('input.input.slope-in', { type: 'text', inputmode: 'decimal', 'aria-label': 'Missweisung manuell in Grad, Ost positiv', onchange: onDeclInput });
  const posBtn = h('button.icon-btn', { type: 'button', title: 'Position bestimmen', 'aria-label': 'Position bestimmen', html: LOC_ICON, onclick: () => requestPos(false) });
  const declList = h('div.list',
    h('div.list-row', h('span.k', 'Position'), h('span.slope-inrow', posV, posBtn)),
    h('div.list-row', h('span.k', 'Missweisung (° Ost +)'), declIn));
  const declNote = h('p.slope-foot');

  // Messliste
  const listEl = h('div.list');
  const clearBtn = h('button.btn.danger', { type: 'button', onclick: clearList }, 'Alle löschen');

  // ---------- Lawinen-Check ----------
  const disclaimer = h('div.banner.warn', h('b', 'Entscheidungshilfe, '), 'ersetzt weder Lawinenlagebericht noch Ausbildung und Beurteilung vor Ort.');
  const lvlSeg = seg(LEVELS.map(l => ({ value: String(l.lvl), label: String(l.lvl) })), String(check.level), v => { check.level = +v; changed(); });
  const lvlInfo = h('div.slope-lvl-info');
  const upperTog = toggle('Zwischenwert zur nächsthöheren Stufe', 'Gefahrenpotential 3, 6 bzw. 12', check.upper, v => { check.upper = v; changed(); });
  const lvl5 = h('div.banner.warn', { hidden: true }, h('b', 'Stufe 5: '), 'kein Touren- und Variantenbetrieb.');
  const lvlCard = h('div.card.slope-card', h('div.card-title', 'Gefahrenstufe laut Lagebericht'), lvlSeg, lvlInfo, upperTog, lvl5);

  const rf1Opts = options(RF1, check.rf1, v => { check.rf1 = v; changed(); });
  const rf1Sugg = h('div.slope-sugg', { hidden: true });
  const rf1Note = h('p.slope-note');
  const rf1Card = h('div.card.slope-card', h('div.card-title', '1. Klasse · Steilheit'), rf1Sugg, rf1Opts, rf1Note);

  const rf2Opts = options(RF2, check.rf2, v => { check.rf2 = v; changed(); });
  const rf2Sugg = h('div.slope-sugg', { hidden: true });
  const freqTog = toggle(RF_FREQUENT.label, 'Nach jedem Neuschneefall wieder befahren', check.frequent, v => { check.frequent = v; changed(); }, '×' + RF_FREQUENT.f);
  const wetTog = toggle('Nassschnee', 'Durchfeuchtete Schneedecke', check.wet, v => { check.wet = v; changed(); });
  const allTog = toggle('Lagebericht: alle Expositionen', 'Gefahrenstellen in allen Hangrichtungen', check.allAspects, v => { check.allAspects = v; changed(); });
  const rf2Void = h('p.slope-note', { hidden: true }, 'Expositionsfaktor entfällt.');
  const rf2Card = h('div.card.slope-card', h('div.card-title', '2. Klasse · Exposition'), rf2Sugg, rf2Opts, freqTog,
    h('div.card-title', { style: { margin: '4px 0 -4px' } }, 'Ausschlussgründe'), wetTog, allTog, rf2Void);

  const rf3Opts = options(RF3, check.rf3, v => { check.rf3 = v; changed(); });
  const rf3Card = h('div.card.slope-card', h('div.card-title', '3. Klasse · Gruppe'), rf3Opts,
    h('p.slope-note', 'Entlastungsabstände: im Aufstieg mindestens 10 m, in der Abfahrt deutlich mehr. Kleine Gruppe: 2–4 Personen.'));

  const resV = h('div.slope-res-v', '–');
  const resVerdict = h('div.slope-verdict');
  const resFormula = h('div.slope-formula');
  const resRules = h('ul.slope-rules');
  const resCard = h('div.card.slope-res', h('div.card-title', { style: { margin: 0 } }, 'Restrisiko'),
    h('div.slope-res-top', resV, resVerdict), resFormula, resRules);

  const srcNote = h('p.slope-foot',
    'Reduktionsmethode nach W. Munter («3×3 Lawinen»). Werte geprüft an: SAC «Die Alpen» 2/1999 (Berechnungsschema), ',
    'J. Schweizer/SLF, bergundsteigen 4/06 (Gefahrenpotential 2 · 4 · 8 · 16, elementare Grenzwerte), bergundsteigen 2022 ',
    '(Nassschnee, Gruppenfaktoren), Uni Freiburg (Zwischenwerte, regelmäßig befahrene Hänge). Steilheitsklassen: EAWS-Glossar. ',
    'Für eine steilste Hangpartie unter 30° nennen die geprüften Quellen keinen eigenen Faktor; es gilt der Faktor für 30–34°.');

  // ---------- Tageslicht ----------
  const dayList = h('div.list');
  const dayNote = h('p.slope-foot');

  body.append(card, accNote, declList, declNote,
    h('div.section-title', 'Messungen'), listEl, clearBtn,
    h('div.section-title', 'Lawinen-Check · Reduktionsmethode'), disclaimer, lvlCard, rf1Card, rf2Card, rf3Card, resCard, srcNote,
    h('div.section-title', 'Tageslicht'), dayList, dayNote);

  // ---------- Sensorik ----------
  function pushSample(s) {
    const t = performance.now();
    s.t = t;
    samples.push(s);
    lastSample = t;
    while (samples.length && samples[0].t < t - KEEP_MS) samples.shift();
  }

  function onOri(o) {
    if (o.beta == null || o.gamma == null) return;
    lastOri = performance.now();
    const up = upFromEuler(o.beta, o.gamma);
    const tilt = tiltDeg(up);
    let aspect = null;
    // Exposition nur bei brauchbarer Lage: nicht fast eben, nicht nahezu senkrecht
    if (o.heading != null && tilt >= 2 && tilt <= 70) aspect = fallLineAzimuth(alphaFromHeading(o.heading), o.beta, o.gamma);
    pushSample({ tilt, pitch: edgePitchDeg(up), aspect, hAcc: o.headingAccuracy, hasHeading: o.heading != null, src: 'ori' });
  }

  function onMotion(e) {
    if (performance.now() - lastOri < 1000) return; // Lage aus Orientation bevorzugt
    const a = e.accelerationIncludingGravity;
    if (!a || a.x == null) return;
    const up = upFromAccel(a.x, a.y, a.z);
    if (!up) return;
    pushSample({ tilt: tiltDeg(up), pitch: edgePitchDeg(up), aspect: null, hAcc: null, hasHeading: false, src: 'acc' });
  }

  async function toggleRun() {
    if (running) { stopRun(); return; }
    const okPerm = await ensureMotionPermission();
    if (disposed) return;
    if (!okPerm) { toast('Sensorfreigabe verweigert'); return; }
    if (!pos || Date.now() - pos.t > POS_MAX_AGE) requestPos(true);
    running = true; frozen = null; samples = []; startedAt = performance.now(); lastSample = 0;
    stopOri = hasOrientation() ? watchOrientation(onOri) : null;
    stopMot = hasMotion() ? watchMotion(onMotion) : null;
    startBtn.textContent = 'Stopp';
    updateHoldBtn();
    keepAwake().then(rel => { if (!running || disposed) rel(); else releaseWake = rel; });
  }

  function stopRun() {
    running = false;
    stopOri && stopOri(); stopMot && stopMot(); stopOri = stopMot = null;
    releaseWake && releaseWake(); releaseWake = null;
    startBtn.textContent = 'Start';
    noData.hidden = true;
    updateHoldBtn();
    renderLive(true);
  }

  const modeVal = s => mode === 'lay' ? s.tilt : Math.abs(s.pitch);
  function windowSummary(ms) {
    const t = performance.now();
    const w = samples.filter(s => s.t >= t - ms);
    if (!w.length) return null;
    const sum = summarize(w.map(s => ({ slope: modeVal(s), aspect: mode === 'lay' ? s.aspect : null })));
    sum.span = t - w[0].t;
    sum.hAcc = w[w.length - 1].hAcc;
    sum.hasHeading = w.some(s => s.hasHeading);
    sum.src = w[w.length - 1].src;
    return sum;
  }

  function onHold() {
    if (frozen) { frozen = null; updateHoldBtn(); renderLive(true); return; }
    const s = windowSummary(HOLD_MS);
    if (!s || s.n < 5) { toast('Noch zu wenige Messwerte'); return; }
    const d = declInfo();
    const aspectTrue = s.aspect != null && d ? wrap360(s.aspect + d.v) : null;
    frozen = { ...s, aspectShown: aspectTrue ?? s.aspect, ref: s.aspect == null ? null : d ? 'true' : 'mag' };
    const m = { t: Date.now(), mode, slope: +s.slope.toFixed(2), sd: +s.sd.toFixed(2), n: s.n,
      aspect: frozen.aspectShown == null ? null : +frozen.aspectShown.toFixed(1), ref: frozen.ref };
    list.unshift(m);
    if (list.length > LIST_MAX) list.length = LIST_MAX;
    save(KEY_LIST, list);
    updateHoldBtn();
    renderLive(true);
    renderList();
    renderCheck();
    toast(`Gehalten: ${fmtDeg1(s.slope)} ±${fmt(s.sd, 1)}°`);
  }

  function updateHoldBtn() {
    holdBtn.disabled = !running && !frozen;
    holdBtn.textContent = frozen ? 'Weiter' : 'Halten';
    holdBtn.classList.toggle('primary', !!frozen);
  }

  // ---------- Darstellung Messung ----------
  function setClass(deg) {
    if (deg == null) { clsEl.hidden = true; return; }
    const c = steepClass(deg);
    clsEl.hidden = false;
    clsEl.dataset.k = c.k;
    clsEl.textContent = c.label;
  }

  function setValue(v) {
    valEl.textContent = '';
    if (v == null) { valEl.textContent = '–'; return; }
    valEl.append(fmt(v, 1), h('small', '°'));
  }

  function renderLive(force = false) {
    if (disposed) return;
    modeHint.textContent = mode === 'lay'
      ? 'Handy mit dem Display nach oben flach auf den Hang oder den aufgelegten Skistock legen.'
      : 'Lange Kante des Handys auf die Hanglinie ausrichten – von der Seite oder vom Hangfuß aus anpeilen. Exposition nur beim Auflegen.';
    const d = declInfo();
    sDecl.set(d ? fmtSigned(d.v) : '–');
    if (frozen) {
      setValue(frozen.slope); setClass(frozen.slope);
      stateEl.textContent = `gehalten · ±${fmt(frozen.sd, 1)}° · n = ${frozen.n}`;
      sSd.set('±' + fmt(frozen.sd, 1) + '°');
      sAsp.set(mode === 'lay' ? fmtAsp(frozen.aspectShown) : '–');
      gauge.set(frozen.slope, { held: frozen.slope, aspect: mode === 'lay' ? frozen.aspectShown : null, showRose: mode === 'lay' });
      compassNote.hidden = true;
      return;
    }
    if (!running) {
      const last = list[0];
      setValue(null); setClass(null);
      stateEl.textContent = 'Bereit';
      sSd.set('–'); sAsp.set('–');
      gauge.set(last && last.mode === mode ? last.slope : 0, { idle: true, held: last && last.mode === mode ? last.slope : null, showRose: mode === 'lay' });
      compassNote.hidden = true;
      return;
    }
    const now = performance.now();
    noData.hidden = !(now - startedAt > NO_DATA_MS && now - lastSample > NO_DATA_MS);
    const s = windowSummary(LIVE_MS);
    if (!s) {
      if (force) { setValue(null); setClass(null); stateEl.textContent = 'Warte auf Sensor …'; gauge.set(0, { idle: true, showRose: mode === 'lay' }); }
      return;
    }
    const aspectShown = s.aspect != null && d ? wrap360(s.aspect + d.v) : s.aspect;
    setValue(s.slope); setClass(s.slope);
    stateEl.textContent = s.src === 'acc' ? 'live · Beschleunigungssensor' : 'live';
    const s2 = windowSummary(HOLD_MS);
    sSd.set(s2 && s2.n > 2 ? '±' + fmt(s2.sd, 1) + '°' : '–');
    sAsp.set(mode === 'lay' ? fmtAsp(aspectShown) : '–');
    gauge.set(s.slope, { aspect: mode === 'lay' ? aspectShown : null, showRose: mode === 'lay' });
    // Hinweise zum Kompass
    let note = '';
    if (mode === 'lay') {
      if (!s.hasHeading) note = 'Kompass nicht verfügbar – Exposition kann nicht bestimmt werden.';
      else if (s.slope < 2) note = 'Fast eben – keine Falllinie bestimmbar.';
      else if (s.hAcc != null && s.hAcc > 20) note = `Kompass ungenau (±${fmt(s.hAcc, 0)}°). Abstand zu Metall (Stöcke, Pickel, LVS) halten.`;
      else if (aspectShown != null && !d) note = 'Exposition magnetisch – Missweisung nicht berücksichtigt (keine Position).';
    }
    compassNote.textContent = note;
    compassNote.hidden = !note;
  }

  // ---------- Position, Missweisung ----------
  function declInfo() {
    if (manualDecl != null && Number.isFinite(manualDecl)) return { v: manualDecl, src: 'manuell' };
    if (pos && window.geomagnetism) return { v: declination(pos.lat, pos.lon), src: 'auto' };
    return null;
  }

  function requestPos(silent) {
    if (!('geolocation' in navigator)) { if (!silent) toast('Ortung nicht verfügbar'); return; }
    navigator.geolocation.getCurrentPosition(p => {
      if (disposed) return;
      pos = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, t: Date.now() };
      save(KEY_POS, pos);
      renderPos(); renderLive(true); renderDay();
      if (!silent) toast('Position aktualisiert');
    }, err => {
      if (!silent && !disposed) toast(err && err.code === 1 ? 'Standortzugriff verweigert' : 'Position nicht bestimmbar');
    }, { enableHighAccuracy: false, maximumAge: 10 * 60e3, timeout: 20000 });
  }

  function onDeclInput() {
    const v = parseNum(declIn.value);
    manualDecl = declIn.value.trim() === '' || v == null || Math.abs(v) > 90 ? null : v;
    save(KEY_DECL, manualDecl);
    renderPos(); renderLive(true);
  }

  function renderPos() {
    posV.textContent = '';
    if (pos) posV.append(`${fmt(Math.abs(pos.lat), 3)}° ${pos.lat >= 0 ? 'N' : 'S'}, ${fmt(Math.abs(pos.lon), 3)}° ${pos.lon >= 0 ? 'O' : 'W'}`, h('small', fmtAge(Date.now() - pos.t)));
    else posV.append('unbekannt');
    const auto = pos && window.geomagnetism ? declination(pos.lat, pos.lon) : null;
    declIn.placeholder = auto != null ? 'auto ' + fmtSigned(auto) : 'z. B. 3,5';
    if (document.activeElement !== declIn) declIn.value = manualDecl != null ? String(manualDecl).replace('.', ',') : '';
    const d = declInfo();
    declNote.textContent = d
      ? (d.src === 'manuell' ? 'Missweisung manuell gesetzt; Exposition rechtweisend.' : 'Missweisung nach World Magnetic Model für die letzte Position; Exposition rechtweisend. Leeres Feld = automatisch.')
      : 'Missweisung nicht berücksichtigt – keine Position. Exposition ist dann magnetisch; Wert manuell eintragen oder Position bestimmen.';
  }

  // ---------- Messliste ----------
  function recent() { const t = Date.now(); return list.filter(m => t - m.t < RECENT_MS); }

  function renderList() {
    listEl.textContent = '';
    clearBtn.hidden = !list.length;
    if (!list.length) {
      listEl.append(h('div.slope-empty', 'Noch keine Messungen. „Halten“ speichert den Mittelwert der letzten 2 s.'));
      return;
    }
    const steep = list.reduce((a, m) => (!a || m.slope > a.slope ? m : a), null);
    list.forEach((m, i) => {
      const c = steepClass(m.slope);
      const d = new Date(m.t);
      const day = new Date().toDateString() === d.toDateString() ? '' : `${pad(d.getDate())}.${pad(d.getMonth() + 1)}. `;
      listEl.append(h('div.list-row',
        h('div.slope-row-main',
          h('b', fmtDeg1(m.slope), h('span.slope-cls.sm', { 'data-k': c.k }, c.label), m === steep && list.length > 1 ? h('span.slope-cls.sm', 'steilste') : null),
          h('span', `±${fmt(m.sd, 1)}° · ${day}${hhmm(m.t)} · ${m.mode === 'sight' ? 'Anpeilen' : 'Auflegen'}`)),
        h('div.slope-row-side',
          h('div.slope-row-asp', m.aspect == null ? '–' : fmtAsp(m.aspect), m.aspect == null ? null : h('small', m.ref === 'true' ? 'rechtweisend' : 'magnetisch')),
          h('button.icon-btn.slope-del', { type: 'button', 'aria-label': 'Messung löschen', html: DEL_ICON, onclick: () => delAt(i) }))));
    });
  }

  function delAt(i) {
    list.splice(i, 1);
    save(KEY_LIST, list);
    renderList(); renderCheck(); renderLive(true);
  }

  function clearList() {
    if (!confirm('Alle Messungen löschen?')) return;
    list = [];
    save(KEY_LIST, list);
    renderList(); renderCheck(); renderLive(true);
  }

  // ---------- Lawinen-Check ----------
  function changed() { save(KEY_CHECK, check); renderCheck(); }

  function suggestion(el, text, apply) {
    el.textContent = '';
    if (!text) { el.hidden = true; return; }
    el.hidden = false;
    el.append(h('span', text), apply ? h('button.btn', { type: 'button', onclick: apply }, 'Übernehmen') : null);
  }

  function renderCheck() {
    const L = LEVELS.find(l => l.lvl === check.level);
    lvlSeg.set(String(check.level));
    const gp = dangerPotential(check.level, check.upper);
    lvlInfo.textContent = '';
    lvlInfo.append(h('b', `${L.lvl} · ${L.name}`), gp != null ? ` · Gefahrenpotential ${gp}` : '');
    upperTog.hidden = !L.gpUp;
    upperTog.set(check.upper);
    lvl5.hidden = check.level !== 5;
    for (const c of [rf1Card, rf2Card, rf3Card, resCard]) c.hidden = check.level === 5;

    // Vorschläge aus Messungen
    const rec = recent();
    const steep = rec.reduce((a, m) => (!a || m.slope > a.slope ? m : a), null);
    rf1Opts.set(check.rf1);
    if (steep) {
      const tol = Math.max(1, steep.sd || 0);
      const sug = suggestRF1(steep.slope, tol);
      const o = RF1.find(x => x.id === sug);
      suggestion(rf1Sugg, `Steilste Messung ${fmtDeg1(steep.slope)} (+${fmt(tol, 1)}° Toleranz) → ${sug === 'none' ? 'kein Faktor' : o.label + ' (×' + o.f + ')'}`,
        sug !== check.rf1 ? () => { check.rf1 = sug; changed(); } : null);
    } else suggestion(rf1Sugg, null);
    rf1Note.textContent = check.level <= 2
      ? 'Maßgebend ist die steilste Hangpartie; bei Stufe 2 im Umkreis von etwa 20 m um die Spur.'
      : 'Maßgebend ist die steilste Hangpartie im ganzen Hang (potentielles Anrissgebiet).';

    rf2Opts.set(check.rf2);
    const asp = rec.filter(m => m.aspect != null);
    if (asp.length) {
      const sug = suggestRF2(asp.map(m => m.aspect));
      const o = RF2.find(x => x.id === sug);
      const names = [...new Set(asp.map(m => compass16(m.aspect)))].join(', ');
      const magn = asp.some(m => m.ref !== 'true') ? ' (teils magnetisch)' : '';
      suggestion(rf2Sugg, `Gemessen: ${names}${magn} → ${sug === 'none' ? 'kein Faktor' : o.label + ' (×' + o.f + ')'}. Gilt nur, wenn die ganze Route diese Hänge meidet.`,
        sug !== check.rf2 ? () => { check.rf2 = sug; changed(); } : null);
    } else suggestion(rf2Sugg, null);
    freqTog.set(check.frequent); wetTog.set(check.wet); allTog.set(check.allAspects);
    const aspectVoid = check.wet || check.allAspects;
    rf2Opts.markVoid(aspectVoid);
    rf2Void.hidden = !aspectVoid;
    rf3Opts.set(check.rf3);

    // Ergebnis
    const r = evaluate(check, steep ? steep.slope : null);
    if (!r || r.blocked) return;
    resV.textContent = fmt(r.risk, r.risk < 10 ? 2 : 1);
    resVerdict.className = 'slope-verdict ' + (r.accepted ? 'ok' : 'no');
    resVerdict.textContent = r.accepted ? '✓ Restrisiko akzeptiert'
      : r.risk <= 1 ? '✕ Regel verletzt' : '✕ Restrisiko zu hoch';
    const used = r.factors.filter(f => f.f > 1).map(f => f.f);
    resFormula.textContent = `${r.gp} : ${used.length ? '(' + used.join(' × ') + ')' : '1'} = ${fmt(r.risk, 2)}`;
    resRules.textContent = '';
    for (const rule of r.rules) resRules.append(h('li', { class: rule.ok ? 'ok' : 'no' }, h('i', rule.ok ? '✓' : '✕'), h('span', rule.text)));
    if (r.aspectVoid) resRules.append(h('li.info', h('i', 'i'), h('span', 'Nassschnee bzw. alle Expositionen kritisch: kein Faktor 2. Klasse für die Exposition.')));
    const lim = ERM_LIMIT[check.level];
    if (lim) {
      const okErm = steep ? steep.slope < lim : null;
      resRules.append(h('li', { class: okErm ? 'ok' : 'info' }, h('i', okErm == null ? 'i' : okErm ? '✓' : '!'),
        h('span', `Gegenprobe elementare Reduktionsmethode (Stufe ${check.level}): steilste Hangpartie unter ${lim}°`
          + (steep ? ` – gemessen ${fmtDeg1(steep.slope)}` : '') + '.')));
    }
    resRules.append(h('li.info', h('i', 'i'), h('span', 'Restrisiko ≤ 1 gilt nach Munter als akzeptiert, nicht als sicher.')));
  }

  // ---------- Tageslicht ----------
  function renderDay() {
    dayList.textContent = '';
    if (!pos) {
      dayList.append(h('div.list-row', h('span.k', 'Keine Position'), h('button.btn', { type: 'button', onclick: () => requestPos(false) }, 'Bestimmen')));
      dayNote.textContent = '';
      return;
    }
    const now = Date.now();
    const d = daylight(pos.lat, pos.lon, now);
    const row = (k, t, extra) => h('div.list-row', h('span.k', k), h('span.v', t == null ? '–' : hhmm(t), extra ? h('small.muted', { style: { display: 'block', fontSize: '12px' } }, extra) : null));
    if (d.alt > H_SUNSET) {
      dayList.append(
        row('Sonnenuntergang', d.sunset, d.sunset ? 'in ' + fmtLeft(d.sunset - now) : 'nicht innerhalb 36 h'),
        row('Ende bürgerliche Dämmerung', d.duskEnd, d.duskEnd ? 'in ' + fmtLeft(d.duskEnd - now) : null));
    } else if (d.alt > H_CIVIL) {
      dayList.append(
        h('div.list-row', h('span.k', 'Sonne'), h('span.v', 'untergegangen')),
        row('Ende bürgerliche Dämmerung', d.duskEnd, d.duskEnd ? 'in ' + fmtLeft(d.duskEnd - now) : null));
    } else {
      dayList.append(
        h('div.list-row', h('span.k', 'Sonne'), h('span.v', 'unter −6° (dunkel)')),
        row('Sonnenaufgang', d.sunrise, d.sunrise ? 'in ' + fmtLeft(d.sunrise - now) : 'nicht innerhalb 36 h'));
    }
    dayNote.textContent = `Für ${fmt(Math.abs(pos.lat), 2)}° ${pos.lat >= 0 ? 'N' : 'S'}, ${fmt(Math.abs(pos.lon), 2)}° ${pos.lon >= 0 ? 'O' : 'W'} (Position ${fmtAge(now - pos.t)}). `
      + 'Ebener Horizont angenommen – hinter Bergen verschwindet die Sonne früher. Uhrzeiten in Gerätezeit.';
  }

  // ---------- Start ----------
  renderPos(); renderLive(true); renderList(); renderCheck(); renderDay();
  const liveTimer = setInterval(() => { if (running && !frozen) renderLive(); }, 100);
  const slowTimer = setInterval(() => { renderDay(); renderPos(); }, 30000);
  // Position still auffrischen, wenn Ortung bereits erlaubt ist
  try {
    navigator.permissions && navigator.permissions.query({ name: 'geolocation' })
      .then(p => { if (!disposed && p.state === 'granted' && (!pos || Date.now() - pos.t > POS_MAX_AGE)) requestPos(true); })
      .catch(() => {});
  } catch { /* egal */ }

  return () => {
    disposed = true;
    clearInterval(liveTimer); clearInterval(slowTimer);
    stopOri && stopOri(); stopMot && stopMot();
    releaseWake && releaseWake();
  };
}
