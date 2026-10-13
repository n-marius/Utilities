// App-Rahmen: Startseite (Raster), Navigation per Hash, Laden der Werkzeuge.
//
// Vertrag für Werkzeugmodule (js/tools/<id>.js):
//   export function mount(body, ctx) -> cleanup()  (darf auch Promise<cleanup> liefern)
//   body: leeres <main>-Element; ctx.setActions(...nodes) füllt rechts die Kopfleiste,
//   ctx.setFlush(true) entfernt den Innenabstand (z. B. für Vollbild-Karte).

import { h, svg } from './lib/ui.js';

const stroke = 'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';

export const TOOLS = [
  {
    id: 'altimeter', title: 'Höhenmesser',
    icon: `<svg viewBox="0 0 64 64" ${stroke}><circle cx="32" cy="32" r="24"/><path d="M32 11v5M32 48v5M11 32h5M48 32h5M17.2 17.2l3.5 3.5M43.3 43.3l3.5 3.5M17.2 46.8l3.5-3.5M43.3 20.7l3.5-3.5"/><path d="M32 32 41 18" stroke-width="2.4"/><path d="M32 32 24 39" stroke-width="3.2"/><circle cx="32" cy="32" r="2.2" fill="currentColor"/></svg>`
  },
  {
    id: 'gps', title: 'GPS (offline)',
    icon: `<svg viewBox="0 0 64 64" ${stroke}><circle cx="32" cy="32" r="18" stroke-dasharray="3 4"/><circle cx="32" cy="32" r="5" fill="currentColor"/><path d="M32 6v10M32 48v10M6 32h10M48 32h10"/></svg>`
  },
  {
    id: 'ins', title: 'Inertialnavigation',
    icon: `<svg viewBox="0 0 64 64" ${stroke}><path d="M10 52c6-2 10-8 14-15s8-11 15-12 12-4 15-13" stroke-dasharray="1 0"/><circle cx="10" cy="52" r="3" fill="currentColor"/><path d="M49 6l6 6-8 2z" fill="currentColor"/><circle cx="24" cy="37" r="1.6" fill="currentColor"/><circle cx="39" cy="25" r="1.6" fill="currentColor"/></svg>`
  },
  {
    id: 'sunfix', title: 'Sonnenortung',
    icon: `<svg viewBox="0 0 64 64" ${stroke}><path d="M6 50h52"/><circle cx="42" cy="22" r="7"/><path d="M42 9v3M42 32v3M29 22h3M52 22h3M32.8 12.8l2.1 2.1M49.1 29.1l2.1 2.1M32.8 31.2l2.1-2.1M49.1 14.9l2.1-2.1"/><path d="M14 50 36 27" stroke-width="2.4"/><path d="M24 50a10 10 0 0 0-3.2-7.3"/></svg>`
  },
  {
    id: 'coords', title: 'Koordinaten',
    icon: `<svg viewBox="0 0 64 64" ${stroke}><circle cx="32" cy="32" r="22"/><ellipse cx="32" cy="32" rx="9" ry="22"/><path d="M10 32h44M14 20h36M14 44h36"/></svg>`
  }
];

const $ = id => document.getElementById(id);
let cleanup = null;
let navToken = 0;

function renderGrid() {
  const grid = $('grid');
  grid.textContent = '';
  for (const t of TOOLS) {
    const tile = h('button.tile', { type: 'button', onclick: () => { location.hash = '#/' + t.id; } },
      svg(t.icon), h('span', t.title));
    grid.append(tile);
  }
  if (TOOLS.length % 2) grid.append(h('div.tile.is-empty'));
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
route();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW', e));
}
