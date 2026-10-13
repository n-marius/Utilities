// Leaflet-Karte mit offline zwischengespeicherten Kacheln (Service Worker cacht jede geladene Kachel).
// Farben der Vektoren über CSS-Klassen: u-pos (Position), u-acc (Genauigkeitskreis),
// u-track (Verlauf), u-alt (Alternativ-/Fehlerbereich). Nachtmodus färbt Kacheln per SVG-Filter rot.

import { load, save } from './store.js';
import { h } from './ui.js';

export const LAYERS = {
  standard: {
    name: 'Standard',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    opts: { maxZoom: 19, attribution: '© OpenStreetMap' }
  },
  topo: {
    name: 'Topo',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    opts: { subdomains: 'abc', maxZoom: 17, attribution: '© OpenStreetMap, SRTM, © OpenTopoMap' }
  }
};

/**
 * Karte erzeugen.
 * createMap(container, {center:[lat,lon], zoom, zoomControl}) -> { map, layer, setLayer(key), fitCircle(lat,lon,r) }
 */
export function createMap(container, opts = {}) {
  const L = window.L;
  const last = load('map:last', { center: [51.1657, 10.4515], zoom: 5 });
  const map = L.map(container, {
    center: opts.center || last.center,
    zoom: opts.zoom ?? last.zoom,
    zoomControl: opts.zoomControl ?? false,
    attributionControl: true,
    worldCopyJump: true
  });
  map.attributionControl.setPrefix(false);

  let layer = null;
  let layerKey = load('map:layer', 'standard');
  function setLayer(key) {
    if (!LAYERS[key]) key = 'standard';
    if (layer) map.removeLayer(layer);
    const def = LAYERS[key];
    layer = L.tileLayer(def.url, { ...def.opts, crossOrigin: true }).addTo(map);
    layerKey = key;
    save('map:layer', key);
    api.layer = layer;
  }

  map.on('moveend', () => {
    const c = map.getCenter();
    save('map:last', { center: [c.lat, c.lng], zoom: map.getZoom() });
  });

  // Kartenbedienknöpfe oben rechts
  const btns = h('div.map-overlay-btns');
  const layerBtn = h('button.btn', { type: 'button', title: 'Kartenstil', html: LAYER_ICON, onclick: async e => {
    e.stopPropagation();
    const keys = Object.keys(LAYERS);
    setLayer(keys[(keys.indexOf(layerKey) + 1) % keys.length]);
    (await import('./ui.js')).toast('Karte: ' + LAYERS[layerKey].name);
  } });
  const dlBtn = h('button.btn', { type: 'button', title: 'Ausschnitt offline speichern', html: DL_ICON, onclick: e => {
    e.stopPropagation();
    prefetchVisible(api);
  } });
  btns.append(layerBtn, dlBtn);
  container.append(btns);
  L.DomEvent.disableClickPropagation(btns);

  const api = {
    map, layer: null, setLayer,
    get layerKey() { return layerKey; },
    /** Ansicht so wählen, dass ein Kreis (m) sichtbar ist. */
    fitCircle(lat, lon, radius, maxZoom = 17) {
      const b = L.latLng(lat, lon).toBounds(Math.max(radius * 2.4, 200));
      map.fitBounds(b, { maxZoom, animate: false });
    }
  };
  setLayer(layerKey);

  // Leaflet braucht nach dem Einblenden die korrekte Größe
  requestAnimationFrame(() => map.invalidateSize());
  setTimeout(() => map.invalidateSize(), 250);
  return api;
}

/** Positionspunkt (CircleMarker). */
export function posMarker(latlng) {
  return window.L.circleMarker(latlng, { radius: 7, className: 'u-pos', interactive: false });
}

/** Genauigkeits-/Fehlerkreis in Metern. */
export function accuracyCircle(latlng, radius, className = 'u-acc') {
  return window.L.circle(latlng, { radius, className, interactive: false });
}

/** Verlaufslinie. */
export function trackLine(latlngs = []) {
  return window.L.polyline(latlngs, { className: 'u-track', interactive: false });
}

/** Sichtbaren Ausschnitt (aktuelle Zoomstufe bis +3, max. maxTiles Kacheln) vorab laden.
 *  Bewusst klein gehalten: Die Kachelserver (OSM, OpenTopoMap) untersagen Massen-Downloads. */
export async function prefetchVisible(api, { maxTiles = 250, onProgress } = {}) {
  const { map, layer } = api;
  const { toast } = await import('./ui.js');
  if (!navigator.onLine) { toast('Offline – Download nicht möglich'); return; }
  const z0 = map.getZoom();
  const maxZ = Math.min(layer.options.maxZoom || 18, z0 + 3);
  const bounds = map.getBounds();
  const tiles = [];
  for (let z = Math.max(1, z0 - 2); z <= maxZ; z++) {
    const nw = map.project(bounds.getNorthWest(), z).divideBy(256).floor();
    const se = map.project(bounds.getSouthEast(), z).divideBy(256).floor();
    for (let x = nw.x; x <= se.x; x++) {
      for (let y = nw.y; y <= se.y; y++) {
        if (tiles.length >= maxTiles) break;
        const n = 2 ** z;
        tiles.push({ x: ((x % n) + n) % n, y, z });
      }
    }
  }
  let done = 0, failed = 0;
  toast(`Lade ${tiles.length} Kacheln …`, 2500);
  const queue = tiles.slice();
  async function worker() {
    while (queue.length) {
      const c = queue.shift();
      try {
        await fetch(layer.getTileUrl(c), { mode: 'cors', credentials: 'omit' });
      } catch { failed++; }
      done++;
      onProgress && onProgress(done, tiles.length);
      if (done % 50 === 0) toast(`Kacheln ${done}/${tiles.length}`, 1500);
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  toast(failed ? `${done - failed} Kacheln gespeichert, ${failed} fehlgeschlagen` : `${done} Kacheln offline gespeichert`, 2600);
}

const LAYER_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2 8l10 5 10-5-10-5z"/><path d="m2 13 10 5 10-5"/></svg>';
const DL_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>';
