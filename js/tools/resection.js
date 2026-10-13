// Kreuzpeilung: Standort aus Kompasspeilungen auf bekannte Ziele (Rückwärtseinschnitt), ohne GPS.
// Rechenkern (ohne DOM): ./resection/solve.js. Bedienung und Messung wie Sonnen-/Sternennavigation
// (astro/fixui.js): Karte oben, Kennzahlen, Tabelle mit Auswahl/[+]/[−]/Alle löschen, 5-s-Countdown.
//
// Peilrichtung ist die Geräte-y-Achse (Oberkante), gleiche Methode und Annahmen wie astro/fixui.js:
// Azimut = atan2(R[1], R[4]) aus rotationMatrix (Gerät -> ENU), Neigung = asin(R[7]).
//  - Android/Chrome: 'deviceorientationabsolute', alpha bezieht sich auf magnetisch Nord.
//  - iOS: alpha relativ; Nordversatz = webkitCompassHeading − Azimut(alpha) wird nur bei |beta| < 60° und
//    |gamma| < 15° nachgeführt (zirkulär geglättet) und auf den gyro-gestützten alpha-Azimut angewandt.
//    Ohne Abgleich wird webkitCompassHeading direkt verwendet.
// Fehlergrenze je Peilung (wie astro): eZ = 0,5° + max(2σ, iOS-Kompassgenauigkeit). Getrennt gespeichert:
// zufälliger Anteil eZr = 0,5° + 2σ; mit mitgeschätztem Kompassversatz gilt nur eZr (+ Restgrenze, s. solve.js).

import { h, svg, toast, copyText, seg, stat, fmt, fmtDist, fmtLatLon, beep } from '../lib/ui.js';
import { ensureMotionPermission, watchOrientation, rotationMatrix } from '../lib/sensors.js';
import { meanAngle, circStd, mean, wrap360, wrap180, distance, R2D, D2R } from '../lib/geo.js';
import { createMap, posMarker, accuracyCircle } from '../lib/map.js';
import { declination } from '../lib/magdecl.js';
import { load, save } from '../lib/store.js';
import { FORMATS, fmtDMS } from './coords/convert.js';
import { solve, bounds, bearingLine, wedge, BIAS_REST, DELTA_MAX } from './resection/solve.js';

const COUNTDOWN = 5;
const WINDOW_MS = 1000;
const KEY_T = 'resection:targets', KEY_R = 'resection:rows', KEY_S = 'resection:settings';

const STYLE = `
.tool-body > .rs-x { flex-shrink: 0; }
.rs-map { height: 38vh; min-height: 240px; }
.rs-chip { position: absolute; left: 10px; bottom: 10px; z-index: 500; background: var(--surface); color: var(--text);
  border: 1px solid var(--line-strong); border-radius: 8px; padding: 5px 9px; font-size: 12px; font-weight: 500; max-width: calc(100% - 70px); }
.rs-pos { grid-column: 1 / -1; cursor: pointer; }
.rs-pos .v { font-size: 19px; }
.rs-sub { font-size: 13px; color: var(--text-2); font-variant-numeric: tabular-nums; margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.stats > .stat.rs-wide { grid-column: 1 / -1; }
.rs-notes { display: flex; flex-direction: column; gap: 4px; }
.rs-tgt { position: relative; }
.rs-tgt svg { position: absolute; left: 0; top: 0; width: 14px; height: 14px; overflow: visible; }
.rs-tgt svg path { fill: var(--accent); stroke: var(--surface); stroke-width: 1.4; stroke-linejoin: round; }
.rs-tgt.is-sel svg path { stroke: var(--accent); stroke-width: 3; fill: var(--surface); }
.rs-tgt span { position: absolute; left: 16px; top: -2px; white-space: nowrap; font: 600 11.5px/16px var(--font); color: var(--text);
  text-shadow: 0 0 2px var(--surface), 0 0 2px var(--surface), 0 0 3px var(--surface); pointer-events: none; }
.rs-num { background: var(--surface); color: var(--text); border: 1px solid var(--line-strong); border-radius: 10px;
  font: 600 12px/18px var(--font); text-align: center; }
.rs-line { stroke-width: 1.8; stroke-opacity: .85; }
.rs-ring { stroke: var(--map-acc); fill: none; stroke-width: 1.2; stroke-dasharray: 4 5; }
.rs-pop .leaflet-popup-content-wrapper, .rs-pop .leaflet-popup-tip { background: var(--surface); color: var(--text);
  box-shadow: 0 4px 18px rgba(0,0,0,.18); border: 1px solid var(--line-strong); }
.rs-pop .leaflet-popup-content { margin: 12px; width: 220px !important; }
.rs-pop a.leaflet-popup-close-button { color: var(--text-2); }
.rs-pop-in { display: flex; flex-direction: column; gap: 8px; }
.rs-pop-c { font-size: 12px; color: var(--text-2); font-variant-numeric: tabular-nums; }
.rs-list { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; box-shadow: var(--shadow); }
.rs-trow { display: flex; align-items: center; gap: 10px; padding: 6px 4px 6px 14px; border-top: 1px solid var(--line); min-height: 52px; cursor: pointer; }
.rs-trow:first-child { border-top: 0; }
.rs-trow.is-selected { background: var(--accent-soft); }
.rs-trow .ic { width: 14px; height: 14px; flex: none; color: var(--text-3); }
.rs-trow.is-selected .ic { color: var(--accent); }
.rs-trow .tx { flex: 1; min-width: 0; }
.rs-trow .n { font-size: 15px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rs-trow .c { font-size: 12px; color: var(--text-2); font-variant-numeric: tabular-nums; }
.rs-trow .cnt { font-size: 12px; color: var(--text-2); font-variant-numeric: tabular-nums; white-space: nowrap; }
.rs-trow .del { background: none; border: 0; width: 44px; height: 44px; display: grid; place-items: center; color: var(--text-3); flex: none; }
.rs-trow .del:active { color: var(--danger); }
.rs-empty { padding: 16px 14px; font-size: 13.5px; color: var(--text-2); text-align: center; }
.rs-add { display: flex; flex-direction: column; gap: 10px; }
.rs-add .row { display: flex; gap: 8px; }
.rs-add .row .input { flex: 1; min-width: 0; }
.rs-add .msg { font-size: 12px; color: var(--text-2); min-height: 16px; padding: 0 2px; }
.rs-add .msg.is-error { color: var(--danger); }
.rs-hint { font-size: 12px; color: var(--text-2); padding: 0 4px; line-height: 1.4; }
.rs-set { display: grid; grid-template-columns: 64px 1fr; align-items: center; gap: 10px; }
.rs-set > label { font-size: 14px; color: var(--text-2); }
.rs-bar { display: flex; align-items: center; gap: 12px; padding: 0 2px; }
.rs-bar .rs-plus { width: 60px; height: 60px; font-size: 34px; font-weight: 300; flex: none; }
.rs-bar .rs-minus { font-weight: 300; flex: none; }
.rs-bar .rs-aim { flex: 1; min-width: 0; font-size: 13px; color: var(--text-2); line-height: 1.3; }
.rs-bar .rs-aim b { display: block; font-size: 15px; color: var(--text); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rs-bar .rs-clear { font-size: 15px; padding: 9px 14px; flex: none; }
.rs-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
.rs-table th, .rs-table td { padding: 9px 6px; }
.rs-table th:first-child, .rs-table td:first-child { padding-left: 12px; }
.rs-table th:last-child, .rs-table td:last-child { padding-right: 12px; }
.rs-table td { vertical-align: top; }
.rs-table tbody tr { cursor: pointer; }
.rs-table td small { display: block; font-size: 11px; color: var(--text-2); }
.rs-table .r { text-align: right; }
.rs-table th.nt { text-transform: none; font-size: 12px; }
.rs-table td.obj { white-space: nowrap; max-width: 120px; overflow: hidden; text-overflow: ellipsis; }
.rs-table tr.rs-bad td:first-child { color: var(--danger); font-weight: 600; }
.rs-table tr.rs-emptyrow td { text-align: center; color: var(--text-2); padding: 20px 12px; white-space: normal; cursor: default; }
.rs-meta { font-size: 12.5px; color: var(--text-2); line-height: 1.5; font-variant-numeric: tabular-nums; }
.rs-meta + .banner { margin-top: 10px; }
.rs-foot { font-size: 12px; color: var(--text-2); line-height: 1.45; padding: 0 4px; }
.rs-ov { gap: 14px; -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px); }
.rs-ov svg { width: 74px; height: 74px; opacity: .9; }
.rs-ov-hint { font-size: 20px; font-weight: 600; max-width: 320px; }
.rs-count { font-size: 128px; font-weight: 200; line-height: 1; font-variant-numeric: tabular-nums; }
.rs-live { font-size: 17px; font-variant-numeric: tabular-nums; min-height: 24px; }
.rs-ov-note { font-size: 14px; max-width: 330px; opacity: .78; line-height: 1.45; }
.rs-ov .btn { background: transparent; color: inherit; border-color: currentColor; margin-top: 10px; min-width: 150px; }
`;

const AIM_ICON = `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
<path d="M47 5l7 12H40z"/>
<rect x="15" y="27" width="16" height="30" rx="3" transform="rotate(38 23 42)"/>
<path d="M30 33l12-12" stroke-dasharray="2 3"/></svg>`;
const TRI = '<svg viewBox="0 0 14 14"><path d="M7 1.5 13 12.5H1z"/></svg>';
const TRI_IC = '<svg class="ic" viewBox="0 0 14 14"><path d="M7 1.5 13 12.5H1z" fill="currentColor"/></svg>';
const X_IC = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';

const pad = n => String(n).padStart(2, '0');
const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const fmtDecl = d => `${fmt(Math.abs(d), 1)}° ${d >= 0 ? 'O' : 'W'}`;
const fmtSigned = d => `${d >= 0 ? '+' : '−'}${fmt(Math.abs(d), 1)}°`;

/** Koordinate in beliebigem Format (Formate aus coords/convert.js) erkennen. */
const PARSERS = (() => {
  const seen = new Set(), out = [];
  const order = ['dd', 'utm', 'mgrs', 'olc', 'maidenhead', 'gk', 'lv95', 'geohash', 'ecef'];
  for (const id of order) {
    const f = FORMATS.find(x => x.id === id);
    if (f && !seen.has(f.parse)) { seen.add(f.parse); out.push(f); }
  }
  return out;
})();
function parseAny(text) {
  const t = text.trim();
  if (!t) return null;
  for (const f of PARSERS) {
    let r;
    try { r = f.parse(t); } catch { r = null; }
    if (r && !r.error && Number.isFinite(r.lat) && Number.isFinite(r.lon)) {
      return { lat: r.lat, lon: r.lon, label: f.id === 'dd' ? 'Grad (Dezimal/GMS)' : f.label.replace(/ \(.*\)$/, ''), note: r.note };
    }
  }
  return { error: 'Format nicht erkannt' };
}

export function mount(body) {
  if (!document.getElementById('style-resection')) document.head.append(h('style#style-resection', STYLE));

  let targets = load(KEY_T, []);
  if (!Array.isArray(targets)) targets = [];
  let rows = load(KEY_R, []);
  if (!Array.isArray(rows)) rows = [];
  const set = Object.assign({ sel: null, bias: 'auto' }, load(KEY_S, {}));
  let selRow = null, result = null, recalcTimer = 0, token = 0;
  const timers = new Set();

  // ---------- Aufbau ----------
  const mapEl = h('div.map.rs-map');
  const chip = h('div.rs-chip', { hidden: true });
  mapEl.append(chip);
  const stats = h('div.stats');
  const notesEl = h('div.rs-notes');

  // Ziele
  const tList = h('div.rs-list');
  const nameIn = h('input.input', { type: 'text', placeholder: 'Name, z. B. Kirchturm', autocomplete: 'off', enterkeyhint: 'next' });
  const coordIn = h('input.input', { type: 'text', placeholder: '48.1372, 11.5756 · 32U 691650 5334754', autocomplete: 'off',
    autocorrect: 'off', autocapitalize: 'off', spellcheck: false, enterkeyhint: 'done', 'aria-label': 'Koordinate' });
  const coordMsg = h('div.msg');
  const addBtn = h('button.btn.primary', { type: 'button', onclick: addFromForm }, 'Hinzufügen');
  coordIn.addEventListener('input', showParse);
  coordIn.addEventListener('keydown', e => { if (e.key === 'Enter') addFromForm(); });
  const addCard = h('div.card.rs-add',
    h('div.card-title', 'Ziel hinzufügen'),
    nameIn, h('div.row', coordIn, addBtn), coordMsg);
  const tHint = h('p.rs-hint', 'Oder auf die Karte tippen bzw. lange drücken: „Ziel hier setzen“. Formate: Dezimalgrad, Grad/Minuten/Sekunden, UTM, MGRS, Gauß-Krüger, LV95, Plus Code, Maidenhead, Geohash, ECEF.');

  // Peilungen
  const biasSeg = seg([{ value: 'auto', label: 'Versatz schätzen' }, { value: 'off', label: 'Aus' }], set.bias === 'off' ? 'off' : 'auto',
    v => { set.bias = v; saveSet(); scheduleRecalc(); });
  const setCard = h('div.card', h('div.rs-set', h('label', 'Kompass'), biasSeg),
    h('p.rs-hint', { style: { margin: '10px 0 0', padding: 0 } }, 'Gemeinsamer Kompassversatz wird ab drei Peilungen auf drei verschiedene Ziele mitgeschätzt.'));
  const plusBtn = h('button.btn.round.primary.rs-plus', { type: 'button', 'aria-label': 'Neue Peilung', onclick: startMeasure }, '+');
  const minusBtn = h('button.btn.round.rs-minus', { type: 'button', 'aria-label': 'Ausgewählte Peilung entfernen', onclick: removeRow }, '−');
  const aimEl = h('div.rs-aim');
  const clearBtn = h('button.btn.danger.rs-clear', { type: 'button', onclick: clearAll }, 'Alle löschen');
  const bar = h('div.rs-bar', plusBtn, minusBtn, aimEl, clearBtn);
  const tbody = h('tbody');
  const table = h('table.table.rs-table',
    h('thead', h('tr', h('th', 'Nr.'), h('th', 'Ziel'), h('th.r', 'Azimut rw.'), h('th.r.nt', '±Az'), h('th.r', 'Zeit'))),
    tbody);
  const tableCard = h('div.card.flush', h('div.rs-wrap', table));
  const detailCard = h('div.card', { hidden: true });
  const sensorBanner = h('div.banner.warn', { hidden: true });

  const foot = h('p.rs-foot',
    'Fehlergrenze je Peilung: ±(0,5° + Sensor); 0,5° für das Ausrichten der Oberkante. ',
    'Sensor = der größere Wert aus doppelter Standardabweichung der letzten Sekunde vor der Erfassung und der vom Gerät gemeldeten Kompassgenauigkeit (iOS). ',
    'Android meldet keine Kompassgenauigkeit: dann nur die Streuung – systematische Kompassfehler sind darin nicht enthalten. ',
    'Kompassversatz (ab drei Zielen, abschaltbar): Die Kompassgenauigkeit gilt als systematischer Anteil und wird durch einen gemeinsamen, mitgeschätzten Versatz ersetzt; ',
    `je Peilung bleibt ±(0,5° + 2σ), bei Peilungen über mehr als 90° verteilt zusätzlich ${BIAS_REST}° Restgrenze (Deviation ist teils richtungsabhängig). Versatz bis ±${DELTA_MAX}° gesucht. `,
    'Lösungsbereich = alle Orte, deren Kurs zu jedem Ziel (Großkreis) innerhalb der Grenze seiner Peilung liegt; Rand aus einem Feingitter, ',
    'Mittelpunkt = Ort mit der kleinsten größten normierten Abweichung, Radius = größter Abstand des Randes. ',
    'Azimut magnetisch gemessen, Missweisung nach WMM2025 am geschätzten Standort.');

  const parts = [mapEl, stats, notesEl,
    h('div.section-title', 'Ziele'), tList, addCard, tHint,
    h('div.section-title', 'Peilungen'), setCard, sensorBanner, bar, tableCard, detailCard, foot];
  for (const p of parts) p.classList.add('rs-x');
  body.append(...parts);

  const mapApi = createMap(mapEl, { zoom: 5 });
  const map = mapApi.map;
  const L = window.L;
  const resLayer = L.featureGroup().addTo(map);
  const tgtLayer = L.featureGroup().addTo(map);
  let fitted = false;

  // ---------- Ziele ----------
  function saveSet() { save(KEY_S, set); }
  function persistT() { save(KEY_T, targets); }
  function persistR() { save(KEY_R, rows); }
  const tById = id => targets.find(t => t.id === id);

  function showParse() {
    const r = parseAny(coordIn.value);
    coordMsg.className = 'msg' + (r && r.error ? ' is-error' : '');
    coordMsg.textContent = !r ? '' : r.error ? r.error : `${r.label}: ${fmtLatLon(r.lat, r.lon, 5)}${r.note ? ' · ' + r.note : ''}`;
  }

  function addTarget(name, lat, lon) {
    const t = { id: Date.now() + Math.floor(Math.random() * 1000), name: (name || '').trim() || `Ziel ${targets.length + 1}`, lat, lon };
    targets.push(t);
    set.sel = t.id;
    saveSet(); persistT();
    renderTargets(); renderBar(); renderTable(); scheduleRecalc();
    toast(`„${t.name}“ hinzugefügt`);
    return t;
  }

  function addFromForm() {
    const r = parseAny(coordIn.value);
    if (!r || r.error) { showParse(); if (!r) { coordMsg.className = 'msg is-error'; coordMsg.textContent = 'Koordinate eingeben'; } return; }
    addTarget(nameIn.value, r.lat, r.lon);
    nameIn.value = ''; coordIn.value = ''; coordMsg.textContent = '';
    nameIn.blur(); coordIn.blur();
    map.setView([r.lat, r.lon], Math.max(map.getZoom(), 12), { animate: false });
  }

  function selectTarget(id) {
    set.sel = id;
    saveSet();
    renderTargets(); renderBar();
  }

  function deleteTarget(t) {
    const n = rows.filter(r => r.target === t.id).length;
    if (n && !confirm(`Ziel „${t.name}“ und ${n === 1 ? 'seine Peilung' : `${n} Peilungen`} löschen?`)) return;
    targets = targets.filter(x => x !== t);
    rows = rows.filter(r => r.target !== t.id);
    if (set.sel === t.id) set.sel = null;
    saveSet(); persistT(); persistR();
    renderTargets(); renderBar(); renderTable(); scheduleRecalc();
  }

  function renderTargets() {
    tList.textContent = '';
    if (!targets.length) tList.append(h('div.rs-empty', 'Noch keine Ziele. Bekannte Punkte in Sichtweite anlegen – Gipfel, Kirchturm, Sendemast.'));
    for (const t of targets) {
      const n = rows.filter(r => r.target === t.id).length;
      const row = h('div.rs-trow', { onclick: () => selectTarget(t.id) },
        svg(TRI_IC),
        h('div.tx', h('div.n', t.name), h('div.c', fmtLatLon(t.lat, t.lon, 5))),
        n ? h('span.cnt', n === 1 ? '1 Peilung' : `${n} Peilungen`) : null,
        h('button.del', { type: 'button', 'aria-label': `${t.name} löschen`, html: X_IC, onclick: e => { e.stopPropagation(); deleteTarget(t); } }));
      if (t.id === set.sel) row.classList.add('is-selected');
      tList.append(row);
    }
    // Kartenmarker
    tgtLayer.clearLayers();
    for (const t of targets) {
      const m = L.marker([t.lat, t.lon], {
        icon: L.divIcon({ className: 'rs-tgt' + (t.id === set.sel ? ' is-sel' : ''), html: TRI + `<span>${esc(t.name)}</span>`, iconSize: [14, 14], iconAnchor: [7, 9] }),
        keyboard: false, zIndexOffset: t.id === set.sel ? 500 : 0
      }).addTo(tgtLayer);
      m.on('click', e => { L.DomEvent.stopPropagation(e); selectTarget(t.id); });
    }
  }

  function renderBar() {
    const t = tById(set.sel);
    aimEl.textContent = '';
    if (t) aimEl.append('Nächste Peilung auf', h('b', t.name));
    else aimEl.append(targets.length ? 'Ziel in der Liste wählen' : 'Erst ein Ziel anlegen');
    minusBtn.disabled = !rows.some(r => r.id === selRow);
    clearBtn.disabled = !rows.length;
  }

  // Karte: Tippen/Langdruck -> Ziel hier setzen
  function onMapPick(e) {
    const { lat, lng } = e.latlng;
    const name = h('input.input', { type: 'text', placeholder: 'Name', value: '', autocomplete: 'off', enterkeyhint: 'done' });
    const go = () => { map.closePopup(); addTarget(name.value, lat, wrap180(lng)); };
    name.addEventListener('keydown', ev => { if (ev.key === 'Enter') go(); });
    const content = h('div.rs-pop-in',
      h('div.rs-pop-c', fmtLatLon(lat, wrap180(lng), 5)),
      name,
      h('button.btn.primary.block', { type: 'button', onclick: go }, 'Ziel hier setzen'));
    L.popup({ className: 'rs-pop', minWidth: 220, maxWidth: 240, autoPanPadding: [16, 16] }).setLatLng(e.latlng).setContent(content).openOn(map);
  }
  map.on('click', onMapPick);
  map.on('contextmenu', onMapPick);

  // ---------- Tabelle ----------
  function renderTable() {
    tbody.textContent = '';
    const reg = result && result.status === 'ok' && result.regions.length === 1 ? result.regions[0] : null;
    const decl = result && result.decl != null ? result.decl : null;
    const corr = reg && reg.delta != null ? -reg.delta : 0;
    if (!rows.length) tbody.append(h('tr.rs-emptyrow', h('td', { colSpan: 5 }, targets.length ? 'Noch keine Peilungen. Ziel wählen, dann +.' : 'Erst Ziele anlegen, dann mit + peilen.')));
    rows.forEach((r, i) => {
      const t = tById(r.target);
      const d = new Date(r.ts);
      const e = result && result.eUsed && result.eUsed[i] != null ? result.eUsed[i] : r.eZ;
      const azCell = decl != null
        ? h('td.r', `${fmt(wrap360(r.az + decl + corr), 1)}°`, h('small', `${fmt(r.az, 1)}° mag.`))
        : h('td.r', `${fmt(r.az, 1)}°`, h('small', 'mag.'));
      const flag = flagOf(i);
      const tr = h('tr', { onclick: () => { selRow = selRow === r.id ? null : r.id; renderTable(); renderBar(); } },
        h('td', String(i + 1) + (flag ? ' !' : '')),
        h('td.obj', t ? t.name : 'gelöscht'),
        azCell,
        h('td.r', fmt(e, 1)),
        h('td.r', `${pad(d.getHours())}:${pad(d.getMinutes())}`, h('small', `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.`)));
      if (r.id === selRow) tr.classList.add('is-selected');
      if (flag) tr.classList.add('rs-bad');
      tbody.append(tr);
    });
    renderDetail();
  }

  function flagOf(i) {
    if (!result) return null;
    return (result.bad && result.bad[i]) || (result.flags && result.flags[i]) || null;
  }

  function renderDetail() {
    const i = rows.findIndex(r => r.id === selRow);
    detailCard.textContent = '';
    if (i < 0) { detailCard.hidden = true; return; }
    detailCard.hidden = false;
    const r = rows[i], t = tById(r.target);
    const d = new Date(r.ts);
    const flag = flagOf(i);
    detailCard.append(
      h('div.card-title', `Peilung ${i + 1}${t ? ' · ' + t.name : ''}`),
      h('div.rs-meta',
        h('div', `Erfasst ${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`),
        h('div', `Azimut ${fmt(r.az, 1)}° mag. ± ${fmt(r.eZ, 1)}° (Sensor ${fmt(r.sZ, 1)}°), davon zufällig ±${fmt(r.eZr, 1)}°`),
        h('div', `Neigung der Oberkante ${fmt(r.tilt, 0)}° · ${r.n} Samples` +
          (r.src === 'ios' ? ' · Kompass iOS' : r.src === 'ios-direct' ? ' · Kompass iOS (ohne Abgleich)' : r.src === 'abs' ? ' · absolute Lage' : '') +
          (r.acc != null ? ` · gemeldete Kompassgenauigkeit ±${fmt(r.acc, 0)}°` : r.src === 'abs' ? ' · Kompassgenauigkeit vom Gerät nicht gemeldet' : ''))),
      flag ? h('div.banner.warn', flag) : null);
  }

  function removeRow() {
    const i = rows.findIndex(r => r.id === selRow);
    if (i < 0) return;
    rows.splice(i, 1);
    selRow = null;
    persistR(); renderTargets(); renderBar(); renderTable(); scheduleRecalc();
  }

  function clearAll() {
    if (!rows.length) return;
    if (!confirm('Alle Peilungen löschen? Die Ziele bleiben erhalten.')) return;
    rows = []; selRow = null;
    persistR(); renderTargets(); renderBar(); renderTable(); scheduleRecalc();
  }

  // ---------- Berechnung ----------
  function scheduleRecalc() {
    clearTimeout(recalcTimer);
    const my = ++token;
    recalcTimer = setTimeout(() => {
      if (my !== token) return;
      const ts = rows.map(r => r.ts).sort((a, b) => a - b);
      const date = new Date(ts.length ? ts[ts.length >> 1] : Date.now());
      try {
        result = solve(targets, rows, { declFn: (la, lo) => declination(la, lo, date), delta: set.bias === 'off' ? 'off' : 'auto' });
      } catch (e) {
        console.error(e);
        result = { status: 'error', notes: [], flags: {}, bad: {}, regions: [], lines: [] };
      }
      renderResult(); renderTable();
    }, 120);
  }

  function tile(label, value, wide = false, ...lines) {
    const t = stat(label, value);
    if (wide) t.el.classList.add('rs-wide');
    for (const l of lines) if (l) t.el.append(h('div.rs-sub', l));
    return t.el;
  }

  const STATUS = { empty: 'Keine Peilung', line: 'Standlinie', ok: 'Bestimmt', inconsistent: 'Widersprüchlich', error: 'Fehler' };

  function renderResult() {
    resLayer.clearLayers();
    stats.textContent = '';
    notesEl.textContent = '';
    chip.hidden = true;
    const r = result || { status: 'empty', notes: [], regions: [], lines: [], nUsed: 0 };
    const regs = r.regions || [];
    const multi = regs.length > 1;
    const bounds = [];
    const flagged = new Set(Object.keys(r.flags || {}).map(Number));

    // Position(en)
    if (r.status === 'ok') {
      regs.forEach((s, i) => {
        const el = tile(multi ? `Bereich ${i + 1}` : 'Position', `${fmt(Math.abs(s.lat), 5)}° ${s.lat >= 0 ? 'N' : 'S'}  ${fmt(Math.abs(s.lon), 5)}° ${s.lon >= 0 ? 'O' : 'W'}`, true,
          fmtDMS({ lat: s.lat, lon: s.lon }), multi ? `Radius ${fmtDist(s.radius)}` + (s.delta != null ? ` · Versatz ${fmtSigned(s.delta)}` : '') : null);
        el.classList.add('rs-pos');
        el.addEventListener('click', () => copyText(`${s.lat.toFixed(6)}, ${s.lon.toFixed(6)}`, 'Koordinaten kopiert'));
        stats.append(el);
      });
    } else {
      const why = r.status === 'line' ? 'Eine Standlinie – zweites Ziel peilen'
        : r.status === 'inconsistent' ? 'Peilungen widersprüchlich'
        : r.status === 'error' ? 'Berechnung fehlgeschlagen'
        : targets.length ? 'Noch keine Peilung' : 'Ziele anlegen, dann peilen';
      stats.append(tile('Position', '–', true, why));
    }
    const main = r.status === 'ok' && !multi ? regs[0] : null;
    const tiles = [
      tile('Radius', main ? fmtDist(main.radius) : '–'),
      tile('Peilungen', String(r.nUsed || 0), false, r.nTargets ? `${r.nTargets} ${r.nTargets === 1 ? 'Ziel' : 'Ziele'}` : null),
      tile('Missweisung', r.decl != null ? fmtDecl(r.decl) : '–', false, r.decl != null ? 'WMM2025' : null),
      main && main.delta != null
        ? tile('Kompassversatz', fmtSigned(main.delta), false, main.deltaLo != null ? `Spanne ${fmtSigned(main.deltaLo)} … ${fmtSigned(main.deltaHi)}` : null)
        : tile('Kompassversatz', r.withDelta ? '–' : 'aus', false, r.withDelta ? null : set.bias === 'off' ? 'abgeschaltet' : 'ab 3 Zielen'),
      tile('Status', multi ? 'Mehrdeutig' : STATUS[r.status] || '–')
    ];
    if (tiles.length % 2) tiles[tiles.length - 1].classList.add('rs-wide');
    stats.append(...tiles);

    // Hinweise
    const notes = (r.notes || []).slice();
    if (r.status === 'inconsistent') notes.unshift({ text: 'Peilungen widersprüchlich: Es gibt keinen Ort, an dem alle Peilungen innerhalb ihrer Fehlergrenzen liegen. Markierte Zeilen prüfen oder entfernen.', warn: true });
    if (r.bad && Object.keys(r.bad).length) notes.push({ text: 'Markierte Peilungen werden nicht verwendet.', warn: true });
    for (const n of notes) notesEl.append(h('div.banner' + (n.warn ? '.warn' : ''), n.text));

    // Karte: Standlinien
    const lineLen = l => {
      if (main || regs.length) {
        let d = 0;
        for (const s of regs) d = Math.max(d, distance(l.lat, l.lon, s.lat, s.lon) + 2.5 * s.radius);
        return Math.max(d * 1.15, 500);
      }
      let span = 0;
      for (const a of targets) for (const b of targets) span = Math.max(span, distance(a.lat, a.lon, b.lat, b.lon));
      return Math.min(150e3, Math.max(span * 2, 20e3));
    };
    for (const l of r.lines || []) {
      const len = lineLen(l);
      const bad = flagged.has(l.row);
      L.polyline(bearingLine(l.lat, l.lon, l.A, len), { className: bad ? 'u-alt rs-line' : 'u-track rs-line', interactive: false }).addTo(resLayer);
      if (r.status === 'line') {
        const wg = L.polygon(wedge(l.lat, l.lon, l.A, l.e, len), { className: 'u-acc', interactive: false }).addTo(resLayer);
        bounds.push(wg);
      }
    }
    if (r.status === 'line') {
      chip.textContent = 'Standlinie: Standort irgendwo im Keil';
      chip.hidden = false;
    }
    if (r.status === 'inconsistent') { chip.textContent = 'Kein gemeinsamer Bereich'; chip.hidden = false; }

    // Lösungsbereiche
    regs.forEach((s, i) => {
      if (s.ring && s.ring.length > 2) L.polygon(s.ring, { className: 'u-acc', interactive: false }).addTo(resLayer);
      const c = accuracyCircle([s.lat, s.lon], s.radius, 'rs-ring').addTo(resLayer);
      posMarker([s.lat, s.lon]).addTo(resLayer);
      bounds.push(c);
      if (multi) {
        L.marker([s.lat, s.lon], {
          icon: L.divIcon({ className: 'rs-num', html: String(i + 1), iconSize: [20, 20], iconAnchor: [-6, 24] }),
          interactive: false, keyboard: false
        }).addTo(resLayer);
      }
    });

    // Ziele mit in den Ausschnitt, solange das Bild nicht zu grob wird
    if (r.status === 'inconsistent' || (regs.length && targets.length)) {
      const used = targets.filter(t => (r.lines || []).some(l => rows[l.row] && rows[l.row].target === t.id));
      const ref = regs[0];
      for (const t of used) {
        if (r.status === 'inconsistent' || distance(t.lat, t.lon, ref.lat, ref.lon) < Math.max(30e3, 8 * ref.radius)) bounds.push(L.marker([t.lat, t.lon]));
      }
    }
    if (bounds.length) {
      try {
        const b = L.featureGroup(bounds).getBounds();
        if (b.isValid()) map.fitBounds(b, { paddingTopLeft: [28, 28], paddingBottomRight: [28, chip.hidden ? 28 : 52], maxZoom: 16, animate: false });
        fitted = true;
      } catch { /* leer */ }
    } else if (!fitted && targets.length) {
      const b = L.latLngBounds(targets.map(t => [t.lat, t.lon]));
      map.fitBounds(b.pad(0.4), { maxZoom: 13, animate: false });
      fitted = true;
    }
  }

  // ---------- Messung (wie astro/fixui.js) ----------
  let stopWatch = null;
  const samples = [];
  let calS = 0, calC = 0, calN = 0;
  let liveCb = null;

  function onOrientation(e) {
    if (e.beta == null) return;
    const R = rotationMatrix(e.alpha, e.beta, e.gamma);
    const tilt = Math.asin(Math.max(-1, Math.min(1, R[7]))) * R2D;
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
    const s = { t: performance.now(), tilt, az, acc: e.headingAccuracy, src };
    samples.push(s);
    while (samples.length && samples[0].t < s.t - 4000) samples.shift();
    if (liveCb) liveCb(s);
  }

  let overlay = null;
  async function startMeasure() {
    if (overlay) return;
    const t = tById(set.sel);
    if (!t) { toast(targets.length ? 'Erst ein Ziel wählen' : 'Erst ein Ziel anlegen'); return; }
    beep(880, 1, 0.0001); // Audio innerhalb der Nutzergeste freischalten (iOS)
    const ok = await ensureMotionPermission();
    if (!ok) {
      sensorBanner.hidden = false;
      sensorBanner.textContent = 'Keine Freigabe für die Lagesensoren. Ohne Sensoren ist keine Peilung möglich.';
      return;
    }
    if (!stopWatch) stopWatch = watchOrientation(onOrientation);
    beep(880, 90);

    const count = h('div.rs-count', String(COUNTDOWN));
    const live = h('div.rs-live', 'Warte auf Sensordaten …');
    overlay = h('div.overlay.rs-ov', { role: 'dialog', 'aria-label': 'Peilung' },
      svg(AIM_ICON),
      h('div.rs-ov-hint', `Oberkante auf „${t.name}“ richten`),
      count, live,
      h('div.rs-ov-note', 'Gerät waagerecht oder leicht geneigt halten und über die Oberkante peilen. Abstand zu Metall, Magneten und Fahrzeugen halten.'),
      h('button.btn', { type: 'button', onclick: () => finish(false) }, 'Abbrechen'));
    document.body.append(overlay);
    liveCb = s => { live.textContent = `Azimut ${s.az == null ? '–' : fmt(s.az, 0) + '°'} mag. · Neigung ${fmt(s.tilt, 0)}°`; };

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
      takeSample(t);
    }
  }

  function takeSample(t) {
    const now = performance.now();
    const win = samples.filter(s => s.t >= now - WINDOW_MS);
    if (win.length < 3) {
      sensorBanner.hidden = false;
      sensorBanner.textContent = 'Keine Lagesensordaten empfangen. Dieses Gerät oder dieser Browser liefert keine Ausrichtung.';
      toast('Peilung fehlgeschlagen');
      return;
    }
    const withAz = win.filter(s => s.az != null);
    if (!withAz.length) {
      sensorBanner.hidden = false;
      sensorBanner.textContent = 'Kein Kompass verfügbar (keine absolute Ausrichtung). Ohne Himmelsrichtung ist keine Peilung möglich.';
      toast('Peilung fehlgeschlagen');
      return;
    }
    sensorBanner.hidden = true;
    const azs = withAz.map(s => s.az);
    const accs = withAz.map(s => s.acc).filter(a => a != null && a >= 0);
    const acc = accs.length ? mean(accs) : null;
    const s2Z = 2 * (azs.length > 1 ? circStd(azs) : 0);
    const b = bounds(s2Z, acc);
    const tilt = mean(win.map(s => s.tilt));
    rows.push({
      id: Date.now(), ts: Date.now(), target: t.id,
      az: meanAngle(azs), s2Z, sZ: Math.max(s2Z, acc ?? 0), acc, eZ: b.eZ, eZr: b.eZr,
      tilt, n: win.length, src: withAz[withAz.length - 1].src
    });
    selRow = null;
    persistR(); renderTargets(); renderBar(); renderTable(); scheduleRecalc();
    if (Math.abs(tilt) > 50) toast('Stark geneigt – Azimut unsicher', 2600);
    else toast(`Peilung ${rows.length} gespeichert`);
  }

  renderTargets();
  renderBar();
  renderTable();
  renderResult();
  scheduleRecalc();

  return () => {
    token++;
    clearTimeout(recalcTimer);
    for (const t of timers) clearInterval(t);
    timers.clear();
    if (overlay) { overlay.remove(); overlay = null; }
    liveCb = null;
    if (stopWatch) { stopWatch(); stopWatch = null; }
    map.off('click', onMapPick);
    map.off('contextmenu', onMapPick);
    map.remove();
  };
}
