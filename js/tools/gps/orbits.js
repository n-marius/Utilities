// Bahndaten der Navigationssatelliten (CelesTrak, OMM/JSON): Laden, offline speichern,
// mit SGP4 (window.satellite) Azimut/Elevation für einen Beobachter berechnen, DOP aus der Geometrie.
// Hinweis: Das ist eine Berechnung aus mittleren Bahnelementen – welche Satelliten das Gerät
// tatsächlich empfängt, gibt der Browser nicht preis.

import { load, save } from '../../lib/store.js';

export const SYSTEMS = [
  { key: 'gps', name: 'GPS', group: 'gps-ops' },
  { key: 'gal', name: 'Galileo', group: 'galileo' },
  { key: 'glo', name: 'GLONASS', group: 'glo-ops' },
  { key: 'bds', name: 'BeiDou', group: 'beidou' }
];

const URL_BASE = 'https://celestrak.org/NORAD/elements/gp.php?FORMAT=json&GROUP=';
const STORE_KEY = 'gps:orbits';
const FIELDS = ['OBJECT_NAME', 'OBJECT_ID', 'EPOCH', 'MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION',
  'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'NORAD_CAT_ID', 'BSTAR',
  'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT'];
const DAY = 86400000;
export const STALE_DAYS = 14;

/** Gespeicherte Bahndaten: { gps: {fetched, list:[omm…]}, … } */
export function loadOrbits() {
  return load(STORE_KEY, {}) || {};
}

function storeGroup(key, entry) {
  const all = loadOrbits();
  all[key] = entry;
  return save(STORE_KEY, all);
}

/** Datensatz auf die für SGP4 nötigen Felder kürzen. */
function slim(o) {
  const r = {};
  for (const f of FIELDS) if (o[f] != null) r[f] = o[f];
  return r;
}

/**
 * Eine Konstellation laden (mit Wiederholung bei Verbindungsabbruch).
 * onProgress({bytes, attempt}) während des Lesens. Gibt {fetched, list} zurück.
 */
export async function fetchGroup(sys, onProgress, signal) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(URL_BASE + sys.group, { cache: 'no-store', credentials: 'omit', signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      let text = '';
      if (res.body && res.body.getReader) {
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let bytes = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.length;
          text += dec.decode(value, { stream: true });
          onProgress && onProgress({ bytes, attempt });
        }
        text += dec.decode();
      } else {
        text = await res.text();
        onProgress && onProgress({ bytes: text.length, attempt });
      }
      let data;
      try { data = JSON.parse(text); } catch { throw new Error('Antwort ist kein JSON'); }
      if (!Array.isArray(data) || !data.length || !data[0].OBJECT_NAME || !data[0].MEAN_MOTION) {
        throw new Error('Unerwartetes Datenformat');
      }
      const entry = { fetched: Date.now(), list: data.map(slim) };
      if (!storeGroup(sys.key, entry)) throw new Error('Speichern fehlgeschlagen');
      return entry;
    } catch (e) {
      if (signal && signal.aborted) throw e;
      lastErr = e;
      onProgress && onProgress({ bytes: 0, attempt: attempt + 1, retry: true });
      await new Promise(r => setTimeout(r, 1200 * attempt));
    }
  }
  throw lastErr;
}

const epochMs = s => Date.parse(/Z$/.test(s) ? s : s + 'Z');

/** Epochen-Statistik einer Liste: Median und ältester Datensatz (ms). */
export function epochInfo(list) {
  const t = (list || []).map(o => epochMs(o.EPOCH)).filter(Number.isFinite).sort((a, b) => a - b);
  if (!t.length) return null;
  return { median: t[Math.floor(t.length / 2)], oldest: t[0], newest: t[t.length - 1] };
}

export const ageDays = (ms, now = Date.now()) => (now - ms) / DAY;

/** Kurzkennung für das Himmelsdiagramm. */
export function shortLabel(sysKey, name) {
  let m;
  if (sysKey === 'gps' && (m = /PRN\s*0*(\d+)/i.exec(name))) return 'G' + m[1].padStart(2, '0');
  if (sysKey === 'bds' && (m = /\((C\d+)\)/i.exec(name))) return m[1].toUpperCase();
  if (sysKey === 'glo' && (m = /\((\d+K?)\)/i.exec(name))) return m[1];
  if (sysKey === 'gal' && (m = /GSAT0*(\d+)/i.exec(name))) return m[1];
  const parts = name.replace(/\s*\(.*\)/, '').trim().split(/\s+/);
  return parts[parts.length - 1].slice(0, 6);
}

/** satrec-Objekte aus gespeicherten Daten aufbauen: [{sys, name, label, rec}] */
export function buildSatrecs(orbits) {
  const sat = window.satellite;
  const out = [];
  for (const s of SYSTEMS) {
    const e = orbits[s.key];
    if (!e || !e.list) continue;
    for (const o of e.list) {
      try {
        const rec = sat.json2satrec(o);
        if (rec.error) continue;
        out.push({ sys: s.key, name: String(o.OBJECT_NAME).replace(/\s+/g, ' ').trim(), label: shortLabel(s.key, String(o.OBJECT_NAME)), rec });
      } catch { /* defekter Datensatz */ }
    }
  }
  return out;
}

/**
 * Azimut/Elevation aller Satelliten für Beobachter (Grad, Höhe m) zum Zeitpunkt date.
 * Gibt [{sys, name, label, az, el, rangeKm}] zurück (alle mit gültiger Lösung, auch unter dem Horizont).
 */
export function lookAngles(sats, lat, lon, heightM, date = new Date()) {
  const sat = window.satellite;
  const obs = { latitude: sat.degreesToRadians(lat), longitude: sat.degreesToRadians(lon), height: (heightM || 0) / 1000 };
  const gmst = sat.gstime(date);
  const out = [];
  for (const s of sats) {
    let pv;
    try { pv = sat.propagate(s.rec, date); } catch { continue; }
    if (!pv || !pv.position || typeof pv.position !== 'object') continue;
    const la = sat.ecfToLookAngles(obs, sat.eciToEcf(pv.position, gmst));
    const el = la.elevation * 180 / Math.PI;
    if (!Number.isFinite(el)) continue;
    out.push({ sys: s.sys, name: s.name, label: s.label, az: ((la.azimuth * 180 / Math.PI) % 360 + 360) % 360, el, rangeKm: la.rangeSat });
  }
  return out;
}

/** Inverse einer symmetrischen n×n-Matrix (Gauß-Jordan). null bei Singularität. */
function invert(m) {
  const n = m.length;
  const a = m.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    if (Math.abs(a[p][c]) < 1e-12) return null;
    [a[c], a[p]] = [a[p], a[c]];
    const d = a[c][c];
    for (let j = 0; j < 2 * n; j++) a[c][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = a[r][c];
      if (f) for (let j = 0; j < 2 * n; j++) a[r][j] -= f * a[c][j];
    }
  }
  return a.map(row => row.slice(n));
}

/**
 * DOP aus der Geometrie (Elevation/Azimut in Grad). Je System eine eigene Uhrenunbekannte.
 * Gibt {pdop, hdop, vdop, n} oder null, wenn zu wenige Satelliten.
 */
export function dop(list) {
  const systems = [...new Set(list.map(s => s.sys))];
  const k = 3 + systems.length;
  if (list.length < k) return null;
  const N = Array.from({ length: k }, () => new Array(k).fill(0));
  const D = Math.PI / 180;
  for (const s of list) {
    const ce = Math.cos(s.el * D);
    const row = new Array(k).fill(0);
    row[0] = -ce * Math.sin(s.az * D); // Ost
    row[1] = -ce * Math.cos(s.az * D); // Nord
    row[2] = -Math.sin(s.el * D);      // oben
    row[3 + systems.indexOf(s.sys)] = 1;
    for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) N[i][j] += row[i] * row[j];
  }
  const Q = invert(N);
  if (!Q) return null;
  const hdop = Math.sqrt(Q[0][0] + Q[1][1]);
  const vdop = Math.sqrt(Q[2][2]);
  return { pdop: Math.sqrt(Q[0][0] + Q[1][1] + Q[2][2]), hdop, vdop, n: list.length };
}
