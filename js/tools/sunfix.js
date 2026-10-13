// Sonnenortung: Position aus Peilungen der Sonne (Höhe + Azimut über die Lagesensoren) und Zeit, ohne GPS.
//
// Peilrichtung ist die Geräte-y-Achse (Oberkante). Aus rotationMatrix (Gerät -> ENU) ist deren
// Erdrichtung Spalte 2: Höhe = asin(Up) (= beta), Azimut = atan2(Ost, Nord) (= −alpha bei |beta| < 90°).
// Nordbezug (magnetisch):
//  - Android/Chrome: 'deviceorientationabsolute', alpha bezieht sich auf magnetisch Nord.
//  - iOS: alpha ist relativ (beliebige, aber gyro-stabile Nullrichtung). webkitCompassHeading (CLHeading)
//    gilt bei flacher bis mittlerer Haltung für die Oberkante; bei steil aufgerichtetem Gerät bezieht iOS
//    den Kurs vermutlich auf die Rückseite (Kamerarichtung). Ohne seitliche Neigung (gamma ≈ 0) liegen
//    Oberkante und Rückseitennormale in derselben Vertikalebene, beide Deutungen liefern denselben Azimut.
//    Annahme hier: Nordversatz = webkitCompassHeading − Azimut(alpha) wird nur bei |beta| < 60° und
//    |gamma| < 15° nachgeführt (zirkulär geglättet) und dann auf den gyro-gestützten alpha-Azimut
//    angewandt. Liegt noch kein Abgleich vor, wird webkitCompassHeading direkt verwendet.
// Unsicherheit je Messung (Grenzen, nicht σ):
//  - Höhe:   eh = 0,5° (Ausrichtung) + 2·Std.-Abw. der Samples + 0,5° (Grundannahme Neigungssensorik)
//  - Azimut: eZ = 0,5° (Ausrichtung) + 2·zirk. Std.-Abw. + webkitCompassAccuracy (iOS) bzw. 5° (Grundannahme)

import { h, svg, toast, copyText, seg, stat, fmt, fmtDist, beep } from '../lib/ui.js';
import { ensureMotionPermission, watchOrientation, rotationMatrix } from '../lib/sensors.js';
import { meanAngle, circStd, mean, std, wrap360, wrap180, R2D, D2R } from '../lib/geo.js';
import { createMap, posMarker, accuracyCircle } from '../lib/map.js';
import { declination } from '../lib/magdecl.js';
import { load, save } from '../lib/store.js';
import { solve, monteCarlo, rowToObs, makeDeclTable } from './sunfix/solver.js';

const KEY_ROWS = 'sunfix:rows';
const KEY_SET = 'sunfix:settings';
const COUNTDOWN = 5;
const WINDOW_MS = 1000;
const BASE_TILT = 0.5, BASE_COMPASS = 5, AIM = 0.5;
const MC_RUNS = 200;

const STYLE = `
.tool-body > .sunfix-x { flex-shrink: 0; }
.sunfix-map { height: 36vh; min-height: 230px; }
.sunfix-chip { position: absolute; left: 10px; bottom: 10px; z-index: 500; background: var(--surface); color: var(--text);
  border: 1px solid var(--line-strong); border-radius: 8px; padding: 5px 9px; font-size: 12px; font-weight: 500; }
.sunfix-pos { grid-column: 1 / -1; cursor: pointer; }
.sunfix-pos .v { font-size: 19px; }
.sunfix-dm { font-size: 13px; color: var(--text-2); font-variant-numeric: tabular-nums; margin-top: 1px; }
.sunfix-num { background: var(--surface); color: var(--text); border: 1px solid var(--line-strong); border-radius: 10px;
  font: 600 12px/18px var(--font); text-align: center; }
.sunfix-notes { display: flex; flex-direction: column; gap: 4px; }
.sunfix-set { display: grid; grid-template-columns: 46px 1fr; align-items: center; gap: 10px 10px; }
.sunfix-set > label { font-size: 14px; color: var(--text-2); }
.sunfix-manual { grid-column: 2; display: flex; align-items: center; gap: 10px; }
.sunfix-manual .input { flex: 1; min-width: 0; }
.sunfix-utc { font-size: 12px; color: var(--text-2); font-variant-numeric: tabular-nums; white-space: nowrap; }
.sunfix-next { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--line); font-size: 13px; color: var(--text-2); font-variant-numeric: tabular-nums; }
.sunfix-bar { display: flex; align-items: center; gap: 12px; padding: 0 2px; }
.sunfix-bar .sunfix-plus { width: 60px; height: 60px; font-size: 34px; font-weight: 300; }
.sunfix-bar .sunfix-minus { font-weight: 300; }
.sunfix-bar .sunfix-spacer { flex: 1; }
.sunfix-bar .sunfix-clear { font-size: 15px; padding: 9px 14px; }
.sunfix-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
.sunfix-table th, .sunfix-table td { padding: 9px 6px; }
.sunfix-table th:first-child, .sunfix-table td:first-child { padding-left: 12px; }
.sunfix-table th:last-child, .sunfix-table td:last-child { padding-right: 12px; }
.sunfix-table td { vertical-align: top; }
.sunfix-table tbody tr { cursor: pointer; }
.sunfix-table td small { display: block; font-size: 11px; color: var(--text-2); }
.sunfix-table .r { text-align: right; }
.sunfix-table th.nt { text-transform: none; font-size: 12px; }
.stats > .stat.sunfix-wide { grid-column: 1 / -1; }
.sunfix-table .nil { color: var(--text-3); }
.sunfix-table tr.sunfix-empty td { text-align: center; color: var(--text-2); padding: 20px 12px; white-space: normal; cursor: default; }
.sunfix-edit .fields { margin-top: 2px; grid-template-columns: 1fr; }
.sunfix-edit .sunfix-in { display: flex; gap: 6px; }
.sunfix-edit .sunfix-in .input { flex: 1; min-width: 0; }
.sunfix-edit .sunfix-in .btn { padding: 0 10px; font-size: 14px; }
.sunfix-meta { margin-top: 10px; font-size: 12.5px; color: var(--text-2); line-height: 1.5; font-variant-numeric: tabular-nums; }
.sunfix-foot { font-size: 12px; color: var(--text-2); line-height: 1.45; padding: 0 4px; }
.sunfix-ov { gap: 14px; -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px); }
.sunfix-ov svg { width: 74px; height: 74px; opacity: .9; }
.sunfix-ov-hint { font-size: 20px; font-weight: 600; max-width: 320px; }
.sunfix-count { font-size: 128px; font-weight: 200; line-height: 1; font-variant-numeric: tabular-nums; }
.sunfix-live { font-size: 17px; font-variant-numeric: tabular-nums; min-height: 24px; }
.sunfix-ov-note { font-size: 14px; max-width: 330px; opacity: .78; line-height: 1.45; }
.sunfix-ov .btn { background: transparent; color: inherit; border-color: currentColor; margin-top: 10px; min-width: 150px; }
`;

const AIM_ICON = `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
<circle cx="47" cy="12" r="5"/><path d="M47 2.5v2M47 19.5v2M37.5 12h2M54.5 12h2"/>
<rect x="17" y="24" width="16" height="30" rx="3" transform="rotate(38 25 39)"/>
<path d="M31 30l9-10" stroke-dasharray="2 3"/></svg>`;

const DAY = 86400000;
const pad = n => String(n).padStart(2, '0');
const localDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = d => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const deDate = iso => { const [y, m, d] = iso.split('-'); return `${d}.${m}.${y}`; };
const deDateShort = iso => { const [, m, d] = iso.split('-'); return `${d}.${m}.`; };
const utcTime = d => `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
const utcDate = d => `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.`;

function fmtDM(v, pos, neg) {
  const a = Math.abs(v);
  let d = Math.floor(a), m = (a - d) * 60;
  if (m >= 59.95) { d++; m = 0; }
  return `${d}° ${fmt(m, 1).padStart(4, '0')}′ ${v >= 0 ? pos : neg}`;
}
const fmtDecl = d => `${fmt(Math.abs(d), 1)}° ${d >= 0 ? 'O' : 'W'}`;

export function mount(body) {
  if (!document.getElementById('style-sunfix')) {
    document.head.append(h('style#style-sunfix', STYLE));
  }

  let rows = load(KEY_ROWS, []);
  if (!Array.isArray(rows)) rows = [];
  const set = Object.assign({ dateMode: 'auto', timeMode: 'auto', dayOffset: 0, timeOffset: 0 }, load(KEY_SET, {}));
  let selected = null;
  let result = null, mcRes = null;
  let token = 0, recalcTimer = 0;
  let declTable = null, declYear = null;
  const timers = new Set();

  // ---------- Karte + Ergebnis ----------
  const mapEl = h('div.map.sunfix-map');
  const chip = h('div.sunfix-chip', { hidden: true });
  mapEl.append(chip);

  const stats = h('div.stats');
  const progress = h('div.progress', { hidden: true }, h('i'));
  const notesEl = h('div.sunfix-notes');

  // ---------- Datum/Zeit-Einstellungen ----------
  const modes = [{ value: 'auto', label: 'Auto' }, { value: 'manual', label: 'Manuell' }, { value: 'empty', label: 'Leer' }];
  const dateIn = h('input.input', { type: 'date', onchange: onDateInput });
  const timeIn = h('input.input', { type: 'time', step: 1, onchange: onTimeInput });
  const dateUtc = h('span.sunfix-utc'), timeUtc = h('span.sunfix-utc');
  const dateRow = h('div.sunfix-manual', dateIn, dateUtc);
  const timeRow = h('div.sunfix-manual', timeIn, timeUtc);
  const dateSeg = seg(modes, set.dateMode, v => { set.dateMode = v; saveSet(); tick(); });
  const timeSeg = seg(modes, set.timeMode, v => { set.timeMode = v; saveSet(); tick(); });
  const nextLine = h('div.sunfix-next');
  const setCard = h('div.card',
    h('div.sunfix-set',
      h('label', 'Datum'), dateSeg, dateRow,
      h('label', 'Zeit'), timeSeg, timeRow),
    nextLine);

  // ---------- Knopfleiste + Tabelle ----------
  const plusBtn = h('button.btn.round.primary.sunfix-plus', { type: 'button', 'aria-label': 'Neue Messung', onclick: startMeasure }, '+');
  const minusBtn = h('button.btn.round.sunfix-minus', { type: 'button', 'aria-label': 'Ausgewählte Messung entfernen', onclick: removeSelected }, '−');
  const clearBtn = h('button.btn.danger.sunfix-clear', { type: 'button', onclick: clearAll }, 'Alle löschen');
  const bar = h('div.sunfix-bar', plusBtn, minusBtn, h('div.sunfix-spacer'), clearBtn);
  const tbody = h('tbody');
  const table = h('table.table.sunfix-table',
    h('thead', h('tr', h('th', 'Nr.'), h('th', 'Datum'), h('th', 'Zeit'), h('th.r', 'Höhe'),
      h('th.r', 'Azimut'), h('th.r.nt', '±h'), h('th.r.nt', '±Az'))),
    tbody);
  const tableCard = h('div.card.flush', h('div.sunfix-wrap', table));
  const editCard = h('div.card.sunfix-edit', { hidden: true });
  const sensorBanner = h('div.banner.warn', { hidden: true });

  const foot = h('p.sunfix-foot',
    'Fehlergrenze je Messung: Höhe ±(0,5° + Sensor), Azimut ±(0,5° + Sensor). ',
    'Sensor-Anteil Höhe: doppelte Standardabweichung der Werte in der letzten Sekunde vor der Erfassung + 0,5° Grundannahme Neigungssensor. ',
    'Sensor-Anteil Azimut: doppelte Standardabweichung + Kompassgenauigkeit des Geräts (iOS) bzw. 5° Grundannahme. ',
    'Azimut wird magnetisch gemessen; Missweisung nach WMM2025 an der jeweiligen Lösung. Höhe mit Refraktion (Normalatmosphäre) korrigiert. ',
    `Kreis: 95 % von ${MC_RUNS} Monte-Carlo-Lösungen, Messwerte gleichverteilt innerhalb dieser Fehlergrenzen gestört, je Lösung ausgewertet. `,
    'Lösungen, deren Güte sich statistisch nicht unterscheidet (Δχ² < 4), werden alle gleichrangig angezeigt.');

  const parts = [mapEl, stats, progress, notesEl, h('div.section-title', 'Messungen'),
    setCard, sensorBanner, bar, tableCard, editCard, foot];
  for (const p of parts) p.classList.add('sunfix-x');
  body.append(...parts);

  const mapApi = createMap(mapEl, { zoom: 3 });
  const L = window.L;
  const layer = L.featureGroup().addTo(mapApi.map);

  // ---------- Einstellungen ----------
  function saveSet() { save(KEY_SET, set); }

  /** Effektiver Zeitpunkt für die nächste Messung (Geräteuhr + manuelle Korrekturen). */
  function effective(now = Date.now()) {
    const d = new Date(now + (set.timeMode === 'manual' ? set.timeOffset : 0));
    if (set.dateMode === 'manual') d.setDate(d.getDate() + set.dayOffset);
    return d;
  }

  function onDateInput() {
    if (!dateIn.value) return;
    const [y, m, d] = dateIn.value.split('-').map(Number);
    const cur = new Date(Date.now() + (set.timeMode === 'manual' ? set.timeOffset : 0));
    const a = Date.UTC(y, m - 1, d), b = Date.UTC(cur.getFullYear(), cur.getMonth(), cur.getDate());
    set.dayOffset = Math.round((a - b) / DAY);
    saveSet(); tick();
  }

  function onTimeInput() {
    if (!timeIn.value) return;
    const [H, M, S = 0] = timeIn.value.split(':').map(Number);
    const now = new Date();
    const cur = (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) * 1000 + now.getMilliseconds();
    let off = (H * 3600 + M * 60 + S) * 1000 - cur;
    off = ((off + 12 * 3600000) % DAY + DAY) % DAY - 12 * 3600000;
    set.timeOffset = off;
    saveSet(); tick();
  }

  function tick() {
    const e = effective();
    dateRow.hidden = set.dateMode !== 'manual';
    timeRow.hidden = set.timeMode !== 'manual';
    if (document.activeElement !== dateIn) dateIn.value = localDate(e);
    if (document.activeElement !== timeIn) timeIn.value = localTime(e);
    dateUtc.textContent = 'UTC ' + utcDate(e);
    timeUtc.textContent = 'UTC ' + utcTime(e);
    const dTxt = set.dateMode === 'empty' ? 'ohne Datum' : deDate(localDate(e));
    const tTxt = set.timeMode === 'empty' ? 'ohne Uhrzeit' : localTime(e);
    const uTxt = set.timeMode === 'empty' ? '' : ` (UTC ${set.dateMode === 'empty' ? '' : utcDate(e) + ' '}${utcTime(e)})`;
    nextLine.textContent = `Nächste Messung: ${dTxt} · ${tTxt}${uTxt}`;
  }
  tick();
  const tickTimer = setInterval(tick, 1000);

  // ---------- Tabelle ----------
  function persist() { save(KEY_ROWS, rows); }

  function renderTable() {
    tbody.textContent = '';
    const decl = result && result.ok && result.solutions.length === 1 ? result.decl : null;
    if (!rows.length) {
      tbody.append(h('tr.sunfix-empty', h('td', { colSpan: 7 }, 'Noch keine Messungen. Mit + messen.')));
    }
    rows.forEach((r, i) => {
      const azCell = decl != null
        ? h('td.r', `${fmt(wrap360(r.az + decl), 1)}°`, h('small', `${fmt(r.az, 1)}° m`))
        : h('td.r', `${fmt(r.az, 1)}°`, h('small', 'mag.'));
      const tr = h('tr',
        { onclick: () => { selected = selected === r.id ? null : r.id; renderTable(); } },
        h('td', String(i + 1)),
        r.date ? h('td', deDateShort(r.date)) : h('td.nil', '–'),
        r.time ? h('td', r.time) : h('td.nil', '–'),
        h('td.r', `${fmt(r.h, 1)}°`),
        azCell,
        h('td.r', fmt(r.eh, 1)),
        h('td.r', fmt(r.eZ, 1)));
      if (r.id === selected) tr.classList.add('is-selected');
      tbody.append(tr);
    });
    minusBtn.disabled = !rows.some(r => r.id === selected);
    clearBtn.disabled = !rows.length;
    renderEditor();
  }

  function renderEditor() {
    const i = rows.findIndex(r => r.id === selected);
    editCard.textContent = '';
    if (i < 0) { editCard.hidden = true; return; }
    editCard.hidden = false;
    const r = rows[i];
    const dIn = h('input.input', { type: 'date', value: r.date || '' });
    const tIn = h('input.input', { type: 'time', step: 1, value: r.time || '' });
    const apply = () => {
      r.date = dIn.value || null;
      r.time = tIn.value ? (tIn.value.length === 5 ? tIn.value + ':00' : tIn.value) : null;
      persist(); renderTable(); scheduleRecalc();
    };
    dIn.addEventListener('change', apply);
    tIn.addEventListener('change', apply);
    const cap = new Date(r.ts);
    editCard.append(
      h('div.card-title', `Messung ${i + 1}`),
      h('div.fields',
        h('div.field', h('label', 'Datum (Ortszeit)'),
          h('div.sunfix-in', dIn, h('button.btn', { type: 'button', onclick: () => { dIn.value = ''; apply(); } }, 'Leer'))),
        h('div.field', h('label', 'Uhrzeit (Ortszeit)'),
          h('div.sunfix-in', tIn, h('button.btn', { type: 'button', onclick: () => { tIn.value = ''; apply(); } }, 'Leer')))),
      h('div.sunfix-meta',
        h('div', `Erfasst (Geräteuhr): ${deDate(localDate(cap))} ${localTime(cap)}`),
        h('div', `Höhe ${fmt(r.h, 2)}° ± ${fmt(r.eh, 2)}° (Sensor ${fmt(r.sh, 2)}°) · Azimut ${fmt(r.az, 1)}° mag. ± ${fmt(r.eZ, 1)}° (Sensor ${fmt(r.sZ, 1)}°)`),
        h('div', `${r.n} Samples${r.src === 'ios' ? ' · Kompass iOS' : r.src === 'ios-direct' ? ' · Kompass iOS (ohne Abgleich)' : r.src === 'abs' ? ' · absolute Lage' : ''}`))
    );
  }

  function removeSelected() {
    const i = rows.findIndex(r => r.id === selected);
    if (i < 0) return;
    rows.splice(i, 1);
    selected = null;
    persist(); renderTable(); scheduleRecalc();
  }

  function clearAll() {
    if (!rows.length) return;
    if (!confirm('Alle Messungen löschen?')) return;
    rows = []; selected = null;
    persist(); renderTable(); scheduleRecalc();
  }

  // ---------- Berechnung ----------
  function scheduleRecalc() {
    clearTimeout(recalcTimer);
    recalcTimer = setTimeout(recalc, 250);
  }

  async function recalc() {
    const my = ++token;
    mcRes = null;
    if (!rows.length) { result = null; renderResult(); renderTable(); return; }
    const obs = rows.map(rowToObs);
    const tMid = obs.map(o => o.t).sort((a, b) => a - b)[obs.length >> 1];
    const year = new Date(tMid).getUTCFullYear();
    if (!declTable || declYear !== year) { declTable = makeDeclTable(declination, new Date(tMid)); declYear = year; }
    try {
      result = solve(obs, { table: declTable });
      result.obs = obs;
    } catch (e) {
      console.error(e);
      result = { ok: false, reason: 'Berechnung fehlgeschlagen' };
    }
    renderResult(); renderTable();
    if (!result.ok) return;
    progress.hidden = false;
    const bar = progress.firstChild;
    bar.style.width = '0%';
    const res = await monteCarlo(obs, result, {
      runs: MC_RUNS, chunk: 8,
      isCancelled: () => my !== token,
      onProgress: f => { bar.style.width = Math.round(f * 100) + '%'; }
    });
    if (my !== token || !res) return;
    progress.hidden = true;
    mcRes = res;
    renderResult();
  }

  /** Kennzahl-Kachel (ui.stat) mit optionalen Zusatzzeilen. */
  function tile(label, value, unit = '', wide = false, ...lines) {
    const t = stat(label, value, unit);
    if (wide) t.el.classList.add('sunfix-wide');
    for (const l of lines) if (l) t.el.append(h('div.sunfix-dm', l));
    return t.el;
  }

  function renderResult() {
    layer.clearLayers();
    chip.hidden = true;
    notesEl.textContent = '';
    stats.textContent = '';
    if (!result || !result.ok) {
      progress.hidden = true;
      stats.append(
        tile('Position', '–', '', true, rows.length ? (result && result.reason) || '' : 'Noch keine Messung'),
        tile('Radius 95 %', '–'), tile('Messungen', String(rows.length)));
      return;
    }
    const r = result;
    const multi = r.solutions.length > 1;
    // gleichwertige Lösungen mit eigener Streuung (Cluster des Monte Carlo)
    const sols = r.solutions.map((s, i) => {
      const c = mcRes && mcRes.per[i];
      return { ...s, lat: c ? c.lat : s.lat, lon: c ? c.lon : s.lon, radius: c ? c.radius : NaN, latHalf: c ? c.latHalf : NaN };
    });
    const dateOf = s => {
      if (s.dDays == null) return null;
      const o = r.obs.find(x => !x.hasDate);
      const d = new Date(o.t + s.dDays * DAY);
      return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.`;
    };
    const dtOf = s => s.dtMin == null ? null : `${s.dtMin >= 0 ? '+' : '−'}${fmt(Math.abs(s.dtMin), 0)} min`;
    const radOf = s => !mcRes ? '…' : r.lonKnown
      ? (Number.isFinite(s.radius) ? fmtDist(s.radius) : '–')
      : (Number.isFinite(s.latHalf) ? `± ${fmt(s.latHalf, s.latHalf < 10 ? 2 : 1)}°` : '–');
    const declLabel = r.lonKnown ? 'Missweisung' : 'Missweisung (geschätzt)';
    const posText = s => r.lonKnown
      ? `${fmt(Math.abs(s.lat), 3)}° ${s.lat >= 0 ? 'N' : 'S'}  ${fmt(Math.abs(s.lon), 3)}° ${s.lon >= 0 ? 'O' : 'W'}`
      : `${fmt(Math.abs(s.lat), 2)}° ${s.lat >= 0 ? 'N' : 'S'}`;
    const dmText = s => r.lonKnown ? `${fmtDM(s.lat, 'N', 'S')}  ${fmtDM(s.lon, 'O', 'W')}` : `${fmtDM(s.lat, 'N', 'S')} · Länge unbestimmt`;
    const copy = s => r.lonKnown
      ? copyText(`${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}`, 'Koordinaten kopiert')
      : copyText(s.lat.toFixed(4), 'Breite kopiert');

    sols.forEach((s, i) => {
      const details = multi ? [
        `${r.lonKnown ? 'Radius 95 %' : 'Breite ±95 %'} ${radOf(s)} · ${declLabel} ${fmtDecl(s.decl)}`,
        [dateOf(s) && `Datum (berechnet) ${dateOf(s)}`, dtOf(s) && `Uhrkorrektur ${dtOf(s)}`].filter(Boolean).join(' · ')
      ] : [];
      const el = tile(multi ? `Lösung ${i + 1}` : 'Position', posText(s), '', true, dmText(s), ...details);
      el.classList.add('sunfix-pos');
      el.addEventListener('click', () => copy(s));
      stats.append(el);
    });
    const tiles = [];
    if (multi) {
      tiles.push(tile('Lösungen', String(sols.length)), tile('Messungen', String(r.nObs)));
    } else {
      const s = sols[0];
      tiles.push(tile(r.lonKnown ? 'Radius 95 %' : 'Breite ±95 %', radOf(s), '', false),
        tile('Messungen', String(r.nObs)), tile(declLabel, fmtDecl(s.decl)));
      if (dateOf(s)) tiles.push(tile('Datum (berechnet)', dateOf(s)));
      if (dtOf(s)) tiles.push(tile('Uhrkorrektur', dtOf(s)));
      if (!r.lonKnown && mcRes && Number.isFinite(s.latHalf)) tiles[0].querySelector('.v').append(h('small', `≈ ${fmt(s.latHalf * 111.195, 0)} km`));
    }
    if (tiles.length % 2) tiles[tiles.length - 1].classList.add('sunfix-wide');
    stats.append(...tiles);

    // Karte: jede gleichwertige Lösung mit eigenem Punkt und eigenem 95-%-Bereich
    const bounds = [];
    const label = (s, i) => {
      if (!multi) return;
      L.marker([s.lat, r.lonKnown ? s.lon : mapApi.map.getCenter().lng], {
        icon: L.divIcon({ className: 'sunfix-num', html: String(i + 1), iconSize: [20, 20], iconAnchor: [-6, 24] }),
        interactive: false, keyboard: false
      }).addTo(layer);
    };
    if (r.lonKnown) {
      sols.forEach((s, i) => {
        if (mcRes && Number.isFinite(s.radius)) bounds.push(accuracyCircle([s.lat, s.lon], Math.max(s.radius, 2000)).addTo(layer));
        const m = posMarker([s.lat, s.lon]).addTo(layer);
        if (!mcRes) bounds.push(m);
        label(s, i);
      });
    } else {
      chip.textContent = 'Länge unbestimmt (keine Uhrzeit)';
      chip.hidden = false;
      let lo = 90, hi = -90;
      sols.forEach((s, i) => {
        const half = Number.isFinite(s.latHalf) ? Math.max(s.latHalf, 0.05) : 0;
        if (mcRes && half) {
          L.rectangle([[Math.max(-85, s.lat - half), -180], [Math.min(85, s.lat + half), 180]],
            { className: 'u-acc', interactive: false }).addTo(layer);
        }
        L.polyline([[s.lat, -180], [s.lat, 180]], { className: 'u-track', interactive: false }).addTo(layer);
        label(s, i);
        lo = Math.min(lo, s.lat - Math.max(half * 1.5, 4));
        hi = Math.max(hi, s.lat + Math.max(half * 1.5, 4));
      });
      // großer Ausschnitt um die aktuelle Kartenmitte, alle Bänder sichtbar
      const lon0 = mapApi.map.getCenter().lng;
      const span = Math.min(170, Math.max(12, hi - lo));
      bounds.push(L.rectangle([[Math.max(-85, lo), lon0 - span], [Math.min(85, hi), lon0 + span]], { interactive: false }));
    }

    const notes = r.notes.slice();
    if (mcRes && r.lonKnown && sols.some(s => s.radius > 3000000)) notes.unshift('Unsicherheit sehr groß – Ergebnis kaum aussagekräftig');
    if (r.underdetermined && mcRes) notes.push('Angezeigt: Mittelpunkt der möglichen Lösungen');
    if (mcRes && mcRes.per.some(c => c.sparse)) notes.push('Für mindestens eine Lösung zu wenige Monte-Carlo-Treffer – Radius vorsichtig übernommen');
    for (const n of notes) notesEl.append(h('div.banner' + (/nicht bestimmbar|Unterbestimmt|schlecht|groß|Mehrdeutig|wenige/.test(n) ? '.warn' : ''), n));

    if (bounds.length) {
      const fg = L.featureGroup(bounds);
      try {
        const b = fg.getBounds();
        if (b.isValid()) mapApi.map.fitBounds(b, { padding: [24, 24], maxZoom: 9, animate: false });
      } catch { /* leer */ }
    }
  }

  // ---------- Messung ----------
  let stopWatch = null;
  const samples = [];
  let calS = 0, calC = 0, calN = 0; // Nordabgleich iOS (zirkulär geglättet)
  let liveCb = null;

  function onOrientation(e) {
    if (e.beta == null) return;
    const R = rotationMatrix(e.alpha, e.beta, e.gamma);
    const alt = Math.asin(Math.max(-1, Math.min(1, R[7]))) * R2D;
    const azRel = wrap360(Math.atan2(R[1], R[4]) * R2D);
    let az = null, src = null;
    if (e.absolute && e.alpha != null) {
      az = azRel; src = 'abs';
    } else if (e.heading != null) {
      if (Math.abs(e.beta) < 60 && Math.abs(e.gamma || 0) < 15) {
        const off = wrap180(e.heading - azRel) * D2R;
        const k = 0.15;
        calS = calN ? calS * (1 - k) + Math.sin(off) * k : Math.sin(off);
        calC = calN ? calC * (1 - k) + Math.cos(off) * k : Math.cos(off);
        calN++;
      }
      if (calN) { az = wrap360(azRel + Math.atan2(calS, calC) * R2D); src = 'ios'; }
      else { az = e.heading; src = 'ios-direct'; }
    }
    const s = { t: performance.now(), alt, az, acc: e.headingAccuracy, src };
    samples.push(s);
    while (samples.length && samples[0].t < s.t - 4000) samples.shift();
    if (liveCb) liveCb(s);
  }

  function startWatch() {
    if (!stopWatch) stopWatch = watchOrientation(onOrientation);
  }

  let overlay = null;
  async function startMeasure() {
    if (overlay) return;
    beep(880, 1, 0.0001); // Audio noch innerhalb der Nutzergeste freischalten (iOS)
    const ok = await ensureMotionPermission();
    if (!ok) {
      sensorBanner.hidden = false;
      sensorBanner.textContent = 'Keine Freigabe für die Lagesensoren. Ohne Sensoren ist keine Peilung möglich.';
      return;
    }
    startWatch();
    beep(880, 90);

    const count = h('div.sunfix-count', String(COUNTDOWN));
    const live = h('div.sunfix-live', 'Warte auf Sensordaten …');
    overlay = h('div.overlay.sunfix-ov', { role: 'dialog', 'aria-label': 'Messung' },
      svg(AIM_ICON),
      h('div.sunfix-ov-hint', 'Gerät hochkant halten, Oberkante zur Sonne ausrichten'),
      count, live,
      h('div.sunfix-ov-note', 'Nicht in die Sonne schauen. Schattenmethode: Gerät so drehen und neigen, dass die Oberkante keinen Schatten auf die Hand wirft.'),
      h('button.btn', { type: 'button', onclick: () => finish(false) }, 'Abbrechen'));
    document.body.append(overlay);

    liveCb = s => {
      live.textContent = `Höhe ${fmt(s.alt, 1)}° · Azimut ${s.az == null ? '–' : fmt(s.az, 0) + '°'} mag.`;
    };
    const t0 = performance.now();
    let shown = COUNTDOWN;
    const iv = setInterval(() => {
      const rem = COUNTDOWN - (performance.now() - t0) / 1000;
      const sec = Math.max(0, Math.ceil(rem));
      if (sec !== shown) {
        shown = sec;
        count.textContent = String(sec);
        if (sec > 0) beep(880, 90);
      }
      if (rem <= 0) finish(true);
    }, 50);
    timers.add(iv);

    function finish(capture) {
      clearInterval(iv); timers.delete(iv);
      liveCb = null;
      if (overlay) { overlay.remove(); overlay = null; }
      if (!capture) return;
      beep(1320, 260);
      takeSample();
    }
  }

  function takeSample() {
    const now = performance.now();
    const win = samples.filter(s => s.t >= now - WINDOW_MS);
    if (win.length < 3) {
      sensorBanner.hidden = false;
      sensorBanner.textContent = 'Keine Lagesensordaten empfangen. Dieses Gerät oder dieser Browser liefert keine Ausrichtung.';
      toast('Messung fehlgeschlagen');
      return;
    }
    const withAz = win.filter(s => s.az != null);
    if (!withAz.length) {
      sensorBanner.hidden = false;
      sensorBanner.textContent = 'Kein Kompass verfügbar (keine absolute Ausrichtung). Ohne Himmelsrichtung ist keine Ortung möglich.';
      toast('Messung fehlgeschlagen');
      return;
    }
    sensorBanner.hidden = true;
    const hs = win.map(s => s.alt);
    const azs = withAz.map(s => s.az);
    const accs = withAz.map(s => s.acc).filter(a => a != null && a >= 0);
    const alt = mean(hs);
    const az = meanAngle(azs);
    const sh = 2 * std(hs) + BASE_TILT;
    const sZ = 2 * (azs.length > 1 ? circStd(azs) : 0) + (accs.length ? mean(accs) : BASE_COMPASS);
    const e = effective();
    const row = {
      id: Date.now(),
      ts: Date.now(),
      date: set.dateMode === 'empty' ? null : localDate(e),
      time: set.timeMode === 'empty' ? null : localTime(e),
      h: alt, az, sh, sZ,
      // Fehlergrenzen exakt 0,5° (Ausrichtung) + Sensor; so gehen sie in Ausgleich (Normierung) und Monte Carlo (±eh/±eZ) ein
      eh: AIM + sh, eZ: AIM + sZ,
      n: win.length, src: withAz[withAz.length - 1].src
    };
    rows.push(row);
    selected = null;
    persist(); renderTable(); scheduleRecalc();
    if (alt < 2) toast('Sonne sehr tief – Refraktion unsicher', 2600);
    else if (alt > 70) toast('Sonne sehr hoch – Azimut unsicher', 2600);
    else toast(`Messung ${rows.length} gespeichert`);
  }

  renderTable();
  renderResult();
  recalc();

  return () => {
    token++;
    clearTimeout(recalcTimer);
    clearInterval(tickTimer);
    for (const t of timers) clearInterval(t);
    timers.clear();
    if (overlay) { overlay.remove(); overlay = null; }
    liveCb = null;
    if (stopWatch) { stopWatch(); stopWatch = null; }
    mapApi.map.remove();
  };
}
