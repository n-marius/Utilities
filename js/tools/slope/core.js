// Hangneigung: Rechenkern ohne DOM (Lage → Neigung/Exposition, Reduktionsmethode, Tageslicht).
//
// Lagequelle: W3C-DeviceOrientation (alpha/beta/gamma) statt accelerationIncludingGravity.
// Begründung:
//  - beta/gamma sind fusionierte, schwerkraftbezogene Lagewinkel (iOS: Core-Motion-Attitude,
//    Android: Rotationsvektor). Sie sind ruhiger als der rohe Beschleunigungsvektor, der jede
//    Handbewegung als Neigungsfehler zeigt, und driften in der Neigung nicht.
//  - Vorzeichen und Achsen sind plattformübergreifend festgelegt; bei accelerationIncludingGravity
//    weichen ältere iOS-Versionen im Vorzeichen ab, was die Richtung der Falllinie umdrehen würde.
//  - Die Exposition braucht ohnehin den Kompass aus demselben Ereignis (ein Bezugssystem).
// Ohne Orientation-Ereignisse dient accelerationIncludingGravity als Rückfall (nur Neigung).
//
// Geometrie: R = rotationMatrix(alpha, beta, gamma) bildet Gerät → ENU ab (sensors.js).
// Dritte Zeile von R = Lotrichtung „oben“ in Gerätekoordinaten. Neigung beim Auflegen =
// Winkel zwischen Geräte-z-Achse (Hangnormale) und Lot; Exposition = Azimut der horizontalen
// Komponente der Hangnormale (zeigt hangabwärts = Richtung der Falllinie).

import { wrap360, meanAngle, circStd, mean, std } from '../../lib/geo.js';
import { altAz } from '../astro/sun.js';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const clamp1 = v => Math.max(-1, Math.min(1, v));

/** Rotationsmatrix Gerät → ENU (identisch mit sensors.js, hier DOM-frei für Tests). */
export function rotMatrix(alpha, beta, gamma) {
  const a = (alpha || 0) * D2R, b = (beta || 0) * D2R, g = (gamma || 0) * D2R;
  const cA = Math.cos(a), sA = Math.sin(a), cB = Math.cos(b), sB = Math.sin(b), cG = Math.cos(g), sG = Math.sin(g);
  return [
    cA * cG - sA * sB * sG, -cB * sA, cG * sA * sB + cA * sG,
    cG * sA + cA * sB * sG,  cA * cB, sA * sG - cA * cG * sB,
    -cB * sG,                sB,      cB * cG
  ];
}

/** Einheitsvektor „oben“ in Gerätekoordinaten aus beta/gamma (unabhängig von alpha). */
export function upFromEuler(beta, gamma) {
  const b = beta * D2R, g = gamma * D2R;
  return [-Math.cos(b) * Math.sin(g), Math.sin(b), Math.cos(b) * Math.cos(g)];
}

/** „Oben“ aus accelerationIncludingGravity (W3C: in Ruhe zeigt der Vektor nach oben). */
export function upFromAccel(x, y, z) {
  const n = Math.hypot(x, y, z);
  if (!(n > 1)) return null;
  return [x / n, y / n, z / n];
}

/** Neigung der Geräteebene gegen die Horizontale (= Winkel z-Achse ↔ Lot), 0…90°. */
export function tiltDeg(up) {
  const n = Math.hypot(up[0], up[1], up[2]);
  return Math.acos(clamp1(Math.abs(up[2]) / n)) * R2D;
}

/** Erhebungswinkel der Geräte-Oberkante (y-Achse) gegen die Horizontale, −90…90°. */
export function edgePitchDeg(up) {
  const n = Math.hypot(up[0], up[1], up[2]);
  return Math.asin(clamp1(up[1] / n)) * R2D;
}

/**
 * Kompassrichtung der Falllinie (Exposition) in Grad, oder null bei fast ebener Lage.
 * alphaAbs: alpha bezogen auf (magnetisch) Nord. Display nach oben oder unten egal:
 * die Hangnormale wird stets nach oben gerichtet.
 */
export function fallLineAzimuth(alphaAbs, beta, gamma, minTilt = 2) {
  const R = rotMatrix(alphaAbs, beta, gamma);
  const s = R[8] >= 0 ? 1 : -1;
  const e = s * R[2], n = s * R[5];
  if (Math.hypot(e, n) < Math.sin(minTilt * D2R)) return null;
  return wrap360(Math.atan2(e, n) * R2D);
}

/**
 * alpha bezogen auf Nord aus dem Kurs der Geräte-Oberkante (sensors.js: heading).
 * Android (absolut): heading = 360 − alpha, also exakt. iOS: webkitCompassHeading
 * entspricht bei mäßiger Neigung dem Kurs der projizierten Oberkante.
 */
export const alphaFromHeading = heading => wrap360(360 - heading);

/** 16-teilige Himmelsrichtung (deutsch). */
export const WINDS16 = ['N', 'NNO', 'NO', 'ONO', 'O', 'OSO', 'SO', 'SSO', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const compass16 = az => WINDS16[Math.round(wrap360(az) / 22.5) % 16];

/**
 * Steilheitsklassen nach EAWS-Glossar „Hangneigung“ (avalanches.org):
 * mäßig steil < 30°, steil ≥ 30°, sehr steil ≥ 35°, extrem steil ≥ 40°;
 * gemessen in der Falllinie an der steilsten Stelle im Hang.
 */
export const CLASSES = [
  { k: 0, min: 0, label: 'mäßig steil' },
  { k: 1, min: 30, label: 'steil' },
  { k: 2, min: 35, label: 'sehr steil' },
  { k: 3, min: 40, label: 'extrem steil' }
];
export function steepClass(deg) {
  let c = CLASSES[0];
  for (const x of CLASSES) if (deg >= x.min) c = x;
  return c;
}

/** Mittelwert/Streuung einer Messreihe [{slope, aspect|null}]. */
export function summarize(samples) {
  if (!samples.length) return null;
  const sl = samples.map(s => s.slope);
  const az = samples.map(s => s.aspect).filter(a => a != null);
  return {
    n: samples.length,
    slope: mean(sl),
    sd: std(sl),
    aspect: az.length >= samples.length / 2 ? meanAngle(az) : null,
    aspectSd: az.length >= samples.length / 2 ? circStd(az) : null
  };
}

// ---------------------------------------------------------------------------
// Reduktionsmethode nach W. Munter (professionelle Variante).
// Geprüft gegen: SAC «Die Alpen» 2/1999 (Fig. 1, Berechnungsschema), J. Schweizer (SLF),
// bergundsteigen 4/06 (Gefahrenpotential 2:4:8:16), bergundsteigen 2022 (Nassschnee-Regel,
// Gruppenfaktoren), Uni Freiburg NuF (Rechenbeispiele, «regelmäßig befahren» = 2).

export const LEVELS = [
  { lvl: 1, name: 'gering', gp: 2, gpUp: 3 },
  { lvl: 2, name: 'mäßig', gp: 4, gpUp: 6 },
  { lvl: 3, name: 'erheblich', gp: 8, gpUp: 12 },
  { lvl: 4, name: 'groß', gp: 16, gpUp: null },
  { lvl: 5, name: 'sehr groß', gp: null, gpUp: null }
];

// Elementare Reduktionsmethode: Grenzwerte der steilsten Hangpartie (SLF 2006, SAC 1999).
export const ERM_LIMIT = { 2: 40, 3: 35, 4: 30 };

export const RF1 = [
  { id: 'none', f: 1, label: 'Keiner', sub: 'Steilste Hangpartie 40° oder steiler bzw. unbekannt' },
  { id: 'lt40', f: 2, label: 'Steilste Hangpartie 35–39°', sub: 'Verzicht auf extrem steile Hänge (≥ 40°)' },
  { id: 'lt35', f: 4, label: 'Steilste Hangpartie 30–34° oder flacher', sub: 'Verzicht auf Hänge ab 35°' }
];
const RF1_BOUND = { lt40: 40, lt35: 35 };
export const RF2 = [
  { id: 'none', f: 1, label: 'Keiner', sub: 'Alle Expositionen möglich' },
  { id: 'north', f: 2, label: 'Verzicht auf Sektor Nord', sub: 'Keine Hänge NW–N–NO' },
  { id: 'half', f: 3, label: 'Verzicht auf nördliche Hälfte', sub: 'Keine Hänge WNW–N–OSO' },
  { id: 'bulletin', f: 4, label: 'Verzicht auf kritische Lagen laut Lagebericht', sub: 'Im Lagebericht genannte Expositionen und Höhenlagen' }
];
export const RF_FREQUENT = { id: 'frequent', f: 2, label: 'Ständig befahrene Hänge' };
export const RF3 = [
  { id: 'none', f: 1, label: 'Keiner', sub: '' },
  { id: 'bigSpaced', f: 2, label: 'Große Gruppe mit Entlastungsabständen', sub: '' },
  { id: 'small', f: 2, label: 'Kleine Gruppe (2–4 Personen)', sub: '' },
  { id: 'smallSpaced', f: 3, label: 'Kleine Gruppe mit Entlastungsabständen', sub: '' }
];

const byId = (list, id) => list.find(o => o.id === id) || list[0];

/** Gefahrenpotential zur Stufe (upper: Zwischenwert zur nächsthöheren Stufe). */
export function dangerPotential(level, upper = false) {
  const L = LEVELS.find(l => l.lvl === level);
  if (!L || L.gp == null) return null;
  return upper && L.gpUp ? L.gpUp : L.gp;
}

/**
 * Restrisiko = Gefahrenpotential / Produkt der Reduktionsfaktoren.
 * Regeln: Restrisiko ≤ 1 akzeptiert; ab «erheblich» ist ein Faktor 1. Klasse Pflicht
 * (steilste Hangpartie unter 40°); optional: gewählter Steilheitsfaktor vs. steilste Messung; bei Nassschnee bzw. wenn der Lagebericht alle
 * Expositionen nennt, entfällt der Expositionsfaktor (2. Klasse).
 */
export function evaluate(st, steepest = null) {
  const level = st.level;
  if (level === 5) return { blocked: true, level };
  const gp = dangerPotential(level, st.upper);
  if (gp == null) return null;
  const r1 = byId(RF1, st.rf1), r2 = byId(RF2, st.rf2), r3 = byId(RF3, st.rf3);
  const aspectVoid = !!(st.wet || st.allAspects);
  const factors = [
    { cls: 1, f: r1.f, label: r1.label },
    { cls: 2, f: aspectVoid ? 1 : r2.f, label: r2.label, void: aspectVoid && r2.f > 1 },
    { cls: 2, f: st.frequent ? RF_FREQUENT.f : 1, label: RF_FREQUENT.label, on: !!st.frequent },
    { cls: 3, f: r3.f, label: r3.label }
  ];
  const prod = factors.reduce((p, x) => p * x.f, 1);
  const risk = gp / prod;
  const rules = [];
  rules.push({ id: 'limit', ok: risk <= 1 + 1e-9, text: 'Restrisiko höchstens 1' });
  if (level >= 3) rules.push({ id: 'rf1', ok: r1.f > 1, text: 'Ab Stufe 3 Pflicht: Faktor 1. Klasse (steilste Hangpartie unter 40°)' });
  // Gewählter Steilheitsfaktor darf der eigenen Messung nicht widersprechen
  const bound = RF1_BOUND[r1.id];
  if (bound && steepest != null && Number.isFinite(steepest)) {
    rules.push({ id: 'measured', ok: steepest < bound, text: `Steilheitsfaktor vereinbar mit steilster Messung (unter ${bound}°)` });
  }
  const accepted = rules.every(r => r.ok);
  return { level, gp, factors, prod, risk, rules, accepted, aspectVoid };
}

/** Vorschlag 1. Klasse aus der steilsten Messung (+ Messtoleranz, konservativ). */
export function suggestRF1(steepest, tol = 1) {
  if (steepest == null || !Number.isFinite(steepest)) return null;
  const s = steepest + tol;
  if (s < 35) return 'lt35';
  if (s < 40) return 'lt40';
  return 'none';
}

// Sektoren als Bereiche der 16-teiligen Rose (Grenzen jeweils halber Sektor = 11,25°).
const SECTOR = {
  north: [303.75, 56.25],  // NW, NNW, N, NNO, NO
  half: [281.25, 123.75]   // WNW … OSO
};
function inArc(az, [from, to], margin = 0) {
  const a = wrap360(az - from + margin);
  return a <= wrap360(to - from) + 2 * margin;
}
export const inSector = (az, id, margin = 0) => inArc(az, SECTOR[id], margin);

/**
 * Vorschlag 2. Klasse aus gemessenen Expositionen: größter Faktor, für den keine
 * Messung (inkl. Toleranz) im gemiedenen Sektor liegt.
 */
export function suggestRF2(aspects, margin = 5) {
  const list = aspects.filter(a => a != null && Number.isFinite(a));
  if (!list.length) return null;
  if (list.every(a => !inSector(a, 'half', margin))) return 'half';
  if (list.every(a => !inSector(a, 'north', margin))) return 'north';
  return 'none';
}

// ---------------------------------------------------------------------------
// Tageslicht (geometrische Sonnenhöhe aus astro/sun.js, ebener Horizont).

export const H_SUNSET = -0.833;  // Refraktion 34′ + Sonnenhalbmesser 16′
export const H_CIVIL = -6;

/** Nächster Durchgang der Sonnenhöhe durch h (dir −1 fallend, +1 steigend) ab t0, innerhalb span. */
export function nextCrossing(lat, lon, t0, h, dir, span = 36 * 3600e3, step = 10 * 60e3) {
  const f = t => altAz(lat, lon, t).alt - h;
  let ta = t0, fa = f(ta);
  for (let tb = t0 + step; tb <= t0 + span; tb += step) {
    const fb = f(tb);
    if ((dir < 0 && fa > 0 && fb <= 0) || (dir > 0 && fa < 0 && fb >= 0)) {
      let a = ta, b = tb, va = fa;
      for (let i = 0; i < 30 && b - a > 1000; i++) {
        const m = (a + b) / 2, vm = f(m);
        if ((vm > 0) === (va > 0)) { a = m; va = vm; } else b = m;
      }
      return (a + b) / 2;
    }
    ta = tb; fa = fb;
  }
  return null;
}

/** Sonnenstand jetzt und die nächsten Ereignisse (UTC-ms). */
export function daylight(lat, lon, now = Date.now()) {
  const alt = altAz(lat, lon, now).alt;
  return {
    alt,
    sunset: nextCrossing(lat, lon, now, H_SUNSET, -1),
    duskEnd: nextCrossing(lat, lon, now, H_CIVIL, -1),
    sunrise: nextCrossing(lat, lon, now, H_SUNSET, +1)
  };
}
