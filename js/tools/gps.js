// GPS (offline): Position des GNSS-Empfängers auf der Karte samt Genauigkeitskreis,
// Fix-Status und Kennzahlen; dazu aus offline gespeicherten Bahndaten (CelesTrak, SGP4)
// berechnete Satellitenstände (Himmelsdiagramm, Anzahl je System, DOP).
//
// Der Browser liefert nur die fertige Lösung (Lat/Lon/Genauigkeit/Höhe …), keine
// Satelliten-Rohdaten. Die Satellitenangaben hier sind daher berechnet, nicht empfangen.

import { h, svg, stat, fmt, fmtLatLon, fmtDuration, copyText, toast, seg } from '../lib/ui.js';
import { watchPosition, keepAwake, geoErrorText } from '../lib/sensors.js';
import { createMap, posMarker, accuracyCircle } from '../lib/map.js';
import { load, save } from '../lib/store.js';
import { SYSTEMS, STALE_DAYS, loadOrbits, fetchGroup, epochInfo, ageDays, buildSatrecs, lookAngles, dop } from './gps/orbits.js';
import { skyplotSVG, legendIcon } from './gps/skyplot.js';

const TARGET_ACC = 10;           // Ziel für die Konvergenzanzeige (m)
const STALE_FIX_MS = 30000;      // ab hier gilt der letzte Fix als veraltet
const AUTO_REFRESH_DAYS = 3;     // Bahndaten automatisch erneuern, wenn älter
const MIN_REFETCH_MS = 2 * 3600e3; // CelesTrak aktualisiert alle 2 h – nicht öfter laden

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
  let mask = load('gps:mask', 5);
  let hidden = new Set(load('gps:hide', []));
  let orbits = loadOrbits();
  let sats = buildSatrecs(orbits);
  let loading = false;
  const abort = new AbortController();
  const stored = load('gps:last', null);

  // ---------- Karte ----------
  const mapEl = h('div.map.gps-map.gps-blk');
  body.append(mapEl);
  const mapApi = createMap(mapEl, stored ? { center: [stored.lat, stored.lon], zoom: 14 } : {});
  const map = mapApi.map;
  let marker = null, circle = null, lastTargetZoom = null;
  map.on('dragstart', () => setFollow(false));
  map.on('moveend', () => { if (basis().src === 'Kartenmitte') updateSky(); });

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
  const sSats = stat('Satelliten (ber.)');
  body.append(
    h('div.stats.gps-blk', sPos.el, sAcc.el, sAlt.el, sCourse.el, sSpeed.el, sTime.el, sSats.el),
    h('p.gps-note.small.muted.gps-blk', 'Höhe: so wie vom Gerät geliefert. iOS gibt Höhe über dem Meeresspiegel an, andere Plattformen teils über dem WGS84-Ellipsoid (in Deutschland rund 40–50 m mehr). Kurs und Geschwindigkeit nur in Bewegung.')
  );

  // ---------- Himmel (berechnet) ----------
  const counts = h('div.gps-counts');
  const skyBox = h('div.gps-sky');
  const skyBasis = h('div.small.muted.gps-basis');
  const skyDop = h('div.gps-dop');
  const skyWarn = h('div.banner.warn', { hidden: true });
  const maskSeg = seg([0, 5, 10, 15].map(v => ({ value: String(v), label: v + '°' })), String(mask), v => {
    mask = Number(v); save('gps:mask', mask); updateSky();
  });
  const listBody = h('tbody');
  const listSum = h('summary', 'Liste');
  const details = h('details.gps-details', listSum,
    h('table.table', h('thead', h('tr', h('th', 'System'), h('th', 'Satellit'), h('th.r', 'Azimut'), h('th.r', 'Höhe'))), listBody));
  body.append(
    h('div.section-title', 'Satelliten'),
    h('div.card.gps-blk',
      h('div.card-title', 'Über dem Horizont · berechnet'),
      h('p.gps-honest.small.muted', 'Aus Bahndaten berechnet, welche Satelliten am Standort über dem Horizont stehen. Welche das Gerät tatsächlich empfängt, gibt der Browser nicht preis. System antippen blendet es im Diagramm aus.'),
      skyWarn, counts, skyBox, skyBasis, skyDop,
      h('div.gps-mask', h('span.small.muted', 'Elevationsmaske'), maskSeg),
      details)
  );

  // ---------- Bahndaten ----------
  const orbitRows = {};
  const orbitList = h('div.list.gps-orbits');
  for (const s of SYSTEMS) {
    const v = h('div.v.small');
    const pb = h('div.progress.gps-row-bar', { hidden: true }, h('i'));
    const row = h('div.list-row.gps-orow', h('div.gps-orow-k', svg(legendIcon(s.key)), h('span', s.name)), h('div.gps-orow-v', v, pb));
    orbitRows[s.key] = { v, pb };
    orbitList.append(row);
  }
  const loadBar = h('div.progress', { hidden: true }, h('i'));
  const loadT = h('div.small.muted', { hidden: true });
  const loadBtn = h('button.btn.block', { type: 'button', onclick: () => loadOrbitsNow(true) });
  body.append(
    h('div.section-title', 'Bahndaten'),
    h('div.card.gps-ocard.gps-blk',
      h('div.card-title', 'CelesTrak · offline gespeichert'),
      orbitList, loadBar, loadT, loadBtn,
      h('p.small.muted.gps-p', 'Dienen nur der Berechnung oben. Die Position selbst bestimmt der GNSS-Empfänger des Geräts – ohne Internet lädt er die Bahndaten (Ephemeriden) direkt aus dem Satellitensignal. Ein solcher Kaltstart dauert 30 s bis etwa 12 Minuten; freie Sicht zum Himmel hilft.')),
    h('div.card.gps-blk',
      h('div.card-title', 'Ortung ohne Netz'),
      h('p.small.muted.gps-p', 'Für eine grobe 2D-Position genügen dem Empfänger 3 Satelliten, für 3D mit Höhe 4. Jeder Fix wird gezeigt, auch ein grober – die Genauigkeit (blauer Kreis) wird mit mehr Satelliten und der Zeit besser. Satellitenanzahl und Signalstärken liefert der Browser nicht; angezeigt wird die berechnete Sichtbarkeit.'))
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
    const prevT = last ? last.t : 0;
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
    if (!prevT) updateSky();
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
        ? 'Ohne Internet startet der Empfänger kalt: 30 s bis etwa 12 min. Freie Sicht zum Himmel hilft.'
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
    } else {
      sPos.set('–'); sAcc.set('–', 'm'); sAlt.set('–', 'm'); sCourse.set('–', ''); sSpeed.set('–', 'km/h'); sTime.set('–', '');
    }
    renderOrbits();
  }

  function trendText() {
    if (accHist.length < 10) return '';
    const med = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    const a = med(accHist.slice(-5)), b = med(accHist.slice(-10, -5));
    if (a < b * 0.85) return ' · wird genauer';
    if (a > b * 1.15) return ' · wird ungenauer';
    return ' · stabil';
  }

  // ---------- Himmel (berechnet) ----------
  function basis() {
    if (last) return { lat: last.lat, lon: last.lon, alt: last.alt, src: Date.now() - last.rx < 120000 ? 'aktuelle Position' : 'letzter Fix' };
    if (stored) return { lat: stored.lat, lon: stored.lon, alt: stored.alt, src: 'letzte bekannte Position', t: stored.t };
    const c = map.getCenter();
    return { lat: c.lat, lon: c.lng, alt: 0, src: 'Kartenmitte' };
  }

  let skyList = [];
  function updateSky() {
    const b = basis();
    const now = new Date();
    if (!sats.length) {
      skyList = [];
      skyBox.innerHTML = skyplotSVG([], mask);
      counts.replaceChildren();
      skyWarn.hidden = false;
      skyWarn.textContent = 'Noch keine Bahndaten gespeichert. Einmal mit Internet laden (unten), danach offline nutzbar.';
      skyBasis.textContent = '';
      skyDop.textContent = '';
      sSats.set('–', '');
      listBody.replaceChildren();
      listSum.textContent = 'Liste';
      return;
    }
    const all = lookAngles(sats, b.lat, b.lon, Number.isFinite(b.alt) && b.alt !== null ? b.alt : 0, now);
    skyList = all.filter(s => s.el >= 0);
    const vis = all.filter(s => s.el >= mask);
    skyBox.innerHTML = skyplotSVG(skyList.filter(s => !hidden.has(s.sys)), mask);

    counts.replaceChildren(...SYSTEMS.map(s => {
      const has = orbits[s.key] && orbits[s.key].list && orbits[s.key].list.length;
      const n = vis.filter(v => v.sys === s.key).length;
      const off = hidden.has(s.key);
      return h('button.gps-count', {
        type: 'button', class: off ? 'is-off' : '', 'aria-pressed': String(!off),
        title: off ? s.name + ' im Diagramm zeigen' : s.name + ' im Diagramm ausblenden',
        onclick: () => {
          if (hidden.has(s.key)) hidden.delete(s.key); else hidden.add(s.key);
          save('gps:hide', [...hidden]);
          updateSky();
        }
      }, h('div.gps-count-k', svg(legendIcon(s.key)), h('span', s.name)), h('div.gps-count-v', has ? String(n) : '–'));
    }));
    sSats.set(String(vis.length), `über ${mask}°`);

    const posTxt = fmtLatLon(b.lat, b.lon, 3);
    skyBasis.textContent = `Für ${b.src} (${posTxt}) · ${now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr · Maske ${mask}°`;

    const dGps = dop(vis.filter(v => v.sys === 'gps'));
    const dAll = dop(vis);
    const enough = vis.length >= 4;
    const dopTxt = d => (d ? `PDOP ${fmt(d.pdop, 1)} · HDOP ${fmt(d.hdop, 1)}` : 'zu wenige');
    skyDop.replaceChildren(
      h('div.gps-dop-row', h('span.muted', 'Geometrie nur GPS'), h('span.num', dopTxt(dGps))),
      h('div.gps-dop-row', h('span.muted', 'Geometrie alle Systeme'), h('span.num', dopTxt(dAll))),
      h('div.small.muted', enough
        ? `${vis.length} berechnet sichtbar – mindestens 4 nötig für 3D, 3 für 2D. DOP gilt, falls alle empfangen werden (kleiner = besser).`
        : `Nur ${vis.length} berechnet sichtbar – für 3D sind 4 nötig, 3 reichen für eine grobe 2D-Position.`)
    );

    // Warnung bei alten Bahndaten
    const old = SYSTEMS.filter(s => {
      const e = orbits[s.key] && epochInfo(orbits[s.key].list);
      return e && ageDays(e.median) > STALE_DAYS;
    });
    skyWarn.hidden = !old.length;
    if (old.length) skyWarn.textContent = `Bahndaten (${old.map(s => s.name).join(', ')}) älter als ${STALE_DAYS} Tage – Stände ungenauer, Sichtbarkeit meist noch brauchbar. Online aktualisieren.`;

    const sorted = [...vis].sort((a, c) => c.el - a.el);
    listSum.textContent = `Liste (${sorted.length})`;
    listBody.replaceChildren(...sorted.map(s => h('tr',
      h('td', h('span.gps-li', svg(legendIcon(s.sys)), SYSTEMS.find(x => x.key === s.sys).name)),
      h('td', { title: s.name }, s.label),
      h('td.r', fmt(s.az, 0) + '°'),
      h('td.r', fmt(s.el, 0) + '°'))));
  }

  // ---------- Bahndaten laden ----------
  const loadState = {};
  function renderOrbits() {
    const now = Date.now();
    let any = false;
    for (const s of SYSTEMS) {
      const r = orbitRows[s.key];
      const e = orbits[s.key];
      const st = loadState[s.key];
      let txt;
      if (st && st.phase === 'load') txt = st.retry ? `Neuer Versuch (${st.attempt}) …` : `lädt … ${fmt((st.bytes || 0) / 1024, 0)} kB`;
      else if (st && st.phase === 'wait') txt = 'wartet';
      else if (st && st.phase === 'err' && !(e && e.list)) txt = 'Fehler: ' + st.msg;
      else if (e && e.list) {
        any = true;
        const ei = epochInfo(e.list);
        const d = ei ? ageDays(ei.median, now) : NaN;
        txt = `${e.list.length} Sat. · ${fmtAge(d)}${d > STALE_DAYS ? ' · veraltet' : ''}`;
        r.v.title = ei ? 'Bahnepoche (Median) ' + new Date(ei.median).toLocaleString('de-DE') + ', geladen ' + new Date(e.fetched).toLocaleString('de-DE') : '';
        if (st && st.phase === 'err') txt += ' · Aktualisierung fehlgeschlagen';
      } else txt = 'nicht geladen';
      r.v.textContent = txt;
      r.v.classList.toggle('gps-warn-t', !!(e && e.list && epochInfo(e.list) && ageDays(epochInfo(e.list).median, now) > STALE_DAYS));
      r.pb.hidden = !(st && (st.phase === 'load' || st.phase === 'wait'));
      if (!r.pb.hidden) {
        r.pb.firstChild.style.width = st.phase === 'wait' ? '0%' : '';
        r.pb.classList.toggle('gps-indet', st.phase === 'load');
      }
    }
    if (loading) {
      loadBtn.disabled = true;
      loadBtn.textContent = 'Lädt …';
    } else if (!navigator.onLine) {
      loadBtn.disabled = true;
      loadBtn.textContent = 'Offline – Laden nicht möglich';
    } else {
      loadBtn.disabled = false;
      loadBtn.textContent = any ? 'Bahndaten aktualisieren' : 'Bahndaten laden';
      loadBtn.classList.toggle('primary', !any);
    }
  }

  async function loadOrbitsNow(manual) {
    if (loading) return;
    if (!navigator.onLine) { toast('Offline – Laden nicht möglich'); return; }
    const now = Date.now();
    const todo = SYSTEMS.filter(s => {
      const e = orbits[s.key];
      if (!e || !e.list) return true;
      if (now - e.fetched < MIN_REFETCH_MS) return false;
      if (manual) return true;
      const ei = epochInfo(e.list);
      return !ei || ageDays(ei.median, now) > AUTO_REFRESH_DAYS;
    });
    if (!todo.length) { if (manual) toast('Bahndaten sind aktuell (vor weniger als 2 h geladen)', 2400); return; }
    loading = true;
    for (const s of todo) loadState[s.key] = { phase: 'wait' };
    loadBar.hidden = false; loadT.hidden = false;
    let done = 0, ok = 0;
    const step = () => {
      loadBar.firstChild.style.width = (done / todo.length * 100).toFixed(0) + '%';
      loadT.textContent = `${done} von ${todo.length} Konstellationen geladen`;
    };
    step();
    renderOrbits();
    for (const s of todo) {
      if (abort.signal.aborted) return;
      loadState[s.key] = { phase: 'load', bytes: 0, attempt: 1 };
      loadT.textContent = `Lade ${s.name} … (${done + 1} von ${todo.length})`;
      renderOrbits();
      try {
        const entry = await fetchGroup(s, p => {
          loadState[s.key] = { phase: 'load', bytes: p.bytes, attempt: p.attempt, retry: p.retry };
          renderOrbits();
        }, abort.signal);
        orbits[s.key] = entry;
        delete loadState[s.key];
        ok++;
      } catch (e) {
        if (abort.signal.aborted) return;
        loadState[s.key] = { phase: 'err', msg: e.message || 'Netzwerk' };
      }
      done++;
      step();
      renderOrbits();
    }
    loading = false;
    orbits = loadOrbits();
    sats = buildSatrecs(orbits);
    loadT.textContent = ok === todo.length ? `${ok} Konstellationen geladen und gespeichert` : `${ok} von ${todo.length} geladen – Rest später erneut versuchen`;
    setTimeout(() => { if (!loading) { loadBar.hidden = true; loadT.hidden = true; } }, 4000);
    renderOrbits();
    updateSky();
  }

  // ---------- Start ----------
  const onNet = () => { render(); if (navigator.onLine) loadOrbitsNow(false); };
  on(window, 'online', onNet);
  on(window, 'offline', onNet);
  const tick = setInterval(render, 1000);
  const skyTick = setInterval(updateSky, 10000);

  setFollow(follow);
  render();
  updateSky();
  start();
  loadOrbitsNow(false);

  return () => {
    abort.abort();
    clearInterval(tick);
    clearInterval(skyTick);
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

function fmtAge(d) {
  if (!Number.isFinite(d)) return '–';
  if (d < 1) return `vor ${Math.max(1, Math.round(d * 24))} h`;
  return `vor ${fmt(d, 0)} ${Math.round(d) === 1 ? 'Tag' : 'Tagen'}`;
}

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
.gps-honest, .gps-p { margin: 0 0 10px; line-height: 1.4; }
.gps-p:last-child { margin-bottom: 0; }
.gps-ocard { display: flex; flex-direction: column; gap: 10px; }
.gps-ocard .gps-p { margin: 0; }
.gps-counts { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: var(--radius-s); overflow: hidden; margin: 10px 0 4px; }
.gps-counts:empty { display: none; }
.gps-count { appearance: none; border: 0; background: var(--surface); padding: 8px 6px; text-align: center; min-width: 0; min-height: 56px; color: var(--text); transition: opacity .15s; }
.gps-count:active { background: var(--surface-2); }
.gps-count.is-off { opacity: .4; }
.gps-count-k { display: flex; align-items: center; justify-content: center; gap: 4px; font-size: 11px; color: var(--text-2); white-space: nowrap; }
.gps-count-v { font-size: 22px; font-weight: 500; font-variant-numeric: tabular-nums; margin-top: 2px; }
.gps-sky { max-width: 340px; margin: 0 auto; width: 100%; }
.gps-sky-svg { width: 100%; height: auto; display: block; overflow: visible; }
.gps-grid { fill: none; stroke: var(--line-strong); stroke-width: 1; }
.gps-grid-h { fill: var(--surface-2); stroke: var(--line-strong); stroke-width: 1.2; }
.gps-grid-minor { stroke: var(--line); }
.gps-grid-mask { stroke-dasharray: 3 3; stroke: var(--text-3); }
.gps-grid-t { font-size: 9px; fill: var(--text-3); }
.gps-dir { font-size: 12px; font-weight: 600; fill: var(--text-2); }
.gps-sym-f { fill: var(--accent); stroke: var(--surface); stroke-width: 1; }
.gps-sym-o { fill: var(--surface); stroke: var(--accent); stroke-width: 1.8; }
.gps-sat.is-low { opacity: .35; }
.gps-sat-t { font-size: 9px; fill: var(--text-2); font-variant-numeric: tabular-nums; }
.gps-basis { text-align: center; margin-top: 4px; }
.gps-dop { margin-top: 10px; display: flex; flex-direction: column; gap: 4px; }
.gps-dop-row { display: flex; justify-content: space-between; gap: 10px; font-size: 14px; }
.gps-dop-row .num { text-align: right; }
.gps-mask { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 12px; }
.gps-mask .seg { flex: 0 1 220px; }
.gps-details { margin-top: 12px; }
.gps-details summary { cursor: pointer; color: var(--accent); font-size: 15px; padding: 8px 0; min-height: 36px; }
.gps-details .table { margin-top: 4px; }
.gps-details .table .r, .gps-details th.r { text-align: right; }
.gps-li { display: inline-flex; align-items: center; gap: 6px; }
.gps-orbits .list-row { align-items: flex-start; }
.gps-orow-k { display: flex; align-items: center; gap: 8px; flex: none; padding-top: 1px; }
.gps-orow-v { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; min-width: 0; text-align: right; }
.gps-orow-v .v { color: var(--text-2); }
.gps-row-bar { width: 120px; }
.gps-warn-t { color: var(--danger) !important; }
.gps-stale { opacity: .45; }
.gps-acc-coarse { stroke-dasharray: 6 5; }
@media (prefers-reduced-motion: reduce) { .gps-dot.is-search, .progress.gps-indet > i { animation: none; } }
`;
  document.head.append(h('style#style-gps', css));
}
