# Waffen-TTK simulieren

`npm run balance:simulate` erzeugt `.artifacts/ttk/current/results.json`, `summary.md` und `rocket-blast.md` für alle zwölf Waffen, zwölf Distanzen und fünf Szenarien. Der Lauf verändert keine Spielwerte.

```sh
npm run balance:simulate
npm run balance:simulate -- --samples 1000 --distances 5,10,20,40,80,120 --out .artifacts/ttk/baseline
npm run balance:simulate -- --armor 100 --out .artifacts/ttk/armor
npm run balance:simulation:test
npm run balance:compare -- .artifacts/ttk/baseline/results.json .artifacts/ttk/candidate/results.json .artifacts/ttk/comparison
```

Die Simulation ruft `resolveWeaponIntent`, `updateTimers`, `updateCondition`, `PlayerEntity.takeDamage`, `ProjectileSystem`, `FlameSystem` und `updateBurn` direkt auf. Reihenfolge und Tickdauer folgen `server/game.js` und `server/protocol/admission.js`. Waffendefinitionen, Schadensfaktor, Trefferboxen, Rundung, Magazine, Nachladen, Projektilflug, Nachbrennen, Ladung und Hitze kommen aus dem Spielcode.

## Versuchsaufbau

- Standard: 100 HP, keine Rüstung, stehendes Ziel frontal, ausgerüstete Waffe, volles Magazin und normale Reserven. Leeres Magazin löst sofort Nachladen aus. Die Schrotflinte schießt wieder, sobald eine Patrone sitzt.
- TTK beginnt beim ersten verarbeiteten Abzug auf Tick 0. Sie enthält Aufladen, Minigun-Anlauf, Projektilflug und erforderliches Nachladen. Ein sofort tödlicher Hitscan hat 0 ms. `damageWindowMs` misst separat die Zeit zwischen erstem Schaden und Kill.
- Eingaben erreichen den frühesten erlaubten Server-Tick. Die 20 Hz quantisieren auf 50 ms. Nach Leerlauf erlaubt der bestehende Cooldown-Übertrag einen verkürzten ersten Schussabstand. Lokale Client-Sperren, menschliche Klickgeschwindigkeit und Paketankunft können langsamer sein.
- Szenarien: perfekte Körper-/Kopftreffer ohne Streuung sowie ADS Körper, ADS Kopf und Hüfte Körper mit echter Streuung. Zielpunkte liegen auf Brust- bzw. Kopfhöhe. Bei Streuung können auch andere Körperzonen getroffen werden. Bei der perfekten Schrotflinte treffen alle Pellets dieselbe Zone; das ist eine theoretische Untergrenze.
- ADS ist vor Beginn erreicht. Rückstoß und Flugbahn werden perfekt kompensiert. Die Flugbahnkorrektur verwendet den echten diskreten Projektilintegrator samt Mündungsversatz. Kein Vorhalten gegen laufende Ziele.
- Kein Gegenfeuer, keine Bewegung, keine Deckung oder Abpraller, keine Reaktions-/Netzlaufzeit, kein Wechseln, Heilen oder Upgrade. Explosionen bewegen das fixierte Ziel nicht. Der Aufbau beschreibt kontrollierte Waffenleistung und keine gemessene TTK echter Matches.
- Minigun startet im Hauptvergleich kalt. Zusatzreihen zeigen bereits drehende Rotoren mit kalter und optimal heißer Waffe. Railgun lädt im Hauptvergleich vollständig; eine zusätzliche Suche bestimmt die früheste tödliche Teilaufladung in 50-ms-Schritten bei perfektem Kerntreffer. PIXEL PICK enthält zusätzlich Rückenangriffe.

## Wiederholbarkeit und Auswertung

Pro zufälliger Zelle laufen standardmäßig 256 Seeds. Die Schusszufallszahlen werden über die echte Spieler-ID-/Schussfolge reproduzierbar erzeugt. Gleiche Seeds werden beim Vergleich von Szenarien und späteren Balancing-Ständen wiederverwendet. Deterministische Fälle laufen einmal.

P10, Median und P90 sind empirische Quantile, keine Konfidenzintervalle. Auch nicht getötete Ziele zählen: Ein erfolgloser Versuch liegt hinter der Zeitgrenze, standardmäßig 20 s. Ein nicht erreichtes Quantil ist `null`; zusätzlich steht die Killrate in den Daten. `null` kann fehlende Reichweite, aufgebrauchte Munition oder zu langsamen Schaden bedeuten. Treffer-/Schusszahlen sind Mittelwerte über sämtliche Versuche, nicht nur erfolgreiche. Bei Projektilen zählt die Schusszahl auch noch fliegende Geschosse. `firstImpactKillRate` meint tödlichen Schaden im selben Tick wie den ersten Treffer; mehrere Pellets zählen dabei zusammen.

`results.json` enthält Einstellungen, Git-Commit, Arbeitsbaumstatus und SHA-256-Hashes der Server-/Shared-Quellen und des Simulators. Ein während des Laufs geänderter Quellstand führt zum Abbruch. Für Balancing-Vergleiche den alten Ergebnisordner behalten, Spielwerte gezielt ändern und mit denselben Optionen in einen neuen Ordner simulieren. Unterschiede in echten Matches danach separat prüfen.

Der Vergleich prüft identische Einstellungen und schreibt `comparison.json` und `comparison.md` mit Vorher-/Nachher-Werten, Quantilen, Killraten und Quellenunterschieden. Zusätzlich enthält jeder Simulationsstand ein Raketen-Splash-Profil: echte Serverexplosionen in 0,25-m-Schritten von 0 bis 7 m, ein Direkttreffer sowie ein Kontrollversuch hinter Deckung. Der Abstand bezieht sich auf den Schadensmesspunkt am Spieler (Fußhöhe + 1,05 m). Schaden, Druck und Terrainzerstörung können unterschiedliche Radien haben.
