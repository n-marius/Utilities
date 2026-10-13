// Kleine DOM- und Formatierungshelfer, von allen Werkzeugen genutzt.

/** h('div.card#id', {onclick, style, ...attrs}, ...children) */
export function h(tag, props, ...children) {
  const m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(tag);
  const el = document.createElement((m && m[1]) || 'div');
  if (m && m[2]) {
    for (const part of m[2].match(/[.#][\w-]+/g)) {
      if (part[0] === '.') el.classList.add(part.slice(1));
      else el.id = part.slice(1);
    }
  }
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'class') el.className += ' ' + v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** SVG-Markup in ein Element umwandeln. */
export function svg(markup) {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  return t.content.firstElementChild;
}

let toastTimer;
export function toast(msg, ms = 1800) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-on'), ms);
}

export async function copyText(text, label = 'Kopiert') {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: 0 } }, text);
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(label);
}

/**
 * Segmentierter Umschalter.
 * seg([{value:'a', label:'A'}, ...], 'a', v => ...) -> Element mit .value / .set(v)
 */
export function seg(options, value, onChange) {
  const el = h('div.seg', { role: 'tablist' });
  const btns = options.map(o => {
    const b = h('button', { type: 'button', onclick: () => { set(o.value); onChange && onChange(o.value); } }, o.label);
    b.dataset.value = o.value;
    el.append(b);
    return b;
  });
  function set(v) {
    el.value = v;
    for (const b of btns) b.classList.toggle('is-active', b.dataset.value === String(v));
  }
  el.set = set;
  set(value);
  return el;
}

/** Kennzahl-Kachel; gibt {el, set(value, unit?)} zurück. */
export function stat(label, value = '–', unit = '') {
  const v = h('div.v');
  const el = h('div.stat', h('div.k', label), v);
  function set(val, u = unit) {
    v.textContent = val;
    if (u) v.append(h('small', u));
  }
  set(value, unit);
  return { el, set };
}

/** Zahl mit deutschem Dezimalkomma. */
export function fmt(n, digits = 0) {
  if (n == null || !Number.isFinite(n)) return '–';
  return n.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Strecke in m bzw. km. */
export function fmtDist(m) {
  if (m == null || !Number.isFinite(m)) return '–';
  if (Math.abs(m) < 1000) return fmt(m, 0) + ' m';
  if (Math.abs(m) < 100000) return fmt(m / 1000, 2) + ' km';
  return fmt(m / 1000, 0) + ' km';
}

/** Breite/Länge kompakt als Dezimalgrad mit Hemisphäre. */
export function fmtLatLon(lat, lon, digits = 5) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return '–';
  return `${fmt(Math.abs(lat), digits)}° ${lat >= 0 ? 'N' : 'S'}, ${fmt(Math.abs(lon), digits)}° ${lon >= 0 ? 'O' : 'W'}`;
}

/** Zeitdauer mm:ss bzw. h:mm:ss */
export function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  const p = n => String(n).padStart(2, '0');
  return hh ? `${hh}:${p(mm)}:${p(ss)}` : `${p(mm)}:${p(ss)}`;
}

/** Kurzer Signalton (WebAudio), z. B. für Countdowns. */
let audioCtx;
export function beep(freq = 880, ms = 90, gain = 0.15) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = freq;
    g.gain.value = gain;
    o.connect(g).connect(audioCtx.destination);
    o.start();
    g.gain.setTargetAtTime(0, audioCtx.currentTime + ms / 1000, 0.015);
    o.stop(audioCtx.currentTime + ms / 1000 + 0.08);
  } catch { /* kein Audio */ }
  if (navigator.vibrate) navigator.vibrate(ms);
}

export const isDark = () => matchMedia('(prefers-color-scheme: dark)').matches;
