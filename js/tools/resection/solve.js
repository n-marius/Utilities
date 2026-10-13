// Kreuzpeilung (Rückwärtseinschnitt): Standort aus Kompasspeilungen auf bekannte Ziele, ohne DOM.
//
// Modell je Peilung i: Ziel T_i (lat/lon), magnetischer Azimut Z_i, Missweisung m (WMM am Schätzort),
// Fehlergrenze e_i (harte Grenze, Grad). Rechtweisender Soll-Peilwinkel A_i = Z_i + m.
// Residuum am Ort P: r_i(P) = wrap180(Kurs(P -> T_i) − A_i)   (Kurs auf der Kugel, geo.bearing)
//
// Mengen-Ansatz: Lösungsbereich = alle Orte P, an denen jede Peilung innerhalb ihrer Grenze liegt.
//  - ohne Kompassfehler:  max_i |r_i| / e_i ≤ 1,  e_i = 0,5° + max(2σ_i, Kompassgenauigkeit_i)
//  - mit Kompassversatz δ (gemeinsamer Fehler aller Peilungen, Anzeige − wahr: Z_i = wahrer Wert − m + δ):
//      es gibt ein δ mit |δ| ≤ DELTA_MAX und |r_i + δ| / e_i ≤ 1 für alle i,  e_i = 0,5° + 2σ_i (+ Rest).
//    Die Kompassgenauigkeit (iOS) gilt dann als systematischer Anteil und steckt in δ. Wie in astro/solver.js:
//    Deviation ist teils richtungsabhängig, der gemeinsame Versatz eine Näherung – sind die Peilungen über
//    mehr als 90° verteilt, gilt je Peilung zusätzlich BIAS_REST als Restgrenze.
//    Minimax über δ geschlossen: g(P) = max_{i,j} (r_i − r_j) / (e_i + e_j), mit der Pseudo-Peilung
//    r = 0, e = DELTA_MAX für die Schranke von δ (eindimensionaler Satz von Helly).
// Bestimmung: Grobgitter über die Umgebung der Ziele -> lokale Minima von g -> Musterverfeinerung ->
// adaptives Feingitter um jedes zulässige Minimum, Rand per Marching Squares (Höhenlinie g = 1).
// Mittelpunkt = Minimax-Punkt (kleinstes g), Radius = größter Abstand des Randes vom Mittelpunkt.

import { bearing, distance, destination, offsetEN, wrap180, D2R, R2D } from '../../lib/geo.js';

export const AIM = 0.5;          // Ausrichten der Oberkante (Grad)
export const DELTA_MAX = 45;     // Suchgrenze für den Kompassversatz (Grad)
export const BIAS_WARN = 30;     // |δ| darüber: unplausibel (wie astro)
export const BIAS_REST = 2;      // Restgrenze je Peilung bei Azimutspreizung > 90° (wie astro)
export const RANGE = 100e3;      // Suchbereich über die Ziele hinaus (m)
const COARSE = 151;              // Grobgitter (Knoten je Achse)
const FINE = 101;                // Feingitter

/** Fehlergrenzen einer Peilung aus 2σ und iOS-Kompassgenauigkeit: gesamt eZ (ohne δ), zufällig eZr (mit δ). */
export function bounds(s2Z, acc) {
  return { eZ: AIM + Math.max(s2Z || 0, acc ?? 0), eZr: AIM + (s2Z || 0) };
}

/** Azimutspreizung (Grad): 360° minus größte Lücke der Peilwinkel. */
export function azSpread(list) {
  const a = list.map(x => ((x % 360) + 360) % 360).sort((x, y) => x - y);
  if (a.length < 2) return 0;
  let gap = 360 - a[a.length - 1] + a[0];
  for (let i = 1; i < a.length; i++) gap = Math.max(gap, a[i] - a[i - 1]);
  return 360 - gap;
}

/** Bewertungsfunktion g(lat, lon) für Peilungen [{lat, lon, A, e}]; out.delta erhält das Minimax-δ. */
export function makeG(obs, withDelta) {
  const n = obs.length;
  const r = new Float64Array(n);
  return function g(lat, lon, out) {
    for (let i = 0; i < n; i++) r[i] = wrap180(bearing(lat, lon, obs[i].lat, obs[i].lon) - obs[i].A);
    if (!withDelta) {
      let w = 0;
      for (let i = 0; i < n; i++) w = Math.max(w, Math.abs(r[i]) / obs[i].e);
      if (out) out.delta = 0;
      return w;
    }
    // Index −1 = Schranke |δ| ≤ DELTA_MAX
    let w = -Infinity, bi = 0, bj = 0;
    for (let i = -1; i < n; i++) {
      const ri = i < 0 ? 0 : r[i], ei = i < 0 ? DELTA_MAX : obs[i].e;
      for (let j = -1; j < n; j++) {
        if (i === j) continue;
        const rj = j < 0 ? 0 : r[j], ej = j < 0 ? DELTA_MAX : obs[j].e;
        const v = (ri - rj) / (ei + ej);
        if (v > w) { w = v; bi = i; bj = j; }
      }
    }
    if (out) {
      const ri = bi < 0 ? 0 : r[bi], ei = bi < 0 ? DELTA_MAX : obs[bi].e;
      const rj = bj < 0 ? 0 : r[bj], ej = bj < 0 ? DELTA_MAX : obs[bj].e;
      // optimaler Versatz in r: (ri·ej + rj·ei)/(ei+ej); Kompassfehler δ = −Versatz
      out.delta = -(ri * ej + rj * ei) / (ei + ej);
      // zulässiges δ-Intervall an diesem Ort
      let lo = -DELTA_MAX, hi = DELTA_MAX;
      for (let i = 0; i < n; i++) { lo = Math.max(lo, -r[i] - obs[i].e); hi = Math.min(hi, -r[i] + obs[i].e); }
      out.lo = lo; out.hi = hi;
    }
    return Math.max(w, 0);
  };
}

/** Punkte entlang der Standlinie: Orte P mit Kurs(P -> T) = A, bis Abstand len (m). */
export function bearingLine(lat, lon, A, len, n = 24) {
  const pts = [[lat, lon]];
  for (let k = 1; k <= n; k++) {
    const d = len * k / n;
    let b = A + 180, p = destination(lat, lon, b, d);
    // Rückwärtskurs um die Meridiankonvergenz nachführen
    for (let it = 0; it < 4; it++) {
      b += wrap180(A - bearing(p[0], p[1], lat, lon));
      p = destination(lat, lon, b, d);
    }
    pts.push(p);
  }
  return pts;
}

/** Keil um die Standlinie (Polygon): Peilwinkel A ± e. */
export function wedge(lat, lon, A, e, len) {
  const a = bearingLine(lat, lon, A - e, len, 16), b = bearingLine(lat, lon, A + e, len, 16);
  return [[lat, lon], ...a.slice(1), ...b.slice(1).reverse()];
}

// ---------- Hilfen lokale Ebene ----------

function frame(pts) {
  const lat0 = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
  const lon0r = pts[0].lon;
  const lon0 = wrap180(lon0r + pts.reduce((s, p) => s + wrap180(p.lon - lon0r), 0) / pts.length);
  const toLL = (x, y) => offsetEN(lat0, lon0, x, y);
  const kx = 6371008.8 * Math.cos(lat0 * D2R) * D2R, ky = 6371008.8 * D2R;
  const toXY = (lat, lon) => [wrap180(lon - lon0) * kx, (lat - lat0) * ky];
  return { lat0, lon0, toLL, toXY };
}

/** Musterverfeinerung (nicht glatt: Zoom-Gitter 5×5) des Minimums von g ab (x, y). */
function refine(g, F, x, y, step) {
  let [la, lo] = F.toLL(x, y);
  let best = g(la, lo);
  for (let it = 0; it < 300 && step > 0.02; it++) {
    let bx = x, by = y, moved = false;
    for (let a = -2; a <= 2; a++) {
      for (let b = -2; b <= 2; b++) {
        if (!a && !b) continue;
        const [p, q] = F.toLL(x + a * step, y + b * step);
        const v = g(p, q);
        if (v < best - 1e-12) { best = v; bx = x + a * step; by = y + b * step; moved = true; }
      }
    }
    if (moved) { x = bx; y = by; } else step /= 2.5;
  }
  return { x, y, g: best };
}

/** Grobsuche: lokale Minima von g im Umkreis der Ziele, verfeinert, aufsteigend sortiert. */
function minima(g, F, half, k = 6) {
  const N = COARSE, c = (N - 1) / 2, d = 2 * half / (N - 1);
  const v = new Float64Array(N * N);
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const [la, lo] = F.toLL((j - c) * d, (i - c) * d);
      v[i * N + j] = g(la, lo);
    }
  }
  const loc = [];
  for (let i = 1; i < N - 1; i++) {
    for (let j = 1; j < N - 1; j++) {
      const x = v[i * N + j];
      let ok = true;
      for (let a = -1; a <= 1 && ok; a++) for (let b = -1; b <= 1; b++) if ((a || b) && v[(i + a) * N + j + b] < x) { ok = false; break; }
      if (ok) loc.push({ i, j, g: x });
    }
  }
  loc.sort((a, b) => a.g - b.g);
  const pick = [];
  for (const m of loc) {
    if (pick.length >= k) break;
    if (pick.some(p => Math.abs(p.i - m.i) <= 3 && Math.abs(p.j - m.j) <= 3)) continue;
    pick.push(m);
  }
  const out = pick.map(m => refine(g, F, (m.j - c) * d, (m.i - c) * d, d));
  out.sort((a, b) => a.g - b.g);
  return { list: out, cell: d };
}

/** Marching Squares: Ringe der Höhenlinie f = 0 (innen f ≤ 0) auf einem Gitter mit Außenrand. */
function contour(f, N, X, Y) {
  // gepolstertes Gitter (N+2)², Rand außen (+1)
  const M = N + 2;
  const val = (i, j) => (i < 1 || j < 1 || i > N || j > N) ? 1 : f[(i - 1) * N + (j - 1)];
  const px = j => X(Math.min(Math.max(j - 1, -0.5), N - 0.5));
  const py = i => Y(Math.min(Math.max(i - 1, -0.5), N - 0.5));
  const pt = new Map(), adj = new Map();
  const edgePt = (key, i0, j0, i1, j1) => {
    if (!pt.has(key)) {
      const a = val(i0, j0), b = val(i1, j1);
      const t = a === b ? 0.5 : a / (a - b);
      pt.set(key, [px(j0) + (px(j1) - px(j0)) * t, py(i0) + (py(i1) - py(i0)) * t]);
    }
    return key;
  };
  const link = (a, b) => {
    (adj.get(a) || adj.set(a, []).get(a)).push(b);
    (adj.get(b) || adj.set(b, []).get(b)).push(a);
  };
  for (let i = 0; i < M - 1; i++) {
    for (let j = 0; j < M - 1; j++) {
      const a = val(i, j), b = val(i, j + 1), c = val(i + 1, j + 1), d = val(i + 1, j);
      const idx = (a <= 0 ? 1 : 0) | (b <= 0 ? 2 : 0) | (c <= 0 ? 4 : 0) | (d <= 0 ? 8 : 0);
      if (idx === 0 || idx === 15) continue;
      const B = () => edgePt(`h${i},${j}`, i, j, i, j + 1);
      const T = () => edgePt(`h${i + 1},${j}`, i + 1, j, i + 1, j + 1);
      const Lf = () => edgePt(`v${i},${j}`, i, j, i + 1, j);
      const R = () => edgePt(`v${i},${j + 1}`, i, j + 1, i + 1, j + 1);
      switch (idx) {
        case 1: case 14: link(B(), Lf()); break;
        case 2: case 13: link(B(), R()); break;
        case 3: case 12: link(Lf(), R()); break;
        case 4: case 11: link(R(), T()); break;
        case 6: case 9: link(B(), T()); break;
        case 7: case 8: link(Lf(), T()); break;
        case 5: case 10: {
          const mid = (a + b + c + d) / 4 <= 0;
          if ((idx === 5) === mid) { link(B(), R()); link(Lf(), T()); } else { link(B(), Lf()); link(R(), T()); }
          break;
        }
      }
    }
  }
  const seen = new Set(), rings = [];
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const ring = [];
    let prev = null, cur = start;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      ring.push(pt.get(cur));
      const nb = adj.get(cur).filter(k => k !== prev && !seen.has(k));
      prev = cur; cur = nb[0];
    }
    if (ring.length >= 3) rings.push(ring);
  }
  return rings;
}

/** Feingitter um ein zulässiges Minimum: Komponente, Rand, Radius, δ-Spanne. */
function region(g, F, m, maxHalf) {
  const N = FINE, c = (N - 1) / 2;
  let half = 200, res = null;
  for (let it = 0; it < 14; it++) {
    const d = 2 * half / (N - 1);
    const v = new Float64Array(N * N);
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const [la, lo] = F.toLL(m.x + (j - c) * d, m.y + (i - c) * d);
        v[i * N + j] = g(la, lo) - 1;
      }
    }
    v[c * N + c] = Math.min(v[c * N + c], -1e-9); // Mittelpunkt ist zulässig
    // Komponente des Mittelpunkts (8er-Nachbarschaft)
    const comp = new Uint8Array(N * N);
    const stack = [c * N + c];
    comp[c * N + c] = 1;
    let i0 = c, i1 = c, j0 = c, j1 = c, count = 0;
    while (stack.length) {
      const k = stack.pop(), i = (k / N) | 0, j = k % N;
      count++;
      i0 = Math.min(i0, i); i1 = Math.max(i1, i); j0 = Math.min(j0, j); j1 = Math.max(j1, j);
      for (let a = -1; a <= 1; a++) {
        for (let b = -1; b <= 1; b++) {
          const ii = i + a, jj = j + b;
          if (ii < 0 || jj < 0 || ii >= N || jj >= N) continue;
          const kk = ii * N + jj;
          if (!comp[kk] && v[kk] <= 0) { comp[kk] = 1; stack.push(kk); }
        }
      }
    }
    res = { v, comp, d, half, count };
    const border = i0 === 0 || j0 === 0 || i1 === N - 1 || j1 === N - 1;
    const ext = Math.max(i1 - i0, j1 - j0);
    if (border && half < maxHalf) { half = Math.min(maxHalf, half * 2.5); continue; }
    if (!border && ext < 14 && half > 0.5) { half = Math.max(0.5, half * Math.max(ext, 2) / 40); continue; }
    break;
  }
  const { v, comp, d, half: H } = res;
  const f = new Float64Array(N * N);
  for (let k = 0; k < N * N; k++) f[k] = comp[k] ? v[k] : Math.max(v[k], 1e-6);
  const rings = contour(f, N, j => m.x + (j - c) * d, i => m.y + (i - c) * d);
  rings.sort((a, b) => b.length - a.length);
  const [lat, lon] = F.toLL(m.x, m.y);
  const ring = (rings[0] || []).map(([x, y]) => F.toLL(x, y));
  let radius = d / 2;
  for (const p of ring) radius = Math.max(radius, distance(lat, lon, p[0], p[1]));
  // δ-Spanne über die zulässigen Knoten
  let dLo = Infinity, dHi = -Infinity;
  const o = {};
  for (let k = 0; k < N * N; k++) {
    if (!comp[k]) continue;
    const i = (k / N) | 0, j = k % N;
    const [la, lo] = F.toLL(m.x + (j - c) * d, m.y + (i - c) * d);
    g(la, lo, o);
    if (o.lo != null) { dLo = Math.min(dLo, o.lo); dHi = Math.max(dHi, o.hi); }
  }
  g(lat, lon, o);
  const inside = (x, y) => {
    const j = Math.round((x - m.x) / d + c), i = Math.round((y - m.y) / d + c);
    return i >= 0 && j >= 0 && i < N && j < N && comp[i * N + j] === 1;
  };
  return {
    lat, lon, x: m.x, y: m.y, g: m.g, radius, ring, half: H, cell: d,
    delta: o.delta, deltaLo: Number.isFinite(dLo) ? dLo : null, deltaHi: Number.isFinite(dHi) ? dHi : null,
    inside, touches: res.count > 0 && H >= maxHalf
  };
}

/** Alle Lösungsbereiche für Peilungen obs (rechtweisend). */
function regionsOf(obs, withDelta) {
  const g = makeG(obs, withDelta);
  const F = frame(obs);
  let spread = 0;
  for (const o of obs) spread = Math.max(spread, Math.hypot(...F.toXY(o.lat, o.lon)));
  const half = spread + RANGE;
  const { list, cell } = minima(g, F, half);
  const regs = [];
  for (const m of list) {
    if (m.g > 1) continue;
    if (regs.some(r => r.inside(m.x, m.y))) continue;
    regs.push(region(g, F, m, half * 1.2));
  }
  return { g, F, regs, best: list[0], cell };
}

// ---------- Geometrie-Hinweise ----------

/** Schnittwinkel: größter Winkel (0–90°) zwischen Sichtlinien zu verschiedenen Zielen am Ort. */
function cutAngle(lat, lon, targets) {
  let best = 0;
  for (let a = 0; a < targets.length; a++) {
    for (let b = a + 1; b < targets.length; b++) {
      const x = bearing(lat, lon, targets[a].lat, targets[a].lon), y = bearing(lat, lon, targets[b].lat, targets[b].lon);
      best = Math.max(best, Math.asin(Math.min(1, Math.abs(Math.sin((x - y) * D2R)))) * R2D);
    }
  }
  return best;
}

/**
 * Gefährlicher Kreis (nur mit δ): Lage ist aus Winkeldifferenzen bestimmbar, wenn die um δ bereinigten
 * Gradienten der Peilwinkel die Ebene aufspannen. Maß: kleinster/größter Singulärwert der zentrierten,
 * normierten Gradientenmatrix. Zusätzlich: liegt der Ort nahe dem Kreis durch drei Ziele?
 */
function dangerCircle(lat, lon, obs, F) {
  const [px, py] = F.toXY(lat, lon);
  const G = obs.map(o => {
    const [tx, ty] = F.toXY(o.lat, o.lon);
    const dx = tx - px, dy = ty - py, d2 = Math.max(dx * dx + dy * dy, 1);
    // Gradient des Kurses (rad/m) nach dem Ort
    return [-dy / d2 / (o.e * D2R), dx / d2 / (o.e * D2R), 1 / o.e];
  });
  // δ herausprojizieren (gewichtetes Mittel der Gradienten abziehen)
  const wsum = G.reduce((s, q) => s + q[2] * q[2], 0);
  const mx = G.reduce((s, q) => s + q[0] * q[2], 0) / wsum, my = G.reduce((s, q) => s + q[1] * q[2], 0) / wsum;
  const sv = M => {
    let a = 0, b = 0, c = 0;
    for (const [x, y] of M) { a += x * x; b += x * y; c += y * y; }
    const t = (a + c) / 2, q = Math.sqrt(Math.max(0, ((a - c) / 2) ** 2 + b * b));
    return Math.sqrt(Math.max(0, t - q)) / Math.max(Math.sqrt(t + q), 1e-30);
  };
  const kDelta = sv(G.map(([x, y, w]) => [x - mx * w, y - my * w]));
  const kPlain = sv(G);
  // Kreis durch drei verschiedene Ziele
  const T = [];
  for (const o of obs) if (!T.some(t => t.lat === o.lat && t.lon === o.lon)) T.push(o);
  let near = T.length >= 3;
  for (let a = 0; a < T.length && near; a++) {
    for (let b = a + 1; b < T.length && near; b++) {
      for (let c = b + 1; c < T.length && near; c++) {
        const [ax, ay] = F.toXY(T[a].lat, T[a].lon), [bx, by] = F.toXY(T[b].lat, T[b].lon), [cx, cy] = F.toXY(T[c].lat, T[c].lon);
        const D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
        const dm = (Math.hypot(ax - px, ay - py) + Math.hypot(bx - px, by - py) + Math.hypot(cx - px, cy - py)) / 3;
        let off;
        if (Math.abs(D) < 1e-6) off = 0;
        else {
          const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / D;
          const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / D;
          const R = Math.hypot(ax - ux, ay - uy);
          off = Math.abs(Math.hypot(px - ux, py - uy) - R);
        }
        if (off / dm > 0.12) near = false;
      }
    }
  }
  return { kDelta, kPlain, near };
}

// ---------- Hauptfunktion ----------

/**
 * Standort bestimmen.
 * targets: [{id, name, lat, lon}]
 * rows:    [{target (id), az (magnetisch), eZ (0,5° + max(2σ, Kompassgenauigkeit)), eZr (0,5° + 2σ)}]
 * opts:    {declFn(lat, lon) -> Missweisung (Grad, Ost positiv), delta: 'auto'|'on'|'off'}
 * Ergebnis: {status: 'empty'|'line'|'ok'|'inconsistent', decl, withDelta, deltaPossible, regions, lines,
 *            nUsed, nTargets, flags {Zeilenindex: Text}, bad {Zeilenindex: Text}, notes [{text, warn}], cut, danger}
 */
export function solve(targets, rows, opts = {}) {
  const declFn = opts.declFn || (() => 0);
  const byId = new Map(targets.map(t => [t.id, t]));
  const bad = {}, flags = {}, notes = [];
  const used = [];
  rows.forEach((r, i) => {
    const t = byId.get(r.target);
    if (!t) bad[i] = 'Ziel gelöscht – Peilung nicht verwendet';
    else if (![r.az, r.eZ, r.eZr].every(Number.isFinite)) bad[i] = 'Unvollständige Messwerte';
    else used.push(i);
  });
  const tIds = [...new Set(used.map(i => rows[i].target))];
  const nTargets = tIds.length;
  const deltaPossible = nTargets >= 3;
  const mode = opts.delta || 'auto';
  const withDelta = deltaPossible && (mode === 'on' || (mode === 'auto' && used.length >= 3));
  const base = { decl: null, withDelta, deltaPossible, regions: [], lines: [], nUsed: used.length, nTargets, flags, bad, notes, cut: null, danger: null, eUsed: {} };
  if (mode === 'on' && !deltaPossible && used.length) notes.push({ text: 'Kompassfehler mitschätzen erst ab drei verschiedenen Zielen möglich.', warn: false });
  if (!used.length) return { ...base, status: 'empty' };

  const tgt = i => byId.get(rows[i].target);
  const spread = azSpread(used.map(i => rows[i].az));
  const rest = withDelta && spread > 90 ? BIAS_REST : 0;
  const mkObsWith = (idx, decl, wd) => idx.map(i => {
    const t = tgt(i);
    const e = wd ? Math.min(rows[i].eZ, rows[i].eZr) + (spread > 90 ? BIAS_REST : 0) : rows[i].eZ;
    return { lat: t.lat, lon: t.lon, A: rows[i].az + decl, e, row: i };
  });
  const mkObs = (idx, decl) => mkObsWith(idx, decl, withDelta);
  const tg = tIds.map(id => byId.get(id));
  const cLat = tg.reduce((s, t) => s + t.lat, 0) / tg.length;
  const cLon = wrap180(tg[0].lon + tg.reduce((s, t) => s + wrap180(t.lon - tg[0].lon), 0) / tg.length);
  let decl = declFn(cLat, cLon);

  if (nTargets < 2) {
    const obs = mkObs(used, decl);
    for (const o of obs) base.eUsed[o.row] = o.e;
    return {
      ...base, status: 'line', decl,
      lines: obs.map(o => ({ row: o.row, lat: o.lat, lon: o.lon, A: o.A, e: rows[o.row].eZ }))
    };
  }

  // Lösen, Missweisung am Schätzort nachführen
  let sol;
  for (let k = 0; k < 4; k++) {
    sol = regionsOf(mkObs(used, decl), withDelta);
    const ref = sol.regs[0] || (sol.best && { lat: sol.F.toLL(sol.best.x, sol.best.y)[0], lon: sol.F.toLL(sol.best.x, sol.best.y)[1] });
    if (!ref) break;
    const d2 = declFn(ref.lat, ref.lon);
    if (Math.abs(wrap180(d2 - decl)) < 0.02) break;
    decl = d2;
  }
  const obs = mkObs(used, decl);
  for (const o of obs) base.eUsed[o.row] = o.e;
  const lines = obs.map(o => ({ row: o.row, lat: o.lat, lon: o.lon, A: o.A, e: o.e }));

  if (!sol.regs.length) {
    // leere Menge: Weglassprobe
    const sus = [];
    const minRest = withDelta ? 3 : 2;
    if (used.length >= 3) {
      for (const j of used) {
        const rest = used.filter(i => i !== j);
        if (new Set(rest.map(i => rows[i].target)).size < minRest) continue;
        const r = regionsOf(mkObs(rest, decl), withDelta);
        if (r.regs.length) sus.push(j);
      }
    }
    // systematischer Fehler? Mit mitgeschätztem Kompassversatz widerspruchsfrei
    // (nur bei Überbestimmung: ab vier Peilungen; bei drei passt ein Versatz immer)
    let sysHint = false;
    if (!withDelta && deltaPossible && used.length >= 4) {
      const rd = regionsOf(mkObsWith(used, decl, true), true).regs[0];
      sysHint = !!rd && Math.abs(rd.delta) <= BIAS_WARN;
    }
    // nicht aussagekräftig, wenn jede Zeile verdächtig ist (Rest jeweils genau bestimmt)
    const informative = sus.length && sus.length < used.length;
    if (sysHint) {
      notes.push({ text: 'Mit mitgeschätztem Kompassversatz wären die Peilungen widerspruchsfrei – vermutlich systematischer Kompassfehler. Option „Kompassversatz schätzen“ einschalten.', warn: true });
    } else if (informative) {
      const txt = sus.length === 1 ? 'Vermutlich Ausreißer: ohne diese Peilung sind die übrigen widerspruchsfrei'
        : 'Möglicher Ausreißer: ohne diese Peilung sind die übrigen widerspruchsfrei';
      for (const j of sus) flags[j] = txt;
    } else if (sol.best) {
      const [la, lo] = sol.F.toLL(sol.best.x, sol.best.y);
      const per = obs.map(o => Math.abs(wrap180(bearing(la, lo, o.lat, o.lon) - o.A)) / o.e);
      const order = per.map((v, k) => k).sort((a, b) => per[b] - per[a]);
      for (const k of order.slice(0, 2)) if (per[k] > 1) flags[obs[k].row] = `Abweichung ${per[k].toFixed(1).replace('.', ',')}× Fehlergrenze`;
    }
    if (informative && sus.length > 1 && !sysHint) notes.push({ text: 'Mehrere Peilungen kommen als Ausreißer infrage – Ziele und Peilungen prüfen.', warn: true });
    return { ...base, status: 'inconsistent', decl, lines, bestG: sol.best ? sol.best.g : null };
  }

  const regions = sol.regs.map(r => ({
    lat: r.lat, lon: r.lon, radius: r.radius, ring: r.ring, g: r.g,
    delta: withDelta ? r.delta : null, deltaLo: withDelta ? r.deltaLo : null, deltaHi: withDelta ? r.deltaHi : null,
    open: r.touches
  }));
  const main = regions[0];
  const cut = cutAngle(main.lat, main.lon, tg);
  let danger = null;
  if (withDelta) {
    danger = dangerCircle(main.lat, main.lon, obs, sol.F);
    if (danger.kDelta < 0.15 && danger.near) notes.push({ text: 'Gefährlicher Kreis: Der Standort liegt nahe dem Kreis durch die Ziele. Mit unbekanntem Kompassfehler ist er dort kaum bestimmbar – ein Ziel in anderer Lage hinzunehmen oder Kompassfehler nicht mitschätzen.', warn: true });
    else if (danger.kDelta < 0.15) notes.push({ text: 'Mit unbekanntem Kompassfehler schwach bestimmt (Ziele liegen ungünstig) – weiteres Ziel in anderer Richtung peilen.', warn: true });
    if (main.delta != null && Math.abs(main.delta) > BIAS_WARN) notes.push({ text: `Kompassversatz unplausibel groß (über ${BIAS_WARN}°) – Kompass kalibrieren (Acht-Bewegung), Störquellen meiden, Ziele prüfen.`, warn: true });
    if (rest) notes.push({ text: `Peilungen über ${Math.round(spread)}° verteilt: je Peilung ${BIAS_REST}° Restgrenze (Deviation teils richtungsabhängig).`, warn: false });
  }
  if (used.length === (withDelta ? 3 : 2)) notes.push({ text: `Genau bestimmt (${used.length} Peilungen${withDelta ? ' mit Kompassversatz' : ''}): keine Kontrolle auf Ausreißer – eine weitere Peilung empfohlen.`, warn: false });
  if (cut < 25) notes.push({ text: `Schleifender Schnitt (${cut.toFixed(0)}°) – Ziel in deutlich anderer Richtung peilen.`, warn: true });
  if (regions.length > 1) notes.push({ text: `Mehrdeutig: ${regions.length} getrennte Bereiche erfüllen alle Peilungen.`, warn: true });
  if (regions.some(r => r.open)) notes.push({ text: 'Bereich reicht bis an den Rand des Suchgebiets – weitere Peilungen nötig.', warn: true });
  if (main.g > 0.8) flagWorst(obs, main, flags, 'Nur knapp vereinbar');
  return { ...base, status: 'ok', decl, regions, lines, cut, danger };
}

function flagWorst(obs, reg, flags, text) {
  let worst = -1, wk = -1;
  obs.forEach((o, k) => {
    const v = Math.abs(wrap180(bearing(reg.lat, reg.lon, o.lat, o.lon) - o.A + (reg.delta || 0))) / o.e;
    if (v > worst) { worst = v; wk = k; }
  });
  if (wk >= 0 && worst > 0.8) flags[obs[wk].row] = `${text} (${worst.toFixed(1).replace('.', ',')}× Fehlergrenze)`;
}
