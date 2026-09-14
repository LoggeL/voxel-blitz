# KESTREL Revision 2 (VK-77 RAPTOR)

Der Karabiner des `rifle`-Slots wurde über die laufende Blender-MCP-Sitzung (Protokoll 5, `execute_blender_code`) mit `tools/blender/kestrel/build-kestrel.py` komplett neu aufgebaut. Das Skript legt eine eigene Szene `KESTREL | Voxel Blitz rifle study` an, prüft beim Bau den eingefrorenen Laufzeitvertrag und speichert mit `copy=True`, so dass die parallele Granaten-Studie in derselben Sitzung unberührt bleibt. Der erste Entwurf (`build-weapon.py`, gerigged mit Reload_Study-Clip) liegt weiter als `kestrel-r1.blend` und `kestrel-r1.glb` daneben.

Die Form ist ein moderner M4-Karabiner: geschlossener Oberreceiver mit offenem Auswurffenster (der Verschlussträger ist darin sichtbar und läuft mit der `bolt`-Gruppe mit), Hülsenabweiser, offen hängender Staubdeckel und Forward Assist; durchgehende Picatinny-Schiene mit umgeklapptem Klappvisier und dem werkseitigen Reflexvisier auf der 0,145-m-Ziellinie; linksseitiger, mitlaufender Durchladehebel; Unterreceiver mit ausgestelltem Magazinschacht, Sicherungshebel, Verschlussfang und Magazinlöser; offener Abzugsbügel; geneigter Pistolengriff mit Griffrippen, Gummirücken und bernsteinfarbener Bodenkappe; achteckiger M-LOK-Handschutz mit Schlitzen auf allen Facetten, bernsteinfarbener Rippen-Abdeckung auf der Stützhandseite und innenliegendem Gasrohr; Gasblock mit A-Rahmen-Korn, das durch das Reflexfenster mitgezielt wird; blanker Lauf mit 0,0170 m Radius über das Hitzeband und sechszinkiger Mündungsfeuerdämpfer; gebogenes 30-Schuss-Magazin mit Sichtrippen, Messing-Patronenfenster und bernsteinfarbener Bodenplatte; sechsstufiger Schiebeschaft auf dem Pufferrohr mit Wangenauflage und geriffelter Gummi-Schaftkappe.

Die acht Oberflächen verwenden die gemeinsame ImageGen-Palette (phosphatierter Stahl, Formpolymer, Petrol-Lack, orangefarbener Lack, Elfenbein-Keramik, genarbter Gummi, gealtertes Messing) plus das transparente Visierglas. Zuordnung und Methodik: `../material-library/README.md`. Neue Bilder wurden nicht erzeugt.

## Aktuelle Dateien

- `kestrel.blend`: bearbeitbare Quelle (eine Szene, Texturen eingebettet); der Exporter entfernt fremde Szenen aus der Sitzungskopie.
- `kestrel.glb`: portables Modell mit Teile-Rig (`body`, `mag`, `bolt`, `trigger`, `factory-optic`, `extra`) und den Markern `muzzle`, `grip`, `support`, `sight`.
- `public/assets/blender/kestrel.gltf` und `.bin`: Spiellieferung, 18 Primitive, 12 532 Dreiecke, 888 880 Byte Geometrie, gemeinsam geladene Texturen.
- `render-hero.png`, `render-side.png`, `render-left.png`, `render-ads.png`, `render-rear.png`: Cycles-Studiobilder des fertigen Modells.
- `mcp-viewport.png`: Viewport-Rücklesung aus der laufenden MCP-Sitzung.
- `validation.json`: Neuimport in einer frischen Blender-Instanz plus Prüfung der Laufzeit-glTF.
- `manifest.json`: Teile, Dreiecke, Anker und Bauprüfungen; `material-library.json`: Palettenzuordnung.
- `kestrel-r1.blend`, `kestrel-r1.glb`, `kestrel.png`, `viewport-untextured.png`: Stand der ersten Fassung, kein Nachweis für diesen Neuaufbau.

## Geprüfter Stand

200 modellierte Teile, 12 532 Dreiecke in portabler Datei und Spiellieferung, 18 Zeichenaufrufe, acht Materialien. Beim Bau bestehen alle Vertragsprüfungen: Mündungsebene bei y 0,598 mit Laufachse (-0,012, 0,045), blanker Radius 0,0170 über das gesamte Hitzeband 0,460..0,572 ohne Fremdgeometrie, alle vier Marker, Abzugsblatt bei y 0,130 mit Spitze z -0,038, Durchladehebel bei y 0,035 mit Ausladung bis x -0,074, nichts außer Visierglas, Korn und Kornschutz auf der 0,145-Linie innerhalb |x| < 0,018, Schienenaufbauten hinter dem Reflexvisier unter z 0,125, Griffflanke bei x 0,020 innerhalb der 0,045-Handfläche, Handschutzunterseite bei z 0,007 auf der Stützhand. Koplanare Flächen: keine. Schwebende Teile: keine (jedes Teil erreicht den Unterreceiver durch tatsächliche Mesh-Überschneidung, Einschluss oder höchstens 1 mm Abstand).

Der Neuimport (`validate-kestrel.py`) bestätigt Knoten, Marker, Identitätstransformationen, Mündungsspitze, Hitzebandradius, freie Ziellinie, Linsenspanne über 0,145, leere `extra`-Gruppe, 18 Primitive und das Dreiecksbudget; die Laufzeit-glTF trägt die Vertragsknoten, `textures/`-Bild-URIs, genau ein Blend-Material und `kestrel.bin` als Puffer.

Im Browser besteht der Integrationslauf (`blender-assets-browser-test.mjs`) für den Karabiner: KESTREL wird im Avatar und in der Erstperson geladen, das Reflexvisier verschwindet bei einem aufgesetzten Ersatzvisier, Skins greifen, Training läuft mit KESTREL. Aufnahmen: `.artifacts/blender-integration/kestrel-{held,scoped,firing}.png`, `.artifacts/weapon-renders/rifle-{held,scoped}.png`, `.artifacts/avatar-renders/rifle-front.png`. Das HUD-Symbol `public/assets/weapons/hud/rifle.png` stammt aus der gelieferten Geometrie. `hitbox-model-test.mjs` und `weapons:reload:test` bestehen unverändert; Anzeigename, Werte, Inventar-ID, Server-Hitboxen und Nachlade-/Abzugszeiten sind unverändert.

Aufbau: `tools/blender/kestrel/build-kestrel.py`. Export: `tools/blender/kestrel/export-game-assets.py`. Neuimport-Prüfung: `tools/blender/kestrel/validate-kestrel.py`. Studiobilder: `tools/blender/kestrel/render-kestrel.py` (`KESTREL_ENGINE=BLENDER_EEVEE` für schnelle Sichtkontrollen).
