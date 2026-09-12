# Waffenhandling: Profile, Grenzen und Prüfung

Stand: 12. September 2026. Lokal implementiert, Ausgangsrevision `dbdc793`.

## Ergebnis

Alle zwölf Waffen besitzen vier abstimmbare Handlingmetriken: Ergonomie, Sway,
vertikalen Rückstoß und horizontalen Rückstoß. Die Basisprofile wirken im Spiel.
Der Prüfstand unter `/weapon-handling.html` erlaubt Änderungen an einer eigenen
Waffeninstanz sowie direkte Vergleiche der Extremwerte. Aufsätze können später
über dieselbe Schnittstelle ein effektives Profil erzeugen.

Die Ergonomie bestimmt die Geschwindigkeit, Beschleunigung und Stabilisierung
beim Nachführen der tatsächlichen Waffenrichtung. Besonders große Waffen drehen
spürbar langsamer. Die normale Blickkamera reagiert unmittelbar; das bewegliche
Absehen zeigt die Schussrichtung. Im Sniper-Zielfernrohr folgt die Kamera wie bisher
der Waffenrichtung. ADS hebt die Drehbegrenzung nicht auf.

## Bezug zu Helldivers 2

Arrowhead beschreibt Ergonomie über die Geschwindigkeit, mit der die Waffenmündung
dem Fadenkreuz folgt. Niedrige Ergonomie verlangsamt das Nachführen.
[Arrowhead, Into the Unjust 5.0.0](https://arrowhead.zendesk.com/hc/en-us/articles/23973732653084--Into-the-Unjust-5-0-0).
Arrowhead beschreibt außerdem Sway und dessen Zusammenhang mit Handling.
[Arrowhead, Patch 01.003.000](https://arrowhead.zendesk.com/hc/en-us/articles/20039732796956--PATCH-01-003-000).

Unsere vier Kategorien, Skalen, Formeln und Waffenwerte sind ein eigener Entwurf.
Sie sind keine nachgewiesene Rekonstruktion der internen Helldivers-Formeln.

## Metriken und Extremwerte

| Metrik | Bereich | Wirkung |
| --- | --- | --- |
| Ergonomie | 0 bis 100 | 45 bis 720 Grad/s maximale Nachführgeschwindigkeit |
| Sway | 0 bis 1,5 Grad Auslenkung; 0,05 bis 2 Hz Grundfrequenz | Stärke und Geschwindigkeit des Pendelns unabhängig einstellen |
| Vertikaler Rückstoß | 0 bis 8 Grad Basisimpuls | Hochschlag pro Schuss; vorhandene Serienverstärkung wird mit skaliert |
| Horizontaler Rückstoß | 0 bis 4 Grad Basisimpuls | Seitlicher Impuls mit dem vorhandenen Muster und Jitter |

Sway bleibt eine sichtbare Kategorie mit zwei technischen Größen. Eine kleinere
Auslenkung bedeutet nicht automatisch eine langsamere Bewegung. Die Grundfrequenz
steuert mehrere überlagerte Sinusschwingungen und ist keine einzelne exakte
Periodendauer. Die Amplitude begrenzt die Grundschwingung je Achse. Haltung,
Atemanhalten, Schmerz und Panik verändern sie anschließend nach den bestehenden
Zustandsregeln. Vergrößerung wirkt über den Kamera-FOV und multipliziert den
physischen Winkel nicht zusätzlich.

Rückstoßwerte sind Basisimpulse, keine garantierten gemessenen Maximalwinkel einer
Schussserie. Muster, Jitter, ADS, Rampen und Erholung bleiben Teil des Waffenprofils.
Null vertikaler Rückstoß entfernt auch dessen Serienrampe. Beim PIXEL PICK entfallen
die beiden ballistischen Rückstoßmetriken; die Schlaganimation bleibt erhalten.

## Basisprofile

| Waffe | Ergonomie | Sway Grad | Sway Hz | Rückstoß vertikal | Rückstoß horizontal |
| --- | ---: | ---: | ---: | ---: | ---: |
| VK-77 RAPTOR | 70 | 0,16 | 0,24 | 0,68 | 0,32 |
| HORNET SMG | 95 | 0,20 | 0,38 | 0,42 | 0,42 |
| M-DOCK 12 | 58 | 0,17 | 0,22 | 2,35 | 0,55 |
| LONGSHOT MK-II | 38 | 0,18 | 0,12 | 3,80 | 0,58 |
| BASTION LMG | 24 | 0,12 | 0,14 | 0,58 | 0,34 |
| IRONCLAD .44 | 88 | 0,24 | 0,40 | 2,25 | 0,68 |
| LN-03 LONGARC | 44 | 0,16 | 0,20 | 1,90 | 0,40 |
| RX-8 HAVOC | 12 | 0,22 | 0,12 | 4,20 | 1,10 |
| CL-9 VOLTLANCE | 34 | 0,16 | 0,16 | 2,60 | 0,45 |
| PIXEL PICK | 100 | 0,08 | 0,50 | entfällt | entfällt |
| M-6 FURNACE | 8 | 0,10 | 0,10 | 0,28 | 0,22 |
| F-4 FIRESTORM | 28 | 0,18 | 0,17 | 0,03 | 0,02 |

Die Rückstoß-Basiswerte stammen aus den bestehenden Kampfprofilen. Ergonomie und
Sway sind die neue erste Abstimmung. Das Waffenmodell behält seine waffenspezifischen
Handpositionen. Ergonomie verändert dessen Nachführen, nicht die anatomische
Position einzelner Finger oder einen Aufsatz am Modell.

## Gemessene Zielwechsel

Referenz: sofortiger Blickwechsel um 90 Grad, Waffe anfangs in Ruhe, ohne Sway und
Rückstoß, ohne ADS. Gemessen wird die Zeit bis höchstens 1 Grad Restfehler bei 60 FPS.
Beschleunigung und Einschwingen sind enthalten. Die Maximalgeschwindigkeit allein
ist deshalb nicht gleich `90 / Zeit`.

| Waffe | Maximale Grad/s | Zeit für 90 Grad |
| --- | ---: | ---: |
| HORNET SMG | 666,8 | 0,400 s |
| VK-77 RAPTOR | 426,5 | 0,483 s |
| M-DOCK 12 | 327,4 | 0,567 s |
| LONGSHOT MK-II | 188,5 | 0,800 s |
| BASTION LMG | 113,8 | 1,150 s |
| IRONCLAD .44 | 595,1 | 0,417 s |
| LN-03 LONGARC | 226,5 | 0,717 s |
| CL-9 VOLTLANCE | 165,1 | 0,883 s |
| RX-8 HAVOC | 67,7 | 1,733 s |
| PIXEL PICK | 720,0 | 0,383 s |
| M-6 FURNACE | 56,9 | 2,017 s |
| F-4 FIRESTORM | 133,1 | 1,033 s |
| Extrem träge, Ergonomie 0 | 45,0 | 2,533 s |
| Extrem handlich, Ergonomie 100 | 720,0 | 0,383 s |

Die Messung läuft zusätzlich mit 30 und 144 FPS. Die Abweichung bleibt innerhalb
eines 30-FPS-Frames. ADS darf den jeweiligen Geschwindigkeitsdeckel nicht überschreiten.
Das langsame Extrem ist ein bewusst drastischer Vergleichswert. Die Minigun ist im
aktuellen Profil gut fünfmal langsamer beim 90-Grad-Zielwechsel als die SMG.

## Umsetzung und Schnittstelle für späteres Customizing

`shared/weapon-handling.js` definiert Grenzen, Basisprofile und reine Funktionen.
`withWeaponHandling` erzeugt eine eigene effektive Waffendefinition und führt deren
Handlingwerte und Rückstoßprofil zusammen. Das Ausgangsobjekt wird nicht verändert.
So können mehrere Spieler später verschiedene Konfigurationen derselben Waffe nutzen.

```js
import { WEAPONS } from './shared/combatmath.js';
import { withWeaponHandling } from './shared/weapon-handling.js';

const configured = withWeaponHandling(WEAPONS.lmg, {
  ergonomics: 36,
  sway: { amplitudeDeg: 0.10, frequencyHz: 0.12 },
  verticalRecoil: 0.46,
  horizontalRecoil: 0.28,
});
```

Partielle Änderungen übernehmen nicht angegebene Werte. Ungültige Zahlen verwenden
die Basiswerte; Werte außerhalb der Grenzen werden begrenzt. Ein eingefrorenes
Referenzprofil erhält die ursprüngliche Rückstoßrampe, sodass sie nach einer
Null-Einstellung wiederhergestellt werden kann.

`shared/weapon-turn.js` simuliert eine eigenständige Waffenorientierung mit einem
festen Schritt von 1/240 Sekunde. Mit `e = Ergonomie / 100` gilt:

- Maximalgeschwindigkeit: `45 + 675 * e^1.6` Grad/s.
- Maximalbeschleunigung: `180 + 5220 * e^1.6` Grad/s².
- Federparameter: `5 + 17 * e`, bei ADS bis zu 12 Prozent höher.
- Geschwindigkeits- und Beschleunigungsgrenzen gelten gemeinsam für beide Achsen.

Die Waffenrichtung wird nicht durch einen maximalen Kameraabstand zurück ins Bild
gezogen. Bei einem 180-Grad-Flick kann sie zunächst außerhalb des Bildes liegen.
Nur kosmetische Verschiebung und Rollwinkel werden begrenzt. Das Absehen erscheint
in diesem Fall nicht fälschlich in der Bildschirmmitte.

Der Live-Pfad in `LocalPlayer` verwendet das aktive Handlingprofil für Drehen und
Sway. Schüsse behalten ihre vor dem eigenen Rückstoß festgehaltene Richtung bis
zum Netzwerkversand. Viewmodel und Absehen folgen demselben Zielstrahl. Die
Kamerafeder verarbeitet auch einen 200-ms-Hänger in ausreichend kleinen Schritten,
damit die erlaubten Rückstoßextrema numerisch stabil bleiben.

Bots berücksichtigen den Ergonomie-Deckel zusätzlich zu ihren bisherigen
Schwierigkeitsgrenzen für horizontales und vertikales Drehen. Sie verwenden weiterhin
ihre eigene Ziel-KI, nicht den vollständigen menschlichen Feder-/Sway-Prozess.

## Prüfstand und Grenzen des aktuellen Ausbaus

Lokal nach dem Serverstart: `http://localhost:3000/weapon-handling.html` (Port an die
laufende Instanz anpassen). Die Seite lädt alle zwölf Basisprofile und verwendet
`LocalPlayer`, `ViewmodelRig` sowie die gemeinsamen Handling- und Rückstoßfunktionen.
Sie bietet 90-/180-Grad-Blickwechsel, ADS, Hocken, Atemanhalten und einzelne Schüsse
oder Serien. Alle vier Metriken sind direkt verstellbar. Der Waffenstandard stellt
die Spielwerte wieder her. Änderungen dort gelten nur für diese Vorschau.

Die Vorschau ist eine stationäre Handlingprüfung. Sie simuliert keine vollständige
Partie mit Munition, Hitze, Lademechanik, Trefferwertung oder anderen Spielern. Die
Kamera bleibt zur Inspektion auch bei der Sniper auf der Blickrichtung; im eigentlichen
Spiel bleibt deren vorhandene Zielfernrohr-Kamera aktiv.

Der Server verwendet weiterhin die übermittelte finale Schussrichtung. Deren
Übereinstimmung mit dem Client ist geprüft. Eine unabhängige serverseitige
Rekonstruktion und Erzwingung der Ergonomie aus rohen Mauseingaben ist noch nicht
implementiert. Der spätere Aufsatzausbau braucht außerdem serverseitig bestätigte
Loadouts und Persistenz. Das Grundmodell für die gewünschten Metriken ist vorhanden.

## Prüfung

- `npm run weapons:handling:test`: alle Profile, Grenzwerte, immutable Änderungen,
  unabhängige Achsen, Null-Rückstoß, 30/60/144 FPS, 90-/180-Grad-Wechsel, ADS,
  Winkelsprung über ±Pi, diagonaler Deckel und 200-ms-Hänger.
- Live-Player, echter JSON-Transport und Serverbewegung: beim schnellen Blickwechsel
  wird die verzögerte Waffenrichtung übertragen; ein Schuss behält seine Richtung vor
  dem eigenen Rückstoß.
- `npm run weapons:feel:test`: Sniper, diskrete Schüsse, Trefferimpuls, Granaten,
  Nachladen, Handling und Projektion bestanden.
- Viewmodel-Verträge: alle Modelle, freie Visierachsen, tatsächliche Mündungsrichtung,
  Ergonomieabstufung und einmalige optische Vergrößerung von Sway bestanden.
- Browser: alle zwölf Profile, Minigun mit 90-/180-Grad-Wechsel, beide Ergonomieextreme,
  ADS, maximale Sway-/Rückstoßwerte sowie Desktop und schmale Ansicht geprüft.
  Keine Browserfehler während dieser Prüfung.

Messdaten und lokale Prüfbelege liegen unter `.artifacts/weapon-handling/`.
Für den Push wurde der vollständige Handling-Stand in einer isolierten Kopie des
Git-Index geprüft. `npm test` bestand vollständig, einschließlich Atlas-/Client-,
Karten-, Nahkampf-, Waffenwechsel-, Smoke-, Lobby-, Duell- und Bot-Prüfungen. Der
Modus-Lobbytest meldete 354 erfolgreiche Prüfungen. Die parallel bearbeiteten
Balance- und Match-Endänderungen gehören nicht zu diesem geprüften Commit.
