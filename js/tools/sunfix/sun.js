// Sonnenephemeride nach NOAA/Meeus (niedrige Genauigkeit, ca. 0,01°), ohne DOM.
// Winkel in Grad, Zeiten als UTC-Millisekunden (Date oder Zahl).

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const wrap360 = a => ((a % 360) + 360) % 360;
const wrap180 = a => { a = wrap360(a); return a > 180 ? a - 360 : a; };

// ΔT = TT − UT (s), für 2020–2030 ausreichend genau; Einfluss auf die Sonne < 0,001°.
export const DELTA_T = 69.2;

export const julianDay = ms => ms / 86400000 + 2440587.5;

/** Sonnenkoordinaten zu einer Ephemeridenzeit (JDE, TT): {lambda, ra, dec, eps, omega} */
export function sunEquatorial(jde) {
  const T = (jde - 2451545) / 36525;
  const L0 = wrap360(280.46646 + T * (36000.76983 + T * 0.0003032));
  const M = (357.52911 + T * (35999.05029 - 0.0001537 * T)) * D2R;
  const C = Math.sin(M) * (1.914602 - T * (0.004817 + 0.000014 * T))
    + Math.sin(2 * M) * (0.019993 - 0.000101 * T)
    + Math.sin(3 * M) * 0.000289;
  const omega = 125.04 - 1934.136 * T;
  const lambda = L0 + C - 0.00569 - 0.00478 * Math.sin(omega * D2R); // scheinbare Länge
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * D2R);
  const l = lambda * D2R, e = eps * D2R;
  const dec = Math.asin(Math.sin(e) * Math.sin(l)) * R2D;
  const ra = wrap360(Math.atan2(Math.cos(e) * Math.sin(l), Math.cos(l)) * R2D);
  return { lambda: wrap360(lambda), ra, dec, eps, omega };
}

/** Mittlere Sternzeit Greenwich (Grad) zu UT-Julianischem Datum (Meeus 12.4). */
export function gmst(jd) {
  const t = jd - 2451545, T = t / 36525;
  return wrap360(280.46061837 + 360.98564736629 * t + T * T * (0.000387933 - T / 38710000));
}

/**
 * Bildpunkt der Sonne: {dec, gha, lat, lon}.
 * gha: Greenwicher Stundenwinkel (0–360, westwärts), lat/lon: Fußpunkt (Ost positiv).
 */
export function sunGP(date) {
  const ms = +date;
  const jd = julianDay(ms);
  const s = sunEquatorial(jd + DELTA_T / 86400);
  // scheinbare Sternzeit: Nutation in Länge ≈ −0,00478°·sin Ω (wie in lambda)
  const gast = gmst(jd) + (-0.00478 * Math.sin(s.omega * D2R)) * Math.cos(s.eps * D2R);
  const gha = wrap360(gast - s.ra);
  return { dec: s.dec, gha, lat: s.dec, lon: wrap180(-gha) };
}

/** Höhe/Azimut aus Breite, Deklination und Ortsstundenwinkel (geometrisch). Azimut ab Nord über Ost. */
export function altAzFromLHA(lat, dec, lha) {
  const p = lat * D2R, d = dec * D2R, t = lha * D2R;
  const sp = Math.sin(p), cp = Math.cos(p), sd = Math.sin(d), cd = Math.cos(d);
  const sh = sp * sd + cp * cd * Math.cos(t);
  const alt = Math.asin(Math.max(-1, Math.min(1, sh))) * R2D;
  const az = wrap360(Math.atan2(-cd * Math.sin(t), sd * cp - cd * sp * Math.cos(t)) * R2D);
  return { alt, az };
}

/** Geometrische Höhe und Azimut der Sonne am Ort zur Zeit. */
export function altAz(lat, lon, date) {
  const gp = sunGP(date);
  return altAzFromLHA(lat, gp.dec, gp.gha + lon);
}

/** Refraktion (Grad) für eine scheinbare Höhe, Bennett (1982); Normalatmosphäre. */
export function refractionApparent(hApp) {
  if (hApp < -1.5) return 0;
  return 1 / Math.tan((hApp + 7.31 / (hApp + 4.4)) * D2R) / 60;
}

/** Refraktion (Grad) für eine wahre Höhe, Sæmundsson (1986). */
export function refractionTrue(hTrue) {
  if (hTrue < -1.9) return 0;
  return 1.02 / Math.tan((hTrue + 10.3 / (hTrue + 5.11)) * D2R) / 60;
}

export const apparentToTrue = h => h - refractionApparent(h);
export const trueToApparent = h => h + refractionTrue(h);

/** Scheinbare Höhe und Azimut (mit Refraktion). */
export function apparentAltAz(lat, lon, date) {
  const r = altAz(lat, lon, date);
  return { alt: trueToApparent(r.alt), az: r.az };
}
