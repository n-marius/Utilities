// Koordinaten: Eingabe in beliebiger Zeile, alle anderen Formate werden live umgerechnet.

import { h, svg, copyText, toast } from '../lib/ui.js';
import { load, save, remove } from '../lib/store.js';
import { geoErrorText } from '../lib/sensors.js';
import { FORMATS, fmtDD } from './coords/convert.js';

const KEY = 'coords';
const ic = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
const ICON_COPY = `<svg viewBox="0 0 24 24" width="20" height="20" ${ic}><rect x="8.5" y="8.5" width="11" height="11" rx="2.5"/><path d="M15.5 5.5v-.5a2 2 0 0 0-2-2H6a2.5 2.5 0 0 0-2.5 2.5V13a2 2 0 0 0 2 2h.5"/></svg>`;
const ICON_RESET = `<svg viewBox="0 0 24 24" width="22" height="22" ${ic}><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4 4v4.5h4.5"/></svg>`;
const ICON_LOC = `<svg viewBox="0 0 24 24" width="18" height="18" ${ic}><path d="M20 4 3.5 11l7 2.5L13 20.5z"/></svg>`;
const ICON_MAP = `<svg viewBox="0 0 24 24" width="18" height="18" ${ic}><path d="M9 4 3.5 6v14L9 18l6 2 5.5-2V4L15 6z"/><path d="M9 4v14M15 6v14"/></svg>`;

const CSS = `
.coords-top { display: flex; gap: 10px; flex-shrink: 0; }
.coords-top a.btn { text-decoration: none; }
.coords-top > .btn { flex: 1; padding-left: 10px; padding-right: 10px; white-space: nowrap; }
.coords-top .btn.is-disabled { opacity: .4; pointer-events: none; }
.coords-list { padding: 0; flex-shrink: 0; }
.coords-row {
  position: relative; padding: 11px 6px 11px 16px; border-top: 1px solid var(--line);
  display: grid; grid-template-columns: 1fr 44px; column-gap: 4px; align-items: center; cursor: text;
}
.coords-row:first-child { border-top: 0; }
.coords-row.is-input { box-shadow: inset 0 0 0 2px var(--accent); border-radius: 12px; border-top-color: transparent; }
.coords-row.is-input + .coords-row { border-top-color: transparent; }
.coords-head { grid-column: 1 / -1; display: flex; align-items: center; gap: 8px; min-height: 18px; padding-right: 10px; }
.coords-label { font-size: 12.5px; color: var(--text-2); letter-spacing: .2px; }
.coords-tag {
  display: none; font-size: 10.5px; font-weight: 600; letter-spacing: .5px; text-transform: uppercase;
  color: var(--accent); background: var(--accent-soft); padding: 1px 7px; border-radius: 6px;
}
.coords-row.is-input .coords-tag { display: inline-block; }
.coords-row.is-input .coords-label { color: var(--accent); }
.coords-val {
  display: block; width: 100%; margin: 3px 0 0; padding: 0; border: 0; outline: none; background: transparent;
  resize: none; overflow: hidden; color: var(--text);
  font-family: var(--mono); font-size: 17px; line-height: 24px; height: 24px;
  font-variant-numeric: tabular-nums; letter-spacing: -.2px; -webkit-user-select: text; user-select: text;
}
.coords-val::placeholder { color: var(--text-3); opacity: 1; }
.coords-val.is-out { font-family: var(--font); font-size: 15px; letter-spacing: 0; }
.coords-copy {
  width: 44px; height: 44px; border: 0; background: none; color: var(--accent);
  display: grid; place-items: center; border-radius: 10px; align-self: end; margin-bottom: -10px;
}
.coords-copy:active { background: var(--accent-soft); }
.coords-copy:disabled { color: var(--text-3); opacity: .45; }
.coords-msg { grid-column: 1 / -1; font-size: 12.5px; line-height: 1.35; color: var(--text-3); margin-top: 6px; padding-right: 10px; }
.coords-msg:empty { display: none; }
.coords-msg.is-error { color: var(--danger); }
.coords-msg.is-note { color: var(--text-2); }
.coords-foot { flex-shrink: 0; font-size: 12.5px; color: var(--text-3); line-height: 1.45; margin: 2px 4px 0; }
`;

export function mount(body, ctx) {
  if (!document.getElementById('style-coords')) {
    document.head.append(h('style#style-coords', CSS));
  }

  let alive = true;
  let activeId = null;       // Zeile mit Eingabe
  let point = null;          // {lat, lon, h, hKnown}
  let extraNote = '';        // z. B. Genauigkeit der Ortung
  let timer = 0;
  const rows = new Map();

  // Kopfleiste: Zurücksetzen
  const resetIcon = h('button.icon-btn', { type: 'button', 'aria-label': 'Zurücksetzen', title: 'Zurücksetzen', onclick: reset }, svg(ICON_RESET));
  ctx.setActions(resetIcon);

  // Oben: Standort und Karten
  const locBtn = h('button.btn', { type: 'button', onclick: locate }, svg(ICON_LOC), h('span', 'Mein Standort'));
  const mapBtn = h('a.btn.primary.is-disabled', {
    href: '#', target: '_blank', rel: 'noopener', 'aria-disabled': 'true', 'aria-label': 'In Apple Karten öffnen'
  }, svg(ICON_MAP), h('span', 'In Karten öffnen'));
  body.append(h('div.coords-top', locBtn, mapBtn));

  // Liste der Formate
  const list = h('div.list.coords-list');
  for (const f of FORMATS) {
    const ta = h('textarea.coords-val', {
      rows: 1, spellcheck: 'false', autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off',
      enterkeyhint: 'done', 'aria-label': f.label, placeholder: f.example
    });
    const copyBtn = h('button.coords-copy', { type: 'button', 'aria-label': f.label + ' kopieren', disabled: true }, svg(ICON_COPY));
    const msg = h('div.coords-msg');
    const row = h('div.coords-row', h('div.coords-head', h('span.coords-label', f.label), h('span.coords-tag', 'Eingabe')), ta, copyBtn, msg);
    const r = { f, row, ta, copyBtn, msg, wasFocused: false };
    rows.set(f.id, r);

    copyBtn.addEventListener('click', () => { if (ta.value.trim()) copyText(ta.value.trim()); });
    // Antippen einer Ausgabe kopiert sie und markiert den Text (Überschreiben macht sie zur Eingabe)
    row.addEventListener('pointerdown', () => { r.wasFocused = document.activeElement === ta; });
    row.addEventListener('click', e => {
      if (copyBtn.contains(e.target)) return;
      if (document.activeElement !== ta) ta.focus();
      if (!r.wasFocused && activeId !== f.id && ta.value.trim()) {
        copyText(ta.value.trim());
        ta.setSelectionRange(0, ta.value.length);
      }
    });
    ta.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); ta.blur(); }
    });
    ta.addEventListener('input', () => {
      if (/[\r\n]/.test(ta.value)) ta.value = ta.value.replace(/[\r\n]+/g, ' ');
      setActive(f.id);
      ta.classList.remove('is-out');
      extraNote = '';
      fit(ta);
      clearTimeout(timer);
      timer = setTimeout(update, 150);
    });
    list.append(row);
  }
  body.append(list);

  body.append(
    h('p.coords-foot',
      'In jede Zeile kann eingegeben werden; Komma oder Punkt, mit oder ohne Grad-, Minuten- und Sekundenzeichen, ',
      'Himmelsrichtung vorn oder hinten. Antippen einer Ausgabe kopiert sie. Flächencodes (Plus Code, Geohash, Locator, ',
      'gekürztes MGRS) stehen für die Mitte ihrer Fläche.'),
    h('button.btn.block', { type: 'button', onclick: reset }, 'Alles zurücksetzen')
  );

  function setActive(id) {
    activeId = id;
    for (const [rid, r] of rows) r.row.classList.toggle('is-input', rid === id);
  }

  function fit(ta) {
    ta.style.height = '24px';
    ta.style.height = ta.scrollHeight + 'px';
  }

  function setMsg(r, text, cls) {
    r.msg.className = 'coords-msg' + (cls ? ' ' + cls : '');
    r.msg.textContent = text || '';
  }

  /** Eingabezeile auswerten und alle anderen Zeilen füllen. */
  function update() {
    clearTimeout(timer);
    const src = activeId && rows.get(activeId);
    const text = src ? src.ta.value.trim() : '';
    point = null;
    let error = '', note = '';
    if (src && text) {
      const res = src.f.parse(text);
      if (res.error) error = res.error;
      else {
        point = { lat: res.lat, lon: res.lon, h: res.h ?? 0, hKnown: res.h != null };
        note = res.note || '';
      }
      save(KEY, { id: activeId, text });
    } else {
      remove(KEY);
    }

    for (const [id, r] of rows) {
      const isSrc = id === activeId;
      if (!isSrc) {
        let val = '';
        if (point) {
          try { val = r.f.format(point) || ''; } catch (e) { console.error(e); }
        }
        r.ta.value = val;
        r.ta.placeholder = point ? (val ? '' : r.f.outside || 'außerhalb') : (error ? '–' : r.f.example);
        r.ta.classList.toggle('is-out', !!point && !val);
        fit(r.ta);
      }
      r.copyBtn.disabled = !r.ta.value.trim();

      if (isSrc && error) setMsg(r, error, 'is-error');
      else if (isSrc && (note || extraNote)) setMsg(r, [extraNote, note].filter(Boolean).join(' · '), 'is-note');
      else if (id === 'ecef' && point && !point.hKnown) setMsg(r, 'Höhe 0 m über Ellipsoid angenommen');
      else setMsg(r, r.f.hint || '');
    }

    if (point) {
      const ll = `${point.lat.toFixed(6)},${point.lon.toFixed(6)}`;
      mapBtn.href = `https://maps.apple.com/?ll=${ll}&q=${ll}`;
      mapBtn.classList.remove('is-disabled');
      mapBtn.removeAttribute('aria-disabled');
    } else {
      mapBtn.href = '#';
      mapBtn.classList.add('is-disabled');
      mapBtn.setAttribute('aria-disabled', 'true');
    }
  }

  function reset() {
    clearTimeout(timer);
    extraNote = '';
    for (const r of rows.values()) r.ta.value = '';
    setActive(null);
    if (document.activeElement && body.contains(document.activeElement)) document.activeElement.blur();
    update();
  }

  function locate() {
    if (!('geolocation' in navigator)) { toast('Ortung nicht verfügbar'); return; }
    locBtn.disabled = true;
    locBtn.lastChild.textContent = 'Ortung …';
    navigator.geolocation.getCurrentPosition(pos => {
      if (!alive) return;
      locBtn.disabled = false;
      locBtn.lastChild.textContent = 'Mein Standort';
      const { latitude: lat, longitude: lon, accuracy } = pos.coords;
      const r = rows.get('dd');
      r.ta.value = fmtDD({ lat, lon });
      setActive('dd');
      extraNote = `Aktuelle Position, Genauigkeit ± ${Math.round(accuracy)} m`;
      fit(r.ta);
      update();
    }, err => {
      if (!alive) return;
      locBtn.disabled = false;
      locBtn.lastChild.textContent = 'Mein Standort';
      toast(geoErrorText(err), 3500);
    }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 5000 });
  }

  const onResize = () => { for (const r of rows.values()) fit(r.ta); };
  window.addEventListener('resize', onResize);

  // Letzte Eingabe wiederherstellen
  const saved = load(KEY);
  if (saved && rows.has(saved.id) && typeof saved.text === 'string') {
    rows.get(saved.id).ta.value = saved.text;
    setActive(saved.id);
  }
  update();
  requestAnimationFrame(onResize);

  return () => {
    alive = false;
    clearTimeout(timer);
    window.removeEventListener('resize', onResize);
  };
}
