# Trouble in Terrorist Town

Erste spielbare Version im Lobby-Menü. Mindestens zwei Teilnehmer; Bots zählen mit.

- Vorbereitung: 60 Sekunden frei bewegen und Waffen suchen, kein Schaden.
- Rollen: zufällig 25 Prozent Traitors (abgerundet, mindestens einer), übrige Innocents. Rollen werden erst nach der Vorbereitung erzeugt. Bei nur einem Teilnehmer wartet die Rollenvergabe auf weitere Teilnehmer.
- 48 zufällig platzierte Waffen auf begehbaren Bodenflächen, verteilt auf sechs Waffentypen. Ein Waffenplatz, kein Startgewehr und keine zusätzlichen Granaten oder Spitzhacke.
- E hebt eine nahe Waffe auf. L legt die getragene Waffe ab. Beide Aktionen stehen auch als Bildschirmtasten bereit. Die Tasten sind in den Einstellungen änderbar. Zum Wechseln erst ablegen.
- B öffnet den geheimen Traitor-Shop. Zwei Credits pro Runde, je ein Credit für Radar, Disguiser, Teleporter, +50 Rüstung, +35 Gesundheit oder volle Reservemunition. Gadget-Bedienung, Originalquellen und Screenshots stehen in [Traitor-Ausrüstung](shop-equipment/README.md). Käufe ohne Nutzen verbrauchen keinen Credit. Jede Aktion wird vom Server geprüft.
- Rollen und Guthaben werden nur an den jeweiligen Spieler übertragen. Traitors sehen die Namen ihrer Mitstreiter. Erst nach Rundenende werden alle Rollen im Ergebniszustand veröffentlicht.
- Ein Leben. Späte Beitritte während der aktiven Runde warten als Zuschauer. Innocents gewinnen bei ausgeschalteten Traitors oder nach fünf Minuten; Traitors gewinnen, wenn kein Innocent mehr lebt. Der vorhandene Abstimmungsablauf startet die nächste Runde mit erneuter Vorbereitung.

Diese erste Version enthält keine Detektivrolle, Leichenuntersuchung, Karma oder zusätzliche Kommunikationskanäle. Bots verwenden bislang das vorhandene Kampfverhalten, keine soziale Täuschungslogik.

## Design und Prüfung

`alternatives.png` wurde mit dem eingebauten ImageGen-Werkzeug erzeugt; der genaue Prompt steht in `prompt.txt`. Ausgangspunkt war `../flamethrower-support/implemented-desktop.png`. Gewählt wurde Variante A mit kompaktem Rollenpanel und zentriertem Shop. Die Umsetzung übernimmt die vorhandenen Armory-Schriften, Karten und Fokusführung. Auf schmalen Displays stehen die drei Karten untereinander. L ersetzt das im Entwurf skizzierte V, damit bestehende Tastenzuweisungen erhalten bleiben.

`implemented-*.png` zeigen den echten Browser mit Produktionsserver. Die Fixture versetzt Spieler an einen realen Waffenpunkt und zieht für die Rollenansicht die Serverzeit vor; Waffenaufnahme, Ablegen, Kauf und Übertragung laufen durch das Produktionsprotokoll. Die zufällige Rolle des Testspielers wird für reproduzierbare Shop-Aufnahmen auf Traitor gesetzt. Der exakte 60-Sekunden-Übergang wird separat in der Simulation geprüft.

- `npm run ttt:test`: Zeitgrenze, Rollenverteilung und Geheimhaltung pro Empfänger, ein Waffenplatz, Konkurrenz um Pickups, Munitionsbestand beim Ablegen, Kaufberechtigung, Wände, später Beitritt, Ausschalten der Traitors, Zeitlimit und neue Runde.
- `npm run ttt:browser`: Lobby bis Match, echte Aufnahme und Ablage, Shop-Kauf mit Serverbestätigung, automatische Shopsperre als Innocent, Desktop 1280×810 und Mobil 390×844.

Visueller Vergleich: zentrierter Drei-Karten-Shop wie Variante A, rote Traitor-Kante, amberfarbene Kaufaktionen und bestehende Spieltypografie. Mobil wurde das Rollenpanel unter die Gesundheitsanzeige verschoben; die Browserprüfung kontrolliert die fehlende Überlappung.
