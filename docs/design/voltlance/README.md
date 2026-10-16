# CL-9 VOLTLANCE, Induktionslicht

Die VOLTLANCE verwendet das vorhandene Blender-Modell PIKE mit neuen, daran angepassten Ladungselementen. Drei Spulenstufen füllen sich von hinten nach vorn. Ihre Kerne wechseln zu Blauweiß, während die Ränder violett bleiben. Dünne Leiterbahnen verbinden Spulen, Kupferschienen, Gehäuse und Schaft. Kurz vor voller Ladung pulsieren die Kerne und kleine elektrische Filamente neben den Spulen.

Ein eigener unsichtbarer Lichtgeber speist den vorhandenen Szenenlicht-Pool und beleuchtet Metall und Handschuhe. Echte Schussblitze haben Vorrang. Die große schwebende Kugel ist durch eine kompakte Mündungskorona ersetzt. Der generische weiße Verschlussblock entfällt bei dieser Waffe, weil er neben dem offenen PIKE-Gehäuse sichtbar war. Die Zielöffnung bleibt frei.

Der gemeinsame Antrieb verwendet die tatsächliche Ladung des eigenen Spielers beziehungsweise die übertragene Ladung anderer Spieler. Entladen und Waffenwechsel setzen Licht und Materialien zurück. Reduzierte Bewegung erhält das Leuchten ohne Pulsieren, rotierende Korona oder Ladungszittern. Schadenswerte, Teilentladung, Ladezeit und Nachladen behalten ihre bisherigen Regeln.

## Referenz und Umsetzung

Die mit dem eingebauten ImageGen erzeugten [Variante A](concept-a.png) und [Variante B](concept-b.png) basieren auf der [ursprünglichen Browseransicht](before/desktop-lance-charged.png). Das [Promptset](prompts.txt) liegt daneben. A bestimmt die Umsetzung: klare Spulen, feine Lichtbahnen, sichtbare Metalloberflächen und blauviolette Abstrahlung. Aus B stammen die kurzen elektrischen Filamente. Die Bilder sind Gestaltungsreferenzen; das Spiel verwendet echte Geometrie und dynamische Materialien.

- [Desktop, voll geladen](captures/desktop-lance-charged.jpg)
- [Desktop, 64 Prozent](captures/desktop-lance-charge.jpg)
- [Desktop, ungeladen](captures/desktop-lance-full.jpg)
- [Mobil, Querformat](captures/landscape-lance-charged.jpg)
- [Mobil, Hochformat](captures/portrait-lance-charged.jpg)
- [Mobil, Zielen](ads/portrait-lance-charged-ads.jpg)
- [Spielrenderer mit HDR und Bloom](runtime/desktop-high-charged.png)
- [Spielrenderer auf Low ohne Bloom](runtime/desktop-low-charged.png)

Die direkten Browseraufnahmen verwenden das tatsächliche PIKE-Modell und die normalen HUD-Werte vor dem bestehenden Kartenbild. `full` bezeichnet ein volles Magazin bei Ladung null. Die Laufzeitaufnahmen verwenden die echte Frontier-Szene mit `WorldView`, Charakterbeleuchtung und `CombatPostProcess`. Alle Bilder sind unveränderte Browserausgaben. Ladung und ruhige Haltung sind definierte Darstellungszustände; die Aufnahmen sind keine gespielte Netzwerkrunde.

Alle 32 finalen Aufnahmen sind ohne Browserfehler: 9 HUD-Ansichten, 4 Ansichten beim Zielen und 19 Aufnahmen mit dem Spielrenderer. Die letzte Gruppe umfasst drei Bildschirmgrößen, jeweils drei Ladestände auf High und Low, sowie den ausdrücklich benannten Vergleich ohne Streulicht.

## Reproduzieren

```sh
node tools/titanfall-weapon-display-capture.mjs --weapons lance --states full,charge,charged --sizes desktop,landscape,portrait --out docs/design/voltlance/captures
node tools/titanfall-weapon-display-capture.mjs --weapons lance --states full,charged --sizes desktop,portrait --ads 1 --out docs/design/voltlance/ads
node tools/chargerifle-polish-capture.mjs --weapon lance --out docs/design/voltlance/runtime
node tools/voltlance-model-test.mjs
```

Der Modelltest prüft Ladestufen, getrennte lokale/entfernte Materialien, Lichtpriorität, Rücksetzen, reduzierte Bewegung und Ressourcenfreigabe. Die Browser-Capture bricht ab, falls das tatsächliche PIKE-Modell nicht geladen ist.

Am 14.10.2026 bestanden der neue VOLTLANCE-Modelltest, 103 bestehende Viewmodel-Prüfungen und 8 Lance/Knife-Prüfungen. Auch CR-6-Modelltest, Waffenwechsel, Client-Ressourcenprüfung und Module-Preload-Abgleich bestanden. Der neue Test läuft regulär in `weapons:feel:test`.

Die separate [Browserprüfung beider Spieleransichten](remote-material-report.json) bestätigt mit geladenem PIKE-Modell die gleichen Spulenstufen bei 0, 20, 64 und 100 Prozent Ladung, getrennte Materialien, Rücksetzen und Vorrang des Schusslichts. Der benannte Vergleich ohne Streulicht im Laufzeitordner zeigt die tatsächliche Wirkung der Lichtquelle auf Gehäuse und Handschuhe.

Die Umsetzung, Referenzen und Prüfberichte liegen lokal im Workspace.
