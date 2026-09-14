# PEREGRINE nach ImageGen-Entwurf A

Der Sniper wurde über Blender MCP nach Variante A aus `../peregrine-redesign/concepts.png` neu aufgebaut. Die Form verwendet einen offenen dreieckigen Schaft, einen durchgehenden petrolfarbenen Vorderschaft, ein kompaktes Zielfernrohr mit elfenbeinfarbenen Ringen und orangefarbene Akzente. Der Bildprompt steht in `../peregrine-redesign/imagegen-prompt.md`.

Die sechs Oberflächen verwenden jetzt die gemeinsame ImageGen-Palette: dunkler Stahl, bearbeiteter Stahl, Petrol-Lack, Elfenbein-Keramik, orangefarbener Lack und genarbter Gummi. Zuordnung und Methodik: `../material-library/README.md`.

## Aktuelle Dateien

- `peregrine.blend`: bearbeitbare Quelle mit eingebetteten Texturen.
- `peregrine.glb`: portables Modell mit eingebetteten Farbtexturen.
- `public/assets/blender/peregrine.gltf` und `.bin`: Spiellieferung mit gemeinsam geladenen Texturen.
- `../peregrine-redesign/model-hero.png`, `model-side.png`, `model-rear.png`, `model-optic.png`: aktuelle Blender-Ansichten mit Texturen.
- `../peregrine-redesign/geometry-validation.json`: Prüfung der aktuellen Geometrie.
- `manifest.json`: Teile, Dreiecke und Anker des neuen Aufbaus.

Die älteren `render-*.png`, `mcp-viewport.png` und `validation.json` in diesem Ordner stammen aus der vorherigen Modellfassung und sind kein Nachweis für diesen Neuaufbau.

## Geprüfter Stand

104 modellierte Objekte, insgesamt 6400 Dreiecke in portabler Datei und Spiellieferung, einschließlich drei separater Nachladepatronen. Keine degenerierten Dreiecke. Neun Verbindungen wurden anhand tatsächlicher Mesh-Überschneidungen geprüft. Beide Handanker liegen auf der Waffenoberfläche; fünf Sichtstrahlen bleiben sowohl im Körper als auch im werkseitigen Zielfernrohr frei.

Die bestehenden Gameplay-Anker und Animationsgruppen bleiben erhalten. Der lokale Ort der optischen Linse wurde an das kompaktere Zielfernrohr angepasst. Der Browserlauf prüft Halten, Zielen, Schießen und Nachladen bei Desktop- und Mobilabmessungen; die Integrationsprüfung deckt 432 Posen ab. Details und Bildschirmaufnahmen liegen unter `.artifacts/sniper-redesign/`.

Aufbau: `tools/blender/peregrine/build-peregrine.py`. Export: `tools/blender/peregrine/export-game-assets.py`. Geometrieprüfung: `tools/blender/peregrine/validate-redesign.py`. Aktuelle Studiobilder: `tools/blender/peregrine/render-redesign.py`.
