# PvE-Entwurf: Bastion

Status: Konzept, noch kein auswählbarer oder implementierter Spielmodus.

1 bis 4 Spieler verteidigen gemeinsam einen Energiekern gegen Gegnerwellen.
Die Deckung wird während des Matches zerstört. Dadurch verändern sich Schusslinien
und Laufwege: Das Team muss seine Verteidigung verlegen, statt eine Position zu halten.
Foundry ist die erste Karte. Waffen, Rauch, Molotows und die vorhandene Zerstörung bleiben relevant.

## Eine Runde

1. **Aufstellen, 25 Sekunden:** Waffen wählen, Munition nachfüllen, Kern reparieren.
2. **Welle abwehren:** Angriffe aus angekündigten Zugängen. Der Kern hat eigene Trefferpunkte.
3. **Verschnaufen, 20 Sekunden:** Tote Spieler kehren zurück. Gemeinsame Credits für die überstandene Welle.
4. **Nächste Welle:** Mehr Druck durch eine andere Gegnerzusammensetzung und zusätzliche Zugänge.

Ziel für den vollständigen Modus: acht Wellen, etwa 12 bis 18 Minuten. Das sind
Abstimmungswerte für Spieltests. Sieg nach der letzten Welle, Niederlage bei
zerstörtem Kern oder gleichzeitigem Tod aller Spieler während einer Welle.

## Gegner

| Typ | Verhalten | Antwort des Teams |
| --- | --- | --- |
| Läufer | Schnelle, schwache Gegner mit SMG. Suchen Seitenwege und greifen Spieler in Reichweite an. | Engstellen halten, Schrotflinte oder Molotow. |
| Sprenger | Steuern den Kern an und schießen mit Raketen auf blockierende Deckung. Lange, sichtbare Vorbereitung vor dem Schuss. | Prioritätsziel; Sicht mit Rauch unterbrechen, von der Seite angreifen. |
| Schwerer | Langsam, viel Rüstung, LMG und klar erkennbare Feuerpausen. | Gemeinsam Rüstung abbauen und während der Pause umsetzen. |

Neue Silhouetten und Farben sollen die Rollen auch ohne Namensschild unterscheiden.
Alle Gegner beachten Rauch und echte Sichtlinien. Verlorene Ziele werden nicht durch
Wände oder Wolken weiterverfolgt. Das Verteidigungsziel darf als Navigationsziel bekannt bleiben.

## Fortschritt und Zusammenarbeit

- Wellenbelohnungen fließen in eine gemeinsame Kasse. Einzelne Kills verteilen kein Geld.
- Das Team wählt zwischen Kernreparatur, Nachschub und vorübergehenden Waffenverbesserungen.
- Reparieren ist eine kurze Interaktion am Kern. Rauch schützt die Annäherung,
  macht aber weder Spieler noch Kern unverwundbar.
- Deckung bleibt zwischen Wellen beschädigt. Kein automatisches Zurücksetzen der ganzen Karte.
- Für den ersten spielbaren Stand kehren Tote erst zwischen Wellen zurück.
  Ein System zum Wiederbeleben mit Liegenbleiben und Ausbluten wäre ein späterer Ausbau.
- Solo reduziert die Anzahl gleichzeitig aktiver Gegner und die Zahl der Angriffsrichtungen.

## Erster spielbarer Umfang

Eine Karte, ein Kern, drei Wellen, Läufer und Sprenger, gemeinsame Credits,
Reparieren und ein eindeutiger Sieg-/Niederlagebildschirm. Zunächst maximal acht
gleichzeitig aktive Gegner. Danach erst acht Wellen, Schwerer und weitere Karten.
Der Modus wird erst nach einer vollständig spielbaren Runde im Menü freigeschaltet.

## Anschluss an den vorhandenen Code

- `shared/modes.js`: Modus `bastion`, Regeln und Kartenkompatibilität.
- Eine eigene Policy in `server/modes/bastion.js` verwaltet Aufstellphase,
  Wellenbudget, Kern, Belohnungen und Rundenende. Der Server entscheidet über alle Treffer und Käufe.
- Der bestehende `BotManager` ist auf bis zu sieben Ersatzspieler ausgelegt.
  PvE-Gegner benötigen eigene IDs, ein separates Gegnerlimit und dürfen keine
  Lobbyplätze belegen oder durch beitretende Menschen ersetzt werden.
- Den vorhandenen Bot-Kampf und die Bewegung wiederverwenden; Zielwahl und
  Wellen-Spawns separat behandeln. Zerstörte Wege müssen neu bewertet werden.
- Kernzustand, Welle, verbleibende Gegner und Teamkasse im Match-Snapshot übertragen.
  Gegnerrollen als einfache, validierte Felder an den vorhandenen Avatarzustand anhängen.
- HUD: Kernzustand oben mittig, Welle und verbleibende Gegner daneben,
  Teamkasse nur während Aufstellphase und Reparatur sichtbar.
- Keine Angreifer-Killcam gegen NPCs. Tote verfolgen lebende Teammitglieder.

## Woran der erste Stand gemessen wird

Solo und vier Spieler können dieselben drei Wellen zu Ende spielen. Beitritt und
Reconnect duplizieren weder Gegner noch Belohnungen. Tote Gegner respawnen nicht
ungeplant. Rauch verhindert sowohl neue Zielerfassung als auch bestehende
Bot-Zielverfolgung. Raketenzerstörung darf Gegner nicht dauerhaft festsetzen.
Kernzerstörung oder Teamtod beendet die Welle genau einmal. Nachschub und Reparatur
lassen sich nicht durch doppelte Kaufnachrichten erschleichen.
