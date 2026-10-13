# CR-6 LONGBOW

Die aktuelle [Annäherung an die Imagegen-Referenz](polish/README.md) ergänzt abgestufte Zellkerne, feine Gehäusekonturen und echte Lichtabstrahlung auf Metall und Handschuhe. Dort liegen auch die neuen Browserbilder mit dem Spielrenderer auf High und Low.

Die sechs Energiezellen zeigen die gespeicherte Ladung in drei gespiegelten Paaren an. Die Paare füllen sich vom hinteren Ende zum Lauf, werden heller und schieben ihre Leuchtringe bis zu 7 mm nach vorn. Entladen und Abbruch setzen Material und Position zurück. Die Anzeige funktioniert am eigenen Modell und bei anderen Spielern anhand ihrer übertragenen Ladung. Jede Waffe besitzt eigene Zellmaterialien.

Frühes Loslassen bewahrt die Ladung für 180 ms. Danach verliert die CR-6 eine volle Ladung pro 700 ms. Eine halbe Ladung ist somit nach insgesamt 530 ms aufgebraucht. Erneutes Drücken setzt die verbleibende Ladung fort. Erst volle Ladung löst einen Schuss aus; vorzeitiges Loslassen verbraucht keine Munition. Nachladen, Waffenwechsel, Tod und blockierte Aktionen löschen die Restladung. Server und Client verwenden dieselbe Abbauformel. Die VOLTLANCE behält ihr bisheriges Verhalten.

Die Referenzen [A](concept-a.png) und [B](concept-b.png) wurden mit dem eingebauten Imagegen-Werkzeug aus der bestehenden Browseransicht erstellt. Das vollständige [Promptset](prompts.txt) liegt daneben. Übernommen wurden die breiteren Leuchtringe aus A. Die Umsetzung erhält die tatsächlichen sechs Zellen, die Waffenform und die vorhandenen Halte-, Visier- und Mündungspositionen. Die Referenzen sind Gestaltungsstudien; das Spiel rendert weiterhin sein prozedurales Modell.

Die Browseransichten wurden gegen A geprüft: dunkle ungeladene Zellen, nacheinander gefüllte Paare und deutlich erkennbare volle Ladung. Die aktuelle [Überladungsdarstellung](overload/README.md) ergänzt auf Wunsch stärkere Emission, orange Halos, heiße Leitungen und pulsierende Zellkerne. Ihre Referenzen und Aufnahmen liegen unter `overload/`; die folgenden Bilder dokumentieren die erste Zellanimation.

- [Vorher, Desktop](before/desktop-chargerifle-charge.jpg)
- [Nachher, Teilladung](after/desktop-chargerifle-charge.jpg)
- [Nachher, volle Ladung](after/desktop-chargerifle-charged.jpg)
- [Mobil, Hochformat](after/portrait-chargerifle-charged.jpg)
- [Mobil, Querformat](after/landscape-chargerifle-charged.jpg)
- [Mobil, Zielen](after-ads/portrait-chargerifle-charged-ads.jpg)

18 aktuelle Browseraufnahmen decken 1920 x 1080, 844 x 390 und 390 x 844 ab, einschließlich Nachladen und Zielen. Beide `capture-report.json` melden keine Browserfehler. Die Capture-Seite verwendet das echte Viewmodel mit definierten Zuständen; sie prüft Darstellung, keine Netzwerkrunde. Ihr `full`-Zustand bedeutet volles Magazin ohne Ladung, `charge` 64 Prozent und `charged` volle Ladung. Modell und Display bekommen dabei denselben Ladewert.

Prüfungen:

```sh
node tools/chargerifle-charge-test.mjs
node tools/chargerifle-model-test.mjs
node tools/titanfall-at-weapons-test.mjs
node tools/titanfall-weapon-display-test.mjs
node tools/weapon-swap-test.mjs
node tools/heavy-weapon-model-test.mjs
node tools/weapon-balance-test.mjs
node tools/client-refactor-test.mjs
node tools/build-module-preload.mjs --check
node tools/smoke.mjs
```

Diese Prüfungen bestanden am 13.10.2026. Der Ladungstest vergleicht echte Client- und Serverlogik einschließlich 30, 60 und 144 Hz, Restladung, Abbruch, Munition und Schusszeitpunkt. Der Modelltest prüft die sechs Zellen, Bewegung, getrennte Materialien, die Ansichten beider Spieler, Rücksetzen und Freigabe der Ressourcen. Der Smoke-Test startete einen lokalen Server und prüfte WebSocket-Snapshots und Schüsse. Die beiden neuen Tests sind auch Teil von `npm run titanfall:test`.

Ergebnis: 3274 Ladungsprüfungen, 726 AT-Waffenprüfungen und 204 Displayprüfungen bestanden. Ein zwischenzeitlicher Fehler der AT-Suite betraf die Mesh-Anzahl des parallel bearbeiteten THUNDERBOLT-Modells. Nach dessen separater Korrektur bestand die vollständige AT-Suite.

Die Änderungen und Referenzen liegen lokal im Workspace.
