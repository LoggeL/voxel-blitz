# Bastion: PvE für Voxel Blitz

Status: ausgearbeitetes Spieldesign, noch nicht implementiert oder im Menü auswählbar.
Stand: 9. September 2026. Alle Balancewerte sind Startwerte für Spieltests.
Die technische Einordnung wurde am aktuellen Arbeitsstand auf Basis von `fa7ee31` geprüft.

1 bis 4 Spieler verteidigen einen Energiekern auf Foundry gegen acht Gegnerwellen.
Eine Partie soll etwa 12 bis 18 Minuten dauern. Deckung bleibt zerstört: Ein
gesprengter Wall wird zur neuen Angriffsroute und zwingt das Team, seine Positionen
anzupassen. Gemeinsam verdientes Geld finanziert Reparaturen und Ausrüstung für diesen Lauf.

## Spielerlebnis

Die ersten Wellen geben Raum, Waffen und Zugänge kennenzulernen. Dann beginnt die
Verteidigung zu bröckeln. Sprenger öffnen Schusslinien, Läufer gehen durch die Lücken,
Schwere binden Spieler mit langen Feuerstößen. Vor jeder Welle ist erkennbar, woher
der nächste Angriff kommt. Gute Prioritäten, Rauch und Bewegung schaffen Luft.

Ein typischer Moment: Zwei Spieler halten den Hauptzugang. Links lädt ein Sprenger
seine Rakete, während ein Läufer den Rückweg zum Kern nimmt. Das Team muss Feuer
umverteilen. Die Rakete reißt trotzdem Deckung auf. In der Pause reichen die Credits
entweder für Reparatur und Rüstung oder für schnelleres Nachladen. Die offene Flanke
bleibt in beiden Fällen bestehen.

Der Kern steht fest; die Verteidiger wechseln ihre Positionen. Die erste Version
braucht drei gut lesbare Gegnertypen, vorhandene Waffen und gezielt gebaute Laufwege.
Freies Bauen, Geschütztürme, Klassen und dauerhafte Stärke-Freischaltungen sind kein
Teil dieses Umfangs. Das Schießen und die zerstörbare Arena tragen den Modus.

## Ablauf und eindeutige Regeln

| Phase | Ablauf |
| --- | --- |
| Aufstellen | 25 Sekunden vor Welle 1. Ausrüstung wählen, Zugänge ansehen, bereitmelden. |
| Angriff | Endlicher Gegnernachschub aus angekündigten Zugängen. Kein Countdown-Sieg. |
| Versorgung | 20 Sekunden zwischen Wellen. Belohnung, Rückkehr gefallener Spieler, kostenlose Grundversorgung, Käufe und Reparatur. |
| Ergebnis | Nach Welle 8 Sieg, bei Kernverlust oder ausgeschaltetem Team Niederlage. Danach gemeinsam erneut starten oder zur Lobby. |

- Wellenende bedeutet: kein lebender Gegner und kein ausstehender Spawn. Tote NPCs
  kehren nicht zurück. Ein kurzer Erfolgston markiert den Wechsel zur Versorgung.
- In Aufstellen und Versorgung darf man laufen; Waffenfeuer, Schaden und Würfe sind
  gesperrt. Laufende Geschosse, Feuerflächen und Rauch werden beim Übergang entfernt.
- Alle können sich bereitmelden. Nach mindestens acht Sekunden startet die nächste
  Welle vorzeitig, wenn alle aktiven Spieler bereit sind. Sonst läuft die feste Zeit ab.
- Käufe, Reparaturen und Bereitschaft beziehen sich auf die aktuelle Vorbereitungsphase.
  Beim Start schließt das Menü, gehaltene Feuer- und Wurfeingaben müssen neu ausgelöst werden.
- Niederlagen haben Vorrang vor einem gleichzeitig erfüllten Wellenende: erst Kern
  prüfen, dann Teamzustand, dann Wellenabschluss. Ergebnis und Belohnung entstehen genau einmal.
- Die Zielzeit ist kein Zeitlimit. Eine langsam gespielte Welle endet ebenfalls erst,
  wenn der Nachschub und alle Gegner erledigt sind.

## Kern und Zerstörung

Der Kern hat zunächst 1.000 HP bei jeder Teamgröße. Kein passiver Heilungseffekt.
Bei 50 % und 25 % erscheinen eine kurze Warnung und ein verändertes Leuchten.
Eingehender Schaden zeigt die Angriffsrichtung; ein erneuter Alarm braucht einen
echten Schwellenwechsel und eine Abklingzeit.

| Schadensquelle | Regel |
| --- | --- |
| Spieler gegen Mitspieler oder Kern | Kein direkter Schaden, kein verbündeter Flächenschaden. |
| Spieler gegen Umgebung | Normale Zerstörung. Eigene Raketen können die Verteidigung öffnen. |
| Gegner gegen Spieler | Eigene PvE-Angriffsprofile mit normalen Treffer-, Rüstungs- und Sichtprüfungen. |
| Gegner gegen Kern | Eigene Kern-Schadenswerte; nur echte Treffer mit Sicht- oder Explosionsprüfung. |
| Gegner gegen Gegner | Kein Schaden. |
| Eigene Explosionen, Feuer und Stürze | Bestehende Selbst- und Umweltschadensregeln gelten für Spieler weiter. |

Der Kern erhält einen eigenen Trefferkörper mit sichtbarem Sockel. Der Sockel,
Spawn-Ausgänge und wenige tragende Bodenstreifen bestehen aus unzerstörbarem Material.
Damit können weder Krater unter dem Kern noch vollständig abgetrennte Wege die Partie
unlösbar machen. Wände und Deckungen entlang der Routen bleiben zerstörbar. Erst ein
neuer Lauf stellt die Karte vollständig wieder her. Kernreparatur baut keine Wand zurück.

## Gegner mit erkennbaren Antworten

Die Werte gelten unabhängig von Welle und Spielerzahl. Die Schwierigkeit steigt über
Anzahl, Zusammensetzung und Zugänge. PvE-Profile verändern keine PvP-Waffenwerte.

| Typ | Startwerte | Verhalten und Ankündigung | Gegenmittel |
| --- | --- | --- | --- |
| Läufer | 80 HP, keine Rüstung, 1,1-fache normale Laufgeschwindigkeit | Schlanke Silhouette, leichte SMG. Greift sichtbare Spieler entlang seiner Route an. Ohne erreichbaren Spieler rückt er zum Kern vor. | Schrotflinte, kurze Feuerstöße und Molotow an Engstellen. |
| Sprenger | 120 HP, keine Rüstung, 0,8-fache Laufgeschwindigkeit | Raketenrucksack, hörbares Aufladen und 1,8 Sekunden sichtbare Schussvorbereitung. Priorisiert blockierende Deckung auf seiner Route, dann den Kern. | Früh fokussieren, beim Aufladen umsetzen, Sicht mit Rauch unterbrechen. |
| Schwerer | 220 HP plus 100 Rüstung, 0,65-fache Laufgeschwindigkeit | Breite Schulterpanzer, LMG. Zwei Sekunden Feuer, danach drei Sekunden sichtbare Abkühlpause. Hält Spieler beschäftigt, während andere vorrücken. | In der Feuerpause flankieren, Präzisionswaffen oder konzentriertes Teamfeuer. |

Läufer beginnen mit Dreiersalven, mindestens einer Sekunde Pause und 6 Schaden pro
Körpertreffer. Schwere beginnen mit maximal acht Schüssen pro Feuerstoß und 8 Schaden
pro Körpertreffer. Zielerfassung braucht mindestens 0,6 Sekunden, mit endlicher
Drehgeschwindigkeit und Streuung. Gegner erzielen zunächst keine kritischen Kopftreffer.
Sprengerraketen verursachen maximal 70 Spielerschaden vor Rüstung und benötigen
mindestens sechs Sekunden bis zum nächsten Abschuss. Das Team muss einen angekündigten
Angriff beantworten können, bevor Präzision oder Feuerrate erhöht werden.

Kernschaden als separater Abstimmungswert: Läufer greifen erst innerhalb von 2,5 Metern
mit einem sichtbaren Schlag für 10 HP pro Sekunde an. Sprenger verursachen bis zu 80 HP
pro Rakete. Ein LMG-Feuerstoß des Schweren verursacht insgesamt höchstens 40 Kernschaden.
Rüstung und Durchschuss werden über die vorhandenen Kampfregeln ausgewertet.

Alle Gegner verlieren ihre Zielverfolgung bei unterbrochener Sicht, auch durch Rauch.
Eine Sprenger-Schussvorbereitung bricht ab, wenn die erforderliche Sicht verloren geht.
Bereits abgefeuerte Raketen fliegen weiter. Der bekannte Standort des Kerns bleibt ein
Navigationsziel. Er erlaubt weder Schüsse durch Wände noch Kenntnis versteckter Spieler.
Silhouette, Ausrüstung und Geräusch unterscheiden die Rollen zusätzlich zu ihren Farben.

## Acht Wellen und Skalierung

Solo-Grundbesetzung für den vollständigen Modus:

| Welle | Läufer | Sprenger | Schwere | Schwerpunkt |
| --- | ---: | ---: | ---: | --- |
| 1 | 8 | 0 | 0 | Ein Hauptzugang, Kern und Rückweg kennenlernen. |
| 2 | 10 | 1 | 0 | Erster Sprenger, Zerstörung als angekündigte Gefahr. |
| 3 | 12 | 2 | 0 | Wechsel der Angriffsrichtung, veränderte Deckung nutzen. |
| 4 | 12 | 2 | 1 | Erster Schwerer, Feuerpausen erkennen. |
| 5 | 14 | 3 | 1 | Hauptangriff mit einer verzögerten Flanke. |
| 6 | 16 | 3 | 2 | Schwere binden Feuer, Sprenger bekommen Priorität. |
| 7 | 18 | 4 | 2 | Wechselnde Zugänge während einer Welle. |
| 8 | 20 | 4 | 3 | Finale mit gestaffelten Gruppen aller drei Rollen. |

| Aktive Spieler bei Wellenstart | Faktor je Gegnertyp | Höchstens gleichzeitig aktiv | Gleichzeitige Zugänge ab Welle 5 |
| --- | ---: | ---: | ---: |
| 1 | 1,0 | 5 | 1 |
| 2 | 1,6 | 8 | 2 |
| 3 | 2,1 | 10 | 2 |
| 4 | 2,6 | 12 | 3 |

Pro Typ wird die Grundbesetzung mit dem Faktor multipliziert und kaufmännisch auf
eine ganze Zahl gerundet. Null bleibt null. Beispiel: Welle 4 mit vier Spielern
enthält insgesamt 31 Läufer, 5 Sprenger und 3 Schwere, davon höchstens 12 gleichzeitig.
Im ersten spielbaren Stand bleibt die Obergrenze bei acht, auch mit drei oder vier Spielern.

Welle 1 und 2 nutzen für alle Teams einen Zugang. Welle 3 und 4 nutzen höchstens zwei,
Solo weiterhin einen. Ab Welle 5 gelten die Tabellenlimits. Im Solospiel wechseln
die angekündigten Richtungen nacheinander. Bereits aktive Gegner können dabei noch
auf früheren Routen stehen; der Nachschub öffnet nie zwei Zugänge gleichzeitig.

Zusätzliche Grenzen für Spezialgegner: höchstens `ceil(Spieler / 2)` aktive Sprenger
und ebenso viele Schwere. Neue Gegner kommen in Gruppen von maximal drei, mindestens
drei Sekunden Abstand zwischen Gruppen. Volle Limits verzögern den Nachschub.
Ein neuer Zugang wird fünf Sekunden vorher durch Markierung und Geräusch angekündigt.
Der Endkampf nutzt dasselbe endliche Budget; es gibt keinen unangekündigten Nachschub
nach dem letzten Gegner und keinen zusätzlichen Boss im ersten vollständigen Modus.

Der Server friert die Besetzung beim Wellenstart ein. Tod oder Verlassen reduziert
weder existierende Gegner noch offene Spawns. Neue Mitspieler steigen in der nächsten
Versorgung ein; erst die folgende Welle nutzt die neue Teamgröße. Gegner werden
niemals wegen eines Beitritts neben Spielern nachgespawnt.

## Ausrüstung und gemeinsame Kasse

Jeder wählt in der Vorbereitung kostenlos eine Hauptwaffe aus dem vorhandenen Arsenal.
Revolver und Spitzhacke bleiben zusätzlich verfügbar. Keine festen Klassen und kein
Waffenwechsel aus dem gesamten Arsenal während der Welle. Das Waffenrad zeigt die
tatsächlich mitgeführten Waffen. Die freie Wahl macht etwa Schrotflinte plus Sniper
oder Flammenwerfer plus LMG zu einer Absprache im Team.

Beim Start und jeder Versorgung: 100 Spieler-HP, geladene Waffen, drei Reservemagazine
pro mitgeführter Schusswaffe sowie ein Rauch und ein ausgewählter offensiver Wurfgegenstand.
Die bestehende Magazin- beziehungsweise Schalenkapazität der Waffe bestimmt die
Munitionsmenge. Rüstung startet bei 50 und bleibt danach auf ihrem Restwert; Rückkehrer
und nach Welle 1 neu Beitretende erhalten 0 Rüstung. Vorhandene Zustände wie Brennen
und Unterdrückung werden zurückgesetzt.
Erneute Ausrüstungswahl in derselben Vorbereitung vervielfacht keine Munition oder Würfe.

Die Teamkasse startet mit 400 Credits. Eine bestandene Welle `w` zahlt
`300 + 50 × w`, unabhängig von Kills, Überlebenden oder Teamgröße. Nach Welle 8 gibt
es das Ergebnis statt einer weiteren Einkaufsphase. Bis zum Finale sind ohne Ausgaben
insgesamt 3.900 Credits verfügbar. Es gibt keine Einnahmen durch Warten oder endlose Gegner.

| Kauf | Kosten | Wirkung und Grenze |
| --- | ---: | --- |
| Kern reparieren | 150 | Bis zu 200 Kern-HP, höchstens zwei Reparaturen pro Vorbereitung. Vier Sekunden Interaktion am Kern. |
| Rüstungspaket | 200 | +50 Rüstung für alle aktiven Spieler, maximal 100. Ein Paket pro Vorbereitung. |
| Munitionsreserve | 400 | Ein zusätzliches Reservemagazin je mitgeführter Waffe bei jeder Grundversorgung. Einmal pro Lauf, wirkt für das ganze Team. |
| Schnelllader | 600 | Nachladezeiten aller Teamwaffen × 0,85, inklusive einzelner Schalen. Einmal pro Lauf, bleibt nach Tod erhalten. |

Jeder aktive Spieler darf kaufen. Die Liste zeigt immer Kosten, Teamwirkung und
bereits gekaufte Verbesserungen. Ein kurzer Eintrag nennt Käufer und Ausgabe. Keine
Abstimmungsdialoge mitten in der 20-Sekunden-Pause. Alle Effekte enden mit dem Lauf.
Rüstungskäufe mit ausschließlich voll gerüsteten Empfängern werden abgelehnt.

Reparaturen sind nur in Aufstellen und Versorgung möglich. Eine gestartete Reparatur
reserviert 150 Credits; nur ein Spieler repariert gleichzeitig. Bewegung aus dem
2-Meter-Radius, Loslassen, Verlassen oder Phasenende bricht ab und gibt die Reservierung
frei. HP und endgültige Abbuchung entstehen gemeinsam beim Abschluss. Ein voller Kern
nimmt keine Reparatur an. Reservierungen zählen bei allen anderen Käufen als ausgegeben.

Beispiel vor Welle 4: Nach drei Wellen stehen insgesamt 1.600 Credits bereit. Zwei
Reparaturen, Rüstung, Munitionsreserve und Schnelllader würden 1.500 kosten. Ob sich
das Team diese Kombination noch leisten kann, hängt von den vorigen Reparaturen ab.

Während der Welle gibt es genau einen angekündigten Versorgungspunkt außerhalb des
Kernrings. Nach 50 % erledigten Gegnern der gesamten Welle wird er aktiv. Jeder Spieler
kann dort einmal pro Welle 35 HP und ein Reservemagazin für seine Hauptwaffe erhalten,
jeweils bis zum Maximum. Keine Rüstung und keine zusätzlichen Würfe. Der Punkt liegt
am geschützten Bodenstreifen, bleibt bis Wellenende aktiv und ersetzt die zufälligen
Arena-Power-ups in Bastion. Der Lauf dorthin schafft eine bewusste Lücke in der Verteidigung.

## Tod, Solo und Verbindungen

Im Koop verfolgen Gefallene sofort lebende Teammitglieder. Sie kehren in der nächsten
Versorgung zurück und behalten Teamverbesserungen. Keine Killcam gegen NPCs. Sind
während einer Welle alle aktiven Teammitglieder tot oder gegangen, endet der Lauf.
Wartende Zuschauer zählen nicht als lebende Verteidiger.

Ein allein gestarteter Lauf hat eine einmalige Notfall-Rückkehr: Beim ersten Tod
wird der Spieler nach fünf Sekunden an einem geprüften sicheren Punkt zurückgebracht,
mit 100 HP, 0 Rüstung und Grundausrüstung. Der Kern bleibt währenddessen verwundbar.
Danach führt ein weiterer Solotod zur Niederlage. Ein offenes Wellenende wartet auf
die Rückkehr. Tritt später ein zweiter aktiver Spieler bei, verfällt eine unverbrauchte
Solo-Rückkehr dauerhaft; Verlassen schaltet sie nicht erneut frei.

Für den ersten Stand gilt: Ein Beitritt oder Reconnect während des Angriffs führt in
die Zuschaueransicht bis zur Versorgung. Es gibt keine automatische Wiederherstellung
eines verlorenen Spielerlebens. In einer Vorbereitung ist der direkte Einstieg möglich.
Ist kein Mensch mehr verbunden, endet der Lauf als verlassen. Eine kurz weiter
auffindbare Lobby darf daraus keine nachträgliche Belohnung oder Fortsetzung machen.
Eine spätere Wiederherstellung derselben Spieleridentität benötigt einen eigenen
Reconnect-Vertrag; die bisherige Lobby-Wiederverbindung reicht dafür nicht aus.

## Foundry als erste PvE-Karte

Geplant ist eine Bastion-Variante von Foundry mit dem Kern im Bereich des Center Crane.
Die genaue Position wird nach einer Laufwegprüfung festgelegt; die bestehenden
PvP-Spawns sind dafür keine bestätigten Gegner-Spawns. Die Variante verändert nur
den Weltklon dieses Modus und erhält eigene Kartenmetadaten.

- Ein innerer Kernring bietet Rückzug und Zugriff auf das Terminal. Alle Seiten
  müssen zu Fuß erreichbar sein, ohne Sprungpflicht für die KI.
- Drei klar bezeichnete Zugänge: Nordschmiede, Westzufahrt und Ostzufahrt. Jeder
  bekommt einen Hauptweg und einen kurzen Seitenweg zur inneren Verteidigung.
- Mindestens zwei voneinander unabhängige Laufwege bleiben dank geschützter
  Bodenstreifen erreichbar, auch nach starkem Raketenbeschuss.
- Zerstörbare Deckung unterbricht lange Schusslinien. Sprenger greifen markierte
  Hindernisse auf ihrer Route an; sie graben nicht beliebig durch die ganze Karte.
- Erhöhte Positionen geben Überblick, können aber nicht alle Kernzugänge abdecken.
  Die Verteidigung vom Dach allein darf den Kern nicht zuverlässig schützen.
- Gegner erscheinen an verdeckten Sammelpunkten außerhalb des Kernrings. Ein Spawn
  verlangt Standfläche, Kopffreiheit, einen erreichbaren Weg, mindestens 12 Meter
  Abstand zu Spielern und keine direkte Spielersicht. Andernfalls wartet er oder
  wechselt zu einem ebenfalls angekündigten, zulässigen Zugang.

Die Sammelpunkte liegen in für Spieler unzugänglichen Nachschubkammern. Die Karte muss
dort Abstand und Sichtschutz auch nach maximaler Zerstörung gewährleisten. Die Prüfung
bezieht sich auf den Erzeugungspunkt; anschließend laufen die Gegner durch einen
normal sichtbaren und bekämpfbaren Ausgang. Das Bewachen eines Ausgangs blockiert
dadurch nicht die Erzeugung des gesamten Nachschubs.

Zerstörung invalidiert nur betroffene Routenabschnitte. Bleibt ein Gegner stecken,
versucht er zunächst eine alternative Route. Kann er über zehn Sekunden nachweislich
keinen Weg zum Ziel finden, wird er an einem unsichtbaren, gültigen Spawn ersetzt.
Dabei bleiben Identität, HP, Rüstung und Wellenzugehörigkeit erhalten; kein Kill und
keine Belohnung werden ausgelöst. Ist kein gültiger Punkt vorhanden, bleibt der Spawn
ausstehend. Solche Fälle werden protokolliert und müssen im Karten-Abnahmetest verschwinden.

## Menü, HUD und Ton

Die Moduskarte heißt "Bastion" mit dem Zusatz "Koop · 1 bis 4 Spieler" und dem Text:
"Verteidigt den Kern. Übersteht acht Wellen. Jede zerstörte Deckung bleibt zerstört."
Für diesen Modus gibt es keinen Regler für Ersatzspieler-Bots. Die Lobby zeigt Map,
Teamplätze und die acht Wellen; für den ersten Stand steht dort ausdrücklich "3 Wellen".

Im Gefecht oben mittig: Kernbalken mit Prozentwert und `Welle 4/8`. Darunter getrennt
`Aktiv: 8` und `Nachschub: 5`, damit ein fast leerer Kampfplatz nicht wie das Wellenende
wirkt. Zugangsmarkierungen zeigen Richtung und Vorwarnzeit, ohne Gegner durch Wände
sichtbar zu machen. Am Rand stehen Zustand der Mitspieler und die Solo-Rückkehr.

Während der Vorbereitung ersetzen Timer, Teamkasse und die vier Angebote die
Gegneranzeige. `B` öffnet das Versorgungspanel, `E` hält eine Reparatur am Kern.
Touch bietet dieselben Aktionen als kontextabhängige Schaltflächen. Ein Blick reicht
für aktuellen Kernzustand, verbleibende Zeit, Kosten und Wirkung einer Auswahl.

Der Ton priorisiert Sprenger-Aufladen, Kernschaden und neue Zugänge vor Musik und
normalen Wellenansagen. Ergebnis: überstandene Wellen, Zeit und verbleibender Kernzustand.
Persönliche Kills dürfen als Detail erscheinen; die Hauptaussage bleibt der gemeinsame Ausgang.

## Umsetzung am vorhandenen Code

Die vorhandene Basis umfasst serverautoritatives Kämpfen mit 20 Hz, Weltzerstörung,
Bot-Bewegung samt Sichtprüfung gegen Rauch, Modus-Policies, Waffenbesitz und Match-Snapshots.
Kern, Wellen, eigene NPC-Rollen und die gemeinsame Ökonomie sind neue Funktionen.

| Bereich | Geplanter Anschluss |
| --- | --- |
| Modusvertrag | `shared/modes.js`: `bastion`, Foundry-Kompatibilität, Team- und Respawnregeln. Zahlen, Wellentabelle und Kaufdefinitionen in neuem `shared/bastion.js`. |
| Ablauf | Neue `server/modes/bastion.js` als Policy hinter `ModeController`: Wellenzustand, Kern, Wellenstart-Teamgröße, Belohnungen und Endzustand. |
| Phasen | Bestehende äußere Phasen `prep`, `live`, `post` verwenden. Aufstellen/Versorgung und Wellenindex als Bastion-Unterzustand, damit Prüfungen auf `live` in der Simulation gültig bleiben. |
| Gegner | Separater Manager unter `server/pve/` mit IDs `npc-bastion-<run>-<sequence>`, endlichem Spawnplan und eigenem Limit. `BotManager.setCount` begrenzt heute auf sieben und verwaltet Ersatzspieler; nicht als Wellenmanager verwenden. |
| KI | Zielerfassung, Kampf-Eingaben und Bewegung aus `server/bots.js` über gemeinsame Helfer wiederverwenden. Rollenwahl, Routen und Spawnplanung bleiben PvE-spezifisch. Die heutige lokale Ausweichlogik ersetzt keinen geprüften Routenplan. |
| Kampf | Kern als explizites Schadensziel mit eigenem Trefferkörper anbinden. Hitscan, Bolzen, Raketen, Granaten und Feuer über gemeinsame Schadensregeln prüfen; nicht als Lobby-Spieler oder Trainings-Dummy tarnen. |
| Karte | `shared/world/metadata.js` und Foundry-Erzeugung: Kern, Spawn-Sammelpunkte, Routen, Breach-Hindernisse, Versorgungspunkt und geschützter Boden. Bestehendes `BEDROCK` auf Eignung nutzen, keine pauschale Metall-Unzerstörbarkeit annehmen. |
| Lobby | `server/lobby.js`: vier menschliche Plätze, keine NPC-Übernahme durch Beitretende, kein Auffüllen mit PvP-Bots, definierter später Einstieg und Ende bei leerem Team. |
| Netzwerk | `server/protocol/snapshot.js` und Welcome: vollständiger Bastion-Zustand einschließlich Unterphase, Welle, aktivem und ausstehendem Nachschub, Kern, Teamkasse, Kaufständen, Versorgungspunkt und Solo-Rückkehr. NPC-Rolle und Fraktion als validierte Avatarfelder. |
| Versorgung | Bestehende Pickup-Effekte wiederverwenden, aber eigenes Wellen-Timing. `shared/powerups.js` erlaubt aktuell nur Fun, TDM und Chaos; Bastion nicht einfach an deren zufälligen Scheduler anhängen. |
| Darstellung | `public/js/ui/mode-presentation.js`, Gameplay-HUD und Session-Steuerung um Modus, Teamangebote und Zuschauen ergänzen. NPCs aus menschlicher Platzbelegung, Spielerliste und Killcam-Auswahl ausschließen. |

Kaufnachrichten benötigen Lauf-ID, Vorbereitungs-ID, Angebots-ID und Request-ID.
Der Server prüft Phase, Teilnahme, Guthaben nach Reservierungen und Kaufgrenze und
bucht atomar. Ein wiederholter Request liefert sein Ergebnis erneut, ohne weiteren
Effekt. Der Snapshot ist auch für spät Beitretende vollständig; vergangene Einzelereignisse
müssen nicht nachgespielt werden. Eine dauerhaft gewachsene Projektilmenge wird nicht
über Chaos-Lab-Upgrades in den Modus übernommen.

## Lieferumfang und Abnahme

Erster spielbarer Stand: Foundry-Variante, ein Kern, Wellen 1 bis 3, Läufer und
Sprenger, Solo und Koop, höchstens acht aktive Gegner, Grundausrüstung, Reparatur,
Rüstungspaket und eindeutiger Abschluss. Solo-Rückkehr, Zuschauerbeitritt und die
autoritative gemeinsame Kasse gehören bereits dazu. Die beiden dauerhaften
Teamverbesserungen und der Versorgungspunkt folgen mit den acht Wellen und dem Schweren.
Während des ersten Standes sind diese Angebote auch nicht im Menü zu sehen.

Der vollständige Modus hat acht Wellen und maximal zwölf aktive Gegner. Wiederbeleben,
weitere Karten, tägliche Varianten, Boss und Endlosmodus bleiben spätere Erweiterungen.
Ein geschlossener spielbarer Lauf ist Voraussetzung für die Freischaltung im Menü.

| Prüfung | Abnahmekriterium |
| --- | --- |
| Lebenszyklus | Solo sowie zwei, drei und vier Spieler können alle verfügbaren Wellen regulär gewinnen und durch Kern- oder Teamverlust verlieren. Gleichzeitige letzte Treffer beenden den Lauf genau einmal. |
| Besetzung | Für jede Teamgröße stimmt die gerundete Wellentabelle. Gesamtzahl, aktive Obergrenze, Spezialgegnerlimit und angekündigte Zugänge bleiben bei Tod, Join und Leave korrekt. |
| Autorität | Doppelte, verspätete und konkurrierende Käufe oder Reparaturen erzeugen weder negatives Guthaben noch zusätzliche Heilung. Abbruch gibt eine Reservierung genau einmal frei. |
| NPC-Lebenszyklus | Kein automatischer PvP-Respawn, kein Bot-Takeover und keine Belegung menschlicher Lobbyplätze. Zuschauer und Tote erhalten keine aktive Zielrolle. |
| Sicht und Treffer | Rauch bricht neue und gehaltene Zielerfassung sowie Sprenger-Vorbereitung. Kern- und Team-Schadensregeln gelten auch für Flächenschaden, Durchschuss und Feuer. |
| Zerstörung | Nach gezieltem Sprengen aller markierten Hindernisse bleiben zwei Laufwege, Kernzugriff und Versorgung erreichbar. Keine dauerhaften festgesetzten Gegner und keine sichtbaren Ersatz-Spawns. |
| Verbindung | Reconnect während der Welle bringt kein zusätzliches Leben und keine Belohnung. Eine leere Lobby beendet den Lauf; neue Beitritte übernehmen keinen NPC. |
| Browser und Touch | Vollständiger Durchlauf mit Auswahl, Kampf, Versorgung, Tod/Zuschauen und Ergebnis. HUD trennt aktive Gegner vom Nachschub, geschlossenes Menü löst keinen Schuss aus. |
| Leistung | Auf dokumentierter Referenzhardware bei vier Spielern und acht beziehungsweise zwölf Gegnern p95 der Server-Tickdauer unter 25 ms und kein anhaltender Rückstand gegenüber 50 ms pro Tick. Client-Framezeiten, Speicher und Netzlast im Raketen-/Feuer-Stresstest erfassen. Noch keine gemessene Leistungszusage. |

Die ersten Spieltests beantworten drei Fragen: Ändert Zerstörung tatsächlich die
Verteidigung? Bleiben angekündigte Angriffe auch Solo vermeidbar? Entsteht vor Welle 8
eine echte Wahl zwischen Kernzustand und Ausrüstung? Dafür pro Welle Dauer, Kernschaden
nach Gegnertyp, Spielertode, Käufe, Wegfehler und Zeit am Versorgungspunkt erfassen.
Erst nach diesen Messungen gelten Spawntempo, Preise und 12 bis 18 Minuten als bestätigt.
