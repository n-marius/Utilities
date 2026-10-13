// Himmelskörper-Kennungen für die Ortsbestimmung: 'sun', 'star:<Katalogschlüssel>', 'planet:<name>'.

import { sunGP } from './sun.js';
import { starGP, planetGP } from './ephem.js';
import { STARS, PLANETS } from './catalog.js';

/** Bildpunkt {dec, gha} (Grad) eines Körpers zur UTC-Zeit (ms). */
export function bodyGP(id, ms) {
  if (!id || id === 'sun') return sunGP(ms);
  const [kind, key] = id.split(':');
  if (kind === 'star') return starGP(key, ms);
  if (kind === 'planet') return planetGP(key, ms);
  throw new Error('Unbekannter Körper ' + id);
}

export function bodyName(id) {
  if (!id || id === 'sun') return 'Sonne';
  const [kind, key] = id.split(':');
  if (kind === 'star') return (STARS[key] && STARS[key].name) || key;
  const p = PLANETS.find(x => x.id === key);
  return p ? p.name : key;
}
