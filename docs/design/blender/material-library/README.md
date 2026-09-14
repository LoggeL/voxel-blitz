# Waffenmaterialien

16 einzelne Oberflächen wurden mit dem eingebauten ImageGen-Werkzeug erzeugt. Die unveränderten PNG-Originale liegen hier, die vollständigen Prompts in `prompts.json`. Die Originale haben 1254 × 1254 Pixel. Das Spiel verwendet JPEGs mit 1024 × 1024 Pixeln aus `public/assets/blender/textures/palette/` (zusammen etwa 8 MiB).

`index.html` zeigt die gesamte Palette, `palette.png` ist ihre gerenderte Übersicht. `weapons-preview.png` zeigt alle zwölf tatsächlich im Browser zusammengesetzten Waffen in ihrer Ruhepose. Die Beleuchtung dieser Übersicht unterscheidet sich von den Blender-Studiobildern.

80 Materialien auf zwölf Waffen verwenden 15 der Oberflächen. Carbongewebe ist als zusätzliche Oberfläche vorbereitet. Glas, Leuchtmaterialien, Markierungen und schwarze Innenflächen behalten ihre jeweilige Darstellung. Die Zuordnung steht in `materials.json`.

Die Materialien kombinieren Bildtexturen mit passenden Metall- und Rauheitswerten sowie dezenter Bump-Struktur. Die Farbtextur liefert auch die Bump-Höhe. Das ist eine gestalterische Annäherung, kein gemessener PBR-Datensatz mit separaten Normal- und Rauheitskarten.

## Blender und Export

Die Palette wurde über Blender MCP auf die gespeicherten Quellen angewendet. `tools/blender/material-library.py` aktualisiert die Blender-Materialknoten, bettet die Bilder in die Quellen und GLBs ein und weist dieselben Bilder im Browser-glTF zu. Die abschließenden Materialschritte sind in den Waffenexportern eingebunden. Das Sniper-Aufbauskript verwendet die Palette ebenfalls.

Zum erneuten Anwenden in Blender (Projektpfad entsprechend setzen):

```python
import runpy
library = runpy.run_path('/Users/logge/Documents/Projects/voxel-blitz/tools/blender/material-library.py')
library['finish_asset']('peregrine')
```

`finish_asset` lädt bei Bedarf eine getrennte Kopie der betreffenden gespeicherten Szene. Die aktuelle Arbeitsszene wird dabei nicht ersetzt. Vorhandene Ausgaben werden vor der ersten Änderung unter `.artifacts/weapon-materials/before/` gesichert.

## Prüfung

- Alle zwölf gespeicherten Blender-Quellen enthalten zusammen 80 zugeordnete Materialien mit eingebetteten Bildern und Bump-Knoten: `blender-validation.json`.
- Alle zwölf Modelle laden im Browser mit UVs, 1024er Texturen und Bump-Struktur. Gemeinsame Bilder verwenden dieselbe Texturinstanz: `browser-validation.json`.
- Alle zwölf Geometrie-Binärdateien stimmen mit dem Stand vor diesem Texturpass überein. Wiederholtes Anwenden verändert die Materialausgabe nicht weiter: `export-validation.json`.
- Der Sniper besteht nach erneutem Export die unabhängigen Prüfungen auf Handkontakt, freie Sicht durch das Zielfernrohr, Geometrie und drei Nachladepatronen: `../peregrine-redesign/geometry-validation.json`.
- Sniper-Browseraufnahmen prüfen Halten, Zielen, Schießen und vier Nachladezeitpunkte bei Desktop- und Mobilabmessungen. Die importierte Waffenintegration besteht 432 Posen. Nachweise: `.artifacts/sniper-redesign/` und `.artifacts/weapon-materials/integration.log`.
- Alle zwölf HUD-Bilder wurden mit `node tools/render-hud-icon.mjs --all` aus den tatsächlich zusammengesetzten Modellen erneuert.

Die umfassendere Nachlade-Präsentationssuite meldete im parallelen Arbeitsstand eine fehlgeschlagene Rocket-Prüfung für die vollständig geöffnete hintere Klappe. Die gezielten Sniper- und Materialprüfungen bestehen; diese Texturarbeit ändert keine Nachladeabläufe.
