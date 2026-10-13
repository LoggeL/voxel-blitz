# CR-6, Annäherung an die Imagegen-Referenz

Die Vorlage bleibt [Überladung A](../overload/concept-a.png), erzeugt mit dem [gespeicherten Imagegen-Prompt](../overload/prompts.txt). Der Vergleich mit der ersten Umsetzung zeigte breite weiße Streifen, eine flächig orange Gehäuseseite und wenig Licht auf dem Metall. Die aktuelle Umsetzung verwendet schmale heiße Kerne in orangefarbenen Leitungen, weich auslaufende Lichtflächen direkt entlang der Leitungen und einen Temperaturverlauf auf den sechs Zellringen. Die Zylinder haben 24 Segmente. Kleine Konturen am hinteren Gehäuse und an den Visierohren greifen weitere Details der Vorlage auf.

Ein unsichtbarer Lichtgeber am Zellblock speist den bestehenden `MuzzleLights`-Pool. Dadurch beleuchtet die Ladung das Gehäuse und die Handschuhe, ohne pro Waffe zusätzliche aktive Szenenlichter anzulegen. Ein echter Mündungsblitz hat Vorrang. Beide Spieleransichten verwenden denselben Ladewert für Material, Halo und Licht. Entladen setzt alles zurück. Die vorhandene Restladungsmechanik bleibt unverändert.

Die Halo-Größe der Zellen ist begrenzt, damit ihre Form bei voller Ladung lesbar bleibt. Transparente Effekte verwenden Tiefentests und schreiben keine Tiefe. Visierlinie, Trefferprüfung und Mündungsanker bleiben frei. Alle Texturen sind kleine, pro Waffe erzeugte Verläufe und werden mit dem Modell freigegeben.

## Browservergleich

- [Desktop, volle Ladung](captures/desktop-chargerifle-charged.jpg)
- [Desktop, ungeladen](captures/desktop-chargerifle-full.jpg)
- [Mobil, Querformat](captures/landscape-chargerifle-charged.jpg)
- [Mobil, Hochformat](captures/portrait-chargerifle-charged.jpg)
- [Desktop, Zielen](ads/desktop-chargerifle-charged-ads.jpg)
- [Mobil, Zielen](ads/portrait-chargerifle-charged-ads.jpg)

Diese 13 Aufnahmen zeigen das echte Viewmodel mit HUD vor dem bestehenden Kartenbild. Die Capture-Seite verwendet jetzt auch den echten Licht-Pool. `full` bedeutet volles Magazin bei Ladung null, `charge` 64 Prozent und `charged` volle Ladung. Im schmalen Hochformat liegt die Waffenanzeige aus der Hüfte außerhalb des Bildes; die vorhandene HUD-Anzeige übernimmt. Beim Zielen bleibt die Waffenanzeige sichtbar.

## Prüfung mit dem Spielrenderer

[High](runtime/desktop-high-charged.png) und [Low](runtime/desktop-low-charged.png) verwenden die echte Frontier-Szene, `WorldView`, Charakterbeleuchtung und `CombatPostProcess`. High aktiviert HDR und Bloom, Low kommt ohne Bloom aus. Die Bilder werden unverändert aus dem Browser-Framebuffer exportiert. Ladung und ruhige Haltung sind definierte Darstellungszustände, keine gespielte Netzwerkrunde.

Die zusätzliche [Aufnahme ohne Lichtabstrahlung](runtime/desktop-high-charged-spill-disabled.png) verwendet dieselbe Haltung und denselben Zeitpunkt. Nur das Licht im Szenenpool ist für diesen ausdrücklich benannten Vergleich abgeschaltet. So lässt sich die Wirkung auf Gehäuse und Handschuhe getrennt von den emissiven Materialien prüfen.

Die 19 Aufnahmen des Spielrenderers decken Desktop, mobiles Querformat und mobiles Hochformat jeweils ungeladen, bei 64 Prozent und voll geladen auf High und Low ab, zuzüglich des Lichtvergleichs. Alle sechs ungeladenen Aufnahmen haben Lichtstärke null. Alle drei Capture-Berichte melden keine Browserfehler, insgesamt sind 32 aktuelle Aufnahmen gespeichert.

```sh
node tools/titanfall-weapon-display-capture.mjs --weapons chargerifle --states full,charge,charged --sizes desktop,landscape,portrait --out docs/design/chargerifle/polish/captures
node tools/titanfall-weapon-display-capture.mjs --weapons chargerifle --states full,charged --sizes desktop,portrait --ads 1 --out docs/design/chargerifle/polish/ads
node tools/chargerifle-polish-capture.mjs --out docs/design/chargerifle/polish/runtime
```

## Tests

Am 13.10.2026 bestanden: CR-6 Modelltest einschließlich Lichtpriorität, Rücksetzen und Texturfreigabe; 3274 Ladungsprüfungen; 726 AT-Waffenprüfungen; 225 Displayprüfungen; Waffenwechsel, schwere Waffenmodelle, Client-Ressourcenprüfung und Module-Preload-Abgleich.

Die Änderungen, Referenzen und Browserbilder liegen lokal im Workspace.
