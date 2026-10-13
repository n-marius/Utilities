# Utilities

Offline-fähige Web-App (PWA). Werkzeuge: Inertialnavigation, Sonnenortung, Sternennavigation, Koordinatenumrechnung, Hangneigung mit Lawinen-Check. Experimentell: Kreuzpeilung. Kein Build-Schritt, keine Server-Komponente.

## Installation auf dem iPhone

1. App veröffentlichen (einmalig), z. B. über GitHub Pages:
   GitHub → Repository → **Settings → Pages** → *Source: Deploy from a branch* → Branch `main`, Ordner `/ (root)` → **Save**.
   Nach 1–2 Minuten ist die App unter `https://<benutzername>.github.io/<repository>/` erreichbar.
   (GitHub Pages für private Repositories setzt ein kostenpflichtiges GitHub-Konto voraus.)
2. Adresse in **Safari** öffnen → Teilen-Symbol → **Zum Home-Bildschirm**.
3. App einmal online starten; danach ist sie vollständig offline nutzbar.
4. Karten: Offline zeigt jede Karte eine eingebaute Grundkarte (Natural Earth: Länder, Grenzen, Gewässer, größere Orte, Gradnetz). Detailkarten (OpenStreetMap) sind offline verfügbar, wenn der Ausschnitt vorher online angesehen oder mit dem Download-Knopf gespeichert wurde (bis 250 Kacheln je Vorgang; die Kachelserver untersagen Massen-Downloads).
5. what3words (Koordinaten-Werkzeug): nur online und mit eigenem API-Schlüssel von what3words.

Berechtigungen: Standort (Start der Inertialnavigation, Koordinaten, Missweisung/Tageslicht bei Hangneigung) und „Bewegung & Ausrichtung“ (Inertialnavigation, Sonnen-/Sternennavigation, Kreuzpeilung, Hangneigung) werden beim ersten Gebrauch abgefragt.

## Technische Grenzen (Browser)

- **Luftdruck, Magnetfeld, Temperatur:** Safari/iOS gibt Web-Apps weder Barometer-, Magnetometer- noch Temperaturwerte (nur die Kompassrichtung). Höhenmesser, Magnetfeld- und Schwere-Ortung sind daher nicht enthalten.
- **GPS-Rohdaten:** Das iPhone gibt Satellitenanzahl, Signalstärken und Rohdaten weder an Web-Apps noch an native Apps heraus; auch der Fortschritt bis zum ersten Fix ist nicht abfragbar. Ein eigenes GPS-Werkzeug ist daher nicht enthalten.
- **Hintergrund:** Bei gesperrtem Bildschirm liefert iOS keine Sensordaten; die Inertialnavigation pausiert.

## Entwicklung

- Lokal starten: `python3 -m http.server 8765` im Projektordner, dann `http://localhost:8765`.
- Nach Änderungen an Dateien: `node scripts/precache.js` (aktualisiert Offline-Dateiliste und Version im Service Worker).
- Icons neu erzeugen: `node scripts/icons.js` (benötigt Playwright/Chromium).

Drittsoftware: Leaflet (BSD-2), geomagnetism/WMM2025 (MIT/gemeinfrei). Kartendaten © OpenStreetMap-Mitwirkende, OpenTopoMap; Grundkarte Natural Earth (gemeinfrei, `scripts/basemap-pack.py`).
