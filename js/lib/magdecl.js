// Magnetische Missweisung (Deklination) nach World Magnetic Model 2025
// (vendor/geomagnetism.min.js, gültig 11/2024 – 11/2029). Positiv = Ost.

export function declination(lat, lon, date = new Date(), altKm = 0) {
  try {
    const gm = window.geomagnetism;
    if (!gm || !Number.isFinite(lat) || !Number.isFinite(lon)) return 0;
    const model = gm.model(date, { allowOutOfBoundsModel: true });
    const d = model.point([lat, lon, altKm]).decl;
    return Number.isFinite(d) ? d : 0;
  } catch {
    return 0;
  }
}

/** Magnetischen Kurs in rechtweisenden Kurs umrechnen. */
export function magToTrue(magHeading, lat, lon, date) {
  return ((magHeading + declination(lat, lon, date)) % 360 + 360) % 360;
}
