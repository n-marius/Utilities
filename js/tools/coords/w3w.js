// what3words über die öffentliche API (proprietär, nur online, eigener API-Schlüssel nötig).

const API = 'https://api.what3words.com/v3/';

/** ///wort.wort.wort tolerant lesen (mit/ohne ///, Leerzeichen statt Punkt, Link). Gibt 'a.b.c' oder null. */
export function parseWords(text) {
  let s = text.trim().toLowerCase();
  s = s.replace(/^(?:https?:\/\/)?(?:www\.)?(?:what3words\.com|w3w\.co|map\.what3words\.com)\//, '');
  s = s.replace(/^\/{1,3}/, '').trim();
  const m = /^([\p{L}\p{M}]+)[.\s。｡･・︒។։။۔።।]+([\p{L}\p{M}]+)[.\s。｡･・︒។։။۔።।]+([\p{L}\p{M}]+)$/u.exec(s);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

/** Fehler mit verständlichem deutschem Text. */
export class W3wError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

function explain(status, err) {
  const code = (err && err.code) || '';
  const msg = (err && err.message) || '';
  switch (code) {
    case 'MissingKey':
    case 'InvalidKey': return 'API-Schlüssel ungültig';
    case 'QuotaExceeded': return 'Kontingent des API-Schlüssels erschöpft';
    case 'BadWords': return 'Unbekannte 3-Wort-Adresse';
    case 'BadCoordinates': return 'Koordinaten ungültig';
    case 'BadLanguage': return 'Sprache nicht unterstützt';
    case 'SuspendedKey': return 'API-Schlüssel gesperrt';
  }
  if (status === 401) return 'API-Schlüssel ungültig';
  if (status === 402 || status === 403 || /plan|upgrade|subscription|permission/i.test(msg)) {
    return 'Mit diesem Tarif nicht erlaubt' + (msg ? ` (what3words: ${msg})` : '');
  }
  if (status === 429) return 'Zu viele Anfragen, später erneut versuchen';
  return msg ? `what3words: ${msg}` : `what3words-Fehler (HTTP ${status})`;
}

async function call(path, params, key, signal, fetchFn) {
  const url = API + path + '?' + new URLSearchParams({ ...params, key }).toString();
  let res;
  try {
    res = await fetchFn(url, { signal, headers: { Accept: 'application/json' } });
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    throw new W3wError('Keine Verbindung zu what3words', 'Network');
  }
  let data = null;
  try { data = await res.json(); } catch { /* kein JSON */ }
  if (!res.ok || !data || data.error) throw new W3wError(explain(res.status, data && data.error), (data && data.error && data.error.code) || 'HTTP' + res.status);
  return data;
}

/** Koordinaten -> {words, nearestPlace, lat, lon}. Ausgabe auf Deutsch. */
export async function toWords(lat, lon, key, { signal, fetchFn = fetch } = {}) {
  const d = await call('convert-to-3wa', { coordinates: `${lat.toFixed(6)},${lon.toFixed(6)}`, language: 'de' }, key, signal, fetchFn);
  if (!d.words) throw new W3wError('Unerwartete Antwort von what3words', 'Format');
  return { words: d.words, nearestPlace: d.nearestPlace || '', lat: d.coordinates && d.coordinates.lat, lon: d.coordinates && d.coordinates.lng };
}

/** 'a.b.c' -> {words, nearestPlace, lat, lon} (Mitte des 3-m-Quadrats). Sprache erkennt die API. */
export async function toCoords(words, key, { signal, fetchFn = fetch } = {}) {
  const d = await call('convert-to-coordinates', { words }, key, signal, fetchFn);
  const c = d.coordinates;
  if (!c || !Number.isFinite(c.lat) || !Number.isFinite(c.lng)) throw new W3wError('Unerwartete Antwort von what3words', 'Format');
  return { words: d.words || words, nearestPlace: d.nearestPlace || '', lat: c.lat, lon: c.lng };
}
