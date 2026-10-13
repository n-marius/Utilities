// Gemeinsamer Zugriff auf Lage-, Bewegungs- und Positionssensoren.
//
// Hinweise zu Plattformen:
// - iOS: DeviceOrientation/-Motion erst nach requestPermission() aus einer Nutzergeste.
//   alpha ist dort relativ (beliebige Nullrichtung, gyro-gestützt); die Kompassrichtung
//   liefert webkitCompassHeading (magnetisch) samt webkitCompassAccuracy (Grad).
// - Android/Chrome: 'deviceorientationabsolute' liefert alpha relativ zu (magnetisch) Nord.
// Alle Kompasswerte hier sind MAGNETISCH. Für rechtweisend Nord magdecl.js verwenden.

let permissionGranted = false;

/** Muss aus einem Klick-Handler aufgerufen werden. Gibt true zurück, wenn Sensoren nutzbar sind. */
export async function ensureMotionPermission() {
  if (permissionGranted) return true;
  try {
    // Beide Anfragen sofort (ohne await dazwischen) starten, sonst verwirft iOS die zweite als nicht nutzerausgelöst.
    const reqs = [];
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      reqs.push(DeviceOrientationEvent.requestPermission());
    }
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      reqs.push(DeviceMotionEvent.requestPermission());
    }
    const res = await Promise.all(reqs);
    if (res.some(r => r !== 'granted')) return false;
    permissionGranted = true;
    return true;
  } catch (e) {
    console.warn('Sensorfreigabe', e);
    return false;
  }
}

export const hasOrientation = () => typeof DeviceOrientationEvent !== 'undefined';
export const hasMotion = () => typeof DeviceMotionEvent !== 'undefined';

/** Bildschirmdrehung in Grad (0, 90, 180, 270). */
export function screenAngle() {
  if (screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle;
  if (typeof window.orientation === 'number') return (window.orientation + 360) % 360;
  return 0;
}

/**
 * Lagedaten abonnieren.
 * cb({alpha, beta, gamma, absolute, heading, headingAccuracy, t})
 *  - alpha/beta/gamma: W3C-Eulerwinkel in Grad (alpha bei iOS relativ!)
 *  - heading: magnetischer Kurs der Geräte-Oberkante (y-Achse) in Grad oder null
 *  - headingAccuracy: Genauigkeit in Grad (nur iOS) oder null
 * Gibt eine Abmeldefunktion zurück.
 */
export function watchOrientation(cb) {
  let gotAbsolute = false;
  const handle = (e, isAbsEvent) => {
    if (e.alpha == null && e.beta == null) return;
    if (isAbsEvent) gotAbsolute = true;
    else if (gotAbsolute) return; // Android: absolutes Ereignis bevorzugen
    let heading = null;
    let headingAccuracy = null;
    if (typeof e.webkitCompassHeading === 'number' && e.webkitCompassHeading >= 0) {
      heading = e.webkitCompassHeading;
      headingAccuracy = typeof e.webkitCompassAccuracy === 'number' && e.webkitCompassAccuracy >= 0 ? e.webkitCompassAccuracy : null;
    } else if ((isAbsEvent || e.absolute) && e.alpha != null) {
      heading = (360 - e.alpha) % 360;
    }
    cb({
      alpha: e.alpha, beta: e.beta, gamma: e.gamma,
      absolute: !!(isAbsEvent || e.absolute),
      heading, headingAccuracy, t: performance.now()
    });
  };
  const onAbs = e => handle(e, true);
  const onRel = e => handle(e, false);
  window.addEventListener('deviceorientationabsolute', onAbs);
  window.addEventListener('deviceorientation', onRel);
  return () => {
    window.removeEventListener('deviceorientationabsolute', onAbs);
    window.removeEventListener('deviceorientation', onRel);
  };
}

/** Rohdaten DeviceMotionEvent abonnieren. Gibt Abmeldefunktion zurück. */
export function watchMotion(cb) {
  const f = e => cb(e);
  window.addEventListener('devicemotion', f);
  return () => window.removeEventListener('devicemotion', f);
}

/**
 * Rotationsmatrix (Gerät -> Erde, ENU: x=Ost, y=Nord, z=oben) aus W3C-Eulerwinkeln.
 * Liefert Array[9] zeilenweise. Bei relativem alpha ist "Nord" die alpha-Nullrichtung.
 */
export function rotationMatrix(alpha, beta, gamma) {
  const d = Math.PI / 180;
  const a = (alpha || 0) * d, b = (beta || 0) * d, g = (gamma || 0) * d;
  const cA = Math.cos(a), sA = Math.sin(a), cB = Math.cos(b), sB = Math.sin(b), cG = Math.cos(g), sG = Math.sin(g);
  return [
    cA * cG - sA * sB * sG, -cB * sA, cG * sA * sB + cA * sG,
    cG * sA + cA * sB * sG,  cA * cB, sA * sG - cA * cG * sB,
    -cB * sG,                sB,      cB * cG
  ];
}

/**
 * Position beobachten (Geolocation, funktioniert auch offline über den GNSS-Empfänger).
 * Gibt Abmeldefunktion zurück.
 */
export function watchPosition(onPos, onErr, opts = {}) {
  if (!('geolocation' in navigator)) {
    onErr && onErr({ code: 0, message: 'Geolocation nicht verfügbar' });
    return () => {};
  }
  const id = navigator.geolocation.watchPosition(onPos, onErr, {
    enableHighAccuracy: true, maximumAge: 0, timeout: 60000, ...opts
  });
  return () => navigator.geolocation.clearWatch(id);
}

/** Bildschirm wach halten, solange möglich. Gibt Freigabefunktion zurück. */
export async function keepAwake() {
  let lock = null;
  let released = false;
  const req = async () => {
    try { if ('wakeLock' in navigator && !released) lock = await navigator.wakeLock.request('screen'); } catch { /* nicht unterstützt */ }
  };
  const onVis = () => { if (document.visibilityState === 'visible') req(); };
  await req();
  document.addEventListener('visibilitychange', onVis);
  return () => {
    released = true;
    document.removeEventListener('visibilitychange', onVis);
    try { lock && lock.release(); } catch { /* egal */ }
  };
}

export function geoErrorText(err) {
  if (!err) return '';
  switch (err.code) {
    case 1: return 'Standortzugriff verweigert (Einstellungen › Datenschutz › Ortungsdienste).';
    case 2: return 'Position derzeit nicht bestimmbar (kein Fix).';
    case 3: return 'Zeitüberschreitung – noch kein Fix. Freie Sicht zum Himmel verbessert den Empfang.';
    default: return err.message || 'Unbekannter Fehler';
  }
}
