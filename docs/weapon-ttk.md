# Waffen-TTK simulieren

`npm run balance:simulate` erzeugt `.artifacts/ttk/current/results.json`, `summary.md` und `rocket-blast.md` für alle dreizehn Waffen, zwölf Distanzen und fünf Szenarien. Der Lauf verändert keine Spielwerte.

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
- Eingaben erreichen den frühesten erlaubten Server-Tick. Die 60 Hz quantisieren auf 16,7 ms. Nach Leerlauf erlaubt der bestehende Cooldown-Übertrag einen verkürzten ersten Schussabstand. Lokale Client-Sperren, menschliche Klickgeschwindigkeit und Paketankunft können langsamer sein.
- Szenarien: perfekte Körper-/Kopftreffer ohne Streuung sowie ADS Körper, ADS Kopf und Hüfte Körper mit echter Streuung. Zielpunkte liegen auf Brust- bzw. Kopfhöhe. Bei Streuung können auch andere Körperzonen getroffen werden. Bei der perfekten Schrotflinte treffen alle Pellets dieselbe Zone; das ist eine theoretische Untergrenze.
- ADS ist vor Beginn erreicht. Rückstoß und Flugbahn werden perfekt kompensiert. Die Flugbahnkorrektur verwendet den echten diskreten Projektilintegrator samt Mündungsversatz. Kein Vorhalten gegen laufende Ziele.
- Kein Gegenfeuer, keine Bewegung, keine Deckung oder Abpraller, keine Reaktions-/Netzlaufzeit, kein Wechseln, Heilen oder Upgrade. Explosionen bewegen das fixierte Ziel nicht. Der Aufbau beschreibt kontrollierte Waffenleistung und keine gemessene TTK echter Matches.
- GV-4 RIPTIDE: Die Scheibe fliegt ohne Schwerkraft, daher wird direkt auf den Zielpunkt gezielt. Der Schütze hält den Abzug; gefangene Scheiben werden sofort wieder geworfen. Die Zusatzreihe `R nach Treffer` drückt R im Tick nach jedem Treffer des Hinwegs und schickt alle Scheiben auf dem Hinweg sofort zurück.
- Minigun startet im Hauptvergleich kalt. Zusatzreihen zeigen bereits drehende Rotoren mit kalter und optimal heißer Waffe. Railgun lädt im Hauptvergleich vollständig; eine zusätzliche Suche bestimmt die früheste tödliche Teilaufladung in 50-ms-Schritten bei perfektem Kerntreffer. PIXEL PICK enthält zusätzlich Rückenangriffe.

## Wiederholbarkeit und Auswertung

Pro zufälliger Zelle laufen standardmäßig 256 Seeds. Die Schusszufallszahlen werden über die echte Spieler-ID-/Schussfolge reproduzierbar erzeugt. Gleiche Seeds werden beim Vergleich von Szenarien und späteren Balancing-Ständen wiederverwendet. Deterministische Fälle laufen einmal.

P10, Median und P90 sind empirische Quantile, keine Konfidenzintervalle. Auch nicht getötete Ziele zählen: Ein erfolgloser Versuch liegt hinter der Zeitgrenze, standardmäßig 20 s. Ein nicht erreichtes Quantil ist `null`; zusätzlich steht die Killrate in den Daten. `null` kann fehlende Reichweite, aufgebrauchte Munition oder zu langsamen Schaden bedeuten. Treffer-/Schusszahlen sind Mittelwerte über sämtliche Versuche, nicht nur erfolgreiche. Bei Projektilen zählt die Schusszahl auch noch fliegende Geschosse. `firstImpactKillRate` meint tödlichen Schaden im selben Tick wie den ersten Treffer; mehrere Pellets zählen dabei zusammen.

`results.json` enthält Einstellungen, Git-Commit, Arbeitsbaumstatus und SHA-256-Hashes der Server-/Shared-Quellen und des Simulators. Ein während des Laufs geänderter Quellstand führt zum Abbruch. Für Balancing-Vergleiche den alten Ergebnisordner behalten, Spielwerte gezielt ändern und mit denselben Optionen in einen neuen Ordner simulieren. Unterschiede in echten Matches danach separat prüfen.

Der Vergleich prüft identische Einstellungen und schreibt `comparison.json` und `comparison.md` mit Vorher-/Nachher-Werten, Quantilen, Killraten und Quellenunterschieden. Zusätzlich enthält jeder Simulationsstand ein Raketen-Splash-Profil: echte Serverexplosionen in 0,25-m-Schritten von 0 bis 7 m, ein Direkttreffer sowie ein Kontrollversuch hinter Deckung. Der Abstand bezieht sich auf den Schadensmesspunkt am Spieler (Fußhöhe + 1,05 m). Schaden, Druck und Terrainzerstörung können unterschiedliche Radien haben.

## GV-4 RIPTIDE (Stand 2026-09-22)

Median aus `npm run balance:simulate` (Standardoptionen, 100 HP, keine Rüstung). Im Freien trifft der Rückweg das Ziel nicht: Die Scheibe dreht mit höchstens 540°/s bei 30 m/s, also mit rund 3,2 m Radius, und kehrt etwa 6 m seitlich versetzt zurück. Zwei Hinweg-Treffer (86,4) lassen 13,6 HP übrig; erst der dritte Wurf nach dem Fangen tötet. Nur bei 20 m, wo der Hinweg endet, treffen beide Scheiben mit Rückweg-Schaden. Der Rückweg-Treffer (57,6) entsteht sonst nur nach einem Wandabpraller oder bei Zielen neben der Rückflugbahn.

| Szenario | 1 m | 5 m | 10 m | 15 m | 20 m | ab 30 m |
|---|---:|---:|---:|---:|---:|---:|
| Perfekt: Körper | 1,47 s | 1,58 s | 1,73 s | 1,87 s | 0,95 s | keine Reichweite |
| Perfekt: Kopf | 0,42 s | 0,52 s | 0,67 s | 0,82 s | 0,97 s | keine Reichweite |
| R nach Treffer, Körper | 0,82 s | 0,92 s | 1,20 s | 1,60 s | 0,95 s | keine Reichweite |
| R nach Treffer, Kopf | 0,42 s | 0,52 s | 0,67 s | 1,22 s | 0,97 s | keine Reichweite |

Die Streuungsszenarien liegen wegen des 0,22-m-Scheibenradius innerhalb von 0,02 s der perfekten Werte. Zum Vergleich: VK-77 RAPTOR 0,35 s (Körper, bis 20 m). Die Spezifikation erwartete 0,40 s mit R und 1,0–1,2 s ohne Trick; beides setzt einen Rückweg durch das Ziel voraus, den die Wendegeometrie im Freien nicht erzeugt. Details und Ursachen: `docs/weapon-design/glaive.md`.
