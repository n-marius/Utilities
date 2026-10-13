// App-Rahmen: Startseite (Raster), Navigation per Hash, Laden der Werkzeuge.
//
// Vertrag für Werkzeugmodule (js/tools/<id>.js):
//   export function mount(body, ctx) -> cleanup()  (darf auch Promise<cleanup> liefern)
//   body: leeres <main>-Element; ctx.setActions(...nodes) füllt rechts die Kopfleiste,
//   ctx.setFlush(true) entfernt den Innenabstand (z. B. für Vollbild-Karte).

import { h, svg } from './lib/ui.js';

const stroke = 'fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"';

export const TABS = [
  { id: 'tools', title: 'Werkzeuge' },
  { id: 'lab', title: 'Experimentell' }
];

export const TOOLS = [
  {
    id: 'ins', tab: 'tools', title: 'Inertialnavigation', sub: 'Koppelnavigation',
    icon: `<svg viewBox="0 0 64 64" ${stroke}><path d="M8 50C24 64 22 30 34 30S46 8 56 12"/><circle cx="8" cy="50" r="4" fill="currentColor" stroke="none"/><path d="M51.1 4.5 56 12l-8.8 2.1"/></svg>`
  },
  {
    id: 'sunfix', tab: 'tools', title: 'Sonnenortung', sub: 'Position ohne GPS',
    icon: `<svg viewBox="0 0 64 64" ${stroke}><path d="M8 50h48"/><circle cx="42" cy="22" r="7"/><path d="M42 8v3M42 33v3M28 22h3M53 22h3M32 12l2 2M50 30l2 2M32 32l2-2M50 14l2-2" stroke-width="2"/><path d="M14 50 34 30"/><path d="M25 50a11 11 0 0 0-3-7.6" stroke-width="2"/></svg>`
  },
  {
    id: 'stars', tab: 'tools', title: 'Sternennavigation', sub: 'Sterne · Planeten',
    icon: `<svg viewBox="0 0 64 64" ${stroke}><path d="M24 40 46 16 52 44Z" stroke-width="1.6" stroke-dasharray="2 4"/><path d="M24 25c1.5 8.5 5.5 12.5 14 14-8.5 1.5-12.5 5.5-14 14-1.5-8.5-5.5-12.5-14-14 8.5-1.5 12.5-5.5 14-14z" fill="currentColor" stroke="none"/><circle cx="46" cy="16" r="4" fill="currentColor" stroke="none"/><circle cx="52" cy="44" r="3" fill="currentColor" stroke="none"/></svg>`
  },
  {
    id: 'coords', tab: 'tools', title: 'Koordinaten', sub: 'Umrechnung · 12 Formate',
    icon: `<svg viewBox="0 0 64 64" ${stroke}><circle cx="32" cy="32" r="23"/><ellipse cx="32" cy="32" rx="10" ry="23"/><path d="M9 32h46M13 20h38M13 44h38" stroke-width="2"/></svg>`
  },
  {
    id: 'gravity', tab: 'lab', title: 'Gravitation', sub: 'Ortung über Erdschwere',
    icon: `<svg viewBox="0 0 64 64" ${stroke}><circle cx="32" cy="15" r="7"/><path d="M32 27v19M25 40l7 7 7-7"/><path d="M12 54h40"/><path d="M16 59l4-5M26 59l4-5M36 59l4-5M46 59l4-5" stroke-width="1.8"/></svg>`
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

let activeTab = (() => { try { return sessionStorage.getItem('utilities:tab') || 'tools'; } catch { return 'tools'; } })();

function renderTabs() {
  const nav = document.querySelector('.tabs');
  nav.textContent = '';
  for (const t of TABS) {
    const on = t.id === activeTab;
    nav.append(h('button.tab', { type: 'button', role: 'tab', class: on ? 'is-active' : null, 'aria-selected': String(on),
      onclick: () => {
        activeTab = t.id;
        try { sessionStorage.setItem('utilities:tab', t.id); } catch { /* egal */ }
        renderTabs();
        renderGrid();
      } }, t.title));
  }
}

function renderGrid() {
  const grid = $('grid');
  grid.textContent = '';
  TOOLS.filter(t => t.tab === activeTab).forEach(t => {
    const tile = h('button.tile', { type: 'button', onclick: () => { location.hash = '#/' + t.id; } },
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
renderTabs();
renderGrid();
updateFoot();
route();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW', e));
  navigator.serviceWorker.ready.then(() => { offlineReady = true; updateFoot(); });
}
