// Sonnenortung: Position aus Peilungen der Sonne (Höhe + Azimut über die Lagesensoren) und Zeit, ohne GPS.
// Oberfläche und Rechenkern gemeinsam mit der Sternennavigation (js/tools/astro/).

import { mountFix } from './astro/fixui.js';

export function mount(body, ctx) {
  return mountFix(body, ctx, {
    key: 'sunfix',
    objectColumn: false,
    hint: () => 'Gerät hochkant halten, Oberkante zur Sonne ausrichten',
    note: () => 'Nicht in die Sonne schauen. Schattenmethode: Gerät so drehen und neigen, dass die Oberkante keinen Schatten auf die Hand wirft.',
    footExtra: 'Sonnenort nach NOAA/Meeus (≈ 0,01°).'
  });
}
