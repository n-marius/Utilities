// App-Rahmen: Startseite (Raster), Navigation per Hash, Laden der Werkzeuge.
//
// Vertrag für Werkzeugmodule (js/tools/<id>.js):
//   export function mount(body, ctx) -> cleanup()  (darf auch Promise<cleanup> liefern)
//   body: leeres <main>-Element; ctx.setActions(...nodes) füllt rechts die Kopfleiste,
//   ctx.setFlush(true) entfernt den Innenabstand (z. B. für Vollbild-Karte).

import { h, svg } from './lib/ui.js';

const stroke = 'fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"';

export const TOOLS = [
  {
    id: 'altimeter', title: 'Höhenmesser', sub: 'Barometrisch · hPa',
    icon: `<svg viewBox="0 0 64 64" ${stroke}><circle cx="32" cy="32" r="25"/><path d="M32 11v4M53 32h-4M32 53v-4M11 32h4" stroke-width="2"/><path d="M32 32 43 17"/><path d="M32 32 22 40" stroke-width="4"/><circle cx="32" cy="32" r="2.6" fill="currentColor" stroke="none"/></svg>`
  },
  {
    id: 'gps', title: 'GPS', sub: 'Offline · Satelliten',
    icon: `<svg viewBox="0 0 64 64" ${stroke}><circle cx="32" cy="32" r="19" stroke-dasharray="4 5"/><circle cx="32" cy="32" r="6" fill="currentColor" stroke="none"/><path d="M32 5v9M32 50v9M5 32h9M50 32h9"/></svg>`
  },
  {
    id: 'ins', title: 'Inertialnavigation', sub: 'Koppelnavigation',
    icon: `<svg viewBox="0 0 64 64" ${stroke}><path d="M12 52c8 0 10-10 18-14s14-4 16-14" stroke-dasharray="1 6"/><circle cx="12" cy="52" r="4" fill="currentColor" stroke="none"/><path d="M38 14l13-4-4 13"/><path d="M51 10 40 21"/></svg>`
  },
  {
    id: 'sunfix', title: 'Sonnenortung', sub: 'Position ohne GPS',
    icon: `<svg viewBox="0 0 64 64" ${stroke}><path d="M8 50h48"/><circle cx="42" cy="22" r="7"/><path d="M42 8v3M42 33v3M28 22h3M53 22h3M32 12l2 2M50 30l2 2M32 32l2-2M50 14l2-2" stroke-width="2"/><path d="M14 50 34 30"/><path d="M25 50a11 11 0 0 0-3-7.6" stroke-width="2"/></svg>`
  },
  {
    id: 'coords', title: 'Koordinaten', sub: 'UTM · MGRS · Grad · Gauß-Krüger',
    icon: `<svg viewBox="0 0 64 64" ${stroke}><circle cx="32" cy="32" r="23"/><ellipse cx="32" cy="32" rx="10" ry="23"/><path d="M9 32h46M13 20h38M13 44h38" stroke-width="2"/></svg>`
  }
];

const $ = id => document.getElementById(id);
let cleanup = null;
let offlineReady = false;

function updateFoot() {
  const el = document.getElementById('home-foot');
  if (!el) return;
  el.textContent = [navigator.onLine ? 'Online' : 'Offline', offlineReady ? 'Offline verfügbar' : null].filter(Boolean).join(' · ');
}
window.addEventListener('online', updateFoot);
window.addEventListener('offline', updateFoot);
let navToken = 0;

function renderGrid() {
  const grid = $('grid');
  grid.textContent = '';
  TOOLS.forEach((t, i) => {
    const wide = TOOLS.length % 2 === 1 && i === TOOLS.length - 1;
    const tile = h('button.tile', { type: 'button', class: wide ? 'wide' : null, onclick: () => { location.hash = '#/' + t.id; } },
      h('span.tile-icon', svg(t.icon)),
      h('span.tile-text', h('span.tile-title', t.title), h('span.tile-sub', t.sub)));
    grid.append(tile);
  });
  grid.append(h('div.home-foot#home-foot', navigator.onLine ? 'Online' : 'Offline'));
}

async function route() {
  const token = ++navToken;
  const id = (location.hash.match(/^#\/([\w-]+)/) || [])[1];
  const tool = TOOLS.find(t => t.id === id);

  if (cleanup) {
    try { await cleanup(); } catch (e) { console.error(e); }
    cleanup = null;
  }
  const body = $('tool-body');
  body.textContent = '';
  body.classList.remove('is-flush');
  $('tool-actions').textContent = '';

  if (!tool) {
    $('tool').hidden = true;
    $('home').hidden = false;
    document.title = 'Utilities';
    return;
  }
  $('home').hidden = true;
  $('tool').hidden = false;
  $('tool-title').textContent = tool.title;
  document.title = tool.title + ' · Utilities';

  const ctx = {
    setActions: (...nodes) => { $('tool-actions').replaceChildren(...nodes); },
    setFlush: on => body.classList.toggle('is-flush', !!on)
  };
  try {
    const mod = await import(`./tools/${tool.id}.js`);
    if (token !== navToken) return;
    const c = await mod.mount(body, ctx);
    if (token !== navToken) { c && c(); return; }
    cleanup = c || null;
  } catch (e) {
    console.error(e);
    body.append(h('div.banner.warn', `Werkzeug konnte nicht geladen werden: ${e.message}`));
  }
}

$('back').addEventListener('click', () => {
  if (history.length > 1 && location.hash) history.back();
  else location.hash = '';
});

window.addEventListener('hashchange', route);
// Modulskripte laufen nach dem Parsen des Dokuments (und nach den defer-Skripten davor).
renderGrid();
updateFoot();
route();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW', e));
  navigator.serviceWorker.ready.then(() => { offlineReady = true; updateFoot(); });
}
