// Ortsbestimmung aus Sonnenpeilungen (Höhe + magnetischer Azimut), ohne DOM.
//
// Modell je Messung i: Zeitpunkt t_i (UTC), scheinbare Höhe h_i, magnetischer Azimut Z_i,
// Fehlergrenzen eh_i/eZ_i. Unbekannte: Breite, Länge und je nach Datenlage
//  - dt: gemeinsamer Uhrversatz (h) der Zeilen ohne Uhrzeit, falls andere Zeilen eine Uhrzeit haben,
//  - D:  gemeinsamer Datumsversatz (Tage) der Zeilen ohne Datum,
//  - m:  Missweisung als Unbekannte, wenn keine Zeile eine Uhrzeit hat (Länge dann unbestimmbar,
//        Missweisung also nicht aus dem Modell ablesbar) – mit schwacher Vorgabe aus WMM entlang der Breite.
// Residuen: (h_ber − h_wahr)/eh und Winkeldiff(Z_ber − (Z_mag + Missweisung))/eZ,
// gelöst mit Levenberg-Marquardt (numerische Jacobi-Matrix) nach Grobsuche über Startwerte.

import { sunGP, altAzFromLHA, apparentToTrue } from './sun.js';
import { distance } from '../../lib/geo.js';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const DAY = 86400000;
const YEAR = 365.2422;
const wrap360 = a => ((a % 360) + 360) % 360;
const wrap180 = a => { a = wrap360(a); return a > 180 ? a - 360 : a; };
const wrapP = (a, half) => { const p = 2 * half; a = ((a + half) % p + p) % p - half; return a; };

/** Tabellenzeile -> Beobachtung. Datum/Zeit als Ortszeit der Gerätezeitzone; Fehlendes aus dem Erfassungszeitpunkt. */
export function rowToObs(row) {
  const b = new Date(row.ts);
  let y = b.getFullYear(), mo = b.getMonth(), d = b.getDate();
  let H = b.getHours(), Mi = b.getMinutes(), S = b.getSeconds(), ms = b.getMilliseconds();
  if (row.date) { const m = row.date.split('-').map(Number); y = m[0]; mo = m[1] - 1; d = m[2]; }
  if (row.time) { const m = row.time.split(':').map(Number); H = m[0]; Mi = m[1] || 0; S = m[2] || 0; ms = 0; }
  return {
    t: new Date(y, mo, d, H, Mi, S, ms).getTime(),
    hasDate: !!row.date, hasTime: !!row.time,
    h: row.h, az: row.az, eh: row.eh, eZ: row.eZ
  };
}

/**
 * Missweisungstabelle (10°-Raster, bilinear, winkelrichtig) aus einer Funktion fn(lat, lon, date).
 * Ohne fn: überall 0.
 */
export function makeDeclTable(fn, date = new Date()) {
  if (!fn) return { at: () => 0, exact: () => 0 };
  const NI = 19, NJ = 37;
  const v = new Float64Array(NI * NJ);
  for (let i = 0; i < NI; i++) {
    for (let j = 0; j < NJ; j++) {
      const lat = Math.max(-89.5, Math.min(89.5, -90 + 10 * i));
      v[i * NJ + j] = fn(lat, -180 + 10 * j, date) || 0;
    }
  }
  return {
    at(lat, lon) {
      const x = (Math.max(-90, Math.min(90, lat)) + 90) / 10;
      const y = (wrap180(lon) + 180) / 10;
      const i = Math.min(NI - 2, Math.floor(x)), j = Math.min(NJ - 2, Math.floor(y));
      const fx = x - i, fy = y - j;
      const a = v[i * NJ + j];
      const b = a + wrap180(v[i * NJ + j + 1] - a);
      const c = a + wrap180(v[(i + 1) * NJ + j] - a);
      const d = a + wrap180(v[(i + 1) * NJ + j + 1] - a);
      return wrap180(a * (1 - fx) * (1 - fy) + b * (1 - fx) * fy + c * fx * (1 - fy) + d * fx * fy);
    },
    exact: (lat, lon) => fn(lat, lon, date) || 0
  };
}

/** Missweisung entlang eines Breitenkreises: zirkulärer Mittelwert und Streuung (Grad). */
function declAlongLat(table, lat) {
  let s = 0, c = 0, n = 0;
  const vals = [];
  for (let lon = -180; lon < 180; lon += 10) {
    const d = table.at(lat, lon);
    vals.push(d);
    s += Math.sin(d * D2R); c += Math.cos(d * D2R); n++;
  }
  const m = Math.atan2(s, c) * R2D;
  const sd = Math.sqrt(vals.reduce((a, d) => a + wrap180(d - m) ** 2, 0) / n);
  return { m0: m, sm: Math.max(2, sd) };
}

// ---------- Modell ----------

function layout(obs) {
  const anyTime = obs.some(o => o.hasTime);
  const allTime = obs.every(o => o.hasTime);
  const L = { lonKnown: anyTime, dtFree: anyTime && !allTime, dFree: obs.some(o => !o.hasDate), mFree: !anyTime, n: 2 };
  if (L.dtFree) L.iDt = L.n++;
  if (L.dFree) L.iD = L.n++;
  if (L.mFree) L.iM = L.n++;
  L.nRes = obs.length * 2 + (L.mFree ? 1 : 0);
  return L;
}

function prep(obs) {
  return obs.map(o => ({ ...o, hTrue: apparentToTrue(o.h) }));
}

/** Zeitpunkt und Stundenwinkelkorrektur einer Beobachtung bei gegebenen Parametern. */
function obsTime(o, p, L) {
  let t = o.t, ghaShift = 0;
  if (L.dtFree && !o.hasTime) t += p[L.iDt] * 3600000;
  if (L.dFree && !o.hasDate) {
    // Datum verschieben, Tageszeit beibehalten: GHA(t + D·Tag) − 360°·D
    t += p[L.iD] * DAY;
    ghaShift = 360 * p[L.iD];
  }
  return { t, ghaShift };
}

function declOf(p, L, ctx) {
  return L.mFree ? p[L.iM] : ctx.table.at(p[0], p[1]) + ctx.corr;
}

function residuals(p, data, L, ctx) {
  const out = new Float64Array(L.nRes);
  const decl = declOf(p, L, ctx);
  let k = 0;
  for (const o of data) {
    const { t, ghaShift } = obsTime(o, p, L);
    const gp = sunGP(t);
    const r = altAzFromLHA(p[0], gp.dec, gp.gha - ghaShift + p[1]);
    out[k++] = (r.alt - o.hTrue) / o.eh;
    out[k++] = wrap180(r.az - (o.az + decl)) / o.eZ;
  }
  if (L.mFree) out[k++] = wrap180(p[L.iM] - ctx.m0) / ctx.sm;
  return out;
}

function normalize(p, L) {
  let lat = p[0], lon = p[1];
  if (lat > 90) { lat = 180 - lat; lon += 180; }
  if (lat < -90) { lat = -180 - lat; lon += 180; }
  p[0] = lat; p[1] = wrap180(lon);
  if (L.dtFree) p[L.iDt] = wrapP(p[L.iDt], 12);
  if (L.dFree) p[L.iD] = wrapP(p[L.iD], YEAR / 2);
  if (L.mFree) p[L.iM] = wrap180(p[L.iM]);
  return p;
}

const ssq = r => { let s = 0; for (const x of r) s += x * x; return s; };

function stepOf(L, i) {
  if (i < 2) return 1e-4;
  if (i === L.iDt) return 1e-4;
  if (i === L.iD) return 1e-3;
  return 1e-4;
}

/** Lineares Gleichungssystem (klein) mit Pivotsuche lösen. */
function solveLin(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-300) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

/** Levenberg-Marquardt. Gibt {p, cost} zurück. */
function lm(p0, data, L, ctx, maxIt = 60) {
  let p = normalize(p0.slice(), L);
  let r = residuals(p, data, L, ctx);
  let cost = ssq(r);
  let lambda = 1e-2;
  const n = L.n, m = r.length;
  for (let it = 0; it < maxIt; it++) {
    // Jacobi-Matrix (zentrale Differenzen)
    const J = Array.from({ length: m }, () => new Float64Array(n));
    for (let j = 0; j < n; j++) {
      const h = stepOf(L, j);
      const pp = p.slice(); pp[j] += h;
      const pm = p.slice(); pm[j] -= h;
      const rp = residuals(pp, data, L, ctx), rm = residuals(pm, data, L, ctx);
      for (let i = 0; i < m; i++) J[i][j] = (rp[i] - rm[i]) / (2 * h);
    }
    const A = Array.from({ length: n }, () => new Array(n).fill(0));
    const g = new Array(n).fill(0);
    for (let i = 0; i < m; i++) {
      for (let a = 0; a < n; a++) {
        g[a] += J[i][a] * r[i];
        for (let b = a; b < n; b++) A[a][b] += J[i][a] * J[i][b];
      }
    }
    for (let a = 0; a < n; a++) for (let b = 0; b < a; b++) A[a][b] = A[b][a];
    let improved = false, stepSize = 0;
    while (lambda < 1e10) {
      const Ad = A.map((row, a) => row.map((v, b) => a === b ? v + lambda * (v + 1e-6) : v));
      const d = solveLin(Ad, g.map(v => -v));
      if (!d || d.some(v => !Number.isFinite(v))) { lambda *= 10; continue; }
      // Schrittweite begrenzen (Grad, Stunden, Tage)
      const big = Math.max(...d.map(Math.abs));
      const sc = big > 30 ? 30 / big : 1;
      const pn = normalize(p.map((v, i) => v + d[i] * sc), L);
      const rn = residuals(pn, data, L, ctx);
      const cn = ssq(rn);
      if (cn < cost) {
        stepSize = big * sc;
        const rel = (cost - cn) / Math.max(cost, 1e-12);
        p = pn; r = rn; cost = cn;
        lambda = Math.max(lambda / 4, 1e-9);
        improved = rel > 1e-10;
        break;
      }
      lambda *= 6;
    }
    if (!improved || stepSize < 1e-7 || cost < 1e-14) break;
  }
  return { p, cost };
}

// ---------- Startwerte ----------

/** Geschlossene Lösung aus einer Messung: Breiten (bis zu 2) und Längen aus δ, GHA, h, Az (rechtweisend). */
function closedForm(dec, gha, h, az) {
  const hh = h * D2R, A = az * D2R, d = dec * D2R;
  const a = Math.sin(hh), b = Math.cos(hh) * Math.cos(A);
  const rho = Math.hypot(a, b);
  const psi = Math.atan2(b, a);
  const s = Math.asin(Math.max(-1, Math.min(1, Math.sin(d) / rho)));
  const res = [];
  for (const x of [s - psi, Math.PI - s - psi]) {
    const phi = Math.atan2(Math.sin(x), Math.cos(x));
    if (Math.abs(phi) > Math.PI / 2) continue;
    const sinT = -Math.sin(A) * Math.cos(hh) / Math.cos(d);
    const cosT = (Math.sin(hh) - Math.sin(phi) * Math.sin(d)) / (Math.cos(phi) * Math.cos(d));
    const lha = Math.atan2(sinT, cosT) * R2D;
    res.push([phi * R2D, wrap180(lha - gha)]);
  }
  return res;
}

function candidates(data, L, ctx) {
  const Dgrid = [];
  if (L.dFree) for (let D = -180; D <= 180; D += 10) Dgrid.push(D);
  else Dgrid.push(0);
  const dtGrid = [];
  if (L.dtFree) for (let x = -12; x < 12; x += 0.5) dtGrid.push(x);
  else dtGrid.push(0);
  const anchors = data.filter(o => !L.dtFree || o.hasTime).slice(0, 3);
  const out = [];
  for (const D of Dgrid) {
    for (const o of anchors) {
      const p = new Array(L.n).fill(0);
      if (L.dFree) p[L.iD] = D;
      const { t, ghaShift } = obsTime(o, p, L);
      const gp = sunGP(t);
      const gha = gp.gha - ghaShift;
      // Missweisung am (noch unbekannten) Ort: zweimal nachführen
      let sols = closedForm(gp.dec, gha, o.hTrue, o.az);
      for (let k = 0; k < 2; k++) {
        sols = sols.flatMap(([lat, lon]) => {
          const dcl = L.mFree ? declAlongLat(ctx.table, lat).m0 : ctx.table.at(lat, lon) + ctx.corr;
          return closedForm(gp.dec, gha, o.hTrue, o.az + dcl);
        });
        // Duplikate grob entfernen
        sols = sols.filter((s, i) => sols.findIndex(q => Math.abs(q[0] - s[0]) < 0.5 && Math.abs(wrap180(q[1] - s[1])) < 0.5) === i);
      }
      for (const [lat, lon] of sols) {
        const q = p.slice();
        q[0] = lat; q[1] = lon;
        if (L.mFree) {
          const pr = declAlongLat(ctx.table, lat);
          q[L.iM] = pr.m0;
        }
        let best = null;
        for (const dt of dtGrid) {
          if (L.dtFree) q[L.iDt] = dt;
          const c = ssq(residuals(q, data, L, ctx));
          if (!best || c < best.cost) best = { cost: c, p: q.slice() };
        }
        out.push(best);
      }
    }
  }
  out.sort((a, b) => a.cost - b.cost);
  return out;
}

function sameSolution(a, b, L) {
  const d = distance(a.p[0], L.lonKnown ? a.p[1] : 0, b.p[0], L.lonKnown ? b.p[1] : 0);
  if (d > 30000) return false;
  if (L.dFree && Math.abs(wrapP(a.p[L.iD] - b.p[L.iD], YEAR / 2)) > 3) return false;
  return true;
}

/** Missweisung iterativ nachführen (exakter Wert am Schätzort) und erneut lösen. */
function refine(sol, data, L, ctx0) {
  const ctx = { ...ctx0 };
  let r = sol;
  for (let k = 0; k < 3; k++) {
    if (L.mFree) Object.assign(ctx, declAlongLat(ctx.table, r.p[0]));
    else ctx.corr = wrap180(ctx.table.exact(r.p[0], r.p[1]) - ctx.table.at(r.p[0], r.p[1]));
    r = lm(r.p, data, L, ctx);
  }
  return { ...r, ctx };
}

function describe(sol, data, L) {
  const res = residuals(sol.p, data, L, sol.ctx);
  const nObs = data.length * 2;
  let s = 0, worst = 0;
  for (let i = 0; i < nObs; i++) { s += res[i] * res[i]; worst = Math.max(worst, Math.abs(res[i])); }
  const p = sol.p;
  return {
    p: p.slice(), ctx: sol.ctx,
    lat: p[0], lon: L.lonKnown ? p[1] : null,
    dtMin: L.dtFree ? p[L.iDt] * 60 : null,
    dDays: L.dFree ? p[L.iD] : null,
    decl: declOf(p, L, sol.ctx),
    rms: Math.sqrt(s / nObs), worst,
    resid: Array.from(res.slice(0, nObs))
  };
}

/**
 * Hauptlösung (+ Alternativen) bestimmen.
 * obs: [{t, hasDate, hasTime, h (scheinbar), az (magnetisch), eh, eZ}]
 * opts: {table: makeDeclTable(...)}
 */
export function solve(obs, opts = {}) {
  if (!obs.length) return { ok: false, reason: 'Keine Messungen' };
  const data = prep(obs);
  const L = layout(data);
  const table = opts.table || makeDeclTable(null);
  const ctx = { table, corr: 0, m0: 0, sm: 5 };
  if (L.mFree) Object.assign(ctx, declAlongLat(table, 0));

  const cands = candidates(data, L, ctx);
  const picked = [];
  for (const c of cands) {
    if (picked.length >= 12) break;
    if (!picked.some(q => sameSolution(q, c, L))) picked.push(c);
  }
  let sols = picked.map(c => refine(lm(c.p, data, L, ctx), data, L, ctx));
  sols.sort((a, b) => a.cost - b.cost);
  const uniq = [];
  for (const s of sols) if (!uniq.some(q => sameSolution(q, s, L))) uniq.push(s);
  if (!uniq.length) return { ok: false, reason: 'Keine Lösung' };

  const nEq = data.length * 2 + (L.mFree ? 1 : 0);
  const under = nEq < L.n;
  const main = describe(uniq[0], data, L);
  const alternatives = [];
  if (!under) {
    for (const s of uniq.slice(1)) {
      const d = describe(s, data, L);
      if (d.rms <= Math.max(1.2, main.rms * 1.5 + 0.3) && alternatives.length < 3) alternatives.push(d);
    }
  }
  const notes = [];
  if (!L.lonKnown) notes.push('Länge unbestimmt (keine Uhrzeit)');
  if (L.mFree) notes.push('Missweisung unbekannt (Länge fehlt) – aus Messung geschätzt');
  if (under) notes.push(L.dFree ? 'Unterbestimmt: ohne Datum mehrere Messungen über einige Stunden nötig' : 'Unterbestimmt: weitere Messungen nötig');
  else if (L.dFree && data.length < 3) notes.push('Ohne Datum: Ergebnis schwach bestimmt – mehr Messungen über einige Stunden verbessern es');
  if (main.rms > 1.5) notes.push('Messungen passen schlecht zusammen (Residuen über den Fehlergrenzen)');
  if (alternatives.length) notes.push('Mehrdeutig: ' + (alternatives.length === 1 ? 'eine weitere Lösung' : alternatives.length + ' weitere Lösungen') + ' möglich');
  return { ok: true, ...main, lonKnown: L.lonKnown, layout: L, underdetermined: under, nObs: data.length, alternatives, notes };
}

// ---------- Monte Carlo ----------

/**
 * Streuung der Lösung durch gleichverteilte Störung der Messwerte innerhalb ±eh/±eZ.
 * Nuisance-Parameter werden zufällig initialisiert. Läuft in Häppchen (setTimeout).
 * Ergebnis: {radius (m), latHalf (Grad), alts:[{radius, latHalf}], center:{lat, lon}, runs, used}
 */
export function monteCarlo(obs, sol, opts = {}) {
  const runs = opts.runs ?? 200, chunk = opts.chunk ?? 10;
  const rng = opts.rng || Math.random;
  const data = prep(obs);
  const L = sol.layout;
  const table = sol.ctx.table;
  const centers = [sol, ...sol.alternatives];
  const pts = [];
  const lim = Math.max(2, 2 * sol.rms + 0.5);
  const U = () => 2 * rng() - 1;

  function oneRun() {
    const pert = data.map(o => {
      const h = o.h + U() * o.eh;
      return { ...o, h, hTrue: apparentToTrue(h), az: o.az + U() * o.eZ };
    });
    const ctx = { ...sol.ctx };
    const p = sol.p.slice();
    if (L.dFree) p[L.iD] = U() * YEAR / 2;
    if (L.dtFree) p[L.iDt] = U() * 12;
    if (L.mFree) {
      // Missweisung an zufälliger Länge auf der geschätzten Breite
      ctx.m0 = table.at(sol.lat, U() * 180);
      ctx.sm = 1;
      p[L.iM] = ctx.m0;
    }
    let r = lm(p, pert, L, ctx);
    let ok = Math.sqrt(ssq(residuals(r.p, pert, L, ctx).slice(0, pert.length * 2)) / (pert.length * 2)) <= lim;
    if (!ok) {
      const q = sol.p.slice();
      if (L.mFree) q[L.iM] = ctx.m0;
      r = lm(q, pert, L, ctx);
      ok = Math.sqrt(ssq(residuals(r.p, pert, L, ctx).slice(0, pert.length * 2)) / (pert.length * 2)) <= lim;
    }
    if (ok) pts.push({ lat: r.p[0], lon: r.p[1] });
  }

  function summarize() {
    const lonOf = c => L.lonKnown ? c.lon : 0;
    let center = { lat: sol.lat, lon: lonOf(sol) };
    if (sol.underdetermined && pts.length > 4) {
      // unterbestimmt: Medoid der Punktwolke als Mittelpunkt
      let best = Infinity;
      for (const a of pts) {
        let s = 0;
        for (const b of pts) s += L.lonKnown ? distance(a.lat, a.lon, b.lat, b.lon) : Math.abs(a.lat - b.lat);
        if (s < best) { best = s; center = { lat: a.lat, lon: L.lonKnown ? a.lon : 0 }; }
      }
    }
    const cs = centers.map((c, i) => (i === 0 ? center : { lat: c.lat, lon: lonOf(c) }));
    const groups = cs.map(() => []);
    for (const q of pts) {
      let bi = 0, bd = Infinity;
      cs.forEach((c, i) => {
        const d = L.lonKnown ? distance(q.lat, q.lon, c.lat, c.lon) : Math.abs(q.lat - c.lat) * 111195;
        if (d < bd) { bd = d; bi = i; }
      });
      groups[bi].push({ d: L.lonKnown ? distance(q.lat, q.lon, cs[bi].lat, cs[bi].lon) : NaN, dl: Math.abs(q.lat - cs[bi].lat) });
    }
    const q95 = arr => { if (!arr.length) return NaN; const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(0.95 * s.length))]; };
    const stats = groups.map(g => ({ radius: q95(g.map(x => x.d)), latHalf: q95(g.map(x => x.dl)), count: g.length }));
    const main = stats[0];
    for (const s of stats.slice(1)) if (s.count < 5) { s.radius = main.radius; s.latHalf = main.latHalf; }
    return { radius: main.radius, latHalf: main.latHalf, center, alts: stats.slice(1), runs, used: pts.length, points: pts };
  }

  return new Promise(resolve => {
    let done = 0;
    function step() {
      if (opts.isCancelled && opts.isCancelled()) { resolve(null); return; }
      const end = Math.min(runs, done + chunk);
      for (; done < end; done++) oneRun();
      opts.onProgress && opts.onProgress(done / runs);
      if (done < runs) setTimeout(step, 0);
      else resolve(summarize());
    }
    step();
  });
}
