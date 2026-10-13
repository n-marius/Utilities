// Koordinatenumrechnung ohne DOM (auch in Node lauffähig).
// Kanonische Darstellung: {lat, lon, h} in WGS84, Grad bzw. m über Ellipsoid.
// Jedes Format: parse(text) -> {lat, lon, h?, note?} | {error} ; format(p) -> Text | null (außerhalb).

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export const WGS84 = ellipsoid(6378137, 1 / 298.257223563);
export const BESSEL = ellipsoid(6377397.155, 1 / 299.1528128);

function ellipsoid(a, f) {
  const e2 = f * (2 - f);
  return { a, f, e2, e: Math.sqrt(e2), n: f / (2 - f) };
}

const normLon = lon => {
  lon = ((lon + 180) % 360 + 360) % 360 - 180;
  return lon === -180 ? 180 : lon;
};

/* ===== Transversale Mercatorprojektion (Krüger-Reihen bis n^6, nach Karney 2011) ===== */

const tmCache = new Map();
function tmCoeffs(ell) {
  if (tmCache.has(ell)) return tmCache.get(ell);
  const n = ell.n, n2 = n * n, n3 = n2 * n, n4 = n3 * n, n5 = n4 * n, n6 = n5 * n;
  const A = ell.a / (1 + n) * (1 + n2 / 4 + n4 / 64 + n6 / 256);
  const alpha = [
    n / 2 - 2 / 3 * n2 + 5 / 16 * n3 + 41 / 180 * n4 - 127 / 288 * n5 + 7891 / 37800 * n6,
    13 / 48 * n2 - 3 / 5 * n3 + 557 / 1440 * n4 + 281 / 630 * n5 - 1983433 / 1935360 * n6,
    61 / 240 * n3 - 103 / 140 * n4 + 15061 / 26880 * n5 + 167603 / 181440 * n6,
    49561 / 161280 * n4 - 179 / 168 * n5 + 6601661 / 7257600 * n6,
    34729 / 80640 * n5 - 3418889 / 1995840 * n6,
    212378941 / 319334400 * n6
  ];
  const beta = [
    n / 2 - 2 / 3 * n2 + 37 / 96 * n3 - 1 / 360 * n4 - 81 / 512 * n5 + 96199 / 604800 * n6,
    1 / 48 * n2 + 1 / 15 * n3 - 437 / 1440 * n4 + 46 / 105 * n5 - 1118711 / 3870720 * n6,
    17 / 480 * n3 - 37 / 840 * n4 - 209 / 4480 * n5 + 5569 / 90720 * n6,
    4397 / 161280 * n4 - 11 / 504 * n5 - 830251 / 7257600 * n6,
    4583 / 161280 * n5 - 108847 / 3991680 * n6,
    20648693 / 638668800 * n6
  ];
  const c = { A, alpha, beta };
  tmCache.set(ell, c);
  return c;
}

/** Geographisch -> transversal Mercator. Gibt {x (Ost), y (Nord)} ohne Falsche Ostung/Nordung. */
export function tmForward(lat, lon, lon0, k0, ell) {
  const { A, alpha } = tmCoeffs(ell);
  const e = ell.e;
  const phi = lat * D2R, lam = (lon - lon0) * D2R;
  const tau = Math.tan(phi);
  const sigma = Math.sinh(e * Math.atanh(e * tau / Math.sqrt(1 + tau * tau)));
  const taup = tau * Math.sqrt(1 + sigma * sigma) - sigma * Math.sqrt(1 + tau * tau);
  const xip = Math.atan2(taup, Math.cos(lam));
  const etap = Math.asinh(Math.sin(lam) / Math.sqrt(taup * taup + Math.cos(lam) ** 2));
  let xi = xip, eta = etap;
  for (let j = 1; j <= 6; j++) {
    xi += alpha[j - 1] * Math.sin(2 * j * xip) * Math.cosh(2 * j * etap);
    eta += alpha[j - 1] * Math.cos(2 * j * xip) * Math.sinh(2 * j * etap);
  }
  return { x: k0 * A * eta, y: k0 * A * xi };
}

/** Transversal Mercator -> geographisch. x, y ohne Falsche Ostung/Nordung. */
export function tmInverse(x, y, lon0, k0, ell) {
  const { A, beta } = tmCoeffs(ell);
  const e = ell.e, e2 = ell.e2;
  const xi = y / (k0 * A), eta = x / (k0 * A);
  let xip = xi, etap = eta;
  for (let j = 1; j <= 6; j++) {
    xip -= beta[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    etap -= beta[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  const sinhEtap = Math.sinh(etap), sinXip = Math.sin(xip), cosXip = Math.cos(xip);
  const taup = sinXip / Math.sqrt(sinhEtap * sinhEtap + cosXip * cosXip);
  let tau = taup;
  for (let i = 0; i < 20; i++) {
    const sigma = Math.sinh(e * Math.atanh(e * tau / Math.sqrt(1 + tau * tau)));
    const taui = tau * Math.sqrt(1 + sigma * sigma) - sigma * Math.sqrt(1 + tau * tau);
    const d = (taup - taui) / Math.sqrt(1 + taui * taui)
      * (1 + (1 - e2) * tau * tau) / ((1 - e2) * Math.sqrt(1 + tau * tau));
    tau += d;
    if (Math.abs(d) < 1e-14) break;
  }
  return { lat: Math.atan(tau) * R2D, lon: normLon(lon0 + Math.atan2(sinhEtap, cosXip) * R2D) };
}

/* ===== UTM ===== */

const BANDS = 'CDEFGHJKLMNPQRSTUVWX';

export function utmZone(lat, lon) {
  lon = normLon(lon);
  let zone = Math.floor((lon + 180) / 6) + 1;
  if (zone > 60) zone = 60;
  if (lat >= 56 && lat < 64 && lon >= 3 && lon < 12) zone = 32; // Südnorwegen
  if (lat >= 72 && lat <= 84 && lon >= 0 && lon < 42) {          // Spitzbergen
    zone = lon < 9 ? 31 : lon < 21 ? 33 : lon < 33 ? 35 : 37;
  }
  return zone;
}

export function utmBand(lat) {
  if (lat < -80 || lat > 84) return null;
  return BANDS[Math.min(19, Math.floor((lat + 80) / 8))];
}

/** WGS84 -> UTM {zone, band, hemi, e, n}; null außerhalb 80° S … 84° N. zone optional erzwingen. */
export function toUTM(lat, lon, forceZone) {
  const band = utmBand(lat);
  if (!band) return null;
  const zone = forceZone || utmZone(lat, lon);
  const { x, y } = tmForward(lat, lon, zone * 6 - 183, 0.9996, WGS84);
  return { zone, band, hemi: lat < 0 ? 'S' : 'N', e: x + 500000, n: lat < 0 ? y + 10000000 : y };
}

export function fromUTM(zone, hemi, e, n) {
  return tmInverse(e - 500000, hemi === 'S' ? n - 10000000 : n, zone * 6 - 183, 0.9996, WGS84);
}

const bandRange = b => { const i = BANDS.indexOf(b); return [-80 + i * 8, i === 19 ? 84 : -72 + i * 8]; };

/* ===== MGRS / UTMREF ===== */

const MG_COLS = ['ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ'];
const MG_ROWS = 'ABCDEFGHJKLMNPQRSTUV';

/** MGRS mit digits Stellen je Achse (5 = 1 m). Koordinaten werden abgeschnitten, nicht gerundet. */
export function toMGRS(lat, lon, digits = 5) {
  const u = toUTM(lat, lon);
  if (!u) return null;
  // Rundungsfehler an Quadratgrenzen vermeiden (1e-6 m)
  const e = Math.floor(u.e + 1e-6), n = Math.floor(u.n + 1e-6);
  const col = MG_COLS[(u.zone - 1) % 3][Math.floor(e / 100000) - 1];
  const row = MG_ROWS[(Math.floor(n / 100000) + (u.zone % 2 ? 0 : 5)) % 20];
  if (!col) return null;
  const f = 10 ** (5 - digits);
  const pad = v => String(Math.floor((v % 100000) / f)).padStart(digits, '0');
  return { zone: u.zone, band: u.band, sq: col + row, e: pad(e), n: pad(n) };
}

export function parseMGRS(text) {
  const s = text.toUpperCase().replace(/[\s,;]+/g, '');
  const m = /^(\d{1,2})([C-HJ-NP-X])([A-HJ-NP-Z])([A-HJ-NP-V])(\d*)$/.exec(s);
  if (!m) return { error: 'Format nicht erkannt' };
  const zone = +m[1], band = m[2], digits = m[5];
  if (zone < 1 || zone > 60 || digits.length % 2 || digits.length > 10) return { error: 'Format nicht erkannt' };
  const ci = MG_COLS[(zone - 1) % 3].indexOf(m[3]);
  const ri = MG_ROWS.indexOf(m[4]);
  if (ci < 0) return { error: 'Quadrat passt nicht zur Zone' };
  const k = digits.length / 2;
  const size = 10 ** (5 - k);
  // Ganze Meter (5 Stellen) als Punkt, gröbere Angaben als Feldmitte
  const off = k === 5 ? 0 : size / 2;
  const e = (ci + 1) * 100000 + (k ? +digits.slice(0, k) * size : 0) + off;
  const nIn = ((ri - (zone % 2 ? 0 : 5) + 20) % 20) * 100000 + (k ? +digits.slice(k) * size : 0) + off;
  // Zeilenbuchstaben wiederholen sich alle 2000 km: passendes Vielfaches über das Breitenband finden
  const hemi = band >= 'N' ? 'N' : 'S';
  const [lo, hi] = bandRange(band);
  let best = null;
  for (let i = 0; i < 6; i++) {
    const n = nIn + i * 2000000;
    if (n > 10000000) break;
    const p = fromUTM(zone, hemi, e, n);
    const d = p.lat < lo ? lo - p.lat : p.lat > hi ? p.lat - hi : 0;
    if (!best || d < best.d) best = { d, p };
  }
  if (!best || best.d > 1) return { error: 'Quadrat passt nicht zum Breitenband' };
  const r = { lat: best.p.lat, lon: best.p.lon };
  if (k < 5) r.note = `Mitte des ${fmtSize(size)}-Quadrats`;
  return r;
}

function fmtSize(m) { return m >= 1000 ? `${m / 1000}-km` : `${m}-m`; }

/* ===== Ellipsoid <-> kartesisch, Helmert ===== */

export function toECEF(lat, lon, h, ell = WGS84) {
  const phi = lat * D2R, lam = lon * D2R;
  const s = Math.sin(phi), c = Math.cos(phi);
  const N = ell.a / Math.sqrt(1 - ell.e2 * s * s);
  return [(N + h) * c * Math.cos(lam), (N + h) * c * Math.sin(lam), (N * (1 - ell.e2) + h) * s];
}

export function fromECEF(x, y, z, ell = WGS84) {
  const { a, e2 } = ell;
  const p = Math.hypot(x, y);
  const lon = Math.atan2(y, x);
  let phi = Math.atan2(z, p * (1 - e2)), h = 0;
  for (let i = 0; i < 12; i++) {
    const s = Math.sin(phi);
    const N = a / Math.sqrt(1 - e2 * s * s);
    h = p * Math.cos(phi) + z * s - a * Math.sqrt(1 - e2 * s * s);
    const next = Math.atan2(z, p * (1 - e2 * N / (N + h)));
    if (Math.abs(next - phi) < 1e-15) { phi = next; break; }
    phi = next;
  }
  const s = Math.sin(phi);
  h = p * Math.cos(phi) + z * s - a * Math.sqrt(1 - e2 * s * s);
  return { lat: phi * R2D, lon: lon * R2D, h };
}

/**
 * 7-Parameter-Helmert, Konvention Position Vector (wie EPSG 9606 / PROJ):
 * X_ziel = T + (1 + s) · R · X_quelle. inverse = true rechnet exakt zurück.
 */
function helmert(X, { tx, ty, tz, rx, ry, rz, s }, inverse = false) {
  const as = D2R / 3600;
  const r = [rx * as, ry * as, rz * as];
  const m = 1 + s * 1e-6;
  const R = [
    [1, -r[2], r[1]],
    [r[2], 1, -r[0]],
    [-r[1], r[0], 1]
  ];
  if (!inverse) {
    return [0, 1, 2].map(i => [tx, ty, tz][i] + m * (R[i][0] * X[0] + R[i][1] * X[1] + R[i][2] * X[2]));
  }
  const b = [(X[0] - tx) / m, (X[1] - ty) / m, (X[2] - tz) / m];
  return solve3(R, b);
}

function solve3(M, b) {
  const det = m => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
    - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
    + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const d = det(M);
  return [0, 1, 2].map(c => det(M.map((row, i) => row.map((v, j) => (j === c ? b[i] : v)))) / d);
}

/* ===== Gauß-Krüger (DHDN / Potsdam, Bessel, 3°-Streifen) ===== */

// Bundesamt-Parametersatz "Deutschland gesamt" DHDN -> WGS84 (= EPSG 1777 "DHDN to WGS 84 (2)").
export const DHDN_TO_WGS84 = { tx: 598.1, ty: 73.7, tz: 418.2, rx: 0.202, ry: 0.045, rz: -2.455, s: 6.7 };
const DE_BOX = { s: 47.0, n: 55.3, w: 5.5, e: 15.5 };

export function wgs84ToDHDN(lat, lon, h = 0) {
  const X = helmert(toECEF(lat, lon, h, WGS84), DHDN_TO_WGS84, true);
  return fromECEF(...X, BESSEL);
}

export function dhdnToWGS84(lat, lon, h = 0) {
  const X = helmert(toECEF(lat, lon, h, BESSEL), DHDN_TO_WGS84);
  return fromECEF(...X, WGS84);
}

/** Gauß-Krüger auf Bessel ohne Datumsübergang. strip: Kennziffer (Mittelmeridian = 3·strip). */
export function gkForward(lat, lon, strip) {
  strip = strip || Math.min(5, Math.max(2, Math.round(lon / 3)));
  const { x, y } = tmForward(lat, lon, strip * 3, 1, BESSEL);
  return { strip, r: x + strip * 1e6 + 500000, h: y };
}

export function gkInverse(r, hw) {
  const strip = Math.floor(r / 1e6);
  return tmInverse(r - strip * 1e6 - 500000, hw, strip * 3, 1, BESSEL);
}

/** WGS84 -> GK (DHDN); null außerhalb Deutschlands. */
export function toGK(lat, lon) {
  if (lat < DE_BOX.s || lat > DE_BOX.n || lon < DE_BOX.w || lon > DE_BOX.e) return null;
  const d = wgs84ToDHDN(lat, lon, 0);
  return gkForward(d.lat, d.lon);
}

export function fromGK(r, hw) {
  const d = gkInverse(r, hw);
  const w = dhdnToWGS84(d.lat, d.lon, 0);
  return { lat: w.lat, lon: w.lon };
}

/* ===== SwissGrid LV95 (CH1903+, schiefachsige Zylinderprojektion nach swisstopo) ===== */

// CH1903+ -> ETRS89/WGS84, 3 Parameter (swisstopo), Genauigkeit etwa 1 m
const CH_TO_WGS84 = { tx: 674.374, ty: 15.056, tz: 405.346, rx: 0, ry: 0, rz: 0, s: 0 };
const CH_BOX = { s: 45.7, n: 47.95, w: 5.8, e: 10.6 };
const CH = (() => {
  const { a, e2, e } = BESSEL;
  const phi0 = (46 + 57 / 60 + 8.66 / 3600) * D2R;
  const lam0 = (7 + 26 / 60 + 22.5 / 3600) * D2R;
  const R = a * Math.sqrt(1 - e2) / (1 - e2 * Math.sin(phi0) ** 2);
  const alpha = Math.sqrt(1 + e2 / (1 - e2) * Math.cos(phi0) ** 4);
  const b0 = Math.asin(Math.sin(phi0) / alpha);
  const K = Math.log(Math.tan(Math.PI / 4 + b0 / 2))
    - alpha * Math.log(Math.tan(Math.PI / 4 + phi0 / 2))
    + alpha * e / 2 * Math.log((1 + e * Math.sin(phi0)) / (1 - e * Math.sin(phi0)));
  return { e, lam0, R, alpha, b0, K };
})();

/** Bessel (CH1903+) -> LV95 {e, n}. */
export function lv95Forward(lat, lon) {
  const { e, lam0, R, alpha, b0, K } = CH;
  const phi = lat * D2R, lam = lon * D2R;
  const S = alpha * Math.log(Math.tan(Math.PI / 4 + phi / 2))
    - alpha * e / 2 * Math.log((1 + e * Math.sin(phi)) / (1 - e * Math.sin(phi))) + K;
  const b = 2 * (Math.atan(Math.exp(S)) - Math.PI / 4);
  const l = alpha * (lam - lam0);
  const lb = Math.atan2(Math.sin(l), Math.sin(b0) * Math.tan(b) + Math.cos(b0) * Math.cos(l));
  const bb = Math.asin(Math.cos(b0) * Math.sin(b) - Math.sin(b0) * Math.cos(b) * Math.cos(l));
  return { e: 2600000 + R * lb, n: 1200000 + R / 2 * Math.log((1 + Math.sin(bb)) / (1 - Math.sin(bb))) };
}

export function lv95Inverse(E, N) {
  const { e, lam0, R, alpha, b0, K } = CH;
  const lb = (E - 2600000) / R;
  const bb = 2 * (Math.atan(Math.exp((N - 1200000) / R)) - Math.PI / 4);
  const b = Math.asin(Math.cos(b0) * Math.sin(bb) + Math.sin(b0) * Math.cos(bb) * Math.cos(lb));
  const l = Math.atan2(Math.sin(lb), Math.cos(b0) * Math.cos(lb) - Math.sin(b0) * Math.tan(bb));
  const lam = lam0 + l / alpha;
  let phi = b;
  for (let i = 0; i < 30; i++) {
    const S = (Math.log(Math.tan(Math.PI / 4 + b / 2)) - K) / alpha
      + e * Math.log(Math.tan(Math.PI / 4 + Math.asin(e * Math.sin(phi)) / 2));
    const next = 2 * Math.atan(Math.exp(S)) - Math.PI / 2;
    if (Math.abs(next - phi) < 1e-15) { phi = next; break; }
    phi = next;
  }
  return { lat: phi * R2D, lon: lam * R2D };
}

export function toLV95(lat, lon) {
  if (lat < CH_BOX.s || lat > CH_BOX.n || lon < CH_BOX.w || lon > CH_BOX.e) return null;
  const X = helmert(toECEF(lat, lon, 0, WGS84), CH_TO_WGS84, true);
  const b = fromECEF(...X, BESSEL);
  return lv95Forward(b.lat, b.lon);
}

export function fromLV95(E, N) {
  const b = lv95Inverse(E, N);
  const w = fromECEF(...helmert(toECEF(b.lat, b.lon, 0, BESSEL), CH_TO_WGS84), WGS84);
  return { lat: w.lat, lon: w.lon };
}

/* ===== Plus Code (Open Location Code) ===== */

const OLC = '23456789CFGHJMPQRVWX';

export function olcEncode(lat, lon, len = 11) {
  lat = Math.min(90, Math.max(-90, lat));
  lon = normLon(lon);
  if (lon === 180) lon = -180;
  // Ganzzahlig wie in der Referenzimplementierung: 1/8000° in Paaren, dann 5 Gitterstufen
  let latV = Math.floor(Math.round((lat + 90) * 25e6 * 1e6) / 1e6);
  let lonV = Math.floor(Math.round((lon + 180) * 8192e3 * 1e6) / 1e6);
  if (latV >= 180 * 25e6) latV = 180 * 25e6 - 1;
  let grid = '';
  for (let i = 0; i < 5; i++) {
    grid = OLC[(latV % 5) * 4 + (lonV % 4)] + grid;
    latV = Math.floor(latV / 5);
    lonV = Math.floor(lonV / 4);
  }
  let pairs = '';
  for (let i = 0; i < 5; i++) {
    pairs = OLC[latV % 20] + OLC[lonV % 20] + pairs;
    latV = Math.floor(latV / 20);
    lonV = Math.floor(lonV / 20);
  }
  const full = pairs + grid;
  return full.slice(0, 8) + '+' + full.slice(8, len);
}

export function olcDecode(text) {
  const s = text.toUpperCase().replace(/\s+/g, '');
  const plus = s.indexOf('+');
  if (plus < 0 || plus !== s.lastIndexOf('+') || plus % 2) return { error: 'Format nicht erkannt' };
  if (plus < 8) {
    return /^[23456789CFGHJMPQRVWX]+\+[23456789CFGHJMPQRVWX]*$/.test(s)
      ? { error: 'Kurzcode ohne Ort – bitte vollständigen Code eingeben' }
      : { error: 'Format nicht erkannt' };
  }
  if (plus > 8) return { error: 'Format nicht erkannt' };
  let digits = s.slice(0, 8) + s.slice(9);
  const pad = digits.indexOf('0');
  if (pad >= 0) {
    if (!/^0+$/.test(digits.slice(pad, 8)) || pad % 2 || digits.length > 8) return { error: 'Format nicht erkannt' };
    digits = digits.slice(0, pad);
  }
  if (!digits.length || digits.length === 9 || [...digits].some(c => !OLC.includes(c))) return { error: 'Format nicht erkannt' };
  if (OLC.indexOf(digits[0]) > 8 || (digits[1] && OLC.indexOf(digits[1]) > 17)) return { error: 'Format nicht erkannt' };
  let lat = -90, lon = -180, latSz = 20, lonSz = 20;
  const np = Math.min(10, digits.length);
  for (let i = 0; i < np; i += 2) {
    if (i) { latSz /= 20; lonSz /= 20; }
    lat += OLC.indexOf(digits[i]) * latSz;
    lon += OLC.indexOf(digits[i + 1]) * lonSz;
  }
  for (let i = 10; i < Math.min(15, digits.length); i++) {
    latSz /= 5; lonSz /= 4;
    const d = OLC.indexOf(digits[i]);
    lat += Math.floor(d / 4) * latSz;
    lon += (d % 4) * lonSz;
  }
  return {
    lat: Math.min(90, lat + latSz / 2), lon: normLon(lon + lonSz / 2),
    sizeM: [latSz * 111320, lonSz * 111320 * Math.cos((lat + latSz / 2) * D2R)]
  };
}

/* ===== Geohash ===== */

const GH = '0123456789bcdefghjkmnpqrstuvwxyz';

export function geohashEncode(lat, lon, len = 10) {
  let la = [-90, 90], lo = [-180, 180], even = true, bit = 0, ch = 0, out = '';
  lon = normLon(lon);
  while (out.length < len) {
    const r = even ? lo : la, v = even ? lon : lat;
    const mid = (r[0] + r[1]) / 2;
    if (v >= mid) { ch = ch * 2 + 1; r[0] = mid; } else { ch *= 2; r[1] = mid; }
    even = !even;
    if (++bit === 5) { out += GH[ch]; bit = 0; ch = 0; }
  }
  return out;
}

export function geohashDecode(text) {
  const s = text.trim().toLowerCase();
  if (!/^[0123456789bcdefghjkmnpqrstuvwxyz]{1,12}$/.test(s)) return { error: 'Format nicht erkannt' };
  let la = [-90, 90], lo = [-180, 180], even = true;
  for (const c of s) {
    const v = GH.indexOf(c);
    for (let b = 4; b >= 0; b--) {
      const r = even ? lo : la;
      const mid = (r[0] + r[1]) / 2;
      if ((v >> b) & 1) r[0] = mid; else r[1] = mid;
      even = !even;
    }
  }
  const lat = (la[0] + la[1]) / 2;
  return { lat, lon: (lo[0] + lo[1]) / 2, sizeM: [(la[1] - la[0]) * 111320, (lo[1] - lo[0]) * 111320 * Math.cos(lat * D2R)] };
}

/* ===== Maidenhead-Locator ===== */

export function maidenheadEncode(lat, lon, len = 6) {
  let x = normLon(lon) + 180, y = Math.min(179.9999999, Math.max(0, lat + 90));
  if (x >= 360) x -= 360;
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWX';
  let out = '';
  let w = 20, hgt = 10;
  for (let i = 0; i < len / 2; i++) {
    const div = i === 0 ? 18 : i % 2 ? 10 : 24;
    if (i) { w /= div; hgt /= div; }
    const cx = Math.floor(x / w), cy = Math.floor(y / hgt);
    x -= cx * w; y -= cy * hgt;
    if (i % 2) out += String(cx) + String(cy);
    else out += i === 0 ? A[cx] + A[cy] : (A[cx] + A[cy]).toLowerCase();
  }
  return out;
}

export function maidenheadDecode(text) {
  const s = text.trim().toUpperCase();
  if (!/^[A-R]{2}(?:\d\d(?:[A-X]{2}(?:\d\d(?:[A-X]{2})?)?)?)?$/.test(s)) return { error: 'Format nicht erkannt' };
  let x = 0, y = 0, w = 20, hgt = 10;
  for (let i = 0; i < s.length / 2; i++) {
    const div = i === 0 ? 18 : i % 2 ? 10 : 24;
    if (i) { w /= div; hgt /= div; }
    const a = s[2 * i], b = s[2 * i + 1];
    const cx = i % 2 ? +a : a.charCodeAt(0) - 65, cy = i % 2 ? +b : b.charCodeAt(0) - 65;
    x += cx * w; y += cy * hgt;
  }
  const lat = y + hgt / 2 - 90;
  return { lat, lon: x + w / 2 - 180, sizeM: [hgt * 111320, w * 111320 * Math.cos(lat * D2R)] };
}

/* ===== Freitext-Parser ===== */

/** Typografische Varianten vereinheitlichen. */
function normalize(text) {
  return text
    .replace(/[′’‘´`]/g, "'")
    .replace(/[″“”„]|''/g, '"')
    .replace(/[º˚]/g, '°')
    .replace(/[−–—]/g, '-')
    .replace(/[   ]/g, ' ')
    .trim();
}

/** Zahlen aus Text; Komma oder Punkt als Dezimaltrenner, Tausender-Apostroph erlaubt. */
function numbers(text) {
  const out = [];
  const re = /[+-]?\d+(?:'\d{3})*(?:[.,]\d+)?/g;
  let m;
  while ((m = re.exec(text))) out.push(parseFloat(m[0].replace(/'/g, '').replace(',', '.')));
  return out;
}

/**
 * Breite/Länge in Dezimalgrad, Grad/Dezimalminuten oder Grad/Min/Sek.
 * Hemisphäre N/S/E/O/W vorn oder hinten, alternativ Vorzeichen; Reihenfolge Breite, Länge,
 * sofern Buchstaben nichts anderes sagen.
 */
export function parseLatLon(text) {
  const s = normalize(text).toUpperCase();
  if (!s) return { error: 'Format nicht erkannt' };
  const tokens = [];
  const re = /\s+|[;,/](?!\d)|([+-]?\d+(?:[.,]\d+)?)|(°|'|")|([NSEWO])|(-)|(.)/gy;
  let m;
  while ((m = re.exec(s))) {
    if (m[1] !== undefined) tokens.push({ t: 'num', v: parseFloat(m[1].replace(',', '.')), neg: m[1][0] === '-', int: !/[.,]/.test(m[1]) });
    else if (m[2]) tokens.push({ t: 'mark', v: m[2] });
    else if (m[3]) tokens.push({ t: 'hemi', v: m[3] === 'O' ? 'E' : m[3] });
    else if (m[4]) tokens.push({ t: 'minus' });
    else if (m[5]) return { error: 'Format nicht erkannt' };
  }
  // Minuszeichen mit Abstand vor einer Zahl
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].t === 'minus') {
      const nx = tokens[i + 1];
      if (!nx || nx.t !== 'num' || nx.neg) return { error: 'Format nicht erkannt' };
      nx.neg = true; nx.v = -nx.v;
      tokens.splice(i, 1);
    }
  }
  const hemis = tokens.filter(t => t.t === 'hemi');
  if (hemis.length > 2) return { error: 'Format nicht erkannt' };

  // Zahlen samt Einheit sammeln, Gruppen bilden
  const nums = [];
  let groupBreak = new Set();
  tokens.forEach((t, i) => {
    if (t.t === 'num') {
      const nx = tokens[i + 1];
      nums.push({ v: t.v, neg: t.neg, int: t.int, mark: nx && nx.t === 'mark' ? nx.v : null, idx: i });
    }
  });
  if (!nums.length || nums.length > 6) return { error: 'Format nicht erkannt' };

  let groups;
  const firstIsHemi = tokens[0].t === 'hemi';
  if (hemis.length === 2) {
    const [h1, h2] = hemis.map(hh => tokens.indexOf(hh));
    if (firstIsHemi) {
      groups = [nums.filter(n => n.idx > h1 && n.idx < h2), nums.filter(n => n.idx > h2)];
      groups.hemi = [tokens[h1].v, tokens[h2].v];
    } else {
      if (tokens.slice(h2 + 1).some(t => t.t === 'num')) return { error: 'Format nicht erkannt' };
      groups = [nums.filter(n => n.idx < h1), nums.filter(n => n.idx > h1 && n.idx < h2)];
      groups.hemi = [tokens[h1].v, tokens[h2].v];
    }
  } else {
    // Gruppengrenze: Zahl mit Gradzeichen nach bereits begonnener Gruppe, oder Hälfte
    const hasDeg = nums.some(n => n.mark === '°');
    groups = [[], []];
    if (hasDeg) {
      let g = 0;
      nums.forEach((n, i) => {
        if (i && n.mark === '°') g++;
        else if (i && n.mark === null && nums[i - 1].mark === '"') g++;
        if (g > 1) g = 2;
        (groups[g] || (groups[g] = [])).push(n);
      });
      if (groups.length > 2) return { error: 'Format nicht erkannt' };
    } else {
      if (nums.length % 2) return { error: 'Format nicht erkannt' };
      groups = [nums.slice(0, nums.length / 2), nums.slice(nums.length / 2)];
    }
    groups.hemi = [null, null];
    if (hemis.length === 1) {
      const hi = tokens.indexOf(hemis[0]);
      // vorn -> gehört zur folgenden Gruppe, sonst zur vorangehenden
      const g = firstIsHemi ? 0 : groups[1].length && hi > groups[1][0].idx ? 1 : 0;
      groups.hemi[g] = hemis[0].v;
    }
  }
  groupBreak = null;
  if (groups.length !== 2 || !groups[0].length || !groups[1].length) return { error: 'Format nicht erkannt' };

  const vals = [];
  for (const g of groups) {
    if (g.length > 3) return { error: 'Format nicht erkannt' };
    const expected = ['°', "'", '"'];
    let deg = 0;
    for (let i = 0; i < g.length; i++) {
      const n = g[i];
      if (n.mark && n.mark !== expected[i]) return { error: 'Format nicht erkannt' };
      if (i > 0 && (n.neg || Math.abs(n.v) >= 60)) return { error: 'Format nicht erkannt' };
      if (i < g.length - 1 && !n.int) return { error: 'Format nicht erkannt' };
      deg += Math.abs(n.v) / [1, 60, 3600][i];
    }
    vals.push({ v: deg, neg: g[0].neg });
  }
  let [h1, h2] = groups.hemi;
  const axis = h => (h === 'N' || h === 'S' ? 'lat' : h ? 'lon' : null);
  let a1 = axis(h1), a2 = axis(h2);
  if (a1 && a1 === a2) return { error: 'Format nicht erkannt' };
  if (!a1) a1 = a2 === 'lat' ? 'lon' : 'lat';
  if (!a2) a2 = a1 === 'lat' ? 'lon' : 'lat';
  const res = {};
  [[vals[0], h1, a1], [vals[1], h2, a2]].forEach(([v, h, a]) => {
    res[a] = (v.neg || h === 'S' || h === 'W' ? -1 : 1) * v.v;
  });
  if (Math.abs(res.lat) > 90 || Math.abs(res.lon) > 180) return { error: 'Außerhalb des Wertebereichs' };
  return { lat: res.lat, lon: normLon(res.lon) };
}

/* ===== Ausgabeformate ===== */

const pad = (v, n) => String(v).padStart(n, '0');

export function fmtDD(p) {
  return `${p.lat.toFixed(6)}, ${normLon(p.lon).toFixed(6)}`;
}

export function fmtDDM(p) {
  const part = (v, w, pos, neg) => {
    const t = Math.round(Math.abs(v) * 60000);
    const d = Math.floor(t / 60000), mm = (t % 60000) / 1000;
    return `${v < 0 ? neg : pos} ${pad(d, w)}° ${pad(mm.toFixed(3), 6)}′`;
  };
  return `${part(p.lat, 2, 'N', 'S')} ${part(normLon(p.lon), 3, 'E', 'W')}`;
}

export function fmtDMS(p) {
  const part = (v, pos, neg) => {
    const t = Math.round(Math.abs(v) * 360000);
    const d = Math.floor(t / 360000), mm = Math.floor((t % 360000) / 6000), ss = (t % 6000) / 100;
    return `${d}° ${mm}′ ${ss.toFixed(2)}″ ${v < 0 ? neg : pos}`;
  };
  return `${part(p.lat, 'N', 'S')}, ${part(normLon(p.lon), 'E', 'W')}`;
}

/** Größe einer Fläche als Hinweistext. */
function areaNote(sizeM) {
  const f = m => (m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1).replace('.', ',')} km` : `${m >= 10 ? Math.round(m) : m.toFixed(1).replace('.', ',')} m`);
  return `Mitte der Fläche, etwa ${f(sizeM[1])} × ${f(sizeM[0])}`;
}

function withArea(r) {
  if (r.error) return r;
  return { lat: r.lat, lon: r.lon, note: areaNote(r.sizeM) };
}

/** Zone/Band + zwei Zahlen. */
export function parseUTM(text) {
  const s = normalize(text).toUpperCase();
  const m = /^(\d{1,2})\s*([C-HJ-NP-X])?\b\s*[,;]?\s*(.*)$/.exec(s);
  if (!m) return { error: 'Format nicht erkannt' };
  const zone = +m[1];
  const rest = m[3].replace(/\b[EN]\b|\b(?:OST|NORD|RW|HW)\b|[=:]/g, ' ');
  if (/[A-Z]/.test(rest)) return { error: 'Format nicht erkannt' };
  const nums = numbers(rest.replace(/(\d),(?=\d{4,}\b)/g, '$1 ').replace(/,(?!\d)/g, ' '));
  if (zone < 1 || zone > 60 || nums.length !== 2) return { error: 'Format nicht erkannt' };
  const [e, n] = nums;
  if (e < 100000 || e > 900000 || n < 0 || n > 10000000) return { error: 'Werte außerhalb des Zonenbereichs' };
  const band = m[2] || null;
  const hemi = band && band < 'N' ? 'S' : 'N';
  const p = fromUTM(zone, hemi, e, n);
  const r = { lat: p.lat, lon: p.lon };
  if (!band) r.note = 'Ohne Breitenband: Nordhalbkugel angenommen';
  else if (utmBand(p.lat) !== band) r.note = `Breitenband passt nicht (berechnet ${utmBand(p.lat) || '–'})`;
  if (p.lat < -80.5 || p.lat > 84.5) return { error: 'Außerhalb des UTM-Bereichs' };
  return r;
}

/** Zwei bezeichnete Zahlen: Rechts/Hochwert bzw. Ost/Nord, auch in vertauschter Reihenfolge. */
function parsePair(text, firstKeys, secondKeys) {
  const s = normalize(text).toUpperCase();
  const keyRe = new RegExp(`\\b(${firstKeys}|${secondKeys})\\b\\s*[=:]?\\s*([+-]?\\d[\\d']*(?:[.,]\\d+)?)`, 'g');
  const tagged = {};
  let m, n = 0;
  while ((m = keyRe.exec(s))) {
    const isFirst = new RegExp(`^(?:${firstKeys})$`).test(m[1]);
    tagged[isFirst ? 'a' : 'b'] = numbers(m[2])[0];
    n++;
  }
  if (n === 2 && tagged.a != null && tagged.b != null) return [tagged.a, tagged.b, true];
  if (n) return null;
  if (/[A-Z]/.test(s)) return null;
  const nums = numbers(s.replace(/(\d),(?=\d{5,}\b)/g, '$1 ').replace(/,(?!\d)/g, ' '));
  return nums.length === 2 ? [nums[0], nums[1], false] : null;
}

export function parseGK(text) {
  const pr = parsePair(text, 'R|RW|RECHTSWERT|Y', 'H|HW|HOCHWERT|X');
  if (!pr) return { error: 'Format nicht erkannt' };
  let [r, hw, tagged] = pr;
  if (!tagged && r > 5000000 && hw < 6000000 && hw > 1000000) [r, hw] = [hw, r];
  const strip = Math.floor(r / 1e6);
  if (strip < 1 || strip > 6 || hw < 5100000 || hw > 6300000) return { error: 'Format nicht erkannt' };
  const p = fromGK(r, hw);
  if (p.lat < DE_BOX.s - 1 || p.lat > DE_BOX.n + 1 || p.lon < DE_BOX.w - 2 || p.lon > DE_BOX.e + 2) {
    return { error: 'Außerhalb Deutschlands' };
  }
  return p;
}

export function parseLV95(text) {
  const pr = parsePair(text, 'E|Y|OST', 'N|X|NORD');
  if (!pr) return { error: 'Format nicht erkannt' };
  let [e, n, tagged] = pr;
  if (!tagged && e < n) [e, n] = [n, e];
  let note;
  if (e > 400000 && e < 900000 && n > 0 && n < 400000) {
    e += 2000000; n += 1000000;
    note = 'LV03 erkannt, als LV95 genähert (± 1–2 m)';
  }
  if (e < 2400000 || e > 2900000 || n < 1000000 || n > 1350000) return { error: 'Außerhalb der Schweiz' };
  const p = fromLV95(e, n);
  if (note) p.note = note;
  return p;
}

export function parseECEF(text) {
  const s = normalize(text).toUpperCase().replace(/\b[XYZ]\b\s*[=:]?/g, ' ').replace(/\bM\b/g, ' ');
  if (/[A-Z]/.test(s)) return { error: 'Format nicht erkannt' };
  const nums = numbers(s.replace(/(\d),(?=\d{4,}\b)/g, '$1 ').replace(/,(?!\d)/g, ' '));
  if (nums.length !== 3) return { error: 'Format nicht erkannt' };
  const p = fromECEF(...nums);
  if (p.h < -12000 || p.h > 100000) return { error: 'Kein Punkt nahe der Erdoberfläche' };
  const r = { lat: p.lat, lon: p.lon, h: p.h };
  if (Math.abs(p.h) >= 0.5) r.note = `Höhe über Ellipsoid ${Math.round(p.h).toLocaleString('de-DE')} m`;
  return r;
}

/* ===== Formatliste für die Oberfläche ===== */

export const FORMATS = [
  {
    id: 'dd', label: 'Dezimalgrad (WGS84)', example: '48.137154, 11.576124',
    parse: parseLatLon, format: fmtDD
  },
  {
    id: 'ddm', label: 'Grad, Dezimalminuten', example: 'N 48° 08.229′ E 011° 34.567′',
    parse: parseLatLon, format: fmtDDM
  },
  {
    id: 'dms', label: 'Grad, Minuten, Sekunden', example: '48° 8′ 13.75″ N, 11° 34′ 34.05″ E',
    parse: parseLatLon, format: fmtDMS
  },
  {
    id: 'utm', label: 'UTM (WGS84/ETRS89)', example: '32U 691650 5334754',
    parse: parseUTM,
    format: p => {
      const u = toUTM(p.lat, p.lon);
      return u && `${u.zone}${u.band} ${Math.round(u.e)} ${Math.round(u.n)}`;
    }
  },
  {
    id: 'mgrs', label: 'MGRS / UTMREF', example: '32U PU 91650 34754',
    parse: parseMGRS,
    format: p => {
      const m = toMGRS(p.lat, p.lon);
      return m && `${m.zone}${m.band} ${m.sq} ${m.e} ${m.n}`;
    }
  },
  {
    id: 'gk', label: 'Gauß-Krüger (DHDN)', example: 'R 4468560 H 5333323',
    hint: 'Bessel, 3°-Streifen · Datum über 7-Parameter-Helmert, Genauigkeit etwa ± 3 m',
    outside: 'außerhalb Deutschlands',
    parse: parseGK,
    format: p => {
      const g = toGK(p.lat, p.lon);
      return g && `R ${Math.round(g.r)} H ${Math.round(g.h)}`;
    }
  },
  {
    id: 'lv95', label: 'SwissGrid LV95', example: 'E 2600000 N 1200000',
    hint: 'CH1903+ · Datum über 3-Parameter-Verschiebung, Genauigkeit etwa ± 1 m',
    outside: 'außerhalb der Schweiz',
    parse: parseLV95,
    format: p => {
      const c = toLV95(p.lat, p.lon);
      return c && `E ${Math.round(c.e)} N ${Math.round(c.n)}`;
    }
  },
  {
    id: 'olc', label: 'Plus Code', example: '8FWH4HPG+F7Q',
    parse: t => withArea(olcDecode(t)),
    format: p => olcEncode(p.lat, p.lon, 11)
  },
  {
    id: 'geohash', label: 'Geohash', example: 'u281z7j5mc',
    parse: t => withArea(geohashDecode(t)),
    format: p => geohashEncode(p.lat, p.lon, 10)
  },
  {
    id: 'maidenhead', label: 'Maidenhead-Locator', example: 'JN58sd',
    parse: t => withArea(maidenheadDecode(t)),
    format: p => maidenheadEncode(p.lat, p.lon, 6)
  },
  {
    id: 'ecef', label: 'ECEF (WGS84), X Y Z in m', example: 'X 4177621.4 Y 855647.5 Z 4727107.5',
    parse: parseECEF,
    format: p => {
      const [x, y, z] = toECEF(p.lat, p.lon, p.h || 0);
      return `X ${x.toFixed(1)} Y ${y.toFixed(1)} Z ${z.toFixed(1)}`;
    }
  }
];

/** Text für die Zwischenablage: typografische Striche durch ASCII ersetzen. */
export function asciiCopy(text) {
  return text.replace(/′/g, "'").replace(/″/g, '"');
}
