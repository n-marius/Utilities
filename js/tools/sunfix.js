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
.sunfix-edit .fields { margin-top: 2px; }
.sunfix-edit .sunfix-in { display: flex; gap: 6px; }
.sunfix-edit .sunfix-in .input { flex: 1; min-width: 0; }
.sunfix-edit .sunfix-in .btn { padding: 0 10px; font-size: 14px; }
.sunfix-meta { margin-top: 10px; font-size: 12.5px; color: var(--text-2); line-height: 1.5; font-variant-numeric: tabular-nums; }
.sunfix-foot { font-size: 12px; color: var(--text-2); line-height: 1.45; padding: 0 4px; }
.sunfix-ov { gap: 14px; }
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

  const sPos = stat('Position');
  sPos.el.classList.add('sunfix-pos');
  const dmLine = h('div.sunfix-dm');
  sPos.el.append(dmLine);
  sPos.el.addEventListener('click', () => {
    if (!result || !result.ok) return;
    const c = center();
    if (!result.lonKnown) copyText(c.lat.toFixed(4), 'Breite kopiert');
    else copyText(`${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}`, 'Koordinaten kopiert');
  });
  const sRad = stat('Radius 95 %');
  const sN = stat('Messungen');
  const sDecl = stat('Missweisung');
  const sExtra1 = stat('–'), sExtra2 = stat('–');
  sExtra1.el.hidden = sExtra2.el.hidden = true;
  const stats = h('div.stats', sPos.el, sRad.el, sN.el, sDecl.el, sExtra1.el, sExtra2.el);
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
    'Fehlergrenzen je Messung: Höhe ±(0,5° + Sensor), Azimut ±(0,5° + Sensor). Sensoranteil: doppelte Streuung der letzten Sekunde vor der Erfassung ',
    'plus 0,5° (Neigung) bzw. Kompassgenauigkeit (iOS) oder 5°. Azimut magnetisch gemessen; Missweisung nach WMM2025 an der geschätzten Position. ',
    `Kreis: 95 % von ${MC_RUNS} Monte-Carlo-Lösungen mit gestörten Messwerten. Höhe mit Refraktion (Normalatmosphäre) korrigiert.`);

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
    const decl = result && result.ok ? result.decl : null;
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

  function center() {
    if (result && result.underdetermined && mcRes) return mcRes.center;
    return { lat: result.lat, lon: result.lon };
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
      result = solve(obs, { table: declTable, tzLon: -new Date(tMid).getTimezoneOffset() / 4 });
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

  function renderResult() {
    layer.clearLayers();
    chip.hidden = true;
    sExtra1.el.hidden = sExtra2.el.hidden = true;
    notesEl.textContent = '';
    if (!result || !result.ok) {
      progress.hidden = true;
      sPos.set('–'); dmLine.textContent = rows.length ? (result && result.reason) || '' : 'Noch keine Messung';
      sRad.set('–'); sN.set(String(rows.length)); sDecl.set('–');
      layoutStats();
      return;
    }
    const r = result;
    const c = center();
    sN.set(String(r.nObs));
    sDecl.el.querySelector('.k').textContent = r.lonKnown ? 'Missweisung' : 'Missweisung (geschätzt)';
    sDecl.set(fmtDecl(r.decl));
    const extras = [];
    if (r.dDays != null) {
      const o = r.obs.find(x => !x.hasDate);
      const d = new Date(o.t + r.dDays * DAY);
      extras.push(['Datum (berechnet)', `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.`]);
    }
    if (r.dtMin != null) extras.push(['Uhrkorrektur', `${r.dtMin >= 0 ? '+' : '−'}${fmt(Math.abs(r.dtMin), 0)}`, 'min']);
    [sExtra1, sExtra2].forEach((s, i) => {
      if (!extras[i]) return;
      s.el.hidden = false;
      s.el.querySelector('.k').textContent = extras[i][0];
      s.set(extras[i][1], extras[i][2] || '');
    });
    layoutStats();

    const bounds = [];
    if (r.lonKnown) {
      sPos.set(`${fmt(Math.abs(c.lat), 3)}° ${c.lat >= 0 ? 'N' : 'S'}  ${fmt(Math.abs(c.lon), 3)}° ${c.lon >= 0 ? 'O' : 'W'}`);
      dmLine.textContent = `${fmtDM(c.lat, 'N', 'S')}  ${fmtDM(c.lon, 'O', 'W')}`;
      if (mcRes && Number.isFinite(mcRes.radius)) {
        sRad.set(fmtDist(mcRes.radius));
        const circ = accuracyCircle([c.lat, c.lon], Math.max(mcRes.radius, 2000)).addTo(layer);
        bounds.push(circ);
        r.alternatives.forEach((a, i) => {
          const rad = mcRes.alts[i] && Number.isFinite(mcRes.alts[i].radius) ? mcRes.alts[i].radius : mcRes.radius;
          bounds.push(accuracyCircle([a.lat, a.lon], Math.max(rad, 2000), 'u-alt').addTo(layer));
        });
      } else {
        sRad.set('…');
        r.alternatives.forEach(a => posMarkerAlt(a.lat, a.lon));
      }
      const m = posMarker([c.lat, c.lon]).addTo(layer);
      if (!bounds.length) bounds.push(m);
    } else {
      sPos.set(`${fmt(Math.abs(c.lat), 2)}° ${c.lat >= 0 ? 'N' : 'S'}`, 'Breite');
      dmLine.textContent = `${fmtDM(c.lat, 'N', 'S')} · Länge unbestimmt`;
      chip.textContent = 'Länge unbestimmt (keine Uhrzeit)';
      chip.hidden = false;
      const band = (lat, half, cls) => L.rectangle(
        [[Math.max(-85, lat - half), -180], [Math.min(85, lat + half), 180]],
        { className: cls, interactive: false }).addTo(layer);
      if (mcRes && Number.isFinite(mcRes.latHalf)) {
        sRad.el.querySelector('.k').textContent = 'Breite ±95 %';
        sRad.set(`± ${fmt(mcRes.latHalf, mcRes.latHalf < 10 ? 2 : 1)}°`, `≈ ${fmtDist(mcRes.latHalf * 111195)}`);
        bounds.push(band(c.lat, Math.max(mcRes.latHalf, 0.05), 'u-alt'));
        r.alternatives.forEach((a, i) => band(a.lat, (mcRes.alts[i] && mcRes.alts[i].latHalf) || mcRes.latHalf, 'u-alt'));
      } else {
        sRad.set('…');
      }
      bounds.push(L.polyline([[c.lat, -180], [c.lat, 180]], { className: 'u-track', interactive: false }).addTo(layer));
    }
    if (r.lonKnown) sRad.el.querySelector('.k').textContent = 'Radius 95 %';

    const notes = r.notes.filter(n => !(n.startsWith('Länge unbestimmt')));
    if (mcRes && r.lonKnown && mcRes.radius > 3000000) notes.unshift('Unsicherheit sehr groß – Ergebnis kaum aussagekräftig');
    if (!r.lonKnown) notes.unshift('Ohne Uhrzeit ist die Länge nicht bestimmbar (Erdrotation und Uhrfehler sind ununterscheidbar). Angezeigt ist das Breitenband.');
    if (r.underdetermined && mcRes) notes.push('Angezeigt: Mittelpunkt der möglichen Lösungen');
    for (const n of notes) notesEl.append(h('div.banner' + (/unbestimmt|Unterbestimmt|schlecht|groß|Mehrdeutig/.test(n) ? '.warn' : ''), n));

    if (bounds.length) {
      const fg = L.featureGroup(bounds);
      try {
        const b = fg.getBounds();
        if (b.isValid()) mapApi.map.fitBounds(b, { padding: [24, 24], maxZoom: 9, animate: false });
      } catch { /* leer */ }
    }
  }

  /** Ungerade Kachelzahl: letzte Kachel über die volle Breite. */
  function layoutStats() {
    const vis = [sRad, sN, sDecl, sExtra1, sExtra2].filter(s => !s.el.hidden);
    vis.forEach((s, i) => s.el.classList.toggle('sunfix-wide', vis.length % 2 === 1 && i === vis.length - 1));
  }

  function posMarkerAlt(lat, lon) {
    L.circleMarker([lat, lon], { radius: 6, className: 'u-alt', interactive: false }).addTo(layer);
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
