# Bodycam Mechaniken im Vergleich mit Voxel Blitz

Stand: 14. Oktober 2026. Codebasis: lokaler Arbeitsbaum auf `269498c`, einschließlich vorhandener lokaler Änderungen. Der Vergleich beschreibt den gelesenen Code, nicht den aktuell deployten Server.

Umsetzungsstand: Die unten vorgeschlagenen Stressbewegungen und die voxelabhängige Umgebungsakustik sind inzwischen lokal eingebaut und im laufenden Spiel geprüft, einschließlich zerstörter Wände und Dächer. Details stehen in [development.md](development.md), die Aufnahmen und Messwerte in [live-evidence.json](../.artifacts/stress-acoustics/live-evidence.json). Der folgende Vergleich hält den Ausgangsstand vor dieser Umsetzung fest.

Die ergiebigsten Ergänzungen sind umgebungsabhängige Akustik und sichtbar andere Waffenhandlungen unter Stress. Voxel Blitz besitzt bereits wesentliche Grundlagen: Pain/Panic, Unterdrückung, Atemanhalten, Waffeninertie, Attachment-Abwägungen, räumliche Geräusche und Training. Bodycams Besonderheit ist nach meiner Einschätzung, wie Körperreaktion, Handlung und Wahrnehmung zusammenwirken. Daraus entstehen Entscheidungen: Wo lade ich nach? Welchen Schallweg höre ich? Kann ich mir gerade erlauben, auf die Ausrüstung zu schauen?

## Quellen und Downloadstatus

| Kommentar | Veröffentlichung | Ausgewertetes Material |
| --- | --- | --- |
| [Animation & Loadout, Teil 1](https://www.youtube.com/watch?v=6YUWQXv0MTk) | IGN am 18.08.2026, Entwicklerkanal am 19.08.2026 | Vollständige IGN-Fassung, deren YouTube-Veröffentlichung der Entwickler verlinkt. Über [IGN auf Open Video](https://open.video/@ign/v/bodycam-official-road-to-locked-and-loaded-dev-diary) heruntergeladen; vollständiges automatisches Groq-Transkript gelesen, ergänzend Stichprobenbilder geprüft. |
| [Sound Design, Teil 2](https://www.youtube.com/watch?v=Oz66Ek1RYWU) | 21.08.2026 | [Offizieller Begleittext](https://steamcommunity.com/games/2406770/announcements/detail/675126551624287626) und Release-Notizen. Video nicht heruntergeladen. |
| [Trenches, Teil 3](https://www.youtube.com/watch?v=hRDSX1RLtnw) | 25.08.2026 | [Offizieller Begleittext](https://steamcommunity.com/games/2406770/announcements/detail/675126551624287629) und Release-Notizen. Video nicht heruntergeladen. |
| [Player Driven Improvements, Teil 4](https://www.youtube.com/watch?v=di0zfZlYv-E) | 28.08.2026 | [Offizieller Begleittext](https://steamcommunity.com/games/2406770/announcements/detail/675126551624287631) und nachfolgende Patches. Video nicht heruntergeladen. |

YouTube verlangte sowohl beim Download als auch im Browser eine Anmeldung zur Bot-Prüfung. Ein verwendbarer angemeldeter Browserzugang stand nicht zur Verfügung. Deshalb ist dies keine vollständige Sichtung aller vier Videos. Der ältere [Devlog vom 28.08.2025](https://www.youtube.com/watch?v=ZaowUvvJ-As) ist zusätzlich erfasst; seine damaligen Ankündigungen sind kein Beleg für den heutigen Lieferstand.

Die Dateien liegen unter [Downloads/bodycam-devlogs-2026-10-14](/Users/logge/Downloads/bodycam-devlogs-2026-10-14). Enthalten sind [Video in 720p](/Users/logge/Downloads/bodycam-devlogs-2026-10-14/mirrors/ign-devlog-1-720p.mp4), [Transkript mit Zeitmarken](/Users/logge/Downloads/bodycam-devlogs-2026-10-14/transcripts/ign-devlog-1-audio.e92d2036.groq.txt), [Downloadmanifest](/Users/logge/Downloads/bodycam-devlogs-2026-10-14/mirrors/source-manifest.json) und offizielle Steam-Texte. Das Video ist 14:43 Minuten lang; Streams und Dekodierung des Endes wurden geprüft. Die folgenden Videozeitmarken beziehen sich auf die IGN-Fassung und sind ungefähre Abschnittsanfänge, keine wortgenauen Zitatgrenzen.

## Was wir bereits haben

Unser Pain/Panic-Modell passt zur im ersten Kommentar beschriebenen Stress-Idee. Bodycam bezeichnet dort zwei Animationszustände als ruhig und gestresst. Eine identische interne Aufteilung in unsere zwei numerischen Werte ist damit nicht belegt.

| Vorhandene Mechanik | Tatsächliche Wirkung im aktuellen Code |
| --- | --- |
| Pain und Panic | Der Server verwaltet beide. HP-Schaden erzeugt Pain; auch von Armor abgefangene Treffer können Panic erzeugen. Beide beeinflussen zusammen mit Exhaustion die Streuung. [player.js](/Users/logge/Documents/Projects/voxel-blitz/server/sim/player.js:205), [combatmath.js](/Users/logge/Documents/Projects/voxel-blitz/shared/combatmath.js:662). |
| Unterdrückungsfeuer | Nahe Schüsse und Explosionen erhöhen Panic. Deckung, Haltung, Sichtlinie, Budget und Cooldown begrenzen die Wirkung. [suppression.js](/Users/logge/Documents/Projects/voxel-blitz/server/sim/suppression.js:7). |
| Gegenmaßnahmen | Atemanhalten hat 2,4 Sekunden Reserve; Ducken und Liegen helfen bei der Erholung. Panic verlängert Nachladen um bis zu 35 Prozent. [conditions.js](/Users/logge/Documents/Projects/voxel-blitz/shared/conditions.js:16), [combatmath.js](/Users/logge/Documents/Projects/voxel-blitz/shared/combatmath.js:662). |
| Körper und Waffenführung | Panic-Sway und Waffeninertie verändern reale Schusswinkel. Lehnen, Liegen und Übersteigen berücksichtigen Kollision bzw. Hitboxen. [aim-sway.js](/Users/logge/Documents/Projects/voxel-blitz/public/js/player/aim-sway.js:74), [weapon-turn.js](/Users/logge/Documents/Projects/voxel-blitz/shared/weapon-turn.js:7), [player-lean.js](/Users/logge/Documents/Projects/voxel-blitz/shared/player-lean.js:29). |
| Audio | 3D-Ortung, Material-Fußschritte, Beinahetreffergeräusche und Explosionsringing existieren. Conquest hat für schwere Quellen bereits Schalllaufzeiten. [voices.js](/Users/logge/Documents/Projects/voxel-blitz/public/js/audio/voices.js:65), [footsteps.js](/Users/logge/Documents/Projects/voxel-blitz/public/js/audio/footsteps.js:87), [sfx.js](/Users/logge/Documents/Projects/voxel-blitz/public/js/audio/sfx.js:300). |
| Ausrüstung und Übung | Attachments haben echte Vor- und Nachteile. Killhouse bietet Training. Conquest besitzt Spotting und Medic-Revive. Diese Funktionen sind keine neuen Lücken. [weapon-attachments.js](/Users/logge/Documents/Projects/voxel-blitz/shared/weapon-attachments.js:63), [training.js](/Users/logge/Documents/Projects/voxel-blitz/server/modes/training.js:6), [conquest-contract.js](/Users/logge/Documents/Projects/voxel-blitz/shared/conquest-contract.js:19). |

## Die relevanten Unterschiede

### Waffenhandlungen unter Stress

Bodycam zeigt verschiedene Nachladebewegungen und Fehlgriffe abhängig vom Stress. Beim Revolver verändert die Zahl nachzuladender Patronen den Ablauf. Später erklärt der Kommentar Griffkorrekturen und Ermüdung der Hände. Quellen: [Teil 1 ab etwa 01:45](https://www.youtube.com/watch?v=MDjn7dsnpgI&t=105s), [Revolver ab 03:14](https://www.youtube.com/watch?v=MDjn7dsnpgI&t=194s), [Griff ab 08:24](https://www.youtube.com/watch?v=MDjn7dsnpgI&t=504s).

Bei uns wird derselbe Reload langsamer abgespielt und von allgemeinem Zittern überlagert. Beim Abbruch kehrt die Waffe zur Grundpose zurück. Der Revolver hat eine feste Speedloader-Nachladung: Mit einer oder fünf verbleibenden Patronen dauert sie jeweils 1,8 Sekunden, leer 2,35 Sekunden. Ein Nachladen einzelner fehlender Kammern fehlt. Belege: [weapon-state.js](/Users/logge/Documents/Projects/voxel-blitz/public/js/guns/weapon-state.js:556), [actions.js](/Users/logge/Documents/Projects/voxel-blitz/public/js/guns/actions.js:130), [reload.js](/Users/logge/Documents/Projects/voxel-blitz/shared/reload.js:7), [Revolverdefinition](/Users/logge/Documents/Projects/voxel-blitz/shared/combatmath.js:217).

Mein Vorschlag: Zuerst eigene ruhige und gestresste Griff- und Nachladevarianten sowie fließende Abbrüche. Munition und Aktionsphasen bleiben an den Serverzustand gebunden. Eine zusätzliche zufällige Ladehemmung würde ich daraus nicht ableiten. Für den Revolver kann man separat entscheiden, ob gezieltes Auffüllen zu unserem Spieltempo passt.

### Akustik hängt vom Raum ab

Der zweite Devlog beschreibt laufend berechneten Nachhall und Schallwege durch Räume, Fenster, Korridore und Treppenhäuser, einschließlich besserer Höhenortung. [Offizieller Begleittext zu Teil 2](https://steamcommunity.com/games/2406770/announcements/detail/675126551624287626).

Bei uns sind 3D-Panning und ein fester Echo-Bus vorhanden. Normale Infanterieschüsse durchlaufen noch kein gemeinsames Modell für aktuelle Raumgeometrie und Öffnungen. Die Wanddämpfung des Bot-Gehörs ist ein separates System. Schalllaufzeit für schwere Conquest-Quellen ist bereits vorhanden und sollte erweitert werden. Belege: [Echo-Bus](/Users/logge/Documents/Projects/voxel-blitz/public/js/audio/engine.js:25), [Infanterieschüsse](/Users/logge/Documents/Projects/voxel-blitz/public/js/audio/sfx.js:1108), [Bot-Gehör](/Users/logge/Documents/Projects/voxel-blitz/server/bot-hearing.js:37).

Mein Vorschlag: Ein gemeinsames Akustikmodell für offen, Raum und Tunnel, ergänzt um Verdeckung und Wege durch Öffnungen. Zerstörte Voxel müssen die akustische Situation ändern können. Das wäre eine besonders passende Verbindung mit unserer zerstörbaren Welt. Rechenaufwand und Anzahl gleichzeitiger Quellen brauchen feste Grenzen.

### Blick und Handlung können auseinandergehen

Im ersten Kommentar erklärt Bodycam den unabhängigen Blick während laufender Körperaktionen. Beim Magazincheck muss man tatsächlich zur Waffe sehen. [Teil 1 ab etwa 06:53](https://www.youtube.com/watch?v=MDjn7dsnpgI&t=413s).

Unsere Infanteriekamera dreht Körper und Waffenrichtung weiter mit. Ein eigener Magazincheck fehlt. Fahrzeug-Free-Look existiert bereits, hat jedoch einen anderen Steuerungskontext. Belege: [local-player.js](/Users/logge/Documents/Projects/voxel-blitz/public/js/player/local-player.js:1075), [Körperausrichtung](/Users/logge/Documents/Projects/voxel-blitz/public/js/player/local-player.js:1353), [Fahrzeug-Free-Look](/Users/logge/Documents/Projects/voxel-blitz/public/js/session/vehicle-controller.js:430).

Mein Vorschlag: Zunächst eine Inspektions- und Magazincheck-Aktion. Ihr Nutzen ist größtenteils Atmosphäre, solange die genaue Munitionszahl ohnehin ständig im HUD steht. Eine unsichere Munitionsanzeige sollte deshalb eine bewusste Regel eines taktischen Modus sein.

### Optiken verändern gezielt das Sichtfeld

Bodycam beschreibt vergrößernde Optiken mit separatem Linsenbild und umschaltbarem Schrägvisier. [Teil 1 ab etwa 09:16](https://www.youtube.com/watch?v=MDjn7dsnpgI&t=556s).

Unser Scope verengt das Sichtfeld der Hauptkamera und legt ein Reticle darüber. PiP und Canted-Switch fehlen. [local-player.js](/Users/logge/Documents/Projects/voxel-blitz/public/js/player/local-player.js:1336), [sniper-scope.js](/Users/logge/Documents/Projects/voxel-blitz/public/js/ui/sniper-scope.js:44).

Mein Vorschlag: Erst den Wechsel zwischen Vergrößerung und Nahvisier als echte Loadout-Entscheidung prüfen. PiP anschließend als Qualitätsoption prototypisieren und messen. Die im Devlog beworbene Unreal-Optimierung belegt keine entsprechende Browser-Performance bei uns.

### Fernaufklärung schafft andere Angriffswege

Bodycam zeigt RC-Fahrzeuge und Drohnen sowie einfache und anspruchsvollere FPV-Steuerung. [Teil 1 ab etwa 11:51](https://www.youtube.com/watch?v=MDjn7dsnpgI&t=711s). Die [Release-Notizen](https://steamcommunity.com/games/2406770/announcements/detail/707780185761513591) dokumentieren Teamkennzeichnung und Einsatz-Cooldowns.

Unser Recon besitzt Spotting, aber keine steuerbare Aufklärungskamera als zerstörbares Gerät. Der Spectator ist eine Beobachterkamera um Teammitglieder. [Spotting](/Users/logge/Documents/Projects/voxel-blitz/server/modes/conquest/spotting.js:199), [Spectator](/Users/logge/Documents/Projects/voxel-blitz/public/js/player/spectator-camera.js:16).

Mein Vorschlag: Eine hörbare und zerstörbare Recon-Drohne für Conquest oder einen taktischen Modus. Der Bediener bleibt verwundbar, Informationen müssen auf reale Kamerasicht beschränkt bleiben. Zunächst Aufklärung; Bewaffnung wäre eine weitere Balanceentscheidung. Das ist ein größeres Feature als ein weiterer Waffentyp.

### Trefferreaktionen vor dem Tod

Bodycam zeigt prozedurales Stolpern und Ausgleichsbewegungen nach Trauma. [Teil 1 ab etwa 05:50](https://www.youtube.com/watch?v=MDjn7dsnpgI&t=350s). Die Release-Notizen bezeichnen das System ausdrücklich als frühe Umsetzung.

Wir haben Aim-Punch, kurze Trefferreaktionen am Oberkörper anderer Spieler, Explosionsimpulse und Physik nach dem Tod. Eine aktive Balancekorrektur lebender Figuren fehlt. [Trefferreaktion](/Users/logge/Documents/Projects/voxel-blitz/public/js/avatar/avatar-roster.js:377), [Todesphysik](/Users/logge/Documents/Projects/voxel-blitz/public/js/avatar/death-physics.js:35).

Mein Vorschlag: Erst lesbare, kurze Reaktionen passend zu Trefferseite und Haltung. Echtes Umwerfen oder erzwungene Schritte verändern Kontrolle, Hitboxen und Netzwerksimulation erheblich. Für die erste Ausbaustufe ist das zu aufwendig und kann wiederholten Kontrollverlust erzeugen.

## Weitere Unterschiede mit niedrigerer Priorität

| Bodycam | Stand bei uns und mögliche Bedeutung |
| --- | --- |
| Flash-, Sticky- und Impact-Granaten | Eine echte Flashbang mit Blickwinkel-/Sichtlinienprüfung und eine geworfene Haftgranate fehlen. Impact-Verhalten existiert bereits beim Pulse Shock, Kontaktwirkung auch beim Molotov. [Grenadenregeln](/Users/logge/Documents/Projects/voxel-blitz/shared/grenade-rules.js:114). Quelle: Release-Notizen. |
| Physisches Tablet und Lobby-Hub | Unser Killhouse ist ein separater Trainingsmodus. Ein begehbarer Wartebereich könnte Wartezeit nutzbar machen. Ein Tablet bringt vor allem Darstellung und sollte auf kleinen Displays die Bedienung nicht erschweren. Quellen: [Teil 1 ab 13:23](https://www.youtube.com/watch?v=MDjn7dsnpgI&t=803s) und Release-Notizen. |
| Trenches mit engen und weiten Wegen | Interessant ist die Verbindung von unterirdischen Routen, exponierten Flächen und gadgetgeeigneten Wegen. Das ist ein Leveldesign-Prinzip; eine weitere große Karte allein übernimmt es nicht. Quelle: [Teil 3](https://steamcommunity.com/games/2406770/announcements/detail/675126551624287629). |
| Wetter- und Lichtszenarien | Die Release-Notizen beschreiben Szenarien zum Match-/Rundenbeginn und ersetzen damit den kontinuierlichen Tagesverlauf. Für uns wäre eine reproduzierbare Auswahl solcher Bedingungen prüfbar; sie ist hier nicht als verifizierte Code-Lücke eingestuft. |

Taktische Lampen und Ziellaser könnten bei uns zusätzlich Sichtbarkeit gegen Positionsverrat abwägen. Im Code gibt es dafür keine entsprechende Infanterieaktion; die vorhandene `flashLight` ist Mündungs-/Ladeeffekt. Dies ist ein eigener Designvorschlag, keine aus dem ausgewerteten Kommentar belegte Bodycam-Regel.

## Empfohlene Reihenfolge

1. **Stress sichtbar in Waffenhandlungen übersetzen.** Nah an unserem bestehenden Modell, direkt wahrnehmbar. Prüfkriterium: Aktionsende und Munitionsänderung bleiben korrekt, auch bei Unterbrechung, Waffenwechsel und unterschiedlichen Panic-Werten.
2. **Umgebungsakustik zusammenführen.** Der größte neue taktische Informationsgewinn. Prüfszenarien: draußen, hinter Wand, durch Türöffnung, anderes Stockwerk, nach Zerstörung der Wand. Spieler- und Bot-Gehör dürfen sich nicht grundlos widersprechen.
3. **Gezielte kleinere Entscheidungen ergänzen.** Flashbang, Canted-Switch oder kontextuelles Revolver-Nachladen einzeln ausprobieren und auf Spieltempo prüfen.
4. **Recon-Drohne als eigenes Feature.** Sichtprüfung, Lebensdauer, Geräusch, Zerstörbarkeit und Wirkung auf bestehendes Spotting gemeinsam entwerfen.
5. **True Body und aktive Balance später.** Das greift tief in Kamera, Animation, Treffergeometrie und Netzwerkverhalten ein.

Das sind Umsetzungsvorschläge, keine bereits ausgeführten Änderungen. Modi mit schnellem Arena- oder Titanfall-Spieltempo sollten ihre eigenen Regeln behalten; passende Systeme lassen sich zuerst in Conquest oder einem taktischen Regelprofil erproben.

## Was wir nicht aus dem Material ableiten sollten

Der erste Kommentar belegt keine separate Blutungs-, Fraktur- oder Organverletzungssimulation. Solche Zustände fehlen zwar in unserem Code, gehören aber deshalb noch nicht auf eine Liste übernommener Bodycam-Features. Ebenso ist unsere Exhaustion derzeit eine Präzisionsfolge und keine Grenze für die Sprintdauer.

Auch angekündigte Details brauchen einen Versionsabgleich: [Patch 1 vom 03.09.2026](https://steamcommunity.com/games/2406770/announcements/detail/707782088403714743) entfernte die sichtbehindernde Kamera-Korrekturanimation aus dem Devlog. Teile des Lobby-Trainings waren laut Release-Notizen noch geschlossen. [Patch 6 vom 25.09.2026](https://steamcommunity.com/games/2406770/announcements/detail/705532193278002608) beschrieb Party-System und Anti-Cheat weiterhin als laufende Arbeit. Die jeweils lauteste Realismus-Idee ist damit nicht automatisch eine bewährte Mechanik.
