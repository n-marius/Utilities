// Geodätische Grundfunktionen (Kugel, R = 6 371 008,8 m), Winkel in Grad, Strecken in m.

export const R_EARTH = 6371008.8;
export const D2R = Math.PI / 180;
export const R2D = 180 / Math.PI;

export const wrap360 = a => ((a % 360) + 360) % 360;
export const wrap180 = a => { a = wrap360(a); return a > 180 ? a - 360 : a; };

/** Großkreisdistanz in m. */
export function distance(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * D2R, p2 = lat2 * D2R, dp = p2 - p1, dl = (lon2 - lon1) * D2R;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Anfangskurs von 1 nach 2 in Grad (0 = Nord). */
export function bearing(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * D2R, p2 = lat2 * D2R, dl = (lon2 - lon1) * D2R;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return wrap360(Math.atan2(y, x) * R2D);
}

/** Zielpunkt bei Kurs (Grad) und Distanz (m). Gibt [lat, lon]. */
export function destination(lat, lon, brg, dist) {
  const d = dist / R_EARTH, t = brg * D2R, p1 = lat * D2R, l1 = lon * D2R;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t));
  const l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [p2 * R2D, wrap180(l2 * R2D)];
}

/** Lokale Verschiebung um Ost/Nord-Meter (für kurze Strecken). Gibt [lat, lon]. */
export function offsetEN(lat, lon, east, north) {
  const dLat = north / R_EARTH * R2D;
  const dLon = east / (R_EARTH * Math.cos(lat * D2R)) * R2D;
  return [lat + dLat, wrap180(lon + dLon)];
}

/** Mittelwert von Winkeln (Grad), korrekt über 0/360. */
export function meanAngle(list) {
  let s = 0, c = 0;
  for (const a of list) { s += Math.sin(a * D2R); c += Math.cos(a * D2R); }
  return wrap360(Math.atan2(s, c) * R2D);
}

/** Zirkuläre Standardabweichung (Grad). */
export function circStd(list) {
  if (!list.length) return NaN;
  let s = 0, c = 0;
  for (const a of list) { s += Math.sin(a * D2R); c += Math.cos(a * D2R); }
  const r = Math.min(1, Math.hypot(s, c) / list.length);
  return Math.sqrt(-2 * Math.log(Math.max(r, 1e-12))) * R2D;
}

export function mean(list) { return list.reduce((a, b) => a + b, 0) / list.length; }
export function std(list) {
  if (list.length < 2) return 0;
  const m = mean(list);
  return Math.sqrt(list.reduce((a, b) => a + (b - m) ** 2, 0) / (list.length - 1));
}
