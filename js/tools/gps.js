// GPS (offline): Position des GNSS-Empfängers auf der Karte samt Genauigkeitskreis,
// Fix-Status, Konvergenz der Genauigkeit und Kennzahlen.
//
// Der Browser liefert nur die fertige Lösung (Lat/Lon/Genauigkeit/Höhe …). Satellitenanzahl
// und Rohdaten sind auf dem iPhone nicht zugänglich (auch nicht für native Apps).

import { h, svg, stat, fmt, fmtLatLon, fmtDuration, copyText } from '../lib/ui.js';
import { watchPosition, keepAwake, geoErrorText } from '../lib/sensors.js';
import { createMap, posMarker, accuracyCircle } from '../lib/map.js';
import { load, save, remove } from '../lib/store.js';

const TARGET_ACC = 10;           // Ziel für die Konvergenzanzeige (m)
const STALE_FIX_MS = 30000;      // ab hier gilt der letzte Fix als veraltet

const FOLLOW_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M20 4 4 11l7 2 2 7z"/></svg>';

export function mount(body, ctx) {
  injectStyle();
  const L = window.L;
  const offs = [];
  const on = (t, ev, f) => { t.addEventListener(ev, f); offs.push(() => t.removeEventListener(ev, f)); };

  // ---------- Zustand ----------
  let running = false, stopWatch = null, wakeRelease = null, restartTimer = null;
  let startT = 0, firstFixMs = null, fixes = 0, last = null, lastSaved = 0;
  const accHist = [];
  let follow = load('gps:follow', true);
  // Altdaten früherer Versionen (berechnete Satelliten) entfernen
  for (const k of ['gps:orbits', 'gps:mask', 'gps:hide']) remove(k);
  const stored = load('gps:last', null);

  // ---------- Karte ----------
  const mapEl = h('div.map.gps-map.gps-blk');
  body.append(mapEl);
  const mapApi = createMap(mapEl, stored ? { center: [stored.lat, stored.lon], zoom: 14 } : {});
  const map = mapApi.map;
  let marker = null, circle = null, lastTargetZoom = null;
  map.on('dragstart', () => setFollow(false));

  // ---------- Kopfleiste ----------
  const followBtn = h('button.icon-btn.gps-follow', { type: 'button', title: 'Karte folgen', 'aria-label': 'Karte folgen', html: FOLLOW_ICON, onclick: () => setFollow(!follow, true) });
  ctx.setActions(followBtn);

  // ---------- Status ----------
  const dot = h('span.gps-dot');
  const headT = h('div.gps-head-t');
  const headSub = h('div.gps-head-sub.small.muted');
  const badge = h('span.gps-badge', { hidden: true });
  const bar = h('div.progress.gps-bar', h('i'));
  const convT = h('div.gps-conv.small.muted');
  const spark = h('div.gps-spark');
  const sparkCap = h('div.gps-spark-cap.small.muted', 'Verlauf der Genauigkeit (logarithmisch) · gestrichelt: ±10 m');
  const meta = h('div.gps-meta.small.muted');
  const runBtn = h('button.btn.block', { type: 'button', onclick: () => (running ? stop() : start()) });
  const errBanner = h('div.banner.warn.gps-blk', { hidden: true });
  const statusCard = h('div.card.gps-status.gps-blk',
    h('div.gps-head', dot, h('div.gps-head-txt', headT, headSub), badge),
    bar, convT, h('div', spark, sparkCap), meta, runBtn);
  body.append(statusCard, errBanner);

  // ---------- Kennzahlen ----------
  const sPos = stat('Breite / Länge · tippen zum Kopieren');
  sPos.el.classList.add('gps-wide', 'gps-tap');
  sPos.el.addEventListener('click', () => {
    if (!last) return;
    copyText(`${last.lat.toFixed(6)}, ${last.lon.toFixed(6)}`, 'Koordinaten kopiert');
  });
  const sAcc = stat('Genauigkeit');
  const sAlt = stat('Höhe (GPS)');
  const sCourse = stat('Kurs');
  const sSpeed = stat('Geschwindigkeit');
  const sTime = stat('Zeit des Fixes');
  const sAge = stat('Alter des Fixes');
  body.append(
    h('div.stats.gps-blk', sPos.el, sAcc.el, sAlt.el, sCourse.el, sSpeed.el, sTime.el, sAge.el),
    h('p.gps-note.small.muted.gps-blk', 'Höhe: so wie vom Gerät geliefert. iOS gibt Höhe über dem Meeresspiegel an, andere Plattformen teils über dem WGS84-Ellipsoid (in Deutschland rund 40–50 m mehr). Kurs und Geschwindigkeit nur in Bewegung.')
  );

  // ---------- Hinweise ----------
  body.append(
    h('div.banner.gps-blk', 'Satellitenanzahl und Rohdaten: vom iPhone nicht zugänglich (auch nicht für native Apps).'),
    h('div.card.gps-blk',
      h('div.card-title', 'Ortung ohne Netz'),
      h('p.small.muted.gps-p', 'Die Position kommt vom GNSS-Empfänger des Geräts, nicht aus dem Internet. Ohne Netz fehlen Hilfsdaten; der erste Fix kann dann deutlich länger dauern, mitunter einige Minuten. Freie Sicht zum Himmel hilft.'),
      h('p.small.muted.gps-p', 'Jeder Fix wird gezeigt, auch ein grober. Der Kreis um den Punkt entspricht der vom Gerät gemeldeten Genauigkeit.'))
  );

  // ---------- Logik: Position ----------
  function setFollow(v, recenter = false) {
    follow = !!v;
    save('gps:follow', follow);
    followBtn.classList.toggle('is-on', follow);
    followBtn.setAttribute('aria-pressed', String(follow));
    if (follow && recenter && last) { lastTargetZoom = null; viewTo(last); }
  }

  function viewTo(p) {
    const ll = L.latLng(p.lat, p.lon);
    const z = Math.min(18, map.getBoundsZoom(ll.toBounds(Math.max(p.acc * 2.6, 120))));
    if (z !== lastTargetZoom) {
      lastTargetZoom = z;
      map.setView(ll, z, { animate: false });
    } else {
      map.panTo(ll, { animate: true, duration: 0.4 });
    }
  }

  function onPos(pos) {
    const c = pos.coords;
    if (!Number.isFinite(c.latitude) || !Number.isFinite(c.longitude)) return;
    const now = Date.now();
    if (firstFixMs == null) firstFixMs = now - startT;
    fixes++;
    errBanner.hidden = true;
    clearTimeout(restartTimer);
    last = {
      lat: c.latitude, lon: c.longitude, acc: Number.isFinite(c.accuracy) ? c.accuracy : NaN,
      alt: c.altitude, altAcc: c.altitudeAccuracy, heading: c.heading, speed: c.speed,
      t: pos.timestamp || now, rx: now
    };
    if (Number.isFinite(last.acc)) { accHist.push(last.acc); if (accHist.length > 120) accHist.shift(); }

    const ll = [last.lat, last.lon];
    const r = Number.isFinite(last.acc) ? last.acc : 0;
    if (!marker) {
      circle = accuracyCircle(ll, r).addTo(map);
      marker = posMarker(ll).addTo(map);
    } else {
      circle.setLatLng(ll).setRadius(r);
      marker.setLatLng(ll);
    }
    const ce = circle.getElement && circle.getElement();
    if (ce) ce.classList.toggle('gps-acc-coarse', quality(last.acc) === 'grob');
    if (follow || fixes === 1) viewTo(last); // erster Fix der Sitzung immer zeigen

    if (now - lastSaved > 10000) {
      save('gps:last', { lat: last.lat, lon: last.lon, alt: last.alt, acc: last.acc, t: last.t });
      lastSaved = now;
    }
    render();
  }

  function onErr(err) {
    errBanner.textContent = geoErrorText(err);
    errBanner.hidden = false;
    if (err && err.code === 1) { stop(); return; }
    // Bei "nicht bestimmbar"/Zeitüberschreitung die Abfrage neu anstoßen
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      if (!running) return;
      stopWatch && stopWatch();
      stopWatch = watchPosition(onPos, onErr, { timeout: 120000 });
    }, 3000);
    render();
  }

  async function start() {
    if (running) return;
    running = true;
    startT = Date.now();
    firstFixMs = null;
    errBanner.hidden = true;
    stopWatch = watchPosition(onPos, onErr, { timeout: 120000 });
    render();
    const rel = await keepAwake();
    if (running && !wakeRelease) wakeRelease = rel; else rel();
  }

  function stop() {
    running = false;
    clearTimeout(restartTimer);
    stopWatch && stopWatch();
    stopWatch = null;
    wakeRelease && wakeRelease();
    wakeRelease = null;
    render();
  }

  // ---------- Darstellung: Status & Kennzahlen ----------
  function render() {
    const now = Date.now();
    const age = last ? now - last.rx : Infinity;
    const stale = last && age > STALE_FIX_MS;
    const q = last ? quality(last.acc) : null;

    dot.classList.toggle('is-search', running && (!last || stale));
    dot.classList.toggle('is-off', !running);
    runBtn.textContent = running ? 'Ortung anhalten' : 'Ortung starten';
    runBtn.classList.toggle('primary', !running);

    if (!running && !last) {
      headT.textContent = 'Angehalten';
      headSub.textContent = 'Ortung starten, um die Position zu bestimmen.';
    } else if (!last) {
      headT.textContent = 'Suche Position · ' + fmtDuration(now - startT);
      headSub.textContent = now - startT > 15000
        ? 'Ohne Netz kann der erste Fix deutlich länger dauern. Freie Sicht zum Himmel hilft.'
        : 'Warte auf den ersten Fix des Empfängers …';
    } else if (!running) {
      headT.textContent = 'Angehalten';
      headSub.textContent = 'Letzter Fix ' + new Date(last.t).toLocaleTimeString('de-DE');
    } else if (stale) {
      headT.textContent = 'Kein neuer Fix seit ' + fmtDuration(age);
      headSub.textContent = 'Anzeige zeigt den letzten Fix. Empfang verbessert sich mit freier Sicht zum Himmel.';
    } else {
      headT.textContent = Number.isFinite(last.acc) ? `Position ±${fmtAcc(last.acc)}` : 'Position';
      headSub.textContent = q === 'grob'
        ? 'Grobe Position – wird gezeigt und verfeinert sich laufend.'
        : q === 'mittel' ? 'Brauchbar; die Genauigkeit nimmt meist noch zu.' : 'Genaue Position.';
    }
    badge.hidden = !last;
    if (last) {
      const label = stale || !running ? 'alt' : q;
      badge.textContent = label;
      badge.className = 'gps-badge q-' + ({ gut: 'good', mittel: 'mid', grob: 'coarse', alt: 'stale' }[label] || 'stale');
    }
    for (const el of [marker && marker.getElement(), circle && circle.getElement()]) {
      if (el) el.classList.toggle('gps-stale', !!(stale || (!running && last)));
    }

    // Konvergenz (Näherung aus der gemeldeten Genauigkeit)
    bar.classList.toggle('gps-indet', running && !last);
    const conv = last && Number.isFinite(last.acc) ? convergence(last.acc) : 0;
    bar.firstChild.style.width = running && !last ? '' : (conv * 100).toFixed(0) + '%';
    if (last && Number.isFinite(last.acc)) {
      convT.textContent = `Genauigkeit ±${fmtAcc(last.acc)} · Ziel ±${TARGET_ACC} m${trendText()} · Näherung`;
    } else {
      convT.textContent = running ? 'Genauigkeit: noch kein Fix' : 'Genauigkeit: –';
    }
    spark.replaceChildren(svg(sparkSVG(accHist)));
    spark.hidden = sparkCap.hidden = accHist.length < 2;

    const parts = [];
    if (firstFixMs != null) parts.push('Erster Fix nach ' + fmtDuration(firstFixMs));
    parts.push('Fixes: ' + fixes);
    parts.push(navigator.onLine ? 'Online' : 'Offline – Ortung läuft trotzdem');
    meta.textContent = parts.join(' · ');

    // Kennzahlen
    if (last) {
      sPos.set(fmtLatLon(last.lat, last.lon, 5));
      sAcc.set(Number.isFinite(last.acc) ? '±' + fmt(last.acc, last.acc < 10 ? 1 : 0) : '–', 'm');
      if (Number.isFinite(last.alt) && last.alt !== null) {
        sAlt.set(fmt(last.alt, 0), Number.isFinite(last.altAcc) && last.altAcc !== null ? `m ±${fmt(last.altAcc, 0)}` : 'm');
      } else sAlt.set('–', 'keine Angabe');
      const moving = Number.isFinite(last.speed) && last.speed !== null && last.speed > 0.3;
      if (moving && Number.isFinite(last.heading) && last.heading !== null) sCourse.set(fmt(last.heading, 0) + '°', compass(last.heading));
      else sCourse.set('–', '');
      sSpeed.set(Number.isFinite(last.speed) && last.speed !== null ? fmt(last.speed * 3.6, 1) : '–', 'km/h');
      sTime.set(new Date(last.t).toLocaleTimeString('de-DE'), '');
      const ageMs = Math.max(0, now - last.t);
      if (ageMs < 60000) sAge.set(String(Math.round(ageMs / 1000)), 's');
      else sAge.set(fmtDuration(ageMs), ageMs < 3600e3 ? 'min' : 'h');
    } else {
      sPos.set('–'); sAcc.set('–', 'm'); sAlt.set('–', 'm'); sCourse.set('–', ''); sSpeed.set('–', 'km/h'); sTime.set('–', ''); sAge.set('–', '');
    }
  }

  function trendText() {
    if (accHist.length < 10) return '';
    const med = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    const a = med(accHist.slice(-5)), b = med(accHist.slice(-10, -5));
    if (a < b * 0.85) return ' · wird genauer';
    if (a > b * 1.15) return ' · wird ungenauer';
    return ' · stabil';
  }

  // ---------- Start ----------
  on(window, 'online', render);
  on(window, 'offline', render);
  const tick = setInterval(render, 1000);

  setFollow(follow);
  render();
  start();

  return () => {
    clearInterval(tick);
    offs.forEach(f => f());
    stop();
    map.remove();
  };
}

// ---------- Hilfen ----------
function quality(acc) {
  if (!Number.isFinite(acc)) return 'grob';
  if (acc <= TARGET_ACC) return 'gut';
  if (acc <= 50) return 'mittel';
  return 'grob';
}

/** 0…1 auf logarithmischer Skala zwischen 1000 m und dem Ziel. */
function convergence(acc) {
  const p = (Math.log(1000) - Math.log(Math.max(acc, 0.1))) / (Math.log(1000) - Math.log(TARGET_ACC));
  return Math.max(0, Math.min(1, p));
}

const fmtAcc = a => (a < 10 ? fmt(a, 1) : a < 10000 ? fmt(a, 0) : fmt(a / 1000, 0) + ' k') + ' m';

function compass(deg) {
  const n = ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'];
  return n[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}

/** Verlauf der Genauigkeit (log. Achse 1–1000 m) mit Ziellinie. */
function sparkSVG(hist) {
  const W = 300, H = 44, pad = 3;
  const y = a => {
    const v = (Math.log10(Math.min(1000, Math.max(1, a)))) / 3; // 0..1
    return pad + (H - 2 * pad) * v;
  };
  const n = hist.length;
  const pts = hist.map((a, i) => `${(n < 2 ? 0 : i / (n - 1) * W).toFixed(1)},${y(a).toFixed(1)}`).join(' ');
  const ty = y(TARGET_ACC).toFixed(1);
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="gps-spark-svg" aria-label="Verlauf der Genauigkeit">` +
    `<line x1="0" y1="${ty}" x2="${W}" y2="${ty}" class="gps-spark-target" vector-effect="non-scaling-stroke"/>` +
    `<polyline points="${pts}" class="gps-spark-line" vector-effect="non-scaling-stroke"/></svg>`;
}

function injectStyle() {
  if (document.getElementById('style-gps')) return;
  const css = `
.gps-blk { flex: none; }
.gps-map { height: 45vh; min-height: 240px; }
.gps-follow svg path { transition: fill .15s; }
.gps-follow.is-on svg path { fill: currentColor; }
.gps-status { display: flex; flex-direction: column; gap: 10px; }
.gps-head { display: flex; align-items: center; gap: 12px; }
.gps-head-txt { flex: 1; min-width: 0; }
.gps-head-t { font-size: 18px; font-weight: 600; font-variant-numeric: tabular-nums; }
.gps-head-sub { margin-top: 2px; line-height: 1.35; }
.gps-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--accent); flex: none; }
.gps-dot.is-off { background: var(--line-strong); }
.gps-dot.is-search { animation: gps-pulse 1.2s ease-in-out infinite; }
@keyframes gps-pulse { 50% { opacity: .2; } }
.gps-badge { flex: none; font-size: 12px; font-weight: 600; letter-spacing: .3px; padding: 3px 10px; border-radius: 999px; border: 1px solid var(--accent); color: var(--accent); }
.gps-badge.q-good { background: var(--accent); color: var(--on-accent); }
.gps-badge.q-mid { background: var(--accent-soft); }
.gps-badge.q-coarse { border-style: dashed; }
.gps-badge.q-stale { color: var(--text-2); border-color: var(--line-strong); }
.progress.gps-indet > i { width: 30%; animation: gps-indet 1.3s ease-in-out infinite; }
@keyframes gps-indet { from { transform: translateX(-100%); } to { transform: translateX(340%); } }
.gps-bar { height: 6px; border-radius: 3px; }
.gps-bar > i { border-radius: 3px; }
.gps-spark { height: 44px; border-bottom: 1px solid var(--line); }
.gps-spark-svg { width: 100%; height: 44px; display: block; }
.gps-spark-line { fill: none; stroke: var(--accent); stroke-width: 1.8; stroke-linejoin: round; }
.gps-spark-target { stroke: var(--text-3); stroke-width: 1; stroke-dasharray: 4 4; }
.gps-meta { line-height: 1.4; }
.gps-spark-cap { font-size: 11.5px; margin-top: 4px; }
.gps-wide { grid-column: 1 / -1; }
.gps-tap { cursor: pointer; }
.gps-tap:active { background: var(--surface-2); }
.gps-note { margin: -4px 4px 0; line-height: 1.4; }
.gps-p { margin: 0 0 8px; line-height: 1.4; }
.gps-p:last-child { margin-bottom: 0; }
.gps-stale { opacity: .45; }
.gps-acc-coarse { stroke-dasharray: 6 5; }
@media (prefers-reduced-motion: reduce) { .gps-dot.is-search, .progress.gps-indet > i { animation: none; } }
`;
  document.head.append(h('style#style-gps', css));
}
