// Koordinaten: Eingabe in beliebiger Zeile, alle anderen Formate werden live umgerechnet.

import { h, svg, copyText, toast } from '../lib/ui.js';
import { load, save, remove } from '../lib/store.js';
import { geoErrorText } from '../lib/sensors.js';
import { FORMATS, fmtDD } from './coords/convert.js';
import { parseWords, toWords, toCoords } from './coords/w3w.js';

const KEY = 'coords';
const KEY_W3W = 'coords:w3wkey';
// what3words: proprietär, nur über die Online-API (eigener Schlüssel)
const W3W = {
  id: 'w3w', label: 'what3words', example: '///filled.count.soap',
  hint: 'Nur online über die what3words-API mit eigenem Schlüssel'
};
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
.coords-head .coords-keybtn {
  margin-left: auto; border: 0; background: none; color: var(--accent); font-size: 13px; padding: 4px 2px; min-height: 28px;
}
.coords-extra { grid-column: 1 / -1; padding-right: 10px; }
.coords-extra:empty { display: none; }
.coords-w3wlink { display: inline-block; margin-top: 8px; font-size: 14px; color: var(--accent); text-decoration: none; padding: 4px 0; }
.coords-keypanel { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; }
.coords-keypanel .input { font-family: var(--mono); font-size: 16px; }
.coords-keypanel .small { color: var(--text-3); font-size: 12.5px; }
.coords-keypanel a { color: var(--accent); text-decoration: none; }
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
  // what3words-Zustand
  let w3wKey = load(KEY_W3W, '') || '';
  let w3wState = null;       // {id, status: 'pending'|'ok'|'error', words, place, lat, lon, error}
  let w3wTimer = 0, w3wCtl = null;
  let w3wSrcWords = '';     // Wörter der Eingabezeile (von der API bestätigt)
  const w3wCache = new Map();

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
  for (const f of [...FORMATS, W3W]) {
    const ta = h('textarea.coords-val', {
      rows: 1, spellcheck: 'false', autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off',
      enterkeyhint: 'done', 'aria-label': f.label, placeholder: f.example
    });
    const copyBtn = h('button.coords-copy', { type: 'button', 'aria-label': f.label + ' kopieren', disabled: true }, svg(ICON_COPY));
    const msg = h('div.coords-msg');
    const row = h('div.coords-row', h('div.coords-head', h('span.coords-label', f.label), h('span.coords-tag', 'Eingabe')), ta, copyBtn, msg);
    const r = { f, row, ta, copyBtn, msg, wasFocused: false };
    rows.set(f.id, r);
    if (f === W3W) buildW3w(r);

    copyBtn.addEventListener('click', () => { if (ta.value.trim()) copyText(ta.value.trim()); });
    // Antippen einer Ausgabe kopiert sie und markiert den Text (Überschreiben macht sie zur Eingabe)
    row.addEventListener('pointerdown', () => { r.wasFocused = document.activeElement === ta; });
    row.addEventListener('click', e => {
      if (copyBtn.contains(e.target) || e.target.closest('.coords-extra, .coords-keybtn')) return;
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
      'gekürztes MGRS) stehen für die Mitte ihrer Fläche. what3words funktioniert nur mit Internet und eigenem API-Schlüssel.'),
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
    let pending = false;
    w3wSrcWords = '';
    if (src && text && src.f === W3W) {
      const words = parseWords(text);
      const res = words && w3wLookup('w:' + words, ctlSignal => toCoords(words, w3wKey, { signal: ctlSignal }));
      if (!words) error = 'Format nicht erkannt';
      else if (res.error) error = res.error;
      else if (res.status === 'pending') pending = true;
      else {
        point = { lat: res.lat, lon: res.lon, h: 0, hKnown: false };
        w3wSrcWords = res.words;
        note = (res.place ? `nahe ${res.place} · ` : '') + 'Mitte des 3-m-Quadrats';
      }
      save(KEY, { id: activeId, text });
    } else if (src && text) {
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
      if (r.f === W3W) { renderW3w(r, isSrc, point, error, note, pending); continue; }
      if (!isSrc) {
        let val = '';
        if (point) {
          try { val = r.f.format(point) || ''; } catch (e) { console.error(e); }
        }
        r.ta.value = val;
        r.ta.placeholder = point ? (val ? '' : r.f.outside || 'außerhalb') : (error || pending ? '–' : r.f.example);
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

  /* ----- what3words ----- */

  function buildW3w(r) {
    const keyInput = h('input.input', {
      type: 'text', value: w3wKey, placeholder: 'API-Schlüssel', autocomplete: 'off', autocorrect: 'off',
      autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'done', 'aria-label': 'what3words-API-Schlüssel'
    });
    const panel = h('div.coords-keypanel', keyInput,
      h('div.small', 'Wird nur auf diesem Gerät gespeichert. ',
        h('a', { href: 'https://developer.what3words.com/public-api', target: '_blank', rel: 'noopener' }, 'Schlüssel beantragen')));
    panel.hidden = !!w3wKey;
    const keyBtn = h('button.coords-keybtn', { type: 'button', 'aria-expanded': String(!panel.hidden) }, 'API-Schlüssel');
    keyBtn.addEventListener('click', () => {
      panel.hidden = !panel.hidden;
      keyBtn.setAttribute('aria-expanded', String(!panel.hidden));
      if (!panel.hidden) keyInput.focus();
    });
    keyInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); keyInput.blur(); } });
    keyInput.addEventListener('input', () => {
      w3wKey = keyInput.value.trim();
      if (w3wKey) save(KEY_W3W, w3wKey); else remove(KEY_W3W);
      w3wAbort();
      w3wState = null;
      w3wCache.clear();
      clearTimeout(timer);
      timer = setTimeout(update, 400);
    });
    r.link = h('a.coords-w3wlink', { href: '#', target: '_blank', rel: 'noopener', hidden: true }, 'In what3words öffnen ↗');
    r.row.querySelector('.coords-head').append(keyBtn);
    r.row.append(h('div.coords-extra', r.link, panel));
  }

  function w3wAbort() {
    clearTimeout(w3wTimer);
    if (w3wCtl) { w3wCtl.abort(); w3wCtl = null; }
  }

  /**
   * Ergebnis für eine Anfrage-ID liefern oder Anfrage (verzögert, abbrechbar) starten.
   * Gibt {status, ...} oder {error} zurück.
   */
  function w3wLookup(id, request) {
    if (!w3wKey) return { error: 'API-Schlüssel nötig' };
    if (w3wCache.has(id)) return w3wCache.get(id);
    if (navigator.onLine === false) return { error: 'nur online' };
    if (w3wState && w3wState.id === id) return w3wState.status === 'error' ? { error: w3wState.error } : w3wState;
    w3wAbort();
    const state = w3wState = { id, status: 'pending' };
    w3wTimer = setTimeout(async () => {
      const ctl = w3wCtl = new AbortController();
      try {
        const res = await request(ctl.signal);
        Object.assign(state, { status: 'ok', words: res.words, place: res.nearestPlace, lat: res.lat, lon: res.lon });
        w3wCache.set(id, state);
      } catch (e) {
        if (e && e.name === 'AbortError') return;
        Object.assign(state, { status: 'error', error: (e && e.message) || 'Fehler' });
      }
      if (ctl === w3wCtl) w3wCtl = null;
      if (alive && state === w3wState) update();
    }, 400);
    return state;
  }

  function renderW3w(r, isSrc, pt, error, note, pending) {
    let words = '';
    if (isSrc) {
      if (error) setMsg(r, error, 'is-error');
      else if (pending) setMsg(r, 'wird abgefragt …', 'is-note');
      else setMsg(r, note, 'is-note');
      words = w3wSrcWords;
    } else {
      let val = '', ph = error || pending ? '–' : r.f.example, msg = r.f.hint, cls = '';
      if (pt) {
        const ll = `${pt.lat.toFixed(6)},${pt.lon.toFixed(6)}`;
        const res = w3wLookup('c:' + ll, sig => toWords(pt.lat, pt.lon, w3wKey, { signal: sig }));
        if (res.error) {
          ph = res.error === 'API-Schlüssel nötig' || res.error === 'nur online' ? res.error : '–';
          if (ph === '–') { msg = res.error; cls = 'is-error'; }
        } else if (res.status === 'pending') ph = 'wird abgefragt …';
        else {
          val = '///' + res.words;
          words = res.words;
          msg = res.place ? `nahe ${res.place}` : '';
          cls = 'is-note';
        }
      } else if (!w3wKey) msg = 'API-Schlüssel nötig · ' + r.f.hint;
      r.ta.value = val;
      r.ta.placeholder = ph;
      r.ta.classList.toggle('is-out', !!pt && !val);
      fit(r.ta);
      setMsg(r, msg, cls);
    }
    r.copyBtn.disabled = !r.ta.value.trim();
    r.link.hidden = !words;
    r.link.href = words ? 'https://what3words.com/' + encodeURIComponent(words).replace(/%2E/gi, '.') : '#';
  }

  function reset() {
    clearTimeout(timer);
    w3wAbort();
    w3wState = null;
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
  window.addEventListener('online', update);
  window.addEventListener('offline', update);

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
    w3wAbort();
    window.removeEventListener('resize', onResize);
    window.removeEventListener('online', update);
    window.removeEventListener('offline', update);
  };
}
