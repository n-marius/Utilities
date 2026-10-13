// Sterne und Planeten: Ort zum Datum (mittleres Äquinoktium des Datums), ohne DOM.
//
// Sterne: J2000-Katalogort + Eigenbewegung (linear, vektoriell) + Präzession IAU 1976 (Lieske).
// Nicht berücksichtigt: Nutation (≤ 17″ in Länge, 9″ in Schiefe) und jährliche Aberration (≤ 20,5″),
// zusammen ≤ ~0,01°, also weit unter der Messgenauigkeit (±0,5° und mehr). Stundenwinkel daher
// konsistent mit mittlerer Sternzeit (GMST) gebildet.
// Planeten: Keplerbahnen nach Standish/JPL "Approximate Positions of the Major Planets", Tabelle 1
// (gültig 1800–2050; heliozentrische Fehler ≲ 40″ bei Venus/Mars, ≲ 10′ bei Jupiter/Saturn),
// geozentrisch gegen das Erde-Mond-Baryzentrum (Abweichung zur Erde ≤ ~25″ bei Venus), mit Lichtlaufzeit.

import { julianDay, gmst, DELTA_T } from './sun.js';
import { STARS } from './catalog.js';

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const AS2R = D2R / 3600;
const wrap360 = a => ((a % 360) + 360) % 360;
const EPS0 = 23.43928 * D2R; // Schiefe der Ekliptik J2000

const vec = (ra, dec) => [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
const radec = v => ({ ra: wrap360(Math.atan2(v[1], v[0]) * R2D), dec: Math.atan2(v[2], Math.hypot(v[0], v[1])) * R2D });

/** Präzessionsmatrix J2000 -> mittleres Äquinoktium des Datums (T in julian. Jahrhunderten TT). */
export function precessionMatrix(T) {
  const zeta = (2306.2181 * T + 0.30188 * T * T + 0.017998 * T ** 3) * AS2R;
  const z = (2306.2181 * T + 1.09468 * T * T + 0.018203 * T ** 3) * AS2R;
  const th = (2004.3109 * T - 0.42665 * T * T - 0.041833 * T ** 3) * AS2R;
  const cz = Math.cos(zeta), sz = Math.sin(zeta), cZ = Math.cos(z), sZ = Math.sin(z), ct = Math.cos(th), st = Math.sin(th);
  return [
    [cz * ct * cZ - sz * sZ, -sz * ct * cZ - cz * sZ, -st * cZ],
    [cz * ct * sZ + sz * cZ, -sz * ct * sZ + cz * cZ, -st * sZ],
    [cz * st, -sz * st, ct]
  ];
}
const mul = (M, v) => [0, 1, 2].map(i => M[i][0] * v[0] + M[i][1] * v[1] + M[i][2] * v[2]);

const tCent = ms => (julianDay(ms) + DELTA_T / 86400 - 2451545) / 36525;

/** J2000-Richtung (RA/Dec Grad) auf das Datum präzedieren. */
export function precess(ra, dec, ms) {
  return radec(mul(precessionMatrix(tCent(ms)), vec(ra * D2R, dec * D2R)));
}

/** Sternort zum Datum (mittleres Äquinoktium): {ra, dec}. */
export function starPlace(star, ms) {
  const T = tCent(ms);
  const years = T * 100;
  const a = star.ra * D2R, d = star.dec * D2R;
  const p = vec(a, d);
  // Einheitsvektoren in Richtung wachsender RA bzw. Dec
  const eA = [-Math.sin(a), Math.cos(a), 0];
  const eD = [-Math.sin(d) * Math.cos(a), -Math.sin(d) * Math.sin(a), Math.cos(d)];
  const ma = (star.pmra || 0) / 1000 * AS2R * years, md = (star.pmdec || 0) / 1000 * AS2R * years;
  const q = [0, 1, 2].map(i => p[i] + eA[i] * ma + eD[i] * md);
  return radec(mul(precessionMatrix(T), q));
}

// ---------- Planeten ----------

// a [AE], e, I [°], L [°], ϖ [°], Ω [°] und Raten je julian. Jahrhundert (JPL, Tabelle 1)
const EL = {
  mercury: [[0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593],
    [0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081]],
  venus: [[0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255],
    [0.00000390, -0.00004107, -0.00078890, 58517.81538729, 0.00268329, -0.27769418]],
  earth: [[1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0],
    [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0]],
  mars: [[1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891],
    [0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343]],
  jupiter: [[5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909],
    [-0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106]],
  saturn: [[9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448],
    [-0.00125060, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794]]
};

/** Heliozentrische äquatoriale J2000-Koordinaten (AE). */
export function helio(key, T) {
  const [e0, r] = EL[key];
  const a = e0[0] + r[0] * T, e = e0[1] + r[1] * T, I = (e0[2] + r[2] * T) * D2R;
  const L = e0[3] + r[3] * T, wb = e0[4] + r[4] * T, Om = e0[5] + r[5] * T;
  let M = wrap360(L - wb); if (M > 180) M -= 360;
  const w = (wb - Om) * D2R, O = Om * D2R;
  const Mr = M * D2R;
  let E = Mr + e * Math.sin(Mr);
  for (let k = 0; k < 8; k++) E -= (E - e * Math.sin(E) - Mr) / (1 - e * Math.cos(E));
  const xp = a * (Math.cos(E) - e), yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const cw = Math.cos(w), sw = Math.sin(w), cO = Math.cos(O), sO = Math.sin(O), cI = Math.cos(I), sI = Math.sin(I);
  const x = (cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp;
  const y = (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp;
  const z = (sw * sI) * xp + (cw * sI) * yp;
  return [x, Math.cos(EPS0) * y - Math.sin(EPS0) * z, Math.sin(EPS0) * y + Math.cos(EPS0) * z];
}

/** Geozentrischer Planetenort J2000 (astrometrisch, mit Lichtlaufzeit): {ra, dec, dist}. */
export function planetJ2000(key, ms) {
  const T = tCent(ms);
  const E = helio('earth', T);
  let P = helio(key, T), g;
  for (let k = 0; k < 2; k++) {
    g = [P[0] - E[0], P[1] - E[1], P[2] - E[2]];
    const tau = Math.hypot(...g) * 0.0057755183; // Tage
    P = helio(key, T - tau / 36525);
  }
  g = [P[0] - E[0], P[1] - E[1], P[2] - E[2]];
  return { ...radec(g), dist: Math.hypot(...g) };
}

/** Planetenort zum Datum (mittleres Äquinoktium). */
export function planetPlace(key, ms) {
  const p = planetJ2000(key, ms);
  return { ...precess(p.ra, p.dec, ms), dist: p.dist };
}

// ---------- Stundenwinkel ----------

const starCache = new Map();

/** Bildpunkt (dec, Greenwicher Stundenwinkel) eines Sterns (Schlüssel aus STARS) oder Planeten. */
export function starGP(key, ms) {
  // Sternort ändert sich pro Tag um < 0,2″: Zwischenspeicher je Tag
  const day = Math.floor(ms / 86400000);
  const ck = key + ':' + day;
  let pl = starCache.get(ck);
  if (!pl) {
    pl = starPlace(STARS[key], ms);
    if (starCache.size > 500) starCache.clear();
    starCache.set(ck, pl);
  }
  return { dec: pl.dec, gha: wrap360(gmst(julianDay(ms)) - pl.ra) };
}

export function planetGP(key, ms) {
  const pl = planetPlace(key, ms);
  return { dec: pl.dec, gha: wrap360(gmst(julianDay(ms)) - pl.ra) };
}
