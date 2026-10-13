# Utilities

Offline-fähige Web-App (PWA) mit fünf Werkzeugen: Höhenmesser, GPS (offline), Inertialnavigation, Sonnenortung, Koordinatenumrechnung. Kein Build-Schritt, keine Server-Komponente.

## Installation auf dem iPhone

1. App veröffentlichen (einmalig), z. B. über GitHub Pages:
   GitHub → Repository → **Settings → Pages** → *Source: Deploy from a branch* → Branch `master`, Ordner `/ (root)` → **Save**.
   Nach 1–2 Minuten ist die App unter `https://<benutzername>.github.io/<repository>/` erreichbar.
   (GitHub Pages für private Repositories setzt ein kostenpflichtiges GitHub-Konto voraus.)
2. Adresse in **Safari** öffnen → Teilen-Symbol → **Zum Home-Bildschirm**.
3. App einmal online starten; danach ist sie vollständig offline nutzbar.
4. Für Offline-Karten: Kartenausschnitt online ansehen oder mit dem Download-Knopf auf der Karte speichern (bis 400 Kacheln je Vorgang).
5. Für die Satellitenberechnung im GPS-Werkzeug einmal online „Bahndaten laden“.

Berechtigungen: Standort (GPS, Inertialnavigation-Start, Koordinaten) und „Bewegung & Ausrichtung“ (Inertialnavigation, Sonnenortung) werden beim ersten Gebrauch abgefragt.

## Technische Grenzen (Browser)

- **Luftdruck:** Safari/iOS gibt Web-Apps keinen Zugriff auf den Barometer. Der Höhenmesser nutzt einen Drucksensor nur, wenn der Browser einen anbietet; sonst manuelle Druckeingabe.
- **GPS-Rohdaten:** Browser liefern keine Satellitenanzahl, Signalstärken oder Ephemeriden. Die Position berechnet der GNSS-Empfänger des Geräts (funktioniert offline). Die angezeigte Satellitenanzahl ist aus Bahndaten (CelesTrak) berechnet, nicht empfangen.
- **Hintergrund:** Bei gesperrtem Bildschirm liefert iOS keine Sensordaten; die Inertialnavigation pausiert.

## Entwicklung

- Lokal starten: `python3 -m http.server 8765` im Projektordner, dann `http://localhost:8765`.
- Nach Änderungen an Dateien: `node scripts/precache.js` (aktualisiert Offline-Dateiliste und Version im Service Worker).
- Icons neu erzeugen: `node scripts/icons.js` (benötigt Playwright/Chromium).

Drittsoftware: Leaflet (BSD-2), satellite.js (MIT), geomagnetism/WMM2025 (MIT/gemeinfrei). Kartendaten © OpenStreetMap-Mitwirkende, CARTO, OpenTopoMap.
