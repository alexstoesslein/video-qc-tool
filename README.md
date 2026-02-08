# Video QC Tool

Webbasiertes Quality-Check-Tool fuer Video- und Audio-Dateien. Analysiert Medien automatisch gegen kanalspezifische Qualitaetsstandards und liefert eine detaillierte Auswertung.

## Features

- **12 Qualitaetspruefungen** -- Aufloesung, Bitrate, Framerate, Sample Rate, Audio-Kanaele, Lautstaerke (LUFS), True Peak, Schwarzbilder, Media Offline, Rauschen, Audio-Uebersteuerung, Fehlschnitte
- **7 Zielkanaele** mit individuellen Schwellwerten -- Podcast, Social Media, YouTube, TV/Broadcast, Kino, Streaming, Webinar
- **Audio-Waveform** mit Clipping- und Lautstaerke-Markern fuer reine Audio-Dateien
- **Fehlschnitt-Erkennung** (Fuck Frames) -- findet versehentlich im Export verbliebene Einzelframes
- **Selektierbare Analysen** -- per Checkbox vor der Analyse auswaehlbar
- **Upload-Fortschritt** -- Echtzeit-Anzeige fuer grosse Dateien (getestet bis 26 GB+)
- **Asynchrone Analyse** -- Threading-basiert mit Live-Fortschrittsanzeige und Zeitschaetzung

## Voraussetzungen

- Python 3.9+
- ffmpeg und ffprobe (muessen im PATH liegen)

### ffmpeg installieren

**macOS:**
```bash
brew install ffmpeg
```

**Ubuntu/Debian:**
```bash
sudo apt install ffmpeg
```

**Windows:**

Binaries von https://ffmpeg.org/download.html herunterladen und zum PATH hinzufuegen.

## Installation

```bash
# Repository klonen
git clone https://github.com/alexstoesslein/video-qc-tool.git
cd video-qc-tool

# Virtuelle Umgebung erstellen
python3 -m venv venv
source venv/bin/activate   # macOS/Linux
# venv\Scripts\activate    # Windows

# Abhaengigkeiten installieren
pip install -r requirements.txt
```

## Starten

```bash
source venv/bin/activate
python app.py
```

Das Tool ist dann erreichbar unter: **http://127.0.0.1:5000**

> **Hinweis (macOS):** Port 5000 wird moeglicherweise vom AirPlay Receiver belegt. In dem Fall `http://127.0.0.1:5000` verwenden, nicht `localhost:5000`.

## Benutzung

1. Video- oder Audio-Datei per Drag & Drop oder Dateiauswahl hochladen
2. Zielkanal waehlen (z.B. YouTube, TV/Broadcast, Podcast)
3. Optional: Einzelne Analysen per Checkbox aktivieren/deaktivieren
4. "Analyse starten" klicken
5. Ergebnisse werden mit Score, Einzelpruefungen und Timeline angezeigt

## Qualitaetspruefungen

| Pruefung | Kategorie | Beschreibung |
|---|---|---|
| Aufloesung | Video | Mindestaufloesung je nach Kanal |
| Bitrate | Video | Mindest-Gesamtbitrate |
| Framerate | Video | Akzeptierte Framerates (z.B. 24, 25, 30 fps) |
| Audio Sample Rate | Audio | Mindest-Abtastrate (44.1/48 kHz) |
| Audio-Kanaele | Audio | Mindestanzahl (Mono/Stereo/5.1) |
| Lautstaerke (LUFS) | Audio | EBU R128 Integrated Loudness |
| True Peak | Audio | Maximaler True-Peak-Pegel |
| Schwarzbilder | Content | Erkennung schwarzer Frames |
| Media Offline | Content | Eingefrorene Frames (Freeze Detect) |
| Rauschen | Content | Signalrauschen (TOUT-Analyse) |
| Audio-Uebersteuerung | Audio | Clipping-Erkennung per Peak-Analyse |
| Fehlschnitte | Content | Versehentliche Einzelframes (Scene Detection) |

## Kanaele und Schwellwerte

| Kanal | Aufloesung | Bitrate | LUFS | True Peak |
|---|---|---|---|---|
| Podcast | 640x480 | 1.000 kbps | -16 +/-2 | -1.0 dBFS |
| Social Media | 1080x1080 | 8.000 kbps | -14 +/-2 | -1.0 dBFS |
| YouTube | 1920x1080 | 10.000 kbps | -14 +/-2 | -1.0 dBFS |
| TV/Broadcast | 1920x1080 | 25.000 kbps | -24 +/-1 | -1.0 dBFS |
| Kino | 3840x2160 | 50.000 kbps | -24 +/-2 | -1.0 dBFS |
| Streaming | 1920x1080 | 15.000 kbps | -24 +/-2 | -2.0 dBFS |
| Webinar | 1280x720 | 2.500 kbps | -16 +/-3 | -1.0 dBFS |

Schwellwerte koennen in `config.py` angepasst werden.

## Projektstruktur

```
video-qc-tool/
  app.py                    # Flask-App, Job-System, API-Endpunkte
  config.py                 # Kanalkonfiguration, Schwellwerte
  requirements.txt          # Python-Abhaengigkeiten
  analyzers/
    metadata.py             # Metadaten-Extraktion (ffprobe)
    black_frames.py         # Schwarzbild-Erkennung (blackdetect)
    media_offline.py        # Freeze-Erkennung (freezedetect)
    noise.py                # Rauschanalyse (signalstats)
    audio_loudness.py       # Lautstaerke-Messung (ebur128)
    audio_clipping.py       # Clipping-Erkennung (astats)
    fuck_frames.py          # Fehlschnitt-Erkennung (scene detection)
    waveform.py             # Waveform-PNG-Erzeugung (showwavespic)
    quality_checks.py       # Qualitaetsbewertung und Aggregation
  static/
    css/style.css           # UI-Styling
    js/app.js               # Hauptlogik, Upload, Polling
    js/results.js           # Ergebnisdarstellung, Player, Waveform
    js/upload.js            # Datei-Upload (Drag & Drop)
  templates/
    index.html              # Single-Page-App Template
```

## Technologie

- **Backend:** Python, Flask, Threading
- **Frontend:** Vanilla JavaScript, HTML, CSS
- **Medienanalyse:** ffmpeg, ffprobe
- **Waveform:** ffmpeg showwavespic-Filter (serverseitig)

## Lizenz

Privates Projekt.
