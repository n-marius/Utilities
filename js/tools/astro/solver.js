// Ortsbestimmung aus Peilungen von Sonne, Sternen und Planeten (Höhe + magnetischer Azimut), ohne DOM.
//
// Modell je Messung i: Körper (bodies.js), Zeitpunkt t_i (UTC), scheinbare Höhe h_i, magnetischer
// Azimut Z_i, Fehlergrenzen eh_i/eZ_i (= 0,5° + Sensor, als harte Grenzen verstanden).
// Unbekannte: Breite, Länge und je nach Datenlage
//  - dt: gemeinsamer Uhrversatz (h) der Zeilen ohne Uhrzeit, falls andere Zeilen eine Uhrzeit haben,
//  - D:  gemeinsamer Datumsversatz (Tage) der Zeilen ohne Datum,
//  - m:  Missweisung als Unbekannte, wenn keine Zeile eine Uhrzeit hat (Länge dann unbestimmbar,
//        Missweisung also nicht aus dem Modell ablesbar) – mit schwacher Vorgabe aus WMM entlang der Breite.
//  - δ:  gemeinsamer systematischer Kompassversatz (Option compassBias, ab 3 Messungen). Dann gilt je
//        Messung nur die zufällige Azimutgrenze eZr = 0,5° + 2σ; der systematische Anteil (iOS-Kompass-
//        genauigkeit) wird durch δ ersetzt. Kompassdeviation ist teils richtungsabhängig, ein gemeinsamer
//        Versatz ist eine Näherung: bei Azimutspreizung > 90° bleibt je Messung eine Restgrenze von 2°.
// Residuen: (h_ber − h_wahr)/eh und Winkeldiff(Z_ber − (Z_mag + Missweisung + δ))/eZ.
// 1) solve(): Kandidaten = lokale Minima der Fehlerquadratsumme (Levenberg-Marquardt nach Grobsuche).
// 2) analyze(): Mengen-Ansatz. Lösungsbereich = alle Orte, an denen JEDE Messung innerhalb ihrer
//    Grenze erfüllt ist (max |r_i| ≤ 1). Bestimmt per Monte Carlo (Störung innerhalb der Grenzen,
//    nur zulässige Lösungen bleiben) plus Gitterprüfung um jeden Kandidaten. Leere Menge = widersprüchlich.

import { altAzFromLHA, apparentToTrue } from './sun.js';
import { bodyGP, bodyName } from './bodies.js';
import { PLANETS } from './catalog.js';
import { distance, destination } from '../../lib/geo.js';

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
    hasDate: !!row.date, hasTime: !!row.time, body: row.body || 'sun',
    h: row.h, az: row.az, eh: row.eh, eZ: row.eZ,
    // zufälliger Anteil der Azimutgrenze (0,5° + 2σ); ältere Zeilen ohne getrennte Angabe: ohne Gerätewert
    // ist eZ bereits zufällig, mit Gerätewert (iOS) und unbekanntem 2σ wird 2σ = 0 angenommen
    eZr: row.eZr ?? (row.acc == null || !(row.sZ <= row.acc) ? row.eZ : 0.5)
  };
}

/**
 * Missweisungstabelle (10°-Raster, bikubisch nach Catmull-Rom, winkelrichtig) aus fn(lat, lon, date).
 * Glatt (C1), damit der Ausgleich nicht an Rasterkanten hängen bleibt. Ohne fn: überall 0.
 */
export function makeDeclTable(fn, date = new Date()) {
  if (!fn) return { at: () => 0, exact: () => 0 };
  const NI = 19, NJ = 36;
  const v = new Float64Array(NI * NJ);
  for (let i = 0; i < NI; i++) {
    for (let j = 0; j < NJ; j++) {
      const lat = Math.max(-89.5, Math.min(89.5, -90 + 10 * i));
      v[i * NJ + j] = fn(lat, -180 + 10 * j, date) || 0;
    }
  }
  const cr = (p0, p1, p2, p3, t) =>
    p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
  return {
    at(lat, lon) {
      const x = (Math.max(-90, Math.min(90, lat)) + 90) / 10;
      const y = (wrap180(lon) + 180) / 10;
      const i = Math.min(NI - 2, Math.floor(x)), j = Math.floor(y) % NJ;
      const fx = x - i, fy = y - j;
      const ref = v[i * NJ + j];
      const val = (ii, jj) => {
        ii = Math.max(0, Math.min(NI - 1, ii));
        jj = ((jj % NJ) + NJ) % NJ;
        return ref + wrap180(v[ii * NJ + jj] - ref);
      };
      const col = [];
      for (let a = -1; a <= 2; a++) col.push(cr(val(i + a, j - 1), val(i + a, j), val(i + a, j + 1), val(i + a, j + 2), fy));
      return wrap180(cr(col[0], col[1], col[2], col[3], fx));
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

export const BIAS_MIN_OBS = 3;
export const BIAS_REST = 2;      // Restgrenze je Messung bei Azimutspreizung > 90° (richtungsabhängige Deviation)
export const BIAS_WARN = 30;     // |δ| darüber: unplausibel

function layout(obs, opts = {}) {
  const anyTime = obs.some(o => o.hasTime);
  const allTime = obs.every(o => o.hasTime);
  const L = { lonKnown: anyTime, dtFree: anyTime && !allTime, dFree: obs.some(o => !o.hasDate), mFree: !anyTime, n: 2 };
  const bias = !!opts.compassBias && obs.length >= BIAS_MIN_OBS;
  // ohne Uhrzeit ist die Missweisung m ohnehin frei: Versatz und Missweisung sind dann nicht trennbar,
  // m übernimmt beides (Vorgabe aus WMM entfällt)
  L.biasFree = bias && !L.mFree;
  L.mOpen = bias && L.mFree;
  if (L.dtFree) L.iDt = L.n++;
  if (L.dFree) L.iD = L.n++;
  if (L.mFree) L.iM = L.n++;
  if (L.biasFree) L.iB = L.n++;
  L.nRes = obs.length * 2 + (L.mFree ? 1 : 0);
  return L;
}

/** Azimutspreizung (Grad): 360° minus größte Lücke der gemessenen Azimute. */
function azSpread(data) {
  const a = data.map(o => wrap360(o.az)).sort((x, y) => x - y);
  if (a.length < 2) return 0;
  let gap = 360 - a[a.length - 1] + a[0];
  for (let i = 1; i < a.length; i++) gap = Math.max(gap, a[i] - a[i - 1]);
  return 360 - gap;
}

/** Wirksame Azimutgrenze je Messung festlegen (mit Versatzschätzung: nur zufälliger Anteil + ggf. Restgrenze). */
function azBounds(data, L) {
  L.spread = azSpread(data);
  L.rest = (L.biasFree || L.mOpen) && L.spread > 90 ? BIAS_REST : 0;
  for (const o of data) o.eZe = (L.biasFree || L.mOpen) ? Math.min(o.eZ, (o.eZr ?? o.eZ)) + L.rest : o.eZ;
  return data;
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

const biasOf = (p, L) => (L.biasFree ? p[L.iB] : 0);

function residualsRaw(p, data, L, ctx) {
  const out = new Float64Array(L.nRes);
  const decl = declOf(p, L, ctx) + biasOf(p, L);
  let k = 0;
  for (const o of data) {
    const { t, ghaShift } = obsTime(o, p, L);
    const gp = bodyGP(o.body, t);
    const r = altAzFromLHA(p[0], gp.dec, gp.gha - ghaShift + p[1]);
    out[k++] = (r.alt - o.hTrue) / o.eh;
    out[k++] = wrap180(r.az - (o.az + decl)) / (o.eZe ?? o.eZ);
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
  if (L.biasFree) p[L.iB] = wrap180(p[L.iB]);
  return p;
}

const residuals = residualsRaw;
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

/**
 * Levenberg-Marquardt. Gibt {p, cost} zurück.
 * power = 4: minimiert Σ r^8 (Näherung an min max |r|, für die Zulässigkeitsprüfung).
 */
function lm(p0, data, L, ctx, maxIt = 60, power = 1) {
  const residuals = power === 1 ? residualsRaw : (q, d, l, c) => residualsRaw(q, d, l, c).map(x => Math.sign(x) * Math.abs(x) ** power);
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
  const Bgrid = L.biasFree ? [-20, -8, 0, 8, 20] : [0];
  const out = [];
  for (const D of Dgrid) for (const B of Bgrid) {
    for (const o of anchors) {
      const p = new Array(L.n).fill(0);
      if (L.dFree) p[L.iD] = D;
      if (L.biasFree) p[L.iB] = B;
      const { t, ghaShift } = obsTime(o, p, L);
      const gp = bodyGP(o.body, t);
      const gha = gp.gha - ghaShift;
      // Missweisung am (noch unbekannten) Ort: zweimal nachführen
      let sols = closedForm(gp.dec, gha, o.hTrue, o.az + B);
      for (let k = 0; k < 2; k++) {
        sols = sols.flatMap(([lat, lon]) => {
          const dcl = L.mFree ? declAlongLat(ctx.table, lat).m0 : ctx.table.at(lat, lon) + ctx.corr;
          return closedForm(gp.dec, gha, o.hTrue, o.az + dcl + B);
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
    if (L.mFree) Object.assign(ctx, declAlongLat(ctx.table, r.p[0]), L.mOpen ? { sm: 1e3 } : {});
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
    bias: L.biasFree ? p[L.iB] : null,
    rms: Math.sqrt(s / nObs), worst,
    resid: Array.from(res.slice(0, nObs))
  };
}


/** Größtes normiertes Residuum der Messungen (ohne Vorgabe für m). ≤ 1: alle Messungen in ihren Grenzen. */
function fmax(p, data, L, ctx) {
  const r = residualsRaw(p, data, L, ctx);
  let w = 0;
  for (let i = 0; i < data.length * 2; i++) w = Math.max(w, Math.abs(r[i]));
  return w;
}

/** Einzelprüfung jeder Zeile (unabhängig vom Ort). Gibt je Zeile null oder {bad, text}. */
export function checkRows(obs) {
  return obs.map(o => {
    if (![o.h, o.az, o.eh, o.eZ, o.t].every(Number.isFinite)) return { bad: true, text: 'Unvollständige Messwerte' };
    if (o.h < -1 || o.h > 90) return { bad: true, text: 'Höhe außerhalb −1° … 90° – an keinem Ort möglich' };
    if (o.h < 3) return { bad: false, text: 'Sehr tief: Refraktion unsicher' };
    if (o.h > 80) return { bad: false, text: 'Sehr hoch: Azimut unsicher' };
    return null;
  });
}

/**
 * Kandidaten bestimmen.
 * obs: [{t, hasDate, hasTime, body, h (scheinbar), az (magnetisch), eh, eZ}]
 * opts: {table: makeDeclTable(...), compassBias?: gemeinsamen Kompassversatz δ mitschätzen (ab 3 Messungen)}
 * Ergebnis: {ok, solutions:[Kandidaten], used:[Indizes der verwendeten Zeilen], flags:[je Zeile], layout, notes, …}
 */
export function solve(obsAll, opts = {}) {
  const flags = checkRows(obsAll);
  const used = obsAll.map((o, i) => i).filter(i => !(flags[i] && flags[i].bad));
  if (!used.length) return { ok: false, reason: obsAll.length ? 'Keine plausiblen Messungen' : 'Keine Messungen', flags, used };
  const data = prep(used.map(i => obsAll[i]));
  const L = layout(data, opts);
  azBounds(data, L);
  const table = opts.table || makeDeclTable(null);
  const ctx = { table, corr: 0, m0: 0, sm: 5 };
  if (L.mFree) Object.assign(ctx, declAlongLat(table, 0), L.mOpen ? { sm: 1e3 } : {});

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
  if (!uniq.length) return { ok: false, reason: 'Keine Lösung', flags, used };

  const nEq = data.length * 2 + (L.mFree ? 1 : 0);
  const under = nEq < L.n;
  // Vorauswahl der Kandidaten (lokale Minima): statistisch gleichwertig (χ² = 4·Σr², e ≈ 2σ, Δχ² < 4)
  // oder Residuen nicht grob außerhalb der Grenzen. Ob ein Kandidat wirklich zulässig ist, entscheidet analyze().
  const all = uniq.map(s => ({ ...describe(s, data, L), cost: s.cost }));
  const best = 4 * all[0].cost;
  const solutions = (under ? all.slice(0, 1) : all.filter(d => 4 * d.cost - best < 4 || d.worst <= 2)).slice(0, 8);
  const notes = [];
  if (!L.lonKnown) notes.push('Ohne absolute Uhrzeit ist die Länge nicht bestimmbar – auch nicht aus mehreren Messungen mit bekannten Zeitabständen, da eine Zeitverschiebung exakt einer Längenverschiebung entspricht.');
  if (L.mFree) notes.push('Missweisung unbekannt (Länge fehlt) – aus Messung geschätzt');
  if (L.dFree && data.some(o => !o.hasDate && o.body !== 'sun')) notes.push('Ohne Datum ist die Länge aus Sternen/Planeten kaum bestimmbar (Sternzeit verschiebt sich um ~1° pro Tag).');
  if (under) notes.push(L.dFree ? 'Unterbestimmt: ohne Datum mehrere Messungen über einige Stunden nötig' : 'Unterbestimmt: weitere Messungen nötig');
  else if (L.dFree && data.length < 3) notes.push('Ohne Datum: Ergebnis schwach bestimmt – mehr Messungen verbessern es');
  if (L.biasFree) notes.push('Kompassversatz wird mitgeschätzt (gemeinsamer Versatz – Näherung, Deviation ist teils richtungsabhängig).' +
    (L.rest ? ` Azimute über ${Math.round(L.spread)}° verteilt: je Messung ${BIAS_REST}° Restgrenze.` : ''));
  if (L.mOpen) notes.push('Kompassversatz und Missweisung sind ohne Uhrzeit nicht trennbar – gemeinsam geschätzt.');
  const nBad = flags.filter(f => f && f.bad).length;
  if (nBad) notes.push(`${nBad === 1 ? 'Eine Messung' : nBad + ' Messungen'} unplausibel und nicht verwendet`);
  return { ok: true, ...solutions[0], solutions, lonKnown: L.lonKnown, layout: L, underdetermined: under, nObs: data.length, used, flags, notes,
    eZused: data.map(o => o.eZe) };
}

// ---------- Lösungsbereich (Mengen-Ansatz) ----------

/**
 * Lösungsbereich bestimmen. Monte Carlo: Messwerte gleichverteilt innerhalb ±eh/±eZ (= je Zeile genau
 * ±(0,5° + Sensor)) stören, Nuisance-Parameter zufällig initialisieren, lösen; eine Probe zählt nur,
 * wenn ihre Lösung ALLE Originalmessungen innerhalb der Grenzen erfüllt. Zusätzlich Gitter um jeden
 * Kandidaten (Ringe/Peilungen, adaptiv vergrößert bzw. verfeinert) mit derselben Zulässigkeitsprüfung.
 * Bereich je Lösung: Mittelpunkt (zulässiger Kandidat bzw. Minimax-Punkt) und größter Abstand
 * zulässiger Punkte (Radius, m) bzw. Breitenausdehnung (latHalf, Grad).
 * Ergebnis: {regions:[…], inconsistent, lonOpen (Länge praktisch offen -> Band), rowFlags:{Index: Text}, accepted, runs, points}
 */
export function analyze(obsAll, sol, opts = {}) {
  const runs = opts.runs ?? 200, chunk = opts.chunk ?? 10;
  const rng = opts.rng || Math.random;
  const L = sol.layout;
  const data = azBounds(prep(sol.used.map(i => obsAll[i])), L);
  const cands = sol.solutions.map(c => ({ ...c, F: fmax(c.p, data, L, c.ctx) }));
  const pts = [];
  const U = () => 2 * rng() - 1;
  let k = 0, accepted = 0;
  const dist = (a, b) => L.lonKnown ? distance(a.lat, a.lon, b.lat, b.lon) : Math.abs(a.lat - b.lat) * 111195;

  // Minimax-Punkt je Kandidat, falls das Ausgleichsminimum selbst nicht zulässig ist
  for (const c of cands) {
    c.center = c.p;
    if (c.F > 1) {
      const mm = lm(c.p, data, L, c.ctx, 80, 4);
      const Fm = fmax(mm.p, data, L, c.ctx);
      if (Fm < c.F) { c.center = mm.p; c.F = Fm; }
    }
  }

  function oneRun() {
    const pert = data.map(o => {
      const h = o.h + U() * o.eh;
      return { ...o, h, hTrue: apparentToTrue(h), az: o.az + U() * o.eZe };
    });
    const c = cands[k++ % cands.length];
    const ctx = { ...c.ctx };
    const p = c.p.slice();
    if (L.dFree) p[L.iD] = U() * YEAR / 2;
    if (L.dtFree) p[L.iDt] = U() * 12;
    if (L.mFree && !L.mOpen) {
      // Missweisung an zufälliger Länge auf der geschätzten Breite
      ctx.m0 = ctx.table.at(c.lat, U() * 180);
      ctx.sm = 1;
      p[L.iM] = ctx.m0;
    }
    for (const start of [p, c.p]) {
      const r = lm(start, pert, L, ctx);
      if (fmax(r.p, data, L, c.ctx) <= 1) { pts.push({ lat: r.p[0], lon: r.p[1], bias: biasOf(r.p, L) }); accepted++; return; }
    }
  }

  /** Gitter um den Kandidaten (Nuisance-Parameter fest): zulässige Punkte. */
  function gridScan(c) {
    const p0 = c.center;
    const K = 24, B = 36;
    let R = 300e3, grew = false, out = [];
    for (let it = 0; it < 10; it++) {
      const feas = [];
      let maxRing = 0;
      for (let ring = 1; ring <= K; ring++) {
        for (let b = 0; b < B; b++) {
          const [lat, lon] = destination(p0[0], p0[1], b * 360 / B, R * ring / K);
          const q = p0.slice(); q[0] = lat; q[1] = lon;
          if (fmax(q, data, L, c.ctx) <= 1) { feas.push({ lat, lon, bias: biasOf(q, L) }); maxRing = ring; }
        }
      }
      out = feas;
      if (maxRing === K && R < 15000e3) { R *= 3; grew = true; continue; }
      if (!grew && maxRing <= 3 && c.F <= 1 && R > 2000) { R /= 4; continue; }
      break;
    }
    return out;
  }

  function summarize() {
    for (const c of cands) for (const q of gridScan(c)) pts.push(q);
    const centers = cands.map(c => ({ lat: c.center[0], lon: L.lonKnown ? c.center[1] : 0 }));
    const groups = cands.map(() => []);
    for (const q of pts) {
      let bi = 0, bd = Infinity;
      centers.forEach((c, i) => { const d = dist(q, c); if (d < bd) { bd = d; bi = i; } });
      groups[bi].push(q);
    }
    let regions = [];
    cands.forEach((c, i) => {
      const g = groups[i];
      if (!g.length && c.F > 1) return; // keine zulässigen Orte: kein Lösungsbereich
      let ctr = centers[i];
      if (c.F > 1 && g.length) {
        // Mittelpunkt nicht zulässig: Medoid der zulässigen Punkte
        let best = Infinity;
        for (const a of g) { let s = 0; for (const b of g) s += dist(a, b); if (s < best) { best = s; ctr = { lat: a.lat, lon: L.lonKnown ? a.lon : 0 }; } }
      } else if (sol.underdetermined && g.length > 4) {
        let best = Infinity;
        for (const a of g) { let s = 0; for (const b of g) s += dist(a, b); if (s < best) { best = s; ctr = { lat: a.lat, lon: L.lonKnown ? a.lon : 0 }; } }
      }
      let radius = 0, latHalf = 0, bMin = Infinity, bMax = -Infinity;
      for (const q of g) {
        radius = Math.max(radius, dist(q, ctr)); latHalf = Math.max(latHalf, Math.abs(q.lat - ctr.lat));
        bMin = Math.min(bMin, q.bias); bMax = Math.max(bMax, q.bias);
      }
      regions.push({
        lat: ctr.lat, lon: L.lonKnown ? ctr.lon : null,
        radius: L.lonKnown ? radius : NaN, latHalf, count: g.length,
        decl: c.decl, dDays: c.dDays, dtMin: c.dtMin, tight: c.worst > 1, src: i,
        bias: L.biasFree ? biasOf(c.center, L) : null,
        biasRange: L.biasFree && g.length ? [bMin, bMax] : null
      });
    });
    // überlappende Bereiche (gleiche Talsohle) zusammenfassen – der Kreis umschließt beide
    regions.sort((a, b) => b.count - a.count);
    const merged = [];
    for (const r of regions) {
      const host = merged.find(m => L.lonKnown ? distance(m.lat, m.lon, r.lat, r.lon) <= m.radius : Math.abs(m.lat - r.lat) <= m.latHalf);
      if (host) {
        if (L.lonKnown) host.radius = Math.max(host.radius, distance(host.lat, host.lon, r.lat, r.lon) + r.radius);
        host.latHalf = Math.max(host.latHalf, Math.abs(host.lat - r.lat) + r.latHalf);
        host.count += r.count;
        if (host.biasRange && r.biasRange) host.biasRange = [Math.min(host.biasRange[0], r.biasRange[0]), Math.max(host.biasRange[1], r.biasRange[1])];
      } else merged.push({ ...r });
    }
    regions = merged.sort((a, b) => a.src - b.src);

    // Zulässige Orte über mehr als die halbe Erde verteilt (z. B. nur Polaris, Sterne ohne Datum):
    // Länge praktisch offen -> als Breitenband darstellen statt als Kreise.
    let lonOpen = false;
    if (L.lonKnown && pts.length > 10) {
      const lons = pts.map(q => ((q.lon % 360) + 360) % 360).sort((a, b) => a - b);
      let gap = 360 - lons[lons.length - 1] + lons[0];
      for (let j = 1; j < lons.length; j++) gap = Math.max(gap, lons[j] - lons[j - 1]);
      if (360 - gap > 180) {
        lonOpen = true;
        const lats = pts.map(q => q.lat).sort((a, b) => a - b);
        const lo = lats[0], hi = lats[lats.length - 1];
        regions = [{ lat: (lo + hi) / 2, lon: null, radius: NaN, latHalf: (hi - lo) / 2, count: pts.length,
          decl: null, dDays: null, dtMin: null, tight: false, src: 0,
          bias: L.biasFree ? cands[0].bias : null,
          biasRange: L.biasFree ? [Math.min(...pts.map(q => q.bias)), Math.max(...pts.map(q => q.bias))] : null }];
      }
    }

    const rowFlags = {};
    const swaps = {};
    const inconsistent = !regions.length;
    const main = sol.solutions[0];
    if (inconsistent || main.worst > 1) {
      // größte normierte Abweichungen an der besten Ausgleichslösung
      const per = data.map((o, j) => Math.max(Math.abs(main.resid[2 * j]), Math.abs(main.resid[2 * j + 1])));
      const order = per.map((v, j) => j).sort((a, b) => per[b] - per[a]);
      for (const j of order.slice(0, inconsistent ? 2 : 1)) {
        if (per[j] > 1) rowFlags[sol.used[j]] = `Abweichung ${per[j].toFixed(1)}× Fehlergrenze`;
      }
      // Weglassprobe: welche einzelne Zeile macht den Rest widerspruchsfrei?
      if (inconsistent && data.length >= 2) {
        const sus = [];
        for (let j = 0; j < data.length && data.length >= 3; j++) {
          const rest = data.filter((_, x) => x !== j);
          const r = lm(main.p, rest, L, main.ctx);
          if (fmax(r.p, rest, L, main.ctx) <= 1) sus.push(sol.used[j]);
        }
        // Verwechslung? Widersprüchliche Planetenmessung probeweise einem anderen Planeten zuordnen
        for (let j = 0; j < data.length; j++) {
          if (!String(data[j].body).startsWith('planet:')) continue;
          for (const pl of PLANETS) {
            const alt = 'planet:' + pl.id;
            if (alt === data[j].body) continue;
            const swapped = data.map((o, x) => (x === j ? { ...o, body: alt } : o));
            const r = lm(main.p, swapped, L, main.ctx);
            if (fmax(r.p, swapped, L, main.ctx) <= 1) {
              swaps[sol.used[j]] = `Passt zu ${bodyName(alt)} statt ${bodyName(data[j].body)} – Verwechslung?`;
              break;
            }
          }
        }
        if (sus.length) {
          // eindeutige Kandidaten gefunden: nur diese markieren
          for (const key of Object.keys(rowFlags)) delete rowFlags[key];
          for (const j of sus) rowFlags[j] = 'Vermutlich Ausreißer: ohne diese Zeile sind die übrigen Messungen widerspruchsfrei';
        }
        for (const [j, t] of Object.entries(swaps)) rowFlags[j] = t;
      }
    }
    return { regions, inconsistent, lonOpen, rowFlags, accepted, runs, points: pts };
  }

  return new Promise(resolve => {
    let done = 0;
    function step() {
      if (opts.isCancelled && opts.isCancelled()) { resolve(null); return; }
      const end = Math.min(runs, done + chunk);
      for (; done < end; done++) oneRun();
      opts.onProgress && opts.onProgress(done / runs);
      if (done < runs) setTimeout(step, 0);
      else setTimeout(() => resolve(opts.isCancelled && opts.isCancelled() ? null : summarize()), 0);
    }
    step();
  });
}
