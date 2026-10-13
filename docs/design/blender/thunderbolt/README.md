# TB-4 Blender asset

Die editierbare Quelle ist [thunderbolt.blend](thunderbolt.blend). Der Build erzeugt das Modell aus dem [Blender-Skript](../../../../tools/blender/thunderbolt/build-thunderbolt.py) und rendert [studio.png](studio.png). Gestaltung und Keramiktextur folgen dem neuen [ImageGen-Entwurf](../../thunderbolt/concept-blender-v2.png), dem [Modell-Prompt](../../thunderbolt/prompt-blender-v2.md) und dem [Textur-Prompt](../../thunderbolt/prompt-ceramic-v2.md). Beide Bilder wurden mit dem integrierten ImageGen-Werkzeug erzeugt.

## Reproduzieren

Vom Repository-Stamm aus, mit Blender 5.2.1 LTS und Node.js:

```sh
BLENDER=/Applications/Blender.app/Contents/MacOS/Blender
"$BLENDER" --background --factory-startup --python-exit-code 1 --python tools/blender/thunderbolt/build-thunderbolt.py
"$BLENDER" --background --factory-startup docs/design/blender/thunderbolt/thunderbolt.blend --python-exit-code 1 --python tools/blender/thunderbolt/export-thunderbolt.py
node tools/thunderbolt-blender-test.mjs
```

Auf Systemen mit Blender im Suchpfad kann `BLENDER=blender` verwendet werden. Der Build überschreibt die TB-4-Quelle und das Studiobild. Der Export schreibt `public/assets/blender/thunderbolt.gltf`, die zugehörige `.bin`, die portable [thunderbolt.glb](thunderbolt.glb) und die lokalen Berichte. Im gemeinsamen Runtime-Manifest wird nur der Eintrag `thunderbolt` ersetzt.

## Geometrie und Animation

Blender speichert die Waffenkoordinaten als `(gameX, -gameZ, gameY)`. Der Export wertet Modifier aus und schreibt Positionen und gesplittete Ecknormalen in Spielkoordinaten `(blenderX, blenderZ, -blenderY)`. UVs werden von Blender `(u, v)` nach glTF `(u, 1-v)` konvertiert: Blender verwendet den unteren, glTF den oberen Bildrand als Ursprung; `GLTFLoader` setzt deshalb `flipY=false`. Alle exportierten Knoten haben Identitätstransformationen. Jeder oberste Knoten ist eine Gruppe mit separaten Mesh-Kindern pro Material; Gruppierung und Material-Batching verändern keine Animationsgrenzen.

Die benannten Teile sind `body`, `bolt`, `trigger`, `rotor`, `orb0` bis `orb3`, `energy`, `arcs` und `optic`. Gruppen und Mesh-Kinder tragen `extras.blenderAsset="thunderbolt"` sowie `extras.part`. [thunderbolt-blender.js](../../../../public/js/guns/models/thunderbolt-blender.js) setzt die global exportierten Meshes einmalig in die lokalen Gelenkkoordinaten um.

| Vertrag | Spielkoordinaten |
| --- | --- |
| Trommelachse | `(-0.103, 0.009, -0.22)` |
| Beschleunigerkern | `(0, 0.07, -0.64)` |
| Autoritative Mündung | `(0, 0.07, -0.74)` |
| Visierhöhe | `y = 0.17` |
| Griffmarker | `(0.004, -0.04, -0.07)` |
| Stützhandmarker | `(-0.004, -0.02, -0.43)` |

Orb `i` liegt relativ zur Trommelachse bei `(0.052*cos(a), 0.052*sin(a), 0.059)` mit `a = π/4 - i*π/2`. Dadurch bleiben Verbrauch, Vierteldrehung und Nachladen mit dem vorhandenen zustandsgetriebenen Animator verbunden. Marker aus der Blender-Quelle werden als Metadaten in `asset.extras.contract` exportiert. Die Geometrie ändert keine Waffenwerte.

## Oberflächen und Eigentum

Alle Meshes besitzen UVs. Die sechs tatsächlichen Farbtexturen sind `thunderbolt-ceramic.png` sowie `palette/machined-steel.jpg`, `phosphated-steel.jpg`, `aged-copper.jpg`, `pebbled-rubber.jpg` und `molded-polymer.jpg` unter `public/assets/blender/textures/`. Die Keramik ist die neue TB-4-Textur; die übrigen Dateien stammen aus der gemeinsamen Materialbibliothek.

Materialien speichern `textureFile`, die ausdrücklich gesetzte `textureTint` und `textureBumpScale`. Der Export übernimmt den Farb-Multiplikator sowie die Metallic-/Roughness-Werte. Die Runtime verwendet die Farbtextur zusätzlich für eine kleine künstlerische Reliefwirkung; separate gemessene Normalen- oder Rauheitskarten sind nicht enthalten. Elektrische Materialien haben absichtlich keine verknüpfte Farbtextur. Ihre Farbe, Leuchtstärke und Rollen bleiben über `tbEnergy`, `tbArc`, `tbOrb` und `KHR_materials_emissive_strength` erhalten.

Geometrie und kanonische Texturen gehören der Seite und werden von Waffeninstanzen geteilt. Materialien werden je Waffeninstanz geklont. Leisten und Visierlichter teilen das `tbEnergy`-Material, die Beschleunigerblitze verwenden `tbArc`. Die vier Magazinladungen und der Beschleunigerkern sind fünf einzelne Kugelmeshes mit dem separaten `tbOrb`-Material. An den Kugeln gibt es keine Äquator- oder Meridian-Meshes. Diese Trennung erlaubt einen eigenen Plasmaeffekt, ohne die Leisten und Visierlichter zu verändern. Die GLB enthält dieselben Geometriebytes und unveränderten Bilddateien wie die Runtime-Ausgabe, ohne externe Texturabhängigkeiten. Ein Runtime-Shader wird über die Materialrolle angebunden; die portable GLB enthält die exportierte Grundfarbe und Emission.

## Geprüfter Stand

Der [Exportbericht](export-report.json) weist 181 Quellmeshes, 39.976 exportierte Dreiecke, 24 Draws, 9 Materialien und 6 Texturen aus. Das Geometriebuffer umfasst 1.981.984 Bytes. 12 kollabierte Quellflächen wurden beim Export entfernt. 99,30 % der texturierten Dreiecke haben eine UV-Fläche größer als die Prüftoleranz.

`node tools/thunderbolt-blender-test.mjs` besteht. Geprüft werden Gruppen und Gelenkpositionen, endliche Positionen, normalisierte Normalen, nicht kollabierte Dreiecke, UV-Abdeckung, tatsächliche Texturdateien, Mündungsposition, freier Sichtstrahl und die bytegenaue GLB-/Runtime-Übereinstimmung einschließlich aller eingebetteten Bilder. Fünf getrennte `tbOrb`-Quellmeshes, reine Kugeloberflächen und die Materialtrennung zu Leisten und Blitzen werden ebenfalls geprüft. Eine direkt aus Blender gelesene Eck-UV je Material-/Teile-Batch wird gegen den Runtime-Accessor geprüft, einschließlich der erforderlichen V-Invertierung.

Ein frischer GLB-Import in eine leere Blender-Instanz bestätigte ebenfalls 24 Meshes, 39.976 Dreiecke und 6 Bilder. Diese Prüfung lässt sich so wiederholen:

```sh
"$BLENDER" --background --factory-startup --python-exit-code 1 --python-expr 'import bpy; bpy.ops.wm.read_factory_settings(use_empty=True); bpy.ops.import_scene.gltf(filepath="docs/design/blender/thunderbolt/thunderbolt.glb"); meshes=[o for o in bpy.context.scene.objects if o.type=="MESH"]; [o.data.calc_loop_triangles() for o in meshes]; counts=(len(meshes),sum(len(o.data.loop_triangles) for o in meshes),len([i for i in bpy.data.images if i.source=="FILE"])); print(counts); assert counts==(24,39976,6)'
```
