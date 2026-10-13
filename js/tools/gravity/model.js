// Schweremodell an der Erdoberfläche und Auswertung der Beschleunigungsmessung (DOM-frei).
//
// g(φ, λ, H) = γ(φ, H) + Δg(φ, λ)
//  - γ(φ, 0): Normalschwere WGS84 nach Somigliana (geodätische Breite φ).
//  - γ(φ, H): Freiluftreduktion 2. Ordnung (Hofmann-Wellenhof/Moritz, Physical Geodesy, Gl. 2-215):
//      γ_H = γ [1 − 2/a (1 + f + m − 2 f sin²φ) H + 3 H²/a²]   (≈ −0,3086 mGal/m)
//    H ist als Höhe über dem Meeresspiegel (Normalhöhe) gemeint. Wird stattdessen die ellipsoidische
//    GPS-Höhe eingesetzt, entsteht ein Fehler von 0,3086 mGal je Meter Geoidhöhe (|N| < ~110 m).
//  - Δg: Freiluftanomalie aus EGM2008 (Pavlis et al. 2012, NGA; Koeffizienten über ICGEM/GFZ),
//    selbst synthetisiert bis Grad/Ordnung 360 auf dem Ellipsoid (sphärische Näherung,
//    Δg = GM/r² Σ (n−1)(a/r)ⁿ Σ (δC̄nm cos mλ + S̄nm sin mλ) P̄nm(sin ψ), Normalfeld WGS84 abgezogen).
//    Gitter 0,5° (361 × 720 Knoten, Zeilen 90°N → 90°S, Spalten 180°W → 179,5°O), Int16 LE in 0,1 mGal,
//    data/gravity-anomaly.bin. Kontrolle: Höhenanomalie aus derselben Synthese (EGM96) trifft die
//    NGA-Prüfwerte bis auf den bekannten Nullgradterm (−0,53 m). Global: Mittel 0, RMS 30,8 mGal,
//    min −345, max +559 mGal. Auflösung ≈ 55 km; kleinräumige Anomalien (Gebirge, Lagerstätten) fehlen.
//    EGM2008 ist von der NGA zur uneingeschränkten Weitergabe freigegeben (Public Release).
//
// Kalibrierung: multiplikativ k = g_modell(Kalibrierort) / |a|_kal, Messung g = k · |a|.
// Additive Alternative (hier nicht verwendet): b = g_modell − |a|_kal, g = |a| + b. Beide stimmen bei
// k ≈ 1 bis auf (k − 1)·Δ überein; ein reiner Nullpunktfehler wäre additiv, ein Skalenfehler multiplikativ.

export const WGS84 = {
  a: 6378137, f: 1 / 298.257223563, gm: 3.986004418e14, omega: 7.292115e-5,
  gammaE: 9.7803253359, gammaP: 9.8321849378, k: 0.00193185265241, e2: 0.00669437999013,
  m: 0.00344978650684
};
export const G0 = 9.80665;           // Normwert 1 g (iOS skaliert Core-Motion-Werte damit)
export const MGAL = 1e-5;            // 1 mGal in m/s²

const D = Math.PI / 180;

/** Normalschwere auf dem Ellipsoid (m/s²), Somigliana. */
export function normalGravity(lat) {
  const s2 = Math.sin(lat * D) ** 2;
  return WGS84.gammaE * (1 + WGS84.k * s2) / Math.sqrt(1 - WGS84.e2 * s2);
}

/** Normalschwere in der Höhe H (m) über dem Ellipsoid/Meeresspiegel, 2. Ordnung. */
export function normalGravityH(lat, H = 0) {
  const { a, f, m } = WGS84;
  const s2 = Math.sin(lat * D) ** 2;
  return normalGravity(lat) * (1 - 2 / a * (1 + f + m - 2 * f * s2) * H + 3 * H * H / (a * a));
}

// ---------- Anomaliegitter ----------
export const GRID = { nlat: 361, nlon: 720, step: 0.5, scale: 0.1 }; // Werte in 0,1 mGal

/** Gitter aus ArrayBuffer (Int16 LE). Liefert {data: Float32Array (mGal), at(lat, lon)} */
export function anomalyGrid(buffer) {
  const n = GRID.nlat * GRID.nlon;
  if (buffer.byteLength !== n * 2) throw new Error('Anomaliegitter: falsche Größe');
  const dv = new DataView(buffer);
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) data[i] = dv.getInt16(i * 2, true) * GRID.scale;
  return {
    data,
    /** Freiluftanomalie in mGal, bilinear. */
    at(lat, lon) {
      const fi = Math.min(GRID.nlat - 1, Math.max(0, (90 - lat) / GRID.step));
      let fj = ((lon + 180) / GRID.step) % GRID.nlon;
      if (fj < 0) fj += GRID.nlon;
      const i0 = Math.min(GRID.nlat - 2, Math.floor(fi)), j0 = Math.floor(fj) % GRID.nlon, j1 = (j0 + 1) % GRID.nlon;
      const u = fi - i0, v = fj - Math.floor(fj);
      const r0 = i0 * GRID.nlon, r1 = r0 + GRID.nlon;
      return (1 - u) * ((1 - v) * data[r0 + j0] + v * data[r0 + j1]) + u * ((1 - v) * data[r1 + j0] + v * data[r1 + j1]);
    }
  };
}

/** Modellschwere mit Einzelanteilen (m/s²). grid darf null sein (dann ohne Anomalie). */
export function modelGravity(lat, lon, H, grid) {
  const gamma0 = normalGravity(lat);
  const gammaH = normalGravityH(lat, H);
  const anomaly = grid ? grid.at(lat, lon) * MGAL : 0;
  return { gamma0, height: gammaH - gamma0, anomaly, g: gammaH + anomaly };
}

/** Geodätische Breiten (≥ 0) mit γ(φ, H) = g, ohne Anomalie. null, wenn außerhalb Äquator…Pol. */
export function latitudeForGamma(g, H = 0) {
  let lo = 0, hi = 90;
  const f = x => normalGravityH(x, H) - g;
  if (f(lo) > 0 || f(hi) < 0) return null;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 0) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

// ---------- Isolinien ----------
const wrap180 = x => ((x + 180) % 360 + 360) % 360 - 180;

/**
 * Isolinien g(φ, λ, H) = level über das ganze Gitter (Marching Squares, Sattel per Zellmittel).
 * Ohne Gitter: Breitenkreise ±φ der Normalschwere. Rückgabe: Array von Linienzügen [[lat, lon], …],
 * Längen innerhalb eines Zuges stetig fortgesetzt (können ±180° überschreiten).
 */
export function isolines(level, H, grid) {
  if (!grid) {
    const phi = latitudeForGamma(level, H);
    if (phi == null) return [];
    const ring = lat => Array.from({ length: 73 }, (_, k) => [lat, -180 + k * 5]);
    return phi < 1e-9 ? [ring(0)] : [ring(phi), ring(-phi)];
  }
  const { nlat, nlon, step } = GRID;
  const gam = new Float64Array(nlat);
  for (let i = 0; i < nlat; i++) gam[i] = normalGravityH(90 - i * step, H) / MGAL;
  const L = level / MGAL;
  const val = (i, j) => gam[i] + grid.data[i * nlon + (j % nlon)] - L; // mGal relativ zum Niveau
  const pts = new Map();     // Kantenschlüssel -> [lat, lon]
  const adj = new Map();     // Kantenschlüssel -> [Segmentindex…]
  const segs = [];
  const HOFF = 0, VOFF = nlat * nlon;
  const hKey = (i, j) => HOFF + i * nlon + (j % nlon);
  const vKey = (i, j) => VOFF + i * nlon + (j % nlon);
  function point(key, va, vb, lat0, lon0, lat1, lon1) {
    if (!pts.has(key)) {
      const t = va / (va - vb);
      pts.set(key, [lat0 + t * (lat1 - lat0), wrap180(lon0 + t * (lon1 - lon0))]);
    }
    return key;
  }
  function addSeg(a, b) {
    const k = segs.length;
    segs.push([a, b]);
    for (const e of [a, b]) { const l = adj.get(e); if (l) l.push(k); else adj.set(e, [k]); }
  }
  for (let i = 0; i < nlat - 1; i++) {
    const latT = 90 - i * step, latB = latT - step;
    for (let j = 0; j < nlon; j++) {
      const lonL = -180 + j * step, lonR = lonL + step;
      const a = val(i, j), b = val(i, j + 1), c = val(i + 1, j + 1), d = val(i + 1, j);
      const sa = a > 0, sb = b > 0, sc = c > 0, sd = d > 0;
      if (sa === sb && sb === sc && sc === sd) continue;
      const e = {};
      if (sa !== sb) e.t = point(hKey(i, j), a, b, latT, lonL, latT, lonR);
      if (sb !== sc) e.r = point(vKey(i, j + 1), b, c, latT, lonR, latB, lonR);
      if (sd !== sc) e.b = point(hKey(i + 1, j), d, c, latB, lonL, latB, lonR);
      if (sa !== sd) e.l = point(vKey(i, j), a, d, latT, lonL, latB, lonL);
      const ks = Object.keys(e);
      if (ks.length === 2) addSeg(e[ks[0]], e[ks[1]]);
      else if (ks.length === 4) {
        const center = (a + b + c + d) / 4 > 0;
        if (center === sa) { addSeg(e.t, e.r); addSeg(e.b, e.l); }
        else { addSeg(e.l, e.t); addSeg(e.r, e.b); }
      }
    }
  }
  // Segmente zu Linienzügen verketten
  const used = new Uint8Array(segs.length);
  const lines = [];
  const walk = (start, from) => {
    const chain = [];
    let edge = from, k = start;
    while (k != null && !used[k]) {
      used[k] = 1;
      const [p, q] = segs[k];
      const next = p === edge ? q : p;
      chain.push(next);
      edge = next;
      k = (adj.get(edge) || []).find(s => !used[s]);
    }
    return chain;
  };
  for (let s = 0; s < segs.length; s++) {
    if (used[s]) continue;
    const p = segs[s][0];
    const fwd = walk(s, p);              // ab p über q weiter
    const back = walk((adj.get(p) || []).find(x => !used[x]), p); // von p in Gegenrichtung
    const keys = [...back.reverse(), p, ...fwd];
    const line = [];
    for (const key of keys) {
      const [lat, lon] = pts.get(key);
      if (line.length) {
        const prev = line[line.length - 1][1];
        line.push([lat, prev + wrap180(lon - prev)]);
      } else line.push([lat, lon]);
    }
    if (line.length > 1) lines.push(line);
  }
  return lines;
}

/** Breiten auf dem Meridian lon mit g(φ, lon, H) = level (aufsteigend). */
export function meridianCrossings(level, H, lon, grid) {
  const f = lat => modelGravity(lat, lon, H, grid).g - level;
  const out = [];
  const stepDeg = 0.1;
  let x0 = -90, f0 = f(x0);
  for (let x1 = -90 + stepDeg; x1 <= 90 + 1e-9; x1 += stepDeg) {
    const f1 = f(x1);
    if (f0 === 0) out.push(x0);
    else if (f0 * f1 < 0) {
      let lo = x0, hi = x1, flo = f0;
      for (let i = 0; i < 30; i++) {
        const mid = (lo + hi) / 2, fm = f(mid);
        if (fm * flo <= 0) hi = mid; else { lo = mid; flo = fm; }
      }
      out.push((lo + hi) / 2);
    }
    x0 = x1; f0 = f1;
  }
  return out;
}

/** Nächster Punkt der Linienzüge zu (lat, lon), lokal eben genähert. {lat, lon, km} oder null. */
export function nearestOnLines(lines, lat, lon) {
  let best = null;
  const R = 6371.0088;
  for (const line of lines) {
    for (let k = 1; k < line.length; k++) {
      const [la0, lo0] = line[k - 1], [la1, lo1] = line[k];
      const c = Math.cos(((la0 + la1) / 2) * D);
      const ax = wrap180(lo0 - lon) * c, ay = la0 - lat;
      const bx = ax + (lo1 - lo0) * c, by = la1 - lat;
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
      const px = ax + t * dx, py = ay + t * dy;
      const dist = Math.hypot(px, py) * D * R;
      if (!best || dist < best.km) best = { km: dist, lat: la0 + t * (la1 - la0), lon: wrap180(lo0 + t * (lo1 - lo0)) };
    }
  }
  return best;
}

// ---------- Auswertung der Samples ----------
export const LIMITS = {
  durationMs: 60000,
  windowMs: 1000,   // Fensterlänge Bewegungsprüfung
  moveLim: 0.06,    // m/s²: max. Abweichung eines Fenstermittels (Vektor) vom ersten Fenster (≈ 0,35° Kippung)
  stdLim: 0.15,     // m/s²: max. Streuung von |a| über die Messung
  trim: 0.1,        // getrimmtes Mittel: je 10 % unten/oben verwerfen
  minRate: 5        // Hz
};

/** Lage: Achse mit dem größten Anteil am mittleren Vektor, Vorzeichen, Neigung gegen diese Achse (Grad). */
export function attitude(v) {
  const abs = v.map(Math.abs);
  const i = abs.indexOf(Math.max(...abs));
  const n = Math.hypot(...v);
  return { axis: 'xyz'[i] + (v[i] >= 0 ? '+' : '−'), tilt: n ? Math.acos(Math.min(1, abs[i] / n)) / D : 0 };
}

export function trimmedMean(list, frac = LIMITS.trim) {
  const s = Float64Array.from(list).sort();
  const cut = Math.floor(s.length * frac);
  let sum = 0;
  for (let i = cut; i < s.length - cut; i++) sum += s[i];
  return sum / (s.length - 2 * cut);
}

/**
 * Laufende Bewegungsprüfung. push(t, x, y, z) -> null oder Fehlertext.
 * Vergleicht jedes abgeschlossene 1-s-Fenstermittel mit dem ersten Fenster.
 */
export function motionMonitor(lim = LIMITS) {
  let ref = null, win = null;
  return {
    maxDev: 0,
    push(t, x, y, z) {
      if (!win) win = { t0: t, n: 0, x: 0, y: 0, z: 0 };
      win.n++; win.x += x; win.y += y; win.z += z;
      if (t - win.t0 < lim.windowMs) return null;
      const m = [win.x / win.n, win.y / win.n, win.z / win.n];
      win = null;
      if (!ref) { ref = m; return null; }
      const dev = Math.hypot(m[0] - ref[0], m[1] - ref[1], m[2] - ref[2]);
      this.maxDev = Math.max(this.maxDev, dev);
      return dev > lim.moveLim ? 'Bewegung erkannt' : null;
    }
  };
}

/**
 * Auswertung einer Messreihe {t[], x[], y[], z[]} (ms, m/s²).
 * Liefert {n, durationS, rate, mean (getrimmt, |a|), plainMean, std, vec, vecNorm, axis, tilt, ok, reason}.
 */
export function analyze(s, lim = LIMITS) {
  const n = s.t.length;
  if (n < 10) return { n, ok: false, reason: 'Zu wenige Messwerte' };
  const mag = new Float64Array(n);
  let sx = 0, sy = 0, sz = 0;
  for (let i = 0; i < n; i++) {
    mag[i] = Math.hypot(s.x[i], s.y[i], s.z[i]);
    sx += s.x[i]; sy += s.y[i]; sz += s.z[i];
  }
  const plainMean = mag.reduce((a, b) => a + b, 0) / n;
  let q = 0;
  for (let i = 0; i < n; i++) q += (mag[i] - plainMean) ** 2;
  const std = Math.sqrt(q / (n - 1));
  const vec = [sx / n, sy / n, sz / n];
  const durationS = (s.t[n - 1] - s.t[0]) / 1000;
  const rate = durationS > 0 ? (n - 1) / durationS : 0;
  const att = attitude(vec);
  const res = {
    n, durationS, rate, mean: trimmedMean(mag, lim.trim), plainMean, std,
    vec, vecNorm: Math.hypot(...vec), axis: att.axis, tilt: att.tilt, ok: true, reason: null
  };
  if (rate < lim.minRate) { res.ok = false; res.reason = `Abtastrate zu gering (${rate.toFixed(1)} Hz)`; }
  else if (std > lim.stdLim) { res.ok = false; res.reason = 'Streuung zu groß – Unterlage nicht ruhig'; }
  return res;
}

/** Hinweis, ob der Mittelwert auffällig exakt 1 g ist (Plattform liefert evtl. normierte Werte). */
export const looksNormalized = mean => Math.abs(mean - G0) < 2e-4;
