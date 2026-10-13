// Sternbilder für die Sternennavigation. Koordinaten ICRS/J2000 (Grad), Eigenbewegung
// pmra = μα·cos δ und pmdec (mas/Jahr), V-Helligkeit. Werte aus SIMBAD (abgerufen 13.10.2026),
// gerundet auf 1e-5°. Vermessen wird jeweils der hellste Stern (target).
// Hinweise: Acrux und α Cen sind Doppelsterne (bloßes Auge: ein Punkt, V = Gesamthelligkeit);
// α Cen: Koordinaten/Eigenbewegung von α Cen A (B steht ~8″ daneben, vernachlässigbar).
// γ Cas (2,4 mag, veränderlich 1,6–3,0) kann zeitweise heller als Schedar sein; Beteigeuze (0,4 mag,
// veränderlich) zeitweise heller als Rigel – vermessen wird der jeweils im Katalog hellste Stern.

const S = (name, ra, dec, v, pmra = 0, pmdec = 0) => ({ name, ra, dec, v, pmra, pmdec });

export const STARS = {
  // Kleiner Wagen
  alfUMi: S('Polaris', 37.95456, 89.26411, 2.02, 44.48, -11.85),
  delUMi: S('Yildun', 263.05416, 86.58646, 4.34),
  epsUMi: S('ε UMi', 251.49268, 82.03726, 4.21),
  zetUMi: S('ζ UMi', 236.01466, 77.79449, 4.27),
  etaUMi: S('η UMi', 244.37613, 75.75534, 4.95),
  gamUMi: S('Pherkad', 230.1821, 71.83403, 3.00),
  betUMi: S('Kochab', 222.67636, 74.1555, 2.08),
  // Großer Wagen
  alfUMa: S('Dubhe', 165.93196, 61.75103, 1.79),
  betUMa: S('Merak', 165.46033, 56.38243, 2.37),
  gamUMa: S('Phecda', 178.4577, 53.69476, 2.44),
  delUMa: S('Megrez', 183.8565, 57.03262, 3.32),
  epsUMa: S('Alioth', 193.50729, 55.95982, 1.77, 111.91, -8.24),
  zetUMa: S('Mizar', 200.98142, 54.92535, 2.23),
  etaUMa: S('Alkaid', 206.88516, 49.31327, 1.86),
  // Kassiopeia
  betCas: S('Caph', 2.29452, 59.14978, 2.27),
  alfCas: S('Schedar', 10.12685, 56.53733, 2.23, 49.126, -31.595),
  gamCas: S('γ Cas', 14.17721, 60.71674, 2.39),
  delCas: S('Ruchbah', 21.45396, 60.23528, 2.68),
  epsCas: S('Segin', 28.59889, 63.6701, 3.37),
  // Orion
  alfOri: S('Beteigeuze', 88.79294, 7.40706, 0.42),
  gamOri: S('Bellatrix', 81.28276, 6.3497, 1.64),
  lamOri: S('Meissa', 83.78449, 9.93416, 3.66),
  delOri: S('Mintaka', 83.00167, -0.2991, 2.41),
  epsOri: S('Alnilam', 84.05339, -1.20192, 1.69),
  zetOri: S('Alnitak', 85.18969, -1.94257, 1.77),
  kapOri: S('Saiph', 86.93912, -9.6696, 2.06),
  betOri: S('Rigel', 78.63447, -8.20164, 0.13, 1.31, 0.5),
  // Kreuz des Südens
  alfCru: S('Acrux', 186.64956, -63.09909, 0.76, -35.83, -14.86),
  betCru: S('Mimosa', 191.93029, -59.68877, 1.25),
  gamCru: S('Gacrux', 187.7915, -57.11321, 1.64),
  delCru: S('Imai', 183.78633, -58.74892, 2.75),
  epsCru: S('ε Cru', 185.34003, -60.40115, 3.57),
  // Skorpion
  alfSco: S('Antares', 247.35192, -26.432, 0.91, -12.11, -23.3),
  betSco: S('Acrab', 241.3593, -19.80545, 2.62),
  delSco: S('Dschubba', 240.08336, -22.62171, 2.32),
  piSco: S('π Sco', 239.71297, -26.11411, 2.91),
  sigSco: S('σ Sco', 245.29715, -25.59279, 2.89),
  tauSco: S('τ Sco', 248.97064, -28.21602, 2.81),
  epsSco: S('Larawag', 252.54088, -34.29323, 2.29),
  muSco: S('μ¹ Sco', 252.96762, -38.0474, 2.98),
  zetSco: S('ζ² Sco', 253.64585, -42.36132, 3.62),
  etaSco: S('η Sco', 258.03831, -43.23919, 3.33),
  thtSco: S('Sargas', 264.32971, -42.99783, 1.85),
  iotSco: S('ι¹ Sco', 266.89616, -40.127, 2.99),
  kapSco: S('κ Sco', 265.62198, -39.02998, 2.39),
  lamSco: S('Shaula', 263.40217, -37.10382, 1.63),
  // Zentaur
  alfCen: S('Rigil Kentaurus', 219.90206, -60.83399, -0.27, -3679.25, 473.67),
  betCen: S('Hadar', 210.95586, -60.37304, 0.58),
  epsCen: S('ε Cen', 204.97191, -53.46639, 2.30),
  zetCen: S('ζ Cen', 208.88494, -47.28837, 2.55),
  etaCen: S('η Cen', 218.87677, -42.15783, 2.31),
  thtCen: S('Menkent', 211.67061, -36.36995, 2.05),
  gamCen: S('γ Cen', 190.37933, -48.95987, 2.17),
  delCen: S('δ Cen', 182.08957, -50.72243, 2.52),
  // Kiel des Schiffs
  alfCar: S('Canopus', 95.98796, -52.69566, -0.74, 19.93, 23.24),
  chiCar: S('χ Car', 119.19467, -52.98235, 3.43),
  epsCar: S('Avior', 125.62848, -59.50948, 1.86),
  iotCar: S('Aspidiske', 139.27253, -59.27523, 2.26),
  betCar: S('Miaplacidus', 138.29991, -69.71721, 1.69),
  upsCar: S('υ Car', 146.77551, -65.07201, 2.99),
  omeCar: S('ω Car', 153.43425, -70.03791, 3.33),
  thtCar: S('θ Car', 160.73917, -64.39445, 2.76)
};

export const CONSTELLATIONS = {
  north: [
    { id: 'umi', name: 'Kleiner Wagen', target: 'alfUMi',
      stars: ['alfUMi', 'delUMi', 'epsUMi', 'zetUMi', 'etaUMi', 'gamUMi', 'betUMi'],
      lines: [['alfUMi', 'delUMi'], ['delUMi', 'epsUMi'], ['epsUMi', 'zetUMi'], ['zetUMi', 'etaUMi'], ['etaUMi', 'gamUMi'], ['gamUMi', 'betUMi'], ['betUMi', 'zetUMi']] },
    { id: 'uma', name: 'Großer Wagen', target: 'epsUMa',
      stars: ['alfUMa', 'betUMa', 'gamUMa', 'delUMa', 'epsUMa', 'zetUMa', 'etaUMa'],
      lines: [['alfUMa', 'betUMa'], ['betUMa', 'gamUMa'], ['gamUMa', 'delUMa'], ['delUMa', 'alfUMa'], ['delUMa', 'epsUMa'], ['epsUMa', 'zetUMa'], ['zetUMa', 'etaUMa']] },
    { id: 'cas', name: 'Kassiopeia', target: 'alfCas',
      stars: ['betCas', 'alfCas', 'gamCas', 'delCas', 'epsCas'],
      lines: [['betCas', 'alfCas'], ['alfCas', 'gamCas'], ['gamCas', 'delCas'], ['delCas', 'epsCas']] },
    { id: 'ori', name: 'Orion', target: 'betOri',
      stars: ['alfOri', 'gamOri', 'lamOri', 'delOri', 'epsOri', 'zetOri', 'kapOri', 'betOri'],
      lines: [['lamOri', 'alfOri'], ['lamOri', 'gamOri'], ['alfOri', 'zetOri'], ['gamOri', 'delOri'], ['delOri', 'epsOri'], ['epsOri', 'zetOri'], ['zetOri', 'kapOri'], ['delOri', 'betOri']] }
  ],
  south: [
    { id: 'cru', name: 'Kreuz des Südens', target: 'alfCru',
      stars: ['alfCru', 'betCru', 'gamCru', 'delCru', 'epsCru'],
      lines: [['alfCru', 'gamCru'], ['betCru', 'delCru']] },
    { id: 'sco', name: 'Skorpion', target: 'alfSco',
      stars: ['betSco', 'delSco', 'piSco', 'sigSco', 'alfSco', 'tauSco', 'epsSco', 'muSco', 'zetSco', 'etaSco', 'thtSco', 'iotSco', 'kapSco', 'lamSco'],
      lines: [['betSco', 'delSco'], ['delSco', 'piSco'], ['delSco', 'sigSco'], ['sigSco', 'alfSco'], ['alfSco', 'tauSco'], ['tauSco', 'epsSco'], ['epsSco', 'muSco'], ['muSco', 'zetSco'], ['zetSco', 'etaSco'], ['etaSco', 'thtSco'], ['thtSco', 'iotSco'], ['iotSco', 'kapSco'], ['kapSco', 'lamSco']] },
    { id: 'cen', name: 'Zentaur', target: 'alfCen',
      stars: ['alfCen', 'betCen', 'epsCen', 'zetCen', 'etaCen', 'thtCen', 'gamCen', 'delCen'],
      lines: [['alfCen', 'betCen'], ['betCen', 'epsCen'], ['epsCen', 'gamCen'], ['gamCen', 'delCen'], ['epsCen', 'zetCen'], ['zetCen', 'etaCen'], ['zetCen', 'thtCen']] },
    { id: 'car', name: 'Kiel des Schiffs', target: 'alfCar',
      stars: ['alfCar', 'chiCar', 'epsCar', 'iotCar', 'betCar', 'upsCar', 'omeCar', 'thtCar'],
      lines: [['alfCar', 'chiCar'], ['chiCar', 'epsCar'], ['epsCar', 'iotCar'], ['iotCar', 'upsCar'], ['upsCar', 'thtCar'], ['epsCar', 'betCar'], ['betCar', 'omeCar'], ['omeCar', 'thtCar']] }
  ]
};

export const PLANETS = [
  { id: 'venus', name: 'Venus' },
  { id: 'mars', name: 'Mars' },
  { id: 'jupiter', name: 'Jupiter' },
  { id: 'saturn', name: 'Saturn' }
];

// Helle Sterne nahe der Ekliptik (SIMBAD, J2000) – zur Einordnung von Planeten („nächster heller Stern“).
export const ECLIPTIC_STARS = [
  S('Aldebaran', 68.98016, 16.5093, 0.86), S('Regulus', 152.09296, 11.96721, 1.40),
  S('Spica', 201.29825, -11.16132, 0.97), S('Antares', 247.35192, -26.432, 0.91),
  S('Pollux', 116.32896, 28.0262, 1.14), S('Castor', 113.64947, 31.88828, 1.58),
  S('Elnath', 81.57297, 28.60745, 1.65), S('Plejaden (Alcyone)', 56.87115, 24.10514, 2.87),
  S('Hamal', 31.79336, 23.46242, 2.01), S('Nunki', 283.81636, -26.29672, 2.07),
  S('Kaus Australis', 276.04299, -34.38462, 1.81), S('Zubenelgenubi', 222.71964, -16.04178, 2.75),
  S('Deneb Algedi', 326.76018, -16.12729, 2.83), S('Denebola', 177.26491, 14.57206, 2.13),
  S('Sadalsuud', 322.88972, -5.57117, 2.89), S('Menkar', 45.56989, 4.08974, 2.53),
  S('Alpheratz', 2.09692, 29.09043, 2.06)
];

// Tierkreis-Sternbilder entlang der Ekliptik: Beginn (ekliptikale Länge J2000, Grad) nach den IAU-Grenzen,
// gemessen auf der Ekliptik selbst. Für Planeten (Breite bis ~8°) nur eine Näherung.
export const ZODIAC = [
  [28.7, 'Widder'], [53.4, 'Stier'], [90.1, 'Zwillinge'], [118.2, 'Krebs'], [138.0, 'Löwe'],
  [174.2, 'Jungfrau'], [218.0, 'Waage'], [241.0, 'Skorpion'], [247.7, 'Schlangenträger'],
  [266.3, 'Schütze'], [299.7, 'Steinbock'], [327.5, 'Wassermann'], [351.6, 'Fische']
];

/** Farbe mit bloßem Auge. */
export const PLANET_COLOR = { venus: 'weiß', mars: 'rötlich', jupiter: 'weißgelb', saturn: 'gelblich' };
