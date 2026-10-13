// Rechenkern der Inertialnavigation (ohne DOM, in Node testbar).
//
// Kursbezug nach dem Start: ausschließlich das relative 'deviceorientation'-Ereignis.
// iOS: alpha ist relativ (Nullrichtung beliebig, gyro-gestützt). Android/Chrome: das
// relative Ereignis stammt aus dem „Game Rotation Vector“ (Gyro + Beschleunigung, ohne
// Magnetometer). Gewählt statt eigener Integration von rotationRate, weil die
// Sensorfusion des Betriebssystems Gyro-Bias und Lage laufend schätzt und damit robuster
// ist als eine Integration im Browser (Ereignisraten schwanken, Bias unbekannt).
// Ein konstanter Versatz c zwischen relativem alpha und Nord wird beim Start aus dem
// bekannten Startkurs bestimmt: R(alpha + c, beta, gamma) ist dann Gerät -> ENU (rechtweisend).

import { rotationMatrix } from '../../lib/sensors.js';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
export const wrap360 = a => ((a % 360) + 360) % 360;
export const wrap180 = a => { a = wrap360(a); return a > 180 ? a - 360 : a; };

/** Annahmen der Fehlerschätzung (keine Messwerte). */
export const ASSUME = {
  stepScale: 0.03,      // Schrittlängenfehler: 3 % der Strecke
  headingErr0: 5,       // Startkursfehler (Grad), falls keine Angabe
  gyroDrift: 0.5,       // Kursdrift (Grad/min)
  accelBias: 0.02       // Restfehler Beschleunigung b (m/s²) für Strapdown: 0,5·b·t²
};

/**
 * Kurs der Bewegungsrichtung aus Rotationsmatrix (Gerät -> ENU, zeilenweise).
 * Geräte-Oberkante (y-Achse) horizontal projiziert; je steiler das Gerät steht,
 * desto stärker wird die Rückseite (-z, Kamerarichtung) beigemischt (Gewicht = y_up²).
 * So liefert Neigen um die Querachse keinen falschen Kurs, und senkrechte Haltung
 * (Oberkante nach oben) bleibt definiert. Gibt Grad (0 = Nord) oder null.
 */
export function forwardHeading(R) {
  const yU = R[7];
  const w = yU * yU;
  const E = R[1] - w * R[2];
  const N = R[4] - w * R[5];
  if (Math.hypot(E, N) < 1e-3) return null;
  return wrap360(Math.atan2(E, N) * R2D);
}

/** Kurs aus Eulerwinkeln mit Versatz c auf alpha. */
export function headingFromEuler(alpha, beta, gamma, c = 0) {
  return forwardHeading(rotationMatrix(alpha + c, beta, gamma));
}

/**
 * Versatz c für alpha, sodass headingFromEuler(alpha, beta, gamma, c) = trueHeading
 * zum Startzeitpunkt. Drehung um die Hochachse: Kurs(alpha + c) = Kurs(alpha) − c.
 */
export function alphaOffset(alpha, beta, gamma, trueHeading) {
  const h0 = headingFromEuler(alpha, beta, gamma, 0);
  if (h0 == null) return null;
  return wrap180(h0 - trueHeading);
}

/** Vektor (Gerät) mit Matrix R nach ENU drehen. */
export function toENU(R, x, y, z) {
  return [
    R[0] * x + R[1] * y + R[2] * z,
    R[3] * x + R[4] * y + R[5] * z,
    R[6] * x + R[7] * y + R[8] * z
  ];
}

/**
 * Schritterkennung aus dem Betrag der Beschleunigung.
 * Gleitende Basislinie (Schwerkraft/Offset) abziehen, Tiefpass (~2,7 Hz),
 * Schritt = lokales Maximum über adaptiver Schwelle, nach Durchgang unter 0,
 * Mindestabstand 0,3 s.
 */
export class StepDetector {
  constructor({ minInterval = 0.3, minThr = 0.6, thrFactor = 0.4 } = {}) {
    this.minInterval = minInterval;
    this.minThr = minThr;
    this.thrFactor = thrFactor;
    this.reset();
  }
  reset() {
    this.t = null; this.base = null; this.y = 0; this.y1 = 0; this.y2 = 0;
    this.armed = true; this.lastStep = -Infinity; this.peakAvg = 2.2; this.count = 0;
  }
  get threshold() { return Math.max(this.minThr, this.thrFactor * this.peakAvg); }
  /** t in s, mag in m/s². Gibt true zurück, wenn ein Schritt erkannt wurde. */
  push(t, mag) {
    if (!Number.isFinite(mag)) return false;
    if (this.t == null) { this.t = t; this.base = mag; return false; }
    const dt = Math.min(0.2, Math.max(0.001, t - this.t));
    this.t = t;
    this.base += (mag - this.base) * (dt / (1.5 + dt));      // Basislinie, tau 1,5 s
    const x = mag - this.base;
    this.y2 = this.y1; this.y1 = this.y;
    this.y += (x - this.y) * (dt / (0.06 + dt));             // Tiefpass, tau 60 ms
    if (this.y < 0) this.armed = true;
    // lokales Maximum bei y1
    if (this.armed && this.y1 > this.y2 && this.y1 >= this.y && this.y1 > this.threshold && t - this.lastStep >= this.minInterval) {
      this.peakAvg += (Math.min(this.y1, 8) - this.peakAvg) * 0.2;
      this.lastStep = t;
      this.armed = false;
      this.count++;
      return true;
    }
    return false;
  }
}

/**
 * Strapdown-Integration (horizontal): Beschleunigung in ENU zweifach integrieren.
 * Optional ZUPT: Ist die Linearbeschleunigung über 0,5 s nahezu konstant null,
 * wird die Geschwindigkeit auf 0 gesetzt (Stillstand).
 */
export class Strapdown {
  constructor({ zupt = true, win = 0.5, stdMax = 0.08, meanMax = 0.15 } = {}) {
    Object.assign(this, { zupt, win, stdMax, meanMax });
    this.reset();
  }
  reset() {
    this.vE = 0; this.vN = 0; this.pE = 0; this.pN = 0; this.dist = 0;
    this.buf = []; this.still = false;
  }
  /** aE, aN in m/s² (ENU), aMag = Betrag Linearbeschleunigung (Gerät), t und dt in s. */
  push(t, dt, aE, aN, aMag) {
    // Trapezregel für die Position
    const vE0 = this.vE, vN0 = this.vN;
    this.vE += aE * dt;
    this.vN += aN * dt;
    if (this.zupt) {
      this.buf.push([t, aMag]);
      while (this.buf.length && t - this.buf[0][0] > this.win) this.buf.shift();
      this.still = false;
      if (this.buf.length >= 8 && t - this.buf[0][0] > this.win * 0.8) {
        let s = 0, s2 = 0;
        for (const [, m] of this.buf) { s += m; s2 += m * m; }
        const n = this.buf.length, mean = s / n, sd = Math.sqrt(Math.max(0, s2 / n - mean * mean));
        if (sd < this.stdMax && mean < this.meanMax) { this.still = true; this.vE = 0; this.vN = 0; }
      }
    }
    const dE = (vE0 + this.vE) / 2 * dt, dN = (vN0 + this.vN) / 2 * dt;
    this.pE += dE; this.pN += dN;
    this.dist += Math.hypot(dE, dN);
  }
  get speed() { return Math.hypot(this.vE, this.vN); }
}

/**
 * Bias der Linearbeschleunigung (Geräteachsen, m/s²): beim Start aus einer
 * Ruhephase gemittelt und danach in erkannten Stillständen (ZUPT) langsam nachgeführt.
 * MEMS-Beschleunigungsmesser haben Offsets von einigen 0,01 m/s²; unkorrigiert
 * erzeugen sie nach 60 s bereits Dezimeter bis Meter Positionsfehler (0,5·b·t²).
 */
export class AccelBias {
  constructor() { this.reset(); }
  reset() { this.n = 0; this.sx = 0; this.sy = 0; this.sz = 0; this.s2 = 0; this.b = [0, 0, 0]; }
  /** Kalibrierprobe aufnehmen. */
  add(x, y, z) {
    this.n++; this.sx += x; this.sy += y; this.sz += z; this.s2 += x * x + y * y + z * z;
    this.b = [this.sx / this.n, this.sy / this.n, this.sz / this.n];
  }
  get mean() { return this.b; }
  /** Streuung (m/s², RMS-Abstand vom Mittelwert) der Kalibrierproben. */
  get spread() {
    if (!this.n) return Infinity;
    const [x, y, z] = this.b;
    return Math.sqrt(Math.max(0, this.s2 / this.n - (x * x + y * y + z * z)));
  }
  get magnitude() { return Math.hypot(...this.b); }
  /** Bias abziehen. */
  correct(x, y, z) { return [x - this.b[0], y - this.b[1], z - this.b[2]]; }
  /** Im Stillstand nachführen (Zeitkonstante tau in s). Rohwerte übergeben. */
  adapt(x, y, z, dt, tau = 4) {
    const k = dt / (tau + dt);
    this.b = [this.b[0] + (x - this.b[0]) * k, this.b[1] + (y - this.b[1]) * k, this.b[2] + (z - this.b[2]) * k];
  }
}

/**
 * Fehlerradius (m), grobe Schätzung.
 * Schritte:   e0 + 3 %·s + s·sin(ψ0 + Drift·t)
 * Strapdown:  e0 + 0,5·b·t² + s·sin(ψ0 + Drift·t)
 * e0 Startunsicherheit (m), s Strecke (m), t Laufzeit (s), ψ0 Startkursfehler (Grad).
 */
export function errorRadius({ method, e0 = 0, dist = 0, t = 0, psi0 = ASSUME.headingErr0 }) {
  const psi = Math.min(90, psi0 + ASSUME.gyroDrift * t / 60);
  const head = dist * Math.sin(psi * D2R);
  const own = method === 'strapdown' ? 0.5 * ASSUME.accelBias * t * t : ASSUME.stepScale * dist;
  return e0 + own + head;
}

/**
 * Koordinaten tolerant lesen: "48,137 11,575", "48.137, 11.575", "48,137N 11,575E".
 * Gibt [lat, lon] oder null.
 */
export function parseLatLon(str) {
  if (!str) return null;
  const re = /([-+−]?\d+(?:[.,]\d+)?)\s*°?\s*([NSOEW])?/gi;
  const out = [];
  let m;
  while ((m = re.exec(str)) && out.length < 2) {
    let v = parseFloat(m[1].replace('−', '-').replace(',', '.'));
    if (m[2] && /[SW]/i.test(m[2])) v = -Math.abs(v);
    out.push(v);
  }
  if (out.length !== 2) return null;
  const [lat, lon] = out;
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return null;
  return [lat, lon];
}

/** Gradzahl mit Komma oder Punkt lesen (0–360). */
export function parseDeg(str) {
  const v = parseFloat(String(str || '').trim().replace('−', '-').replace(',', '.'));
  return Number.isFinite(v) ? wrap360(v) : null;
}
