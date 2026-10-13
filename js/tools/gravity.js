// Gravitation (experimentell): Ortsbestimmung aus dem Betrag der lokalen Schwerebeschleunigung.
//
// Ablauf: Gerät 60 s ruhig flach ablegen, |accelerationIncludingGravity| robust mitteln (getrimmtes Mittel),
// mit Faktor k aus einer GPS-gestützten Kalibrierung skalieren und die Isolinien g_modell(φ, λ, H) = g
// auf der Karte zeigen (Modell und Daten: gravity/model.js).
//
// Plattform (Stand WebKit-Quellcode, Source/WebCore/platform/ios/WebCoreMotionManager.mm):
//  - iOS/Safari: accelerationIncludingGravity = (CMDeviceMotion.userAcceleration + .gravity) · 9,80665.
//    gravity ist eine Schätzung der Sensorfusion (in der Praxis ein Einheitsvektor), userAcceleration der
//    Rest. Ob die Summe den Rohbetrag des Beschleunigungssensors wiedergibt (dann wäre die Messung
//    sinnvoll) oder durch Filter/Biasschätzung von Core Motion Richtung 1 g gezogen wird, ist von Apple
//    nicht dokumentiert. Ohne Gyroskop nutzt WebKit direkt CMAccelerometerData (Rohwerte in g).
//    Werte werden per Timer abgefragt (≈ 60 Hz), einzelne Samples können doppelt vorkommen.
//  - Android/Chrome: Werte des Beschleunigungssensors (TYPE_ACCELEROMETER), werkskalibriert.
// Deshalb: Mittelwert mit 6 Stellen und Streuung anzeigen; liegt der Mittelwert auffällig exakt bei
// 9,80665 m/s², wird ein Hinweis auf normierte Werte gezeigt.

import { h, toast, seg, stat, fmt, fmtLatLon, beep } from '../lib/ui.js';
import { ensureMotionPermission, hasMotion, keepAwake, watchPosition, geoErrorText } from '../lib/sensors.js';
import { createMap, posMarker } from '../lib/map.js';
import { load, save, remove } from '../lib/store.js';
import {
  anomalyGrid, modelGravity, isolines, latitudeForGamma, meridianCrossings, nearestOnLines,
  analyze, motionMonitor, looksNormalized, LIMITS, MGAL
} from './gravity/model.js';

const KEY_CAL = 'gravity:cal', KEY_HIST = 'gravity:hist', KEY_H = 'gravity:h', KEY_VIEW = 'gravity:view';
const KEY_RAW_CAL = 'gravity:raw:cal', KEY_RAW_LAST = 'gravity:raw:last';
const PREP_S = 5;            // Vorlauf zum Ablegen
const GPS_ACC = 30;          // m: Fix wird ohne Rückfrage übernommen
const NO_DATA_MS = 3000;
const HIST_MAX = 50;

const STYLE = `
.gravity-map { height: 42vh; min-height: 260px; }
.gravity-big .v { font-size: 19px; }
.stats > .stat.gravity-wide { grid-column: 1 / -1; }
.gravity-line { fill: none !important; stroke-width: 2; }
.gravity-line.u-alt { stroke-width: 1.5; }
.gravity-rows .list-row .v { font-size: 15px; }
.gravity-hin { display: flex; align-items: center; gap: 8px; }
.gravity-hin .input { width: 110px; text-align: right; min-height: 38px; padding: 6px 10px; }
.gravity-hin span { color: var(--text-2); font-size: 14px; }
.gravity-card { display: flex; flex-direction: column; gap: 12px; }
.gravity-card .card-title { margin: 0; }
.gravity-hrow { display: flex; align-items: center; justify-content: space-between; gap: 12px; color: var(--text-2); font-size: 14px; }
.gravity-notes { display: flex; flex-direction: column; gap: 8px; }
.gravity-note { font-size: 12.5px; color: var(--text-2); line-height: 1.45; }
.gravity-foot { font-size: 12px; color: var(--text-2); line-height: 1.45; padding: 0 4px; }
.gravity-hist .list-row { cursor: pointer; }
.gravity-hist .list-row.is-selected { background: var(--accent-soft); }
.gravity-hist .k small { display: block; font-size: 12px; color: var(--text-3); }
.gravity-hist .v small { display: block; font-size: 12px; color: var(--text-2); }
.gravity-empty { text-align: center; color: var(--text-2); font-size: 14px; padding: 18px 12px; }
.gravity-ov { gap: 10px; -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px); }
.gravity-ov-title { font-size: 19px; font-weight: 600; max-width: 330px; }
.gravity-count { font-size: 112px; font-weight: 200; line-height: 1; font-variant-numeric: tabular-nums; }
.gravity-ov .progress { width: 240px; }
.gravity-live { font-size: 16px; font-variant-numeric: tabular-nums; min-height: 44px; line-height: 1.4; }
.gravity-ov-note { font-size: 14px; max-width: 330px; opacity: .78; line-height: 1.45; min-height: 20px; }
.gravity-ov-btns { display: flex; gap: 10px; margin-top: 8px; }
.gravity-ov .btn { background: transparent; color: inherit; border-color: currentColor; min-width: 130px; }
`;

const EXPORT_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V4M7.5 8.5 12 4l4.5 4.5"/><path d="M5 13v6a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-6"/></svg>';

const pad = n => String(n).padStart(2, '0');
const fmtTime = t => { const d = new Date(t); return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmtG = g => fmt(g, 6);
const fmtMgal = v => (v > 0 ? '+' : v < 0 ? '−' : '±') + fmt(Math.abs(v), 1);
const fmtLat = v => `${fmt(Math.abs(v), 3)}° ${v >= 0 ? 'N' : 'S'}`;
const numStr = v => String(Math.round(v * 10) / 10).replace('.', ',');
const parseNum = s => { const v = parseFloat(String(s).replace(',', '.')); return Number.isFinite(v) ? v : null; };

export function mount(body, ctx) {
  if (!document.getElementById('style-gravity')) document.head.append(h('style#style-gravity', STYLE));

  let cal = load(KEY_CAL, null);
  let hist = load(KEY_HIST, []);
  if (!Array.isArray(hist)) hist = [];
  let hOverride = load(KEY_H, null);
  let selected = hist[0] || null;
  let grid = null, gridState = 'loading';
  let run = null;            // laufende Messung
  let disposed = false;
  let redrawTimer = 0;

  // ---------- Kopfleiste ----------
  ctx.setActions(h('button.icon-btn', { type: 'button', title: 'Daten exportieren', 'aria-label': 'Daten exportieren', html: EXPORT_ICON, onclick: exportData }));

  // ---------- Aufbau ----------
  const banner = h('div.banner.warn', h('b', 'Experimentell. '), 'Gerät für jede Messung 60 s flach auf eine feste Unterlage legen und nicht berühren.');
  const sensorBanner = h('div.banner.warn', { hidden: hasMotion() }, 'Beschleunigungssensor in diesem Browser nicht verfügbar.');
  const gridBanner = h('div.banner', { hidden: true });

  // Kalibrierung
  const calBtn = h('button.btn.block', { type: 'button', onclick: startCalibration }, 'Kalibrieren');
  const calAltIn = h('input.input', { type: 'text', inputmode: 'decimal', onchange: onCalAlt });
  const calRows = h('div.list.gravity-rows');
  const calNotes = h('div.gravity-notes');

  // Messung
  const measBtn = h('button.btn.primary', { type: 'button', onclick: startMeasurement }, 'Messen (60 s)');
  const calQuick = h('button.btn', { type: 'button', onclick: startCalibration }, 'Kalibrieren');
  const hIn = h('input.input', { type: 'text', inputmode: 'decimal', oninput: onHeight });
  const stats = h('div.stats');
  const sA = stat('Betrag (Mittel)', '–', 'm/s²'), sStd = stat('Streuung', '–', 'm/s²');
  const sG = stat('Schwere kalibriert', '–', 'm/s²'), sD = stat('Δ zur Kalibrierung', '–', 'mGal');
  const sAx = stat('Lage', '–'), sN = stat('Abtastung', '–');
  sG.el.classList.add('gravity-big'); sA.el.classList.add('gravity-big');
  stats.append(sA.el, sStd.el, sG.el, sD.el, sAx.el, sN.el);
  const measNotes = h('div.gravity-notes');
  const measCard = h('div.card.gravity-card', h('div.card-title', 'Ortsbestimmung'),
    h('div.gravity-hrow', h('span', 'Höhe Messort'), h('span.gravity-hin', hIn, h('span', 'm'))),
    h('div.btn-row', calQuick, measBtn));

  // Karte
  const mapEl = h('div.map.gravity-map');
  const viewSeg = seg([{ value: 'world', label: 'Welt' }, { value: 'region', label: 'Region' }],
    load(KEY_VIEW, 'region'), v => { save(KEY_VIEW, v); fitView(); });

  // Kandidaten, Modell, Verlauf
  const candList = h('div.list.gravity-rows');
  const modelList = h('div.list.gravity-rows');
  const histList = h('div.list.gravity-hist');
  const clearBtn = h('button.btn.danger', { type: 'button', onclick: clearHistory }, 'Verlauf löschen');

  const foot = h('p.gravity-foot',
    'Modell: Normalschwere WGS84 (Somigliana) + Freiluftreduktion 2. Ordnung (≈ −0,3086 mGal/m, Höhe über Meeresspiegel) ',
    '+ Freiluftanomalie aus EGM2008 bis Grad 360 (0,5°-Gitter, ≈ 55 km Auflösung; NGA, Public Release). ',
    'Kalibrierung multiplikativ: g = k · |a|, k = g_Modell(Kalibrierort) / |a|_Kalibrierung. ',
    'Messwert: getrimmtes Mittel (10 %) des Betrags. Verworfen wird bei Bewegung (Fenstermittel > ',
    fmt(LIMITS.moveLim, 2), ' m/s² vom ersten Fenster) oder Streuung > ', fmt(LIMITS.stdLim, 2), ' m/s². ',
    'iOS: Safari bildet den Wert aus Core-Motion-Schätzwerten (Schwere + Nutzerbeschleunigung); ob der Betrag dem Rohsensor entspricht, ist nicht dokumentiert. ',
    '1 mGal = 10⁻⁵ m/s²; Äquator–Pol: 5186 mGal.');

  body.append(banner, sensorBanner, gridBanner, measCard, stats, measNotes, mapEl, viewSeg,
    h('div.section-title', 'Kandidaten'), candList,
    h('div.section-title', 'Kalibrierung'), calRows, calNotes, calBtn,
    h('div.section-title', 'Modell am Kalibrierort'), modelList,
    h('div.section-title', 'Verlauf'), histList, clearBtn, foot);

  const mapApi = createMap(mapEl, { center: [30, 10], zoom: 1 });
  const L = window.L;
  const layer = L.featureGroup().addTo(mapApi.map);

  // ---------- Anomaliegitter laden ----------
  fetch('data/gravity-anomaly.bin')
    .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
    .then(buf => { if (disposed) return; grid = anomalyGrid(buf); gridState = 'ok'; renderAll(); })
    .catch(e => {
      console.warn('Anomaliegitter', e);
      if (disposed) return;
      gridState = 'fail';
      gridBanner.hidden = false;
      gridBanner.textContent = 'Anomaliegitter nicht geladen – Isolinien nur aus Normalschwere und Höhe (Breitenkreise).';
      renderAll();
    });

  // ---------- Berechnungen ----------
  const calModel = () => cal ? modelGravity(cal.lat, cal.lon, cal.alt || 0, grid) : null;
  const kFactor = () => { const m = calModel(); return m ? m.g / cal.a : 1; };
  const heightM = () => hOverride ?? (cal ? cal.alt || 0 : 0);
  const gObs = e => kFactor() * e.a;

  // ---------- Darstellung ----------
  function row(k, v) { return h('div.list-row', h('span.k', k), h('span.v', v)); }

  function renderCal() {
    calRows.textContent = '';
    calNotes.textContent = '';
    if (!cal) {
      calRows.hidden = true;
      calNotes.append(h('div.gravity-note', 'Noch nicht kalibriert. Kalibrierung an einem Ort mit GPS-Empfang: Position und Höhe werden per GPS bestimmt, danach folgt eine 60-s-Messung. Ohne Kalibrierung gilt k = 1.'));
      calBtn.textContent = 'Kalibrieren';
      return;
    }
    calRows.hidden = false;
    const m = calModel();
    if (document.activeElement !== calAltIn) calAltIn.value = numStr(cal.alt || 0);
    calRows.append(
      row('Zeitpunkt', fmtTime(cal.t)),
      row('Position', `${fmtLatLon(cal.lat, cal.lon, 4)}${cal.acc != null ? ' · ±' + fmt(cal.acc, 0) + ' m' : ''}`),
      h('div.list-row', h('span.k', cal.altSrc === 'gps' ? 'Höhe (GPS)' : 'Höhe (manuell)'), h('span.gravity-hin', calAltIn, h('span', 'm'))),
      row('|a| gemessen', fmtG(cal.a) + ' m/s²'),
      row('Streuung', fmt(cal.std, 5) + ' m/s²'),
      row('g Modell', fmtG(m.g) + ' m/s²'),
      row('Faktor k', fmt(m.g / cal.a, 7)),
      row('Lage', `${cal.axis} · ${fmt(cal.tilt, 1)}° geneigt`));
    calNotes.append(h('div.gravity-note',
      'Höhe: Browser liefern je nach Gerät Höhe über Ellipsoid oder über Meeresspiegel (Unterschied in Mitteleuropa ≈ 45–50 m ≈ 15 mGal). Bei Bedarf hier korrigieren; k wird neu berechnet.'));
    if (looksNormalized(cal.a)) calNotes.append(h('div.banner.warn', 'Mittelwert liegt bei exakt 1 g (9,80665 m/s²) – die Plattform liefert vermutlich normierte Werte.'));
    calBtn.textContent = 'Neu kalibrieren';
  }

  function renderModel() {
    modelList.textContent = '';
    if (!cal) { modelList.append(h('div.gravity-empty', 'Nach der Kalibrierung verfügbar.')); return; }
    const m = calModel();
    modelList.append(
      row('Normalschwere (Breite ' + fmtLat(cal.lat) + ')', fmtG(m.gamma0)),
      row('Höhe ' + fmt(cal.alt || 0, 0) + ' m', fmtMgal(m.height / MGAL) + ' mGal'),
      row('Anomalie', gridState === 'ok' ? fmtMgal(m.anomaly / MGAL) + ' mGal' : (gridState === 'loading' ? '…' : 'nicht verfügbar')),
      row('Summe', fmtG(m.g) + ' m/s²'));
  }

  function renderMeas() {
    if (document.activeElement !== hIn) hIn.value = hOverride != null ? numStr(hOverride) : '';
    hIn.placeholder = cal ? numStr(cal.alt || 0) : '0';
    calQuick.hidden = !!cal;
    measNotes.textContent = '';
    const e = selected;
    if (!e) {
      for (const s of [sA, sStd, sG, sD, sAx, sN]) s.set('–');
      stats.hidden = true;
      measNotes.hidden = true;
      return;
    }
    stats.hidden = false;
    sA.set(fmtG(e.a), 'm/s²');
    sStd.set(fmt(e.std, 5), 'm/s²');
    sG.set(fmtG(gObs(e)), 'm/s²');
    sD.set(cal ? fmtMgal((gObs(e) - calModel().g) / MGAL) : '–', 'mGal');
    sAx.set(`${e.axis} · ${fmt(e.tilt, 1)}°`);
    sN.set(`${e.n} · ${fmt(e.rate, 0)}`, 'Hz');
    if (!cal) measNotes.append(h('div.banner.warn', 'Ohne Kalibrierung (k = 1).'));
    else if (cal.axis !== e.axis) measNotes.append(h('div.banner.warn', `Andere Lage als bei der Kalibrierung (${e.axis} statt ${cal.axis}). Skalenfehler sind achsabhängig.`));
    if (looksNormalized(e.a)) measNotes.append(h('div.banner.warn', 'Mittelwert liegt bei exakt 1 g (9,80665 m/s²) – die Plattform liefert vermutlich normierte Werte.'));
    if (e !== hist[0]) measNotes.append(h('div.gravity-note', 'Anzeige: Messung vom ' + fmtTime(e.t) + '.'));
    measNotes.hidden = !measNotes.childElementCount;
  }

  let lines = [];
  function renderMap() {
    layer.clearLayers();
    lines = [];
    if (cal) posMarker([cal.lat, cal.lon]).addTo(layer);
    const e = selected;
    if (!e) return;
    const g = gObs(e), H = heightM();
    // Breitenkreise der Normalschwere (ohne Anomalie)
    for (const l of isolines(g, H, null)) addLine(l, 'u-alt gravity-line');
    if (grid) {
      lines = isolines(g, H, grid);
      for (const l of lines) addLine(l, 'u-track gravity-line');
    }
  }
  function addLine(line, className) {
    let mn = Infinity, mx = -Infinity;
    for (const p of line) { mn = Math.min(mn, p[1]); mx = Math.max(mx, p[1]); }
    const shifts = [0];
    if (mx > 180) shifts.push(-360);
    if (mn < -180) shifts.push(360);
    for (const s of shifts) {
      L.polyline(s ? line.map(([a, b]) => [a, b + s]) : line, { className, interactive: false }).addTo(layer);
    }
  }

  function renderCand() {
    candList.textContent = '';
    const e = selected;
    if (!e) { candList.append(h('div.gravity-empty', 'Noch keine Messung.')); return; }
    const g = gObs(e), H = heightM();
    const phi = latitudeForGamma(g, H);
    candList.append(row('Nur Normalschwere', phi == null ? 'außerhalb Äquator–Pol' : `± ${fmt(phi, 3)}°`));
    if (grid && cal) {
      const cr = meridianCrossings(g, H, cal.lon, grid);
      candList.append(row(`Auf ${fmt(Math.abs(cal.lon), 2)}° ${cal.lon >= 0 ? 'O' : 'W'}`,
        cr.length ? cr.slice().reverse().map(fmtLat).join(', ') : 'keine'));
      const near = nearestOnLines(lines, cal.lat, cal.lon);
      if (near) candList.append(row('Nächster Punkt zum Kalibrierort', `${fmt(near.km, 1)} km · ${fmtLat(near.lat)}`));
    } else if (gridState === 'loading') candList.append(row('Mit Anomalie', '…'));
    candList.append(row('Höhe für Isolinien', fmt(H, 0) + ' m'));
  }

  function renderHist() {
    histList.textContent = '';
    clearBtn.hidden = !hist.length;
    if (!hist.length) { histList.append(h('div.gravity-empty', 'Noch keine Messungen.')); return; }
    const gc = cal ? calModel().g : null;
    for (const e of hist) {
      const r = h('div.list-row', { onclick: () => { selected = e; renderAll(); fitView(); } },
        h('span.k', fmtTime(e.t), h('small', `${e.axis} · Streuung ${fmt(e.std, 4)}`)),
        h('span.v', fmtG(gObs(e)), h('small', gc != null ? fmtMgal((gObs(e) - gc) / MGAL) + ' mGal' : '')));
      if (e === selected) r.classList.add('is-selected');
      histList.append(r);
    }
  }

  function renderAll() {
    if (disposed) return;
    renderCal(); renderModel(); renderMeas(); renderMap(); renderCand(); renderHist();
  }

  function fitView() {
    if (viewSeg.value === 'region' && cal) {
      mapApi.map.fitBounds([[cal.lat - 12, cal.lon - 18], [cal.lat + 12, cal.lon + 18]], { animate: false });
    } else mapApi.map.setView([30, 10], 1, { animate: false });
  }

  // ---------- Eingaben ----------
  function onCalAlt() {
    const v = parseNum(calAltIn.value);
    if (!cal || v == null) { renderCal(); return; }
    cal.alt = v; cal.altSrc = 'manual';
    save(KEY_CAL, cal);
    renderAll();
  }
  function onHeight() {
    const v = parseNum(hIn.value);
    hOverride = hIn.value.trim() === '' ? null : v;
    save(KEY_H, hOverride);
    clearTimeout(redrawTimer);
    redrawTimer = setTimeout(() => { renderMeas(); renderMap(); renderCand(); renderHist(); }, 350);
  }
  function clearHistory() {
    if (!confirm('Alle Messungen löschen?')) return;
    hist = []; selected = null;
    save(KEY_HIST, hist); remove(KEY_RAW_LAST);
    renderAll();
  }

  // ---------- Messablauf ----------
  async function startCalibration() {
    if (run) return;
    const ok = await ensureMotionPermission();
    if (!ok) { toast('Sensorfreigabe verweigert'); return; }
    measure('cal');
  }
  async function startMeasurement() {
    if (run) return;
    const ok = await ensureMotionPermission();
    if (!ok) { toast('Sensorfreigabe verweigert'); return; }
    measure('loc');
  }

  function measure(kind) {
    const ov = {
      title: h('div.gravity-ov-title'), count: h('div.gravity-count'), bar: h('i'),
      live: h('div.gravity-live', { style: { whiteSpace: 'pre-line' } }), note: h('div.gravity-ov-note'), btns: h('div.gravity-ov-btns')
    };
    const el = h('div.overlay.gravity-ov', ov.title, ov.count, h('div.progress', ov.bar), ov.live, ov.note, ov.btns);
    document.body.append(el);

    const r = run = { kind, phase: 'prep', t0: performance.now(), samples: null, stops: [], el, best: null, gpsErr: null };
    let mon = null, wsum = 0, wmean = 0, wm2 = 0, lastEvent = 0, tStart = 0;

    const cancelBtn = h('button.btn', { type: 'button', onclick: () => finish(null) }, 'Abbrechen');
    ov.btns.append(cancelBtn);
    keepAwake().then(rel => { if (run === r) r.stops.push(rel); else rel(); });

    // Sensor
    const onMotion = e => {
      const a = e.accelerationIncludingGravity;
      if (!a || a.x == null || a.y == null || a.z == null) return;
      const t = performance.now();
      lastEvent = t;
      if (r.phase !== 'rec') return;
      const s = r.samples;
      s.t.push(t); s.x.push(a.x); s.y.push(a.y); s.z.push(a.z);
      const m = Math.hypot(a.x, a.y, a.z);
      wsum++; const d = m - wmean; wmean += d / wsum; wm2 += d * (m - wmean);
      const why = mon.push(t, a.x, a.y, a.z);
      if (why) fail(why + ' – Messung verworfen.');
    };
    window.addEventListener('devicemotion', onMotion);
    r.stops.push(() => window.removeEventListener('devicemotion', onMotion));
    const onVis = () => { if (document.visibilityState !== 'visible' && r.phase !== 'done') fail('App im Hintergrund – Messung unterbrochen.'); };
    document.addEventListener('visibilitychange', onVis);
    r.stops.push(() => document.removeEventListener('visibilitychange', onVis));

    // GPS (nur Kalibrierung), läuft parallel zur Messung
    if (kind === 'cal') {
      r.stops.push(watchPosition(p => {
        const c = p.coords;
        if (!r.best || c.accuracy <= r.best.acc) {
          r.best = { lat: c.latitude, lon: c.longitude, acc: c.accuracy, alt: c.altitude, altAcc: c.altitudeAccuracy, t: p.timestamp };
        }
        if (c.altitude != null && (r.alt == null || (c.altitudeAccuracy ?? 999) <= (r.altAcc ?? 999))) { r.alt = c.altitude; r.altAcc = c.altitudeAccuracy; }
        r.gpsErr = null;
        if (r.phase === 'gps') maybeFinishGps();
      }, err => { r.gpsErr = geoErrorText(err); }));
    }

    const tick = setInterval(update, 200);
    r.stops.push(() => clearInterval(tick));
    update();

    function gpsLine() {
      if (kind !== 'cal') return '';
      if (r.best) return `GPS ±${fmt(r.best.acc, 0)} m` + (r.alt != null ? ` · Höhe ${fmt(r.alt, 0)} m${r.altAcc != null ? ' (±' + fmt(r.altAcc, 0) + ' m)' : ''}` : ' · keine Höhe');
      return r.gpsErr || 'GPS: warte auf Fix …';
    }

    function update() {
      if (run !== r) return;
      const now = performance.now();
      if (r.phase === 'prep') {
        const left = PREP_S - (now - r.t0) / 1000;
        ov.title.textContent = kind === 'cal' ? 'Kalibrierung: Gerät flach ablegen und nicht berühren' : 'Gerät flach ablegen und nicht berühren';
        ov.count.textContent = Math.max(1, Math.ceil(left));
        ov.bar.style.width = '0%';
        ov.live.textContent = '';
        ov.note.textContent = gpsLine();
        if (left <= 0) {
          r.phase = 'rec'; tStart = now;
          r.samples = { t: [], x: [], y: [], z: [] };
          mon = motionMonitor();
          r.startEpoch = Date.now();
        }
      } else if (r.phase === 'rec') {
        const el2 = now - tStart;
        const left = (LIMITS.durationMs - el2) / 1000;
        ov.title.textContent = kind === 'cal' ? 'Kalibrierung läuft' : 'Messung läuft';
        ov.count.textContent = Math.max(0, Math.ceil(left));
        ov.bar.style.width = Math.min(100, el2 / LIMITS.durationMs * 100) + '%';
        ov.live.textContent = wsum ? `|a| ${fmtG(wmean)} m/s²\nStreuung ${fmt(wsum > 1 ? Math.sqrt(wm2 / (wsum - 1)) : 0, 5)} m/s² · ${wsum} Werte` : '';
        ov.note.textContent = gpsLine();
        if (now - Math.max(lastEvent, tStart) > NO_DATA_MS && !r.samples.t.length) {
          fail('Keine Sensordaten. Freigabe prüfen; das Gerät hat evtl. keinen Beschleunigungssensor.');
        } else if (el2 >= LIMITS.durationMs) evaluate();
      } else if (r.phase === 'gps') {
        ov.note.textContent = gpsLine();
      }
    }

    function evaluate() {
      const res = analyze(r.samples);
      if (!res.ok) { fail(res.reason + ' – Messung verworfen.'); return; }
      r.res = res;
      beep(1046, 160);
      if (kind === 'cal') {
        r.phase = 'gps';
        ov.title.textContent = 'Messung abgeschlossen';
        ov.count.textContent = '';
        ov.live.textContent = `|a| ${fmtG(res.mean)} m/s²`;
        ov.bar.style.width = '100%';
        maybeFinishGps();
        if (run === r && r.phase === 'gps') {
          ov.title.textContent = 'Warte auf GPS-Fix (≤ ' + GPS_ACC + ' m)';
          ov.btns.prepend(h('button.btn', { type: 'button', onclick: () => { if (r.best) commitCal(); else toast('Noch kein GPS-Fix'); } }, 'Übernehmen'));
        }
      } else commitLoc();
    }

    function maybeFinishGps() {
      if (r.phase === 'gps' && r.best && r.best.acc <= GPS_ACC) commitCal();
    }

    function rawPack() {
      const s = r.samples, q = v => Math.round(v * 1e5) / 1e5;
      return { t0: r.startEpoch, dt: s.t.map(t => Math.round((t - s.t[0]) * 10) / 10), x: s.x.map(q), y: s.y.map(q), z: s.z.map(q) };
    }
    function summary(res) {
      return { t: r.startEpoch, a: res.mean, plainMean: res.plainMean, std: res.std, n: res.n, rate: res.rate,
        axis: res.axis, tilt: res.tilt, vec: res.vec.map(v => Math.round(v * 1e6) / 1e6) };
    }

    function commitCal() {
      const b = r.best;
      const prevAlt = cal ? cal.alt : 0;
      cal = { ...summary(r.res), lat: b.lat, lon: b.lon, acc: b.acc,
        alt: r.alt != null ? r.alt : prevAlt, altAcc: r.altAcc ?? null, altSrc: r.alt != null ? 'gps' : 'manual' };
      save(KEY_CAL, cal);
      if (!save(KEY_RAW_CAL, rawPack())) toast('Rohdaten nicht gespeichert (Speicher voll)');
      finish('Kalibriert' + (r.alt == null ? ' – GPS ohne Höhe, bitte Höhe eintragen' : ''));
      if (viewSeg.value === 'region') fitView();
    }

    function commitLoc() {
      const e = summary(r.res);
      hist.unshift(e);
      if (hist.length > HIST_MAX) hist.length = HIST_MAX;
      selected = e;
      save(KEY_HIST, hist);
      if (!save(KEY_RAW_LAST, rawPack())) toast('Rohdaten nicht gespeichert (Speicher voll)');
      finish('Messung gespeichert');
      fitView();
    }

    function fail(msg) {
      if (run !== r || r.phase === 'fail') return;
      r.phase = 'fail';
      beep(330, 220);
      ov.title.textContent = msg;
      ov.count.textContent = '';
      ov.live.textContent = '';
      ov.btns.textContent = '';
      ov.btns.append(
        h('button.btn', { type: 'button', onclick: () => { finish(null); measure(kind); } }, 'Neu starten'),
        h('button.btn', { type: 'button', onclick: () => finish(null) }, 'Schließen'));
    }

    function finish(msg) {
      if (run !== r) return;
      r.phase = 'done';
      for (const s of r.stops) { try { s(); } catch { /* egal */ } }
      el.remove();
      run = null;
      renderAll();
      if (msg) toast(msg, 2600);
    }
    r.finish = finish;
  }

  // ---------- Export ----------
  async function exportData() {
    const data = {
      app: 'Utilities · Gravitation', exportiert: new Date().toISOString(), einheiten: 'm/s², Zeit ms',
      kalibrierung: cal, rohKalibrierung: load(KEY_RAW_CAL, null),
      messungen: hist.map(e => ({ ...e, g: gObs(e) })), rohLetzteMessung: load(KEY_RAW_LAST, null),
      faktorK: kFactor(), hoehe: heightM()
    };
    const d = new Date();
    const name = `gravitation-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    try {
      const file = new File([blob], name, { type: 'application/json' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
    } catch (e) { if (e && e.name === 'AbortError') return; }
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  renderAll();
  fitView();

  return () => {
    disposed = true;
    clearTimeout(redrawTimer);
    if (run) run.finish(null);
    mapApi.map.remove();
  };
}
