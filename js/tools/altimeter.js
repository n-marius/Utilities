// Höhenmesser: barometrische Höhe nach Internationaler Standardatmosphäre (Troposphäre).
//
// Druckquelle: Generic-Sensor-API (window.PressureSensor / window.Barometer), sofern vorhanden.
// Safari/iOS und Chrome geben den Gerätebarometer derzeit nicht an Web-Apps weiter; dann wird
// der Druck manuell eingegeben (z. B. von einem externen Barometer). Es werden keine Werte erfunden.
// Referenz: QNH aus GPS-Höhe (gemerkt) oder Standarddruck 1013,25 hPa (Druckhöhe / FL).

import { h, svg, seg, stat, fmt, toast } from '../lib/ui.js';
import { watchPosition, geoErrorText } from '../lib/sensors.js';
import { load, save } from '../lib/store.js';

// ===== Physik (ISA, Troposphäre) =====
export const P_STD = 1013.25;          // hPa
const K_ALT = 44330.77;                // m
const N_EXP = 0.190263;
export const FT = 0.3048;              // m je ft

/** Höhe (m) aus Druck p und Referenzdruck pRef (hPa). */
export function baroAltitude(p, pRef = P_STD) {
  return K_ALT * (1 - Math.pow(p / pRef, N_EXP));
}

/** Referenzdruck (QNH, hPa) aus Druck p (hPa) und bekannter Höhe h (m). */
export function qnhFromAltitude(p, hM) {
  return p / Math.pow(1 - hM / K_ALT, 1 / N_EXP);
}

/** Flugfläche (Druckhöhe in 100 ft) als Text, z. B. "FL 052". */
export function flightLevel(p) {
  const fl = Math.round(baroAltitude(p, P_STD) / FT / 100);
  return 'FL ' + (fl < 0 ? '−' : '') + String(Math.abs(fl)).padStart(3, '0');
}

/** Sensorwert defensiv nach hPa umrechnen (Pa, kPa, bar oder hPa). */
export function toHpa(x) {
  if (typeof x !== 'number' || !Number.isFinite(x) || x <= 0) return null;
  let p = x;
  if (x > 3000) p = x / 100;            // Pa
  else if (x >= 20 && x <= 200) p = x * 10; // kPa
  else if (x < 2) p = x * 1000;         // bar
  return p >= 100 && p <= 1200 ? p : null;
}

// ===== Drucksensor (Generic-Sensor-Stil) =====
function sensorCtor() {
  if (typeof window.PressureSensor === 'function') return { Ctor: window.PressureSensor, name: 'PressureSensor' };
  if (typeof window.Barometer === 'function') return { Ctor: window.Barometer, name: 'Barometer' };
  return null;
}

function startPressureSensor(onHpa, onError) {
  const found = sensorCtor();
  if (!found) return null;
  let s = null;
  const onReading = () => {
    const raw = s.pressure ?? s.value ?? (s.reading && s.reading.pressure);
    const p = toHpa(raw);
    if (p != null) onHpa(p);
  };
  const onErr = e => onError((e && e.error) || e);
  try {
    s = new found.Ctor({ frequency: 10 });
    if (typeof s.addEventListener === 'function') {
      s.addEventListener('reading', onReading);
      s.addEventListener('error', onErr);
    } else {
      s.onreading = onReading;
      s.onerror = onErr;
    }
    s.start();
  } catch (e) {
    onError(e);
  }
  return {
    name: found.name,
    stop() {
      if (!s) return;
      try {
        if (typeof s.removeEventListener === 'function') {
          s.removeEventListener('reading', onReading);
          s.removeEventListener('error', onErr);
        } else { s.onreading = null; s.onerror = null; }
        s.stop();
      } catch { /* egal */ }
      s = null;
    }
  };
}

// ===== Styles =====
const CSS = `
.altimeter-top { flex: none; }
.altimeter-inst { width: 100%; max-width: 480px; margin: 0 auto; display: block; border-radius: 8.5%; box-shadow: var(--shadow); }
.altimeter-inst svg { width: 100%; height: auto; display: block; }
.altimeter-housing { fill: var(--surface); stroke: var(--line); stroke-width: 1.5; }
.altimeter-screw { fill: var(--surface-2); stroke: var(--line-strong); stroke-width: 1.2; }
.altimeter-slot { stroke: var(--line-strong); stroke-width: 2; stroke-linecap: round; }
.altimeter-bezel { fill: var(--surface-2); stroke: var(--line-strong); stroke-width: 1.5; }
.altimeter-face { fill: var(--surface); stroke: var(--line); stroke-width: 1.5; }
.altimeter-tick { stroke: var(--text); stroke-width: 1.6; }
.altimeter-tick.is-major { stroke-width: 4; }
.altimeter-num { fill: var(--text); font: 600 37px var(--font-display, var(--font)); text-anchor: middle; dominant-baseline: central; font-variant-numeric: tabular-nums; }
.altimeter-lbl { fill: var(--text); font: 600 14px var(--font-display, var(--font)); letter-spacing: 2.6px; text-anchor: middle; }
.altimeter-lbl.is-sub { fill: var(--text-2); font-weight: 500; font-size: 10.5px; letter-spacing: 1.4px; }
.altimeter-win { fill: var(--surface-2); stroke: var(--line-strong); stroke-width: 1.5; }
.altimeter-win-sep { stroke: var(--line); stroke-width: 1; }
.altimeter-digit { fill: var(--text); font: 600 27px var(--mono); text-anchor: middle; dominant-baseline: central; }
.altimeter-digit.is-dim { fill: var(--text-3); }
.altimeter-kollsman { fill: var(--text); font: 600 21px var(--mono); text-anchor: middle; dominant-baseline: central; }
.altimeter-index { fill: var(--accent); }
.altimeter-tag { fill: var(--accent); font: 700 10.5px var(--font); letter-spacing: 1.4px; text-anchor: middle; }
.altimeter-hatch-a { fill: var(--accent); }
.altimeter-hatch-b { fill: var(--surface); }
.altimeter-flag-t { fill: var(--accent); font: 800 13px var(--font); letter-spacing: 1.5px; text-anchor: middle; dominant-baseline: central; paint-order: stroke; stroke: var(--surface); stroke-width: 5px; }
.altimeter-ptr { fill: var(--text); stroke: var(--surface); stroke-width: 1.5; stroke-linejoin: round; }
.altimeter-ptr-10k { fill: var(--accent); stroke: var(--surface); stroke-width: 1; }
.altimeter-ptr-10k-line { stroke: var(--accent); stroke-width: 2.5; }
.altimeter-hub { fill: var(--text); }
.altimeter-hub-c { fill: var(--surface-2); }

.altimeter-controls { display: flex; gap: 10px; align-items: stretch; }
.altimeter-mode {
  flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px;
  background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); padding: 6px 8px; min-height: 68px;
}
.altimeter-opt {
  background: none; border: 0; min-width: 62px; min-height: 52px; padding: 4px 6px; border-radius: 10px;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px; color: var(--text-3);
  transition: color .2s;
}
.altimeter-opt b { font-family: var(--font-display, var(--font)); font-size: 16px; font-weight: 700; letter-spacing: 1.5px; }
.altimeter-opt span { font-size: 11px; letter-spacing: .5px; }
.altimeter-opt.is-active { color: var(--text); }
.altimeter-opt.is-active b { color: var(--accent); }
.altimeter-knob {
  position: relative; width: 52px; height: 52px; border-radius: 50%; padding: 0; flex: none;
  border: 1px solid var(--line-strong);
  background: repeating-conic-gradient(var(--line-strong) 0 2.5deg, var(--surface-2) 2.5deg 9deg);
  transform: rotate(-45deg); transition: transform .45s cubic-bezier(.3, 1.45, .5, 1);
}
.altimeter-knob.is-std { transform: rotate(45deg); }
.altimeter-knob::before {
  content: ""; position: absolute; inset: 6px; border-radius: 50%;
  background: var(--surface); box-shadow: 0 0 0 1px var(--line-strong);
}
.altimeter-knob i {
  position: absolute; left: 50%; top: 9px; width: 4px; height: 15px; margin-left: -2px;
  border-radius: 2px; background: var(--accent);
}
.altimeter-unit { width: 108px; flex: none; }
.altimeter-unit button { font-size: 15px; letter-spacing: .5px; }

.altimeter-row { display: flex; gap: 10px; align-items: flex-end; }
.altimeter-row .field { flex: 1; }
.altimeter-note { font-size: 13px; color: var(--text-2); line-height: 1.4; margin: 10px 2px 0; }
.altimeter-note b { color: var(--text); font-weight: 600; }
.altimeter-prog { margin-top: 10px; }
.altimeter-input.is-bad { border-color: var(--danger); }
.altimeter-banner { font-size: 12.5px; color: var(--text-2); }
.altimeter-banner b { color: var(--text); }
`;

function ensureStyle() {
  if (document.getElementById('style-altimeter')) return;
  document.head.append(h('style#style-altimeter', CSS));
}

// ===== Instrument (SVG) =====
const C = 200;
const NS = 'http://www.w3.org/2000/svg';
const DRUM_X = 145, DRUM_W = 22, DRUM_Y = 238, DRUM_H = 42, DIGIT_H = 42;

function polar(r, deg) {
  const a = deg * Math.PI / 180;
  return [C + r * Math.sin(a), C - r * Math.cos(a)];
}

function buildInstrument() {
  let ticks = '';
  for (let i = 0; i < 50; i++) {
    const major = i % 5 === 0;
    const [x1, y1] = polar(major ? 150 : 164, i * 7.2);
    const [x2, y2] = polar(178, i * 7.2);
    ticks += `<line class="altimeter-tick${major ? ' is-major' : ''}" x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}"/>`;
  }
  let nums = '';
  for (let n = 0; n < 10; n++) {
    const [x, y] = polar(127, n * 36);
    nums += `<text class="altimeter-num" x="${x.toFixed(1)}" y="${y.toFixed(1)}">${n}</text>`;
  }
  const screws = [[26, 26, 20], [374, 26, 70], [26, 374, 115], [374, 374, 160]].map(([x, y, a]) =>
    `<circle class="altimeter-screw" cx="${x}" cy="${y}" r="8"/><line class="altimeter-slot" x1="${x - 5}" y1="${y}" x2="${x + 5}" y2="${y}" transform="rotate(${a} ${x} ${y})"/>`
  ).join('');

  // Trommelzähler: je Stelle ein Streifen 0–9,0
  let drum = '';
  for (let i = 0; i < 5; i++) {
    const cx = DRUM_X + 2 + i * DRUM_W + DRUM_W / 2;
    let strip = '';
    for (let k = 0; k <= 10; k++) strip += `<text class="altimeter-digit" x="${cx}" y="${DRUM_Y + DRUM_H / 2 + k * DIGIT_H}">${k % 10}</text>`;
    drum += `<g data-cell="${i}"><g class="altimeter-strip">${strip}</g><text class="altimeter-digit altimeter-sign" x="${cx}" y="${DRUM_Y + DRUM_H / 2}" hidden>−</text></g>`;
    if (i) drum += `<line class="altimeter-win-sep" x1="${DRUM_X + 2 + i * DRUM_W}" y1="${DRUM_Y + 4}" x2="${DRUM_X + 2 + i * DRUM_W}" y2="${DRUM_Y + DRUM_H - 4}"/>`;
  }
  const drumW = DRUM_W * 5 + 4;

  const markup = `
<svg xmlns="${NS}" viewBox="0 0 400 400" role="img" aria-label="Höhenmesser">
  <defs>
    <clipPath id="altimeter-drum-clip"><rect x="${DRUM_X}" y="${DRUM_Y}" width="${drumW}" height="${DRUM_H}" rx="5"/></clipPath>
    <pattern id="altimeter-hatch" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect class="altimeter-hatch-b" width="10" height="10"/><rect class="altimeter-hatch-a" width="5" height="10"/>
    </pattern>
  </defs>
  <rect class="altimeter-housing" x="1" y="1" width="398" height="398" rx="34"/>
  ${screws}
  <circle class="altimeter-bezel" cx="200" cy="200" r="194"/>
  <circle class="altimeter-face" cx="200" cy="200" r="183"/>
  ${ticks}${nums}
  <text class="altimeter-lbl" x="158" y="158">ALT</text>
  <text class="altimeter-lbl is-sub" x="242" y="157" data-ref="scale">100 M</text>

  <rect class="altimeter-win" x="${DRUM_X}" y="${DRUM_Y}" width="${drumW}" height="${DRUM_H}" rx="5"/>
  <g clip-path="url(#altimeter-drum-clip)" data-ref="drum">${drum}</g>
  <text class="altimeter-lbl is-sub" x="200" y="298" data-ref="unit">M</text>

  <rect class="altimeter-win" x="264" y="184" width="62" height="32" rx="4"/>
  <path class="altimeter-index" d="M262 200 l-8 -6 v12 z"/>
  <text class="altimeter-kollsman" x="295" y="201" data-ref="kollsman">1013</text>
  <text class="altimeter-tag" x="295" y="178" data-ref="tag">STD</text>
  <text class="altimeter-lbl is-sub" x="295" y="232" style="letter-spacing:1px">hPa</text>

  <g data-ref="flag" hidden>
    <rect x="76" y="186" width="58" height="28" rx="3" fill="url(#altimeter-hatch)" class="altimeter-win" style="fill:url(#altimeter-hatch)"/>
    <text class="altimeter-flag-t" x="105" y="200.5">OFF</text>
  </g>

  <g data-ref="p10k">
    <line class="altimeter-ptr-10k-line" x1="200" y1="200" x2="200" y2="34"/>
    <path class="altimeter-ptr-10k" d="M200 18 L209 36 L191 36 Z"/>
  </g>
  <g data-ref="p1k">
    <path class="altimeter-ptr" d="M200 92 L211 114 L208 206 L192 206 L189 114 Z"/>
  </g>
  <g data-ref="p100">
    <path class="altimeter-ptr" d="M200 36 L205.5 60 L204 214 L196 214 L194.5 60 Z"/>
    <path class="altimeter-ptr" d="M195 214 L205 214 L206.5 244 L193.5 244 Z"/>
  </g>
  <circle class="altimeter-hub" cx="200" cy="200" r="11"/>
  <circle class="altimeter-hub-c" cx="200" cy="200" r="3.5"/>
</svg>`;
  const el = svg(markup);
  const ref = n => el.querySelector(`[data-ref="${n}"]`);
  const cells = [...el.querySelectorAll('[data-cell]')].map(g => ({
    strip: g.querySelector('.altimeter-strip'),
    digits: [...g.querySelectorAll('.altimeter-strip text')],
    sign: g.querySelector('.altimeter-sign'),
    dim: null
  }));
  const r = {
    el, cells,
    p100: ref('p100'), p1k: ref('p1k'), p10k: ref('p10k'),
    drum: ref('drum'), unit: ref('unit'), scale: ref('scale'),
    kollsman: ref('kollsman'), tag: ref('tag'), flag: ref('flag')
  };
  return r;
}

/** Druck in hPa ohne Tausenderpunkt. */
const fmtP = (n, d = 1) => n.toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d, useGrouping: false });

const smooth = x => x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x);
const mod = (a, n) => ((a % n) + n) % n;

/** Zeiger und Trommel auf Wert v (Anzeigeeinheit) stellen. */
function drawInstrument(r, v, valid) {
  r.p100.setAttribute('transform', `rotate(${(mod(v, 1000) / 1000 * 360).toFixed(2)} 200 200)`);
  r.p1k.setAttribute('transform', `rotate(${(mod(v, 10000) / 10000 * 360).toFixed(2)} 200 200)`);
  r.p10k.setAttribute('transform', `rotate(${(mod(v, 100000) / 100000 * 360).toFixed(2)} 200 200)`);

  if (!valid) {
    for (const c of r.cells) { c.strip.setAttribute('hidden', ''); c.sign.removeAttribute('hidden'); c.sign.textContent = '–'; }
    return;
  }
  const neg = v < -0.5;
  // Versatz +0,4: Ziffer rollt um ±0,1 um den Rundungspunkt (x,5)
  const u = Math.min(Math.abs(v), 99999) + 0.4;
  const n = neg ? 4 : 5;
  r.cells.forEach((c, idx) => {
    const isSign = neg && idx === 0;
    c.sign.toggleAttribute('hidden', !isSign);
    c.sign.textContent = '−';
    c.strip.toggleAttribute('hidden', isSign);
    if (isSign) return;
    const i = 4 - idx;              // Stellenwert 10^i
    if (i >= n) return;
    const base = 10 ** i;
    const digit = Math.floor(u / base) % 10;
    const rem = u % base;
    const off = smooth((rem - (base - 0.2)) / 0.2);
    c.strip.setAttribute('transform', `translate(0 ${(-(digit + off) * DIGIT_H).toFixed(2)})`);
    const dim = u < base && i > 0;   // führende Nullen gedämpft
    if (dim !== c.dim) { c.digits.forEach(d => d.classList.toggle('is-dim', dim)); c.dim = dim; }
  });
}

// ===== Werkzeug =====
export function mount(body, ctx) {
  ensureStyle();

  const st = {
    mode: load('altimeter:mode', 'gps') === 'std' ? 'std' : 'gps',
    unit: load('altimeter:unit', 'm') === 'ft' ? 'ft' : 'm',
    cal: load('altimeter:cal', null),          // {qnh, alt, acc, t, p}
    manualText: load('altimeter:manualP', ''),
    sensor: sensorCtor() ? 'idle' : 'none',     // none | idle | starting | active | error
    sensorErr: '',
    sensorP: null, sensorT: 0,
    gps: null, gpsErr: null,
    calRun: null                               // {t0, samples, timer}
  };
  if (st.cal && !(Number.isFinite(st.cal.qnh) && st.cal.qnh > 800 && st.cal.qnh < 1200)) st.cal = null;

  // --- Instrument
  const inst = buildInstrument();
  const instWrap = h('div.altimeter-inst', inst.el);

  // --- Modus-Drehschalter + Einheit
  const optGps = h('button.altimeter-opt', { type: 'button', role: 'radio', onclick: () => setMode('gps') }, h('b', 'GPS'), h('span', 'QNH'));
  const optStd = h('button.altimeter-opt', { type: 'button', role: 'radio', onclick: () => setMode('std') }, h('b', 'STD'), h('span', '1013,25'));
  const knob = h('button.altimeter-knob', {
    type: 'button', 'aria-label': 'Modus umschalten',
    onclick: () => setMode(st.mode === 'gps' ? 'std' : 'gps')
  }, h('i'));
  const modeBox = h('div.altimeter-mode', { role: 'radiogroup', 'aria-label': 'Referenz' }, optGps, knob, optStd);
  const unitSeg = seg([{ value: 'm', label: 'm' }, { value: 'ft', label: 'ft' }], st.unit, v => {
    st.unit = v; save('altimeter:unit', v); render();
  });
  unitSeg.classList.add('altimeter-unit');
  const controls = h('div.altimeter-controls', modeBox, unitSeg);

  // --- Druckquelle
  const pInput = h('input.input.altimeter-input', {
    id: 'altimeter-p', type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: 'z. B. 1008,6',
    value: st.manualText,
    oninput: () => { st.manualText = pInput.value.trim(); save('altimeter:manualP', st.manualText); render(); }
  });
  const manualField = h('div.field', h('label', { for: 'altimeter-p' }, 'Gemessener Druck (hPa)'), pInput);
  const sensorBtn = h('button.btn', { type: 'button', onclick: () => startSensor() }, 'Drucksensor starten');
  const sourceRow = h('div.altimeter-row', manualField, sensorBtn);

  // --- Kalibrierung (GPS-Modus) bzw. Standardhinweis
  const calBtn = h('button.btn.primary.block', { type: 'button', onclick: () => (st.calRun ? stopCal(true) : startCal()) }, 'Höhe per GPS setzen');
  const calBar = h('i');
  const calProg = h('div.progress.altimeter-prog', calBar);
  const calNote = h('p.altimeter-note');
  const calBox = h('div', h('div', { style: { marginTop: '14px' } }, calBtn), calProg, calNote);
  const stdNote = h('p.altimeter-note');
  const srcCard = h('div.card', h('div.card-title', 'Druck und Referenz'), sourceRow, calBox, stdNote);

  // --- Kennzahlen
  const sP = stat('Druck'), sRef = stat('Referenz'), sAlt = stat('Höhe'), sFl = stat('Flugfläche'),
    sGps = stat('GPS-Höhe'), sCal = stat('GPS-Kalibrierung');
  const stats = h('div.stats', sP.el, sRef.el, sAlt.el, sFl.el, sGps.el, sCal.el);

  const banner = h('div.banner.altimeter-banner');

  for (const el of [instWrap, controls, srcCard, stats, banner]) el.classList.add('altimeter-top');
  body.append(instWrap, controls, srcCard, stats, banner);

  // ===== Druck
  let sensor = null, sensorWatchdog = 0;
  function startSensor() {
    if (sensor) sensor.stop();
    st.sensor = 'starting'; st.sensorErr = ''; st.sensorP = null;
    sensor = startPressureSensor(p => {
      const now = performance.now();
      // Leichte Glättung (Zeitkonstante 0,5 s)
      if (st.sensorP == null || now - st.sensorT > 3000) st.sensorP = p;
      else st.sensorP += (p - st.sensorP) * (1 - Math.exp(-(now - st.sensorT) / 500));
      st.sensorT = now;
      if (st.sensor !== 'active') st.sensor = 'active';
      render();
    }, e => {
      st.sensor = 'error';
      st.sensorErr = (e && (e.name === 'NotAllowedError' ? 'Zugriff verweigert' : e.message || e.name)) || 'unbekannter Fehler';
      st.sensorP = null;
      render();
    });
    clearTimeout(sensorWatchdog);
    sensorWatchdog = setTimeout(() => {
      if (st.sensor === 'starting') { st.sensor = 'error'; st.sensorErr = 'keine Messwerte'; render(); }
    }, 4000);
    render();
  }

  function manualP() {
    const v = parseFloat(String(st.manualText).replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(v) && v >= 300 && v <= 1100 ? v : null;
  }

  /** Aktueller Druck {p, src} oder null. */
  function pressure() {
    if (st.sensor === 'active' && st.sensorP != null) return { p: st.sensorP, src: 'Sensor' };
    const m = manualP();
    return m != null ? { p: m, src: 'manuell' } : null;
  }

  function refP() {
    if (st.mode === 'std') return P_STD;
    return st.cal ? st.cal.qnh : null;
  }

  // ===== GPS (Vergleichswert und Kalibrierung)
  let stopGps = null;
  function startGps() {
    if (stopGps) stopGps();
    st.gpsErr = null;
    stopGps = watchPosition(pos => {
      const c = pos.coords;
      st.gps = {
        alt: Number.isFinite(c.altitude) ? c.altitude : null,
        altAcc: Number.isFinite(c.altitudeAccuracy) ? c.altitudeAccuracy : null,
        t: pos.timestamp || Date.now()
      };
      st.gpsErr = null;
      if (st.calRun && st.gps.alt != null) st.calRun.samples.push({ alt: st.gps.alt, acc: st.gps.altAcc });
      render();
    }, err => {
      st.gpsErr = err;
      render();
    });
  }

  const CAL_MAX = 20000, CAL_MIN = 3000, CAL_GOOD = 5;

  function startCal() {
    if (!pressure()) { toast('Zuerst muss ein Druckwert vorliegen'); return; }
    if (st.gpsErr) startGps();
    const run = { t0: performance.now(), samples: [], timer: 0, err: null };
    st.calRun = run;
    run.timer = setInterval(() => {
      const el = performance.now() - run.t0;
      const best = bestAcc(run.samples);
      if (el >= CAL_MAX || (el >= CAL_MIN && best != null && best <= CAL_GOOD)) finishCal();
      else render();
    }, 250);
    render();
  }

  function bestAcc(samples) {
    let b = null;
    for (const s of samples) if (s.acc != null && (b == null || s.acc < b)) b = s.acc;
    return b;
  }

  function stopCal(cancelled) {
    if (!st.calRun) return;
    clearInterval(st.calRun.timer);
    st.calRun = null;
    if (cancelled) toast('Abgebrochen');
    render();
  }

  function finishCal() {
    const run = st.calRun;
    const samples = run.samples;
    const pr = pressure();
    stopCal(false);
    if (!samples.length) {
      st.calMsg = st.gpsErr ? geoErrorText(st.gpsErr) : 'Keine GPS-Höhe erhalten. Freie Sicht zum Himmel verbessert den Empfang.';
      render();
      return;
    }
    if (!pr) { st.calMsg = 'Kein Druckwert – Kalibrierung verworfen.'; render(); return; }
    // Gewichtetes Mittel der besten Proben (Genauigkeit ≤ 1,5 × beste)
    const best = bestAcc(samples);
    let alt;
    if (best == null) {
      alt = samples.reduce((a, s) => a + s.alt, 0) / samples.length;
    } else {
      let sw = 0, sa = 0;
      for (const s of samples) {
        if (s.acc == null || s.acc > best * 1.5) continue;
        const w = 1 / Math.max(s.acc, 0.5) ** 2;
        sw += w; sa += w * s.alt;
      }
      alt = sa / sw;
    }
    st.cal = { qnh: qnhFromAltitude(pr.p, alt), alt, acc: best, t: Date.now(), p: pr.p, src: pr.src };
    st.calMsg = '';
    save('altimeter:cal', st.cal);
    toast('QNH ' + fmtP(st.cal.qnh) + ' hPa gesetzt');
    render();
  }

  // ===== Modus
  function setMode(m) {
    if (m === st.mode) return;
    st.mode = m;
    save('altimeter:mode', m);
    if (m === 'std' && st.calRun) stopCal(true);
    render();
  }

  // ===== Zeigeranimation (kritisch gedämpfte Feder)
  const anim = { x: 0, v: 0, target: 0, valid: false, raf: 0, last: 0 };
  const OMEGA = 7; // 1/s
  function setTarget(t, valid) {
    if (!anim.raf && !anim.inited) { anim.x = t; anim.inited = true; }
    // Große Sprünge (z. B. Einheitenwechsel) verkürzen, damit die Zeiger nicht minutenlang kreisen
    if (Math.abs(t - anim.x) > 2000) { anim.x = t - Math.sign(t - anim.x) * 2000; anim.v = 0; }
    anim.target = t;
    anim.valid = valid;
    if (!anim.raf) { anim.last = 0; anim.raf = requestAnimationFrame(step); }
  }
  function step(ts) {
    const dt = anim.last ? Math.min(0.05, (ts - anim.last) / 1000) : 1 / 60;
    anim.last = ts;
    const a = -OMEGA * OMEGA * (anim.x - anim.target) - 2 * OMEGA * anim.v;
    anim.v += a * dt;
    anim.x += anim.v * dt;
    if (Math.abs(anim.x - anim.target) < 0.005 && Math.abs(anim.v) < 0.01) {
      anim.x = anim.target; anim.v = 0;
      drawInstrument(inst, anim.x, anim.valid);
      anim.raf = 0;
      return;
    }
    drawInstrument(inst, anim.x, anim.valid);
    anim.raf = requestAnimationFrame(step);
  }

  // ===== Darstellung
  const toUnit = m => st.unit === 'ft' ? m / FT : m;
  const U = () => st.unit;
  const timeText = t => {
    const d = new Date(t), now = new Date();
    const hm = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    return d.toDateString() === now.toDateString() ? hm : d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }) + ' ' + hm;
  };

  function render() {
    const pr = pressure();
    const ref = refP();
    const altM = pr && ref ? baroAltitude(pr.p, ref) : null;
    const unit = U();

    // Instrument
    const valid = altM != null;
    setTarget(valid ? toUnit(altM) : 0, valid);
    inst.flag.toggleAttribute('hidden', valid);
    inst.unit.textContent = unit.toUpperCase();
    inst.scale.textContent = unit === 'ft' ? '100 FT' : '100 M';
    inst.tag.textContent = st.mode === 'std' ? 'STD' : 'QNH';
    inst.kollsman.textContent = ref ? String(Math.round(ref)).padStart(4, '0') : '––––';

    // Schalter
    knob.classList.toggle('is-std', st.mode === 'std');
    optGps.classList.toggle('is-active', st.mode === 'gps');
    optStd.classList.toggle('is-active', st.mode === 'std');
    optGps.setAttribute('aria-checked', String(st.mode === 'gps'));
    optStd.setAttribute('aria-checked', String(st.mode === 'std'));
    unitSeg.set(unit);

    // Druckquelle
    const sensorOn = st.sensor === 'active' || st.sensor === 'starting';
    manualField.hidden = sensorOn;
    sensorBtn.hidden = !(st.sensor === 'idle' || st.sensor === 'error');
    sensorBtn.textContent = st.sensor === 'error' ? 'Erneut versuchen' : 'Drucksensor starten';
    sourceRow.hidden = manualField.hidden && sensorBtn.hidden;
    pInput.classList.toggle('is-bad', st.manualText !== '' && manualP() == null);

    // Kalibrierung / STD
    calBox.hidden = st.mode !== 'gps';
    stdNote.hidden = st.mode !== 'std';
    calBox.firstChild.style.marginTop = sourceRow.hidden ? '0' : '14px';
    stdNote.style.marginTop = sourceRow.hidden ? '0' : '';
    if (st.mode === 'gps') {
      const run = st.calRun;
      calBtn.textContent = run ? 'Abbrechen' : (st.cal ? 'Höhe neu per GPS setzen' : 'Höhe per GPS setzen');
      calBtn.classList.toggle('primary', !run);
      calBtn.disabled = !run && !pr;
      calProg.hidden = !run;
      if (run) {
        const el = performance.now() - run.t0;
        calBar.style.width = Math.min(100, el / CAL_MAX * 100).toFixed(1) + '%';
        const last = run.samples[run.samples.length - 1];
        const best = bestAcc(run.samples);
        calNote.replaceChildren(
          `GPS-Fix … ${Math.floor(el / 1000)} / ${CAL_MAX / 1000} s`,
          last ? ` · ${fmt(toUnit(last.alt), 0)} ${unit}` + (best != null ? ` ± ${fmt(toUnit(best), 0)} ${unit}` : '') : ' · warte auf Höhe',
          st.gpsErr ? h('br') : '', st.gpsErr ? geoErrorText(st.gpsErr) : ''
        );
      } else if (!pr) {
        calNote.replaceChildren('Zuerst muss ein Druckwert vorliegen.');
      } else if (st.calMsg) {
        calNote.replaceChildren(st.calMsg);
      } else if (st.cal) {
        const c = st.cal;
        calNote.replaceChildren(
          h('b', `QNH ${fmtP(c.qnh)} hPa`),
          ` aus GPS-Höhe ${fmt(toUnit(c.alt), 0)} ${unit}` + (c.acc != null ? ` ± ${fmt(toUnit(c.acc), 0)} ${unit}` : '') +
          ` · ${timeText(c.t)}. Der Luftdruck ändert sich mit dem Wetter – regelmäßig neu setzen.`
        );
      } else {
        calNote.replaceChildren('Am aktuellen Ort einen GPS-Fix holen; aus Druck und GPS-Höhe wird der Referenzdruck (QNH) berechnet und gemerkt.');
      }
    } else {
      stdNote.replaceChildren(h('b', 'Standarddruck 1013,25 hPa.'), ' Angezeigt wird die Druckhöhe (ISA), Grundlage der Flugflächen.');
    }

    // Kennzahlen
    sP.el.querySelector('.k').textContent = pr ? `Druck · ${pr.src}` : 'Druck';
    sP.set(pr ? fmtP(pr.p) : '–', 'hPa');
    sRef.el.querySelector('.k').textContent = st.mode === 'std' ? 'Referenz · STD' : 'Referenz · QNH';
    sRef.set(ref ? fmtP(ref, st.mode === 'std' ? 2 : 1) : '–', 'hPa');
    sAlt.el.querySelector('.k').textContent = st.mode === 'std' ? 'Druckhöhe' : 'Höhe (QNH)';
    sAlt.set(altM != null ? fmt(toUnit(altM), 0) : '–', unit);
    sFl.set(pr ? flightLevel(pr.p) : '–', '');
    if (st.gps && st.gps.alt != null) {
      sGps.set(fmt(toUnit(st.gps.alt), 0), st.gps.altAcc != null ? `${unit} ± ${fmt(toUnit(st.gps.altAcc), 0)}` : unit);
    } else {
      sGps.set('–', st.gpsErr ? 'kein Fix' : st.gps ? 'keine Höhe' : 'warte …');
    }
    if (st.cal) sCal.set(timeText(st.cal.t), st.cal.acc != null ? `± ${fmt(toUnit(st.cal.acc), 0)} ${unit}` : '');
    else sCal.set('–', '');

    // Sensorstatus
    if (st.sensor === 'none') {
      banner.replaceChildren(h('b', 'Kein Drucksensor im Browser verfügbar.'),
        ' Safari und Chrome geben den Barometer des Geräts nicht an Web-Apps weiter. Druck manuell eingeben, z. B. von einem externen Barometer. GPS-Höhe ist nur Vergleichswert (je nach Gerät über Meeresspiegel oder Ellipsoid).');
    } else if (st.sensor === 'active') {
      banner.replaceChildren(h('b', `Drucksensor aktiv`), ` (${sensor ? sensor.name : 'Sensor'}). GPS-Höhe ist nur Vergleichswert.`);
    } else if (st.sensor === 'starting') {
      banner.replaceChildren('Drucksensor wird gestartet …');
    } else if (st.sensor === 'error') {
      banner.replaceChildren(h('b', 'Drucksensor nicht nutzbar'), ` (${st.sensorErr}). Druck manuell eingeben.`);
    } else {
      banner.replaceChildren(h('b', 'Drucksensor gefunden.'), ' Mit „Drucksensor starten“ freigeben oder Druck manuell eingeben.');
    }
  }

  render();
  drawInstrument(inst, anim.x, anim.valid);
  startGps();
  if (st.sensor === 'idle') startSensor(); // ggf. scheitert das ohne Nutzergeste -> Knopf

  return () => {
    if (anim.raf) cancelAnimationFrame(anim.raf);
    anim.raf = 0;
    clearTimeout(sensorWatchdog);
    if (st.calRun) clearInterval(st.calRun.timer);
    st.calRun = null;
    if (sensor) sensor.stop();
    sensor = null;
    if (stopGps) stopGps();
    stopGps = null;
  };
}
