// Inertialnavigation: Startpunkt + Startkurs (GPS/Kompass oder manuell) werden nach dem Start
// ausschließlich mit Inertialsensoren fortgeschrieben – Schritte (Koppelnavigation) oder
// Strapdown (Doppelintegration). Nach dem Start kein GPS und kein Magnetkompass.
// Rechenkern und Begründung der Kursquelle: ins/core.js.

import { h, svg, seg, stat, fmt, fmtDist, fmtLatLon, fmtDuration, copyText, toast } from '../lib/ui.js';
import { ensureMotionPermission, hasMotion, hasOrientation, watchOrientation, watchMotion, watchPosition, rotationMatrix, keepAwake, geoErrorText } from '../lib/sensors.js';
import { offsetEN, distance } from '../lib/geo.js';
import { createMap, posMarker, accuracyCircle, trackLine } from '../lib/map.js';
import { declination, magToTrue } from '../lib/magdecl.js';
import { load, save, remove } from '../lib/store.js';
import { ASSUME, AccelBias, StepDetector, Strapdown, forwardHeading, headingFromEuler, alphaOffset, toENU, ErrorModel, biasUncertainty, parseLatLon, parseDeg, wrap360 } from './ins/core.js';

const CFG_KEY = 'ins:cfg';
const RUN_KEY = 'ins:run';
const LAST_KEY = 'ins:last';
const MAX_TRACK = 20000;

const STYLE = `
.ins-map { height: 42vh; min-height: 250px; }
#tool-body > .ins-fix { flex-shrink: 0; }
.ins-badge { position: absolute; left: 10px; top: 10px; z-index: 500; display: flex; align-items: center; gap: 8px;
  background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 5px 12px 5px 5px;
  box-shadow: 0 1px 4px rgba(0,0,0,.15); pointer-events: none; }
.ins-badge svg { width: 36px; height: 36px; color: var(--text); display: block; }
.ins-badge .ins-needle { transform-origin: 18px 18px; transition: transform .2s linear; }
.ins-badge .ins-deg { font-size: 18px; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1.1; }
.ins-badge .ins-sub { font-size: 10px; letter-spacing: .5px; text-transform: uppercase; color: var(--text-2); }
.ins-start { stroke: var(--map-track); fill: var(--surface); stroke-width: 2.5; fill-opacity: 1; }
.ins-arrow { color: var(--map-pos); }
.ins-arrow svg { display: block; width: 44px; height: 44px; transform-origin: 22px 22px; }
.ins-wide { grid-column: 1 / -1; }
.ins-copy { cursor: pointer; }
.ins-copy .v { font-size: 17px; }
.ins-big { min-height: 56px; font-size: 18px; font-weight: 600; }
.ins-note { font-size: 13px; color: var(--text-2); line-height: 1.45; margin: 0; }
.ins-gap { display: flex; flex-direction: column; gap: 12px; }
.ins-inline { display: flex; gap: 8px; align-items: stretch; }
.ins-inline .input { flex: 1; min-width: 0; }
.ins-inline .btn { flex: none; }
.ins-sub2 { font-size: 12.5px; color: var(--text-2); margin-top: 2px; }
.ins-err { color: var(--danger); }
.ins-formula { font-family: var(--mono); font-size: 12px; color: var(--text); background: var(--surface-2);
  border-radius: 8px; padding: 8px 10px; line-height: 1.6; overflow-x: auto; white-space: nowrap; }
.ins-status { font-size: 12.5px; color: var(--text-2); text-align: center; font-variant-numeric: tabular-nums; }
.ins-list-v { text-align: right; }
`;

const ROSE = `<svg viewBox="0 0 36 36" fill="none" stroke="currentColor" stroke-width="1.4">
  <circle cx="18" cy="18" r="16" opacity=".35"/>
  <text x="18" y="7.6" font-size="6.5" text-anchor="middle" fill="currentColor" stroke="none" font-weight="700">N</text>
  <g class="ins-needle"><path d="M18 9 L22.5 24 L18 21 L13.5 24 Z" fill="currentColor" stroke="none"/></g>
</svg>`;

const ARROW = `<svg viewBox="0 0 44 44"><path d="M22 1.5 L29 13.5 L22 11 L15 13.5 Z" fill="currentColor"/></svg>`;
const CENTER_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"/></svg>';

function ensureStyle() {
  if (document.getElementById('style-ins')) return;
  document.head.append(h('style#style-ins', STYLE));
}

const waitFor = (fn, ms) => new Promise(res => {
  const t0 = performance.now();
  const tick = () => {
    const v = fn();
    if (v || performance.now() - t0 > ms) res(v || null);
    else setTimeout(tick, 50);
  };
  tick();
});

const fmtDeg = d => d == null ? '–' : fmt(wrap360(Math.round(d)) % 360, 0) + '°';
const fmtErr = r => '±' + (r < 10 ? fmt(r, 1) + '\u202fm' : fmtDist(r).replace(' ', '\u202f'));
const fmtIn = p => p.map(v => String(+v.toFixed(6)).replace('.', ',')).join(' ');
const fmtSigned = (d, digits = 1) => (d >= 0 ? '+' : '−') + fmt(Math.abs(d), digits) + '°';

export function mount(body, ctx) {
  ensureStyle();
  const L = window.L;

  // ---------- Einstellungen und gespeicherter Lauf ----------
  const stored = load(CFG_KEY, null);
  const cfg = Object.assign({ start: 'gps', method: 'strapdown', stepLen: 0.75, zupt: true, manPos: null, manHead: null, manPsi0: null, manE0: 0 }, stored, { v: 2 });
  const saveCfg = () => save(CFG_KEY, cfg);
  // Einmalige Umstellung: früher war „Schritte“ voreingestellt, Standard ist jetzt Strapdown
  if (stored && (stored.v || 1) < 2) { cfg.method = 'strapdown'; saveCfg(); }
  let run = load(RUN_KEY, null);
  let state = run && run.track && run.track.length ? 'ended' : 'idle';
  if (state === 'idle') run = null;
  let note = state === 'ended' ? 'Gespeicherter Verlauf. Beim Verlassen wurde angehalten – im Hintergrund wird nicht weitergerechnet.' : '';

  // ---------- Sensorzustand ----------
  let fix = null, geoErr = null;     // letzte GPS-Position (nur vor dem Start)
  let compass = null;                // {mag, acc, t} magnetisch
  let rel = null;                    // relatives deviceorientation {alpha, beta, gamma, abs, t}
  let c = 0;                         // alpha-Versatz relativ -> rechtweisend
  let haveRel = false;
  let lastHeading = null;
  let unGeo = null, unCompass = null, unRel = null, unMotion = null, unWake = null;
  let det = new StepDetector(), sd = null;
  let lastMotionT = null, tickPrev = null;
  let motionCount = 0, relCount = 0, motionHz = 0, relHz = 0, rateT = performance.now();
  let noLinAcc = false, warnBg = false, linOk = 0, linNull = 0;
  let calibHeading = null, em = null;
  let bias = new AccelBias(), unCalib = null, calibTimer = null, calibT0 = 0;
  let follow = true, saveT = 0, hasLast = !!load(LAST_KEY, null);

  // ---------- Aufbau ----------
  const mapEl = h('div.map.ins-map');
  const needleWrap = svg(ROSE);
  const badgeDeg = h('div.ins-deg', '–');
  const badgeSub = h('div.ins-sub', 'Kurs rw');
  const badge = h('div.ins-badge', needleWrap, h('div', badgeDeg, badgeSub));
  mapEl.append(badge);

  const sKurs = stat('Kurs', '–');
  const sErr = stat('Fehlerradius', '–');
  const sDist = stat('Strecke', '–');
  const sSteps = stat('Schritte', '–');
  const sDur = stat('Dauer', '–');
  const sSpeed = stat('Geschw. Mittel', '–');
  const sPos = stat('Position · tippen zum Kopieren', '–');
  sPos.el.classList.add('ins-wide', 'ins-copy');
  sPos.el.addEventListener('click', () => {
    const p = curPos();
    if (p) copyText(`${p[0].toFixed(6)}, ${p[1].toFixed(6)}`, 'Position kopiert');
  });
  const stats = h('div.stats', sKurs.el, sErr.el, sDist.el, sSteps.el, sDur.el, sSpeed.el, sPos.el);

  const btnMain = h('button.btn.primary.ins-big', { type: 'button', onclick: onMain }, 'Start');
  const btnReset = h('button.btn.ins-big', { type: 'button', onclick: onReset }, 'Zurücksetzen');
  const btnRow = h('div.btn-row', btnMain, btnReset);
  const status = h('div.ins-status');
  const bannerBox = h('div.ins-gap');

  // Startkonfiguration
  const segStart = seg([{ value: 'gps', label: 'GPS + Kompass' }, { value: 'manual', label: 'Manuell' }], cfg.start, v => {
    cfg.start = v; saveCfg(); syncSources(); render();
  });
  const gpsRows = {
    pos: h('div.ins-list-v', '–'), posSub: h('div.ins-sub2', 'Warte auf Position …'),
    comp: h('div.ins-list-v', '–'), compSub: h('div.ins-sub2', '')
  };
  const btnActivate = h('button.btn.block', { type: 'button', onclick: activateCompass }, 'Kompass aktivieren');
  const gpsPanel = h('div.ins-gap',
    h('div.list',
      h('div.list-row', h('span.k', 'Position'), h('div', gpsRows.pos, gpsRows.posSub)),
      h('div.list-row', h('span.k', 'Kompass'), h('div', h('div.ins-list-v', gpsRows.comp), gpsRows.compSub))
    ),
    btnActivate
  );

  const inPos = h('input.input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', spellcheck: false, placeholder: '48,137 11,575',
    value: cfg.manPos ? fmtIn(cfg.manPos) : '' });
  const posMsg = h('div.ins-sub2', 'Dezimalgrad Breite Länge – oder lange auf die Karte tippen.');
  const btnLast = h('button.btn', { type: 'button', onclick: useLast }, 'Letzte');
  const inHead = h('input.input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: 'z. B. 75',
    value: cfg.manHead != null ? fmt(cfg.manHead, 1) : '' });
  const headMsg = h('div.ins-sub2', 'Grad, rechtweisend (geografisch Nord).');
  const btnTake = h('button.btn', { type: 'button', onclick: takeCompass }, 'Kompass');
  inPos.addEventListener('input', () => {
    const p = parseLatLon(inPos.value);
    if (p) { cfg.manPos = p; cfg.manE0 = 0; saveCfg(); posMsg.classList.remove('ins-err'); posMsg.textContent = fmtLatLon(p[0], p[1], 5); render(); }
    else { posMsg.classList.toggle('ins-err', !!inPos.value.trim()); posMsg.textContent = inPos.value.trim() ? 'Nicht lesbar – Format „48,137 11,575“.' : 'Dezimalgrad Breite Länge – oder lange auf die Karte tippen.'; }
  });
  inHead.addEventListener('input', () => {
    const d = parseDeg(inHead.value);
    cfg.manHead = d; cfg.manPsi0 = null; saveCfg();
    headMsg.classList.toggle('ins-err', d == null && !!inHead.value.trim());
    headMsg.textContent = d == null && inHead.value.trim() ? 'Bitte Zahl 0–360 eingeben.' : 'Grad, rechtweisend (geografisch Nord).';
    render();
  });
  const manPanel = h('div.ins-gap',
    h('div.field', h('label', 'Position'), h('div.ins-inline', inPos, btnLast), posMsg),
    h('div.field', h('label', 'Ausrichtung'), h('div.ins-inline', inHead, btnTake), headMsg)
  );

  const cfgCard = h('div.card.ins-gap',
    h('div.card-title', 'Startpunkt'),
    segStart, gpsPanel, manPanel,
    h('p.ins-note', 'Gerät beim Start in Gehrichtung halten: Oberkante zeigt in Bewegungsrichtung. Danach werden weder GPS noch Magnetkompass verwendet.')
  );

  const segMethod = seg([{ value: 'strapdown', label: 'Inertial' }, { value: 'steps', label: 'Schritte (Extra)' }], cfg.method, v => {
    cfg.method = v; saveCfg(); render();
  });
  const inStep = h('input.input', { type: 'text', inputmode: 'decimal', value: fmt(cfg.stepLen, 2) });
  inStep.addEventListener('change', () => {
    const v = parseFloat(inStep.value.replace(',', '.'));
    if (Number.isFinite(v) && v >= 0.2 && v <= 2) { cfg.stepLen = v; saveCfg(); }
    inStep.value = fmt(cfg.stepLen, 2);
  });
  const segZupt = seg([{ value: 'on', label: 'An' }, { value: 'off', label: 'Aus' }], cfg.zupt ? 'on' : 'off', v => {
    cfg.zupt = v === 'on'; saveCfg(); if (sd) sd.zupt = cfg.zupt;
  });
  const stepsPanel = h('div.ins-gap',
    h('div.field', h('label', 'Schrittlänge (m)'), inStep),
    h('p.ins-note', 'Zusatzverfahren (Fußgänger-Koppelnavigation): Schritte werden aus dem Beschleunigungsbetrag erkannt; je Schritt wird die Position um die Schrittlänge im aktuellen Kurs fortgeschrieben. Driftet langsamer als Strapdown, setzt aber Gehen voraus.')
  );
  const strapNote = h('p.ins-note', 'Strapdown: Beschleunigung ohne Schwerkraft wird mit der Gerätelage nach Ost/Nord gedreht und zweifach integriert. Beim Start 2 s Kalibrierung – Gerät ruhig halten; der gemessene Offset (Bias) wird danach abgezogen und bei Stillstand nachgeführt.');
  const strapPanel = h('div.ins-gap',
    strapNote,
    h('div.field', h('label', 'Stillstandserkennung (ZUPT)'), segZupt),
    h('div.banner.warn', h('b', 'Driftet stark. '), 'Reine Doppelintegration der Smartphone-Beschleunigung: kleinste Messfehler wachsen mit t². Nur für kurze Zeiträume (Sekunden bis wenige Minuten) aussagekräftig.')
  );
  const methodCard = h('div.card.ins-gap', h('div.card-title', 'Verfahren'), segMethod, stepsPanel, strapPanel);

  const runList = h('div.list');
  const formula = h('div.ins-formula',
    h('div', 'Inertial: r = r₀ + Σ½·b·T² + Σ sin ψ·Δs'),
    h('div', 'Schritte: r = r₀ + Σ (3 % + sin ψ)·Δs'),
    h('div', `ψ = ψ₀ + ${fmt(ASSUME.driftMove, 1)}°/min·t_Bew + ${fmt(ASSUME.driftRest, 1)}°/min·t_Ruhe`),
    h('div', `b = √((σ/√n)² + ${fmt(ASSUME.biasInst, 2)}²) m/s²`));
  const estCard = h('div.card.ins-gap',
    h('div.card-title', 'Fehlerradius (Schätzung)'),
    formula,
    h('p.ins-note', `Der Kreis wächst nur bei Bewegung. T Dauer je Bewegungsabschnitt – ein erkannter Stillstand (ZUPT) beendet ihn; ohne ZUPT zählt die ganze Laufzeit. Δs zurückgelegte Strecke, r₀ Startunsicherheit (GPS-Genauigkeit, manuell 0 m), ψ₀ Startkursfehler (Kompassgenauigkeit, sonst ${ASSUME.headingErr0}°), σ und n aus der Kalibrierung, ${fmt(ASSUME.biasInst, 2)} m/s² angenommener Rest-Bias (Instabilität, Schwerkraftleck beim Drehen/Neigen). Drift- und Bias-Werte sind Annahmen, keine Messwerte.`)
  );
  const hint = h('p.ins-note', 'Sensordaten gibt es nur bei geöffneter App und entsperrtem Bildschirm (iOS). Beim Verlassen des Werkzeugs wird angehalten; der Verlauf bleibt gespeichert, läuft aber nicht im Hintergrund weiter.');

  body.append(mapEl, bannerBox, stats, btnRow, status, cfgCard, methodCard, runList, estCard, hint);
  // Flex-Kinder mit overflow:hidden würden sonst im scrollenden Spaltenlayout gestaucht
  for (const el of body.children) el.classList.add('ins-fix');

  const followBtn = h('button.icon-btn', { type: 'button', title: 'Position zentrieren', 'aria-label': 'Position zentrieren', html: CENTER_ICON, onclick: () => {
    follow = true;
    const p = curPos() || previewPos();
    if (p) map.setView(p, Math.max(map.getZoom(), 16), { animate: false });
  } });
  ctx.setActions(followBtn);

  // ---------- Karte ----------
  const mapApi = createMap(mapEl, {});
  const map = mapApi.map;
  const trackLayer = trackLine([]).addTo(map);
  const errLayer = accuracyCircle([0, 0], 1).addTo(map);
  const startLayer = L.circleMarker([0, 0], { radius: 5, className: 'ins-start', interactive: false });
  const posLayer = posMarker([0, 0]);
  const arrowLayer = L.marker([0, 0], { icon: L.divIcon({ className: 'ins-arrow', html: ARROW, iconSize: [44, 44], iconAnchor: [22, 22] }), interactive: false, keyboard: false });
  map.on('dragstart', () => { follow = false; });
  const onMapPick = e => {
    if (state !== 'idle') return;
    if (e.type === 'click' && cfg.start !== 'manual') return;
    if (cfg.start !== 'manual') { cfg.start = 'manual'; segStart.set('manual'); syncSources(); }
    setManPos([e.latlng.lat, wrapLon(e.latlng.lng)], 0);
  };
  map.on('click', onMapPick);
  map.on('contextmenu', onMapPick);
  const wrapLon = l => ((l + 540) % 360) - 180;

  // ---------- Sensoren ----------
  function startCompass() {
    if (unCompass || !hasOrientation()) return;
    unCompass = watchOrientation(o => {
      let mag = o.heading;
      // Android (absolutes alpha): Kurs neigungsrichtig aus der Lage, wie später beim Fortschreiben
      if (o.absolute && o.headingAccuracy == null && o.alpha != null) mag = forwardHeading(rotationMatrix(o.alpha, o.beta, o.gamma));
      if (mag == null) return;
      compass = { mag, acc: o.headingAccuracy, t: performance.now() };
    });
  }
  function stopCompass() { if (unCompass) { unCompass(); unCompass = null; } compass = null; }

  // Relatives Lageereignis (iOS: alpha relativ; Android/Chrome: ohne Magnetometer).
  function startRel() {
    if (unRel || !hasOrientation()) return;
    const f = e => {
      if (e.alpha == null || e.beta == null) return;
      rel = { alpha: e.alpha, beta: e.beta, gamma: e.gamma || 0, abs: !!e.absolute, t: performance.now() };
      relCount++;
    };
    window.addEventListener('deviceorientation', f);
    unRel = () => window.removeEventListener('deviceorientation', f);
  }
  function stopRel() { if (unRel) { unRel(); unRel = null; } rel = null; }

  function startGeo() {
    if (unGeo) return;
    unGeo = watchPosition(p => {
      const first = !fix;
      fix = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, ts: p.timestamp };
      geoErr = null;
      if (first && state === 'idle' && cfg.start === 'gps') map.setView([fix.lat, fix.lon], 17, { animate: false });
      render();
    }, err => { geoErr = err; render(); }, { maximumAge: 30000 });
  }
  function stopGeo() { if (unGeo) { unGeo(); unGeo = null; } }

  function syncSources() {
    if (state === 'idle') {
      if (cfg.start === 'gps') startGeo(); else stopGeo();
      startCompass();
    } else {
      stopGeo();
      stopCompass();
    }
  }

  async function activateCompass() {
    const ok = await ensureMotionPermission();
    if (!ok) { toast('Sensorzugriff nicht erlaubt'); return; }
    startCompass();
    startRel();
    const got = await waitFor(() => compass, 1500);
    if (!got) toast('Kein Kompasswert verfügbar');
    render();
  }

  const compassFresh = () => compass && performance.now() - compass.t < 2500 ? compass : null;
  function compassTrue(lat, lon) {
    const cp = compassFresh();
    if (!cp) return null;
    return { true: magToTrue(cp.mag, lat, lon), mag: cp.mag, decl: declination(lat, lon), acc: cp.acc };
  }
  function declRef() {
    if (cfg.start === 'gps' && fix) return [fix.lat, fix.lon];
    if (cfg.manPos) return cfg.manPos;
    if (fix) return [fix.lat, fix.lon];
    const m = map.getCenter();
    return [m.lat, m.lng];
  }

  // ---------- Manuelle Eingaben ----------
  function setManPos(p, e0) {
    cfg.manPos = p; cfg.manE0 = e0 || 0; saveCfg();
    inPos.value = fmtIn(p);
    posMsg.classList.remove('ins-err');
    posMsg.textContent = fmtLatLon(p[0], p[1], 5) + (e0 ? ` · ${fmtErr(e0)} übernommen` : '');
    render();
  }
  function useLast() {
    const last = load(LAST_KEY, null);
    if (!last) { toast('Keine letzte Schätzung vorhanden'); return; }
    setManPos([last.lat, last.lon], last.err || 0);
    map.setView([last.lat, last.lon], Math.max(map.getZoom(), 16), { animate: false });
  }
  async function takeCompass() {
    if (!compassFresh()) {
      const ok = await ensureMotionPermission();
      if (!ok) { toast('Sensorzugriff nicht erlaubt'); return; }
      startCompass();
      startRel();
      await waitFor(() => compassFresh(), 1500);
    }
    const [lat, lon] = declRef();
    const ct = compassTrue(lat, lon);
    if (!ct) { toast('Kein Kompasswert verfügbar'); return; }
    cfg.manHead = Math.round(ct.true * 10) / 10;
    cfg.manPsi0 = ct.acc;
    saveCfg();
    inHead.value = fmt(cfg.manHead, 1);
    headMsg.classList.remove('ins-err');
    headMsg.textContent = `Vom Kompass: magnetisch ${fmtDeg(ct.mag)}, Missweisung ${fmtSigned(ct.decl)}` + (ct.acc != null ? `, ±${fmt(ct.acc, 0)}°` : '');
    render();
  }

  // ---------- Ablauf ----------
  async function onMain() {
    if (state === 'running') return pause();
    if (state === 'paused') return resume();
    if (state === 'ended') return onReset();
    await start();
  }

  async function start() {
    // Freigabe zuerst, direkt aus der Nutzergeste (iOS)
    const ok = await ensureMotionPermission();
    if (!ok) { toast('Sensorzugriff nicht erlaubt – Start nicht möglich'); return; }
    if (!hasMotion()) { toast('Keine Bewegungssensoren verfügbar'); return; }
    startRel();
    let sp;
    if (cfg.start === 'gps') {
      if (!fix) { toast('Noch keine GPS-Position'); return; }
      startCompass();
      btnMain.disabled = true;
      const got = await waitFor(() => compassFresh(), 1500);
      btnMain.disabled = false;
      if (!got) { toast('Kein Kompasswert – Ausrichtung manuell wählen'); render(); return; }
      const ct = compassTrue(fix.lat, fix.lon);
      sp = { lat: fix.lat, lon: fix.lon, e0: fix.acc || 0, heading: ct.true, mag: ct.mag, decl: ct.decl, psi0: ct.acc ?? ASSUME.headingErr0, src: 'gps' };
    } else {
      if (!cfg.manPos) { toast('Startposition fehlt'); inPos.focus(); return; }
      if (cfg.manHead == null) { toast('Ausrichtung fehlt'); inHead.focus(); return; }
      sp = { lat: cfg.manPos[0], lon: cfg.manPos[1], e0: cfg.manE0 || 0, heading: cfg.manHead, psi0: cfg.manPsi0 ?? ASSUME.headingErr0, src: 'manual' };
    }
    // Kursbezug: relatives alpha zum Startzeitpunkt
    btnMain.disabled = true;
    const r0 = await waitFor(() => rel && performance.now() - rel.t < 1000 ? rel : null, 1500);
    btnMain.disabled = false;
    haveRel = false;
    if (r0) {
      const off = alphaOffset(r0.alpha, r0.beta, r0.gamma, sp.heading);
      if (off != null) { c = off; haveRel = true; }
    }
    stopGeo();
    stopCompass();       // ab hier kein Magnetkompass

    // Strapdown: Bias-Kalibrierung in Ruhe (2 s)
    bias = new AccelBias();
    linOk = 0; linNull = 0;
    if (cfg.method === 'strapdown') {
      calibHeading = sp.heading;
      const cal = await calibrate(2000);
      if (!cal) return;
      bias = cal;
    }

    run = {
      v: 1, method: cfg.method, stepLen: cfg.stepLen, created: Date.now(), start: sp,
      E: 0, N: 0, dist: 0, steps: 0, tRun: 0, heading: sp.heading, err: sp.e0, speedNow: 0,
      relSrc: !haveRel ? 'none' : r0.abs ? 'abs' : 'rel',
      bias: cfg.method === 'strapdown' ? { mag: bias.magnitude, spread: bias.spread, n: bias.n, b: biasUncertainty(bias.spread, bias.n) } : null, track: [[sp.lat, sp.lon]]
    };
    det = new StepDetector();
    sd = new Strapdown({ zupt: cfg.zupt });
    em = new ErrorModel({ method: cfg.method, e0: sp.e0, psi0: sp.psi0, b: run.bias ? run.bias.b : ASSUME.accelBias });
    run.em = em;
    lastHeading = sp.heading;
    noLinAcc = false; warnBg = false; note = ''; linOk = 0; linNull = 0;
    follow = true;
    map.setView([sp.lat, sp.lon], Math.max(map.getZoom(), 17), { animate: false });
    await beginMotion();
    state = 'running';
    persist(true);
    render();
  }

  /** Ruhephase aufnehmen; gibt AccelBias oder null (Abbruch, Hinweis per Toast). */
  async function calibrate(ms) {
    const cal = new AccelBias();
    let nulls = 0;
    state = 'calib'; calibT0 = performance.now();
    render();
    unCalib = watchMotion(e => {
      const a = e.acceleration;
      if (a && a.x != null) cal.add(a.x, a.y, a.z); else nulls++;
    });
    if (!unWake) unWake = await keepAwake();
    await new Promise(res => { calibTimer = setTimeout(res, ms); });
    calibTimer = null;
    if (unCalib) { unCalib(); unCalib = null; }
    if (state !== 'calib') return null;          // inzwischen verlassen/zurückgesetzt
    let msg = '';
    if (cal.n < 10) msg = nulls ? 'Keine Beschleunigung ohne Schwerkraft – Strapdown nicht möglich. „Schritte (Extra)“ verwenden.' : 'Keine Bewegungsdaten empfangen.';
    else if (cal.spread > 0.3) msg = 'Gerät war nicht ruhig genug – ruhig halten und erneut starten.';
    if (msg) {
      if (unWake) { unWake(); unWake = null; }
      state = 'idle';
      syncSources();
      toast(msg, 3200);
      render();
      return null;
    }
    return cal;
  }

  async function beginMotion() {
    lastMotionT = null;
    tickPrev = performance.now();
    unMotion = watchMotion(onMotion);
    if (!unWake) unWake = await keepAwake();
  }
  function endMotion() {
    if (unMotion) { unMotion(); unMotion = null; }
    if (unWake) { unWake(); unWake = null; }
    accumulateTime();
  }
  function accumulateTime() {
    if (state === 'running' && tickPrev != null && run) {
      const now = performance.now();
      run.tRun += now - tickPrev;
      tickPrev = now;
    }
  }

  function pause(reason) {
    if (state !== 'running') return;
    if (em) em.closeSegment();          // Fortsetzen beginnt mit v = 0
    endMotion();
    state = 'paused';
    if (reason) { note = reason; warnBg = true; }
    persist(true);
    render();
  }
  async function resume() {
    if (state !== 'paused') return;
    det.reset();
    if (sd) { sd.vE = 0; sd.vN = 0; sd.buf = []; }
    warnBg = false; note = '';
    state = 'running';
    await beginMotion();
    render();
  }

  function onReset() {
    if (run && run.track.length > 1 && !confirm('Verlauf löschen und neu beginnen?')) return;
    if (state === 'running') endMotion();
    if (run) {
      const p = curPos();
      if (p) { save(LAST_KEY, { lat: p[0], lon: p[1], err: run.err, t: Date.now() }); hasLast = true; }
    }
    run = null; sd = null; em = null; haveRel = false; note = ''; warnBg = false;
    remove(RUN_KEY);
    state = 'idle';
    stopRel();
    syncSources();
    trackLayer.setLatLngs([]);
    render();
  }

  // ---------- Fortschreibung ----------
  function currentHeading() {
    if (haveRel && rel) {
      const hd = headingFromEuler(rel.alpha, rel.beta, rel.gamma, c);
      if (hd != null) lastHeading = hd;
    }
    return lastHeading;
  }

  function onMotion(e) {
    if (state !== 'running' || !run) return;
    motionCount++;
    let t = (e.timeStamp || performance.now()) / 1000;
    let dt = lastMotionT == null ? 0 : t - lastMotionT;
    if (!(dt > 0) || dt > 0.25) {
      // Zeitstempel unbrauchbar oder Lücke: Intervall des Ereignisses (ms; ältere iOS: s)
      const iv = Number(e.interval);
      dt = lastMotionT == null ? 0 : (iv > 1 ? iv / 1000 : iv > 0 ? iv : 0.016);
      if (dt > 0.25) dt = 0.25;
    }
    lastMotionT = t;

    if (run.method === 'steps') {
      const a = e.accelerationIncludingGravity && e.accelerationIncludingGravity.x != null ? e.accelerationIncludingGravity : e.acceleration;
      if (!a || a.x == null) return;
      const mag = Math.hypot(a.x, a.y, a.z);
      if (em) em.update(dt, t - det.lastStep > 1.5, 0);   // Ruhe: seit 1,5 s kein Schritt
      if (det.push(t, mag)) {
        const hd = currentHeading();
        const L0 = run.stepLen;
        run.E += L0 * Math.sin(hd * Math.PI / 180);
        run.N += L0 * Math.cos(hd * Math.PI / 180);
        run.dist += L0;
        if (em) em.update(0, false, L0);
        run.steps++;
        addTrackPoint(0);
      }
    } else {
      const a = e.acceleration;
      if (!a || a.x == null) { linNull++; noLinAcc = linOk === 0 && linNull > 30; return; }
      linOk++; noLinAcc = false;
      if (!rel || dt <= 0) return;
      const [x, y, z] = bias.correct(a.x, a.y, a.z);
      const R = rotationMatrix(rel.alpha + (haveRel ? c : 0), rel.beta, rel.gamma);
      const [aE, aN] = toENU(R, x, y, z);
      sd.push(t, dt, aE, aN, Math.hypot(x, y, z));
      if (sd.still) bias.adapt(a.x, a.y, a.z, dt);   // Bias im Stillstand nachführen
      const ds = sd.dist - run.dist;
      run.E = sd.pE; run.N = sd.pN; run.dist = sd.dist; run.speedNow = sd.speed;
      if (em) em.update(dt, sd.zupt && sd.still, ds);
      addTrackPoint(0.5);
    }
  }

  function addTrackPoint(minDist) {
    const p = curPos();
    const tr = run.track;
    const last = tr[tr.length - 1];
    if (minDist && last && distance(last[0], last[1], p[0], p[1]) < minDist) return;
    tr.push([+p[0].toFixed(7), +p[1].toFixed(7)]);
    if (tr.length > MAX_TRACK) run.track = tr.filter((_, i) => i % 2 === 0 || i === tr.length - 1);
  }

  function curPos() {
    if (!run) return null;
    return offsetEN(run.start.lat, run.start.lon, run.E, run.N);
  }
  function previewPos() {
    if (cfg.start === 'gps') return fix ? [fix.lat, fix.lon] : null;
    return cfg.manPos;
  }
  function previewHeading() {
    if (state === 'calib' && calibHeading != null) return calibHeading;
    if (cfg.start === 'manual') return cfg.manHead;
    const [lat, lon] = declRef();
    const ct = compassTrue(lat, lon);
    return ct ? ct.true : null;
  }

  function persist(force) {
    if (!run) return;
    const now = performance.now();
    if (!force && now - saveT < 3000) return;
    saveT = now;
    save(RUN_KEY, run);
  }

  // ---------- Anzeige ----------
  function setHeadingUI(hd, sub) {
    badgeDeg.textContent = fmtDeg(hd);
    badgeSub.textContent = sub;
    needleWrap.querySelector('.ins-needle').style.transform = `rotate(${hd == null ? 0 : hd}deg)`;
    const icon = arrowLayer.getElement && arrowLayer.getElement();
    if (icon) {
      const s = icon.querySelector('svg');
      if (s) { s.style.transform = `rotate(${hd == null ? 0 : hd}deg)`; s.style.visibility = hd == null ? 'hidden' : 'visible'; }
    }
  }

  function placeMarkers(p, r, hd, startP) {
    if (p) {
      posLayer.setLatLng(p); if (!map.hasLayer(posLayer)) posLayer.addTo(map);
      arrowLayer.setLatLng(p); if (!map.hasLayer(arrowLayer)) arrowLayer.addTo(map);
      errLayer.setLatLng(p); errLayer.setRadius(Math.max(r || 0, 0.5));
      errLayer.setStyle({ opacity: r ? 1 : 0, fillOpacity: r ? 1 : 0 });
    } else {
      for (const l of [posLayer, arrowLayer]) if (map.hasLayer(l)) map.removeLayer(l);
      errLayer.setStyle({ opacity: 0, fillOpacity: 0 });
    }
    if (startP) { startLayer.setLatLng(startP); if (!map.hasLayer(startLayer)) startLayer.addTo(map); }
    else if (map.hasLayer(startLayer)) map.removeLayer(startLayer);
  }

  let lastTrackLen = -1;
  function render() {
    const idle = state === 'idle';
    cfgCard.hidden = !idle;
    gpsPanel.hidden = cfg.start !== 'gps';
    manPanel.hidden = cfg.start !== 'manual';
    segMethod.querySelectorAll('button').forEach(b => { b.disabled = !idle; });
    const method = run ? run.method : cfg.method;
    stepsPanel.hidden = !idle || method !== 'steps';
    strapPanel.hidden = method !== 'strapdown';
    strapNote.hidden = !idle;
    methodCard.hidden = !idle && method !== 'strapdown';
    segMethod.hidden = !idle;
    btnLast.hidden = !hasLast;

    btnMain.textContent = { idle: 'Start', calib: 'Kalibrieren …', running: 'Stopp', paused: 'Fortsetzen', ended: 'Neue Messung' }[state];
    btnMain.disabled = state === 'calib';
    btnReset.hidden = idle || state === 'ended' || state === 'calib';

    // Banner
    const banners = [];
    if (!hasMotion() || !hasOrientation()) banners.push(h('div.banner.warn', 'Dieser Browser liefert keine Lage-/Bewegungssensoren. Inertialnavigation nicht möglich.'));
    if (note) banners.push(h('div.banner' + (warnBg ? '.warn' : ''), note));
    if (run && state !== 'idle' && !haveRel && state !== 'ended') banners.push(h('div.banner.warn', h('b', 'Keine Lagedaten. '), 'Kursänderungen werden nicht erfasst – der Startkurs bleibt konstant.'));
    if (run && run.method === 'strapdown' && noLinAcc) banners.push(h('div.banner.warn', 'Das Gerät liefert keine Beschleunigung ohne Schwerkraft – Strapdown nicht möglich. Verfahren „Schritte“ verwenden.'));
    if (state === 'running' && motionHz === 0 && run && run.tRun > 2500) banners.push(h('div.banner.warn', 'Keine Bewegungsdaten empfangen.'));
    bannerBox.replaceChildren(...banners);
    bannerBox.hidden = !banners.length;

    // GPS-Panel
    if (idle && cfg.start === 'gps') {
      if (fix) {
        gpsRows.pos.textContent = fmtLatLon(fix.lat, fix.lon, 5);
        const age = Math.max(0, (Date.now() - fix.ts) / 1000);
        gpsRows.posSub.textContent = `±${fmt(fix.acc, 0)} m · ${age < 2 ? 'aktuell' : 'vor ' + fmtDuration(age * 1000)}`;
      } else {
        gpsRows.pos.textContent = '–';
        gpsRows.posSub.textContent = geoErr ? geoErrorText(geoErr) : 'Warte auf Position …';
      }
      const [lat, lon] = declRef();
      const ct = compassTrue(lat, lon);
      if (ct) {
        gpsRows.comp.textContent = `${fmtDeg(ct.true)} rw`;
        gpsRows.compSub.textContent = `magn. ${fmtDeg(ct.mag)} · Missw. ${fmtSigned(ct.decl)}` + (ct.acc != null ? ` · ±${fmt(ct.acc, 0)}°` : '');
      } else {
        gpsRows.comp.textContent = '–';
        gpsRows.compSub.textContent = 'kein Kompasswert';
      }
      btnActivate.hidden = !!ct || !hasOrientation();
    }

    // Kennzahlen
    if (run) {
      const p = curPos();
      const hd = state === 'ended' ? run.heading : currentHeading();
      if (state !== 'ended' && hd != null) run.heading = hd;
      const tS = run.tRun / 1000;
      if (em && state !== 'ended') run.err = em.radius;
      sKurs.set(fmtDeg(hd), 'rw');
      sErr.set(fmtErr(run.err));
      sDist.set(fmtDist(run.dist));
      if (run.method === 'steps') { sSteps.el.querySelector('.k').textContent = 'Schritte'; sSteps.set(fmt(run.steps, 0)); }
      else { sSteps.el.querySelector('.k').textContent = 'Geschw. akt.'; sSteps.set(fmt(run.speedNow * 3.6, 1), 'km/h'); }
      sDur.set(fmtDuration(run.tRun));
      sSpeed.set(tS > 1 ? fmt(run.dist / tS * 3.6, 1) : '–', 'km/h');
      sPos.set(fmtLatLon(p[0], p[1], 5));
      setHeadingUI(hd, state === 'running' ? 'Kurs rw · inertial' : 'Kurs rw');
      if (run.track.length !== lastTrackLen) { trackLayer.setLatLngs(run.track); lastTrackLen = run.track.length; }
      placeMarkers(p, run.err, hd, [run.start.lat, run.start.lon]);
      if (state === 'running' && follow) {
        const inner = map.getBounds().pad(-0.25);
        if (!inner.contains(p)) map.panTo(p, { animate: false });
      }
      const hzTxt = state === 'running' ? `Bewegung ${fmt(motionHz, 0)} Hz · Lage ${fmt(relHz, 0)} Hz${sd && run.method === 'strapdown' && sd.still ? ' · Stillstand' : ''}` : '';
      status.textContent = hzTxt;
      status.hidden = !hzTxt;
      renderRunList();
    } else {
      const p = previewPos();
      const hd = previewHeading();
      for (const s of [sDist, sSteps, sDur, sSpeed]) s.set('–');
      sSteps.el.querySelector('.k').textContent = cfg.method === 'steps' ? 'Schritte' : 'Geschw. akt.';
      sKurs.set(fmtDeg(hd), hd != null ? 'rw' : '');
      const r0 = cfg.start === 'gps' ? (fix ? fix.acc : null) : (cfg.manPos ? cfg.manE0 || 0 : null);
      sErr.set(r0 != null ? fmtErr(r0) : '–');
      sPos.set(p ? fmtLatLon(p[0], p[1], 5) : '–');
      setHeadingUI(hd, 'Startkurs rw');
      if (lastTrackLen !== 0) { trackLayer.setLatLngs([]); lastTrackLen = 0; }
      placeMarkers(p, r0, hd, cfg.start === 'manual' ? p : null);
      if (cfg.start === 'manual' && map.hasLayer(posLayer)) map.removeLayer(posLayer);
      const left = Math.max(0, 2 - (performance.now() - calibT0) / 1000);
      status.textContent = state === 'calib' ? `Gerät ruhig halten – Kalibrierung ${fmt(left, 1)} s` : '';
      status.hidden = state !== 'calib';
      runList.hidden = true;
    }
  }

  function renderRunList() {
    const s = run.start;
    const rows = [
      ['Verfahren', run.method === 'steps' ? `Schritte à ${fmt(run.stepLen, 2)} m` : 'Inertial (Strapdown)' + (cfg.zupt ? ' + ZUPT' : '')],
      run.bias && ['Bias (Start)', `${fmt(run.bias.mag, 3)} m/s² · Streuung ${fmt(run.bias.spread, 3)}`],
      run.bias && run.bias.b && ['b (Annahme)', `${fmt(run.bias.b, 3)} m/s²`],
      run.em && ['Bewegt / Ruhe', `${fmtDuration((run.em.tMove || 0) * 1000)} / ${fmtDuration((run.em.tRest || 0) * 1000)} · ψ ±${fmt(em ? em.psi : (run.em.psi0 || 0), 1)}°`],
      ['Start', s.src === 'gps' ? `GPS ±${fmt(s.e0, 0)} m` : (s.e0 ? `manuell ±${fmt(s.e0, 0)} m` : 'manuell')],
      ['Startkurs', `${fmtDeg(s.heading)} rw` + (s.src === 'gps' ? ` (magn. ${fmtDeg(s.mag)}, Missw. ${fmtSigned(s.decl)})` : '') + ` ±${fmt(s.psi0, 0)}°`],
      ['Kursquelle', { rel: 'Lage relativ (Gyro)', abs: 'Lage (vom Browser absolut)', none: 'keine – Kurs konstant' }[run.relSrc] || '–']
    ];
    runList.replaceChildren(...rows.filter(Boolean).map(([k, v]) => h('div.list-row', h('span.k', k), h('span.v.small', v))));
    runList.hidden = false;
  }

  // ---------- Takt ----------
  const timer = setInterval(() => {
    const now = performance.now();
    if (now - rateT >= 1000) {
      motionHz = motionCount * 1000 / (now - rateT);
      relHz = relCount * 1000 / (now - rateT);
      motionCount = 0; relCount = 0; rateT = now;
    }
    accumulateTime();
    if (state === 'running') persist(false);
    render();
  }, 250);

  const onVis = () => {
    if (document.visibilityState === 'hidden' && state === 'running') {
      pause('Im Hintergrund angehalten. Während der Unterbrechung wurden keine Bewegungen erfasst; der Kursbezug kann verloren sein – Kurs prüfen, sonst neu starten (Manuell › Letzte).');
    }
  };
  document.addEventListener('visibilitychange', onVis);

  // ---------- Start ----------
  syncSources();
  if (run) {
    trackLayer.setLatLngs(run.track);
    lastTrackLen = run.track.length;
    const b = trackLayer.getBounds();
    if (b.isValid()) map.fitBounds(b.pad(0.2), { maxZoom: 18, animate: false });
  } else {
    const p = previewPos();
    if (p) map.setView(p, 17, { animate: false });
  }
  render();

  return () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVis);
    if (state === 'running') endMotion();
    if (run) { save(RUN_KEY, run); }
    if (unWake) { unWake(); unWake = null; }
    if (calibTimer) clearTimeout(calibTimer);
    if (unCalib) { unCalib(); unCalib = null; }
    stopGeo(); stopCompass(); stopRel();
    if (unMotion) { unMotion(); unMotion = null; }
    map.remove();
  };
}
