# Traitor-Ausrüstung

Der Shop enthält Radar, Disguiser und Teleporter sowie die bisherige Versorgung mit Rüstung, Heilung und Munition. Alle Artikel kosten einen Credit. Das Budget bleibt bei zwei Credits pro Runde; Gadgets sind jeweils einmal pro Runde erhältlich und belegen keinen Waffenplatz.

## Orientierung am Original

Recherchiert am 13. September 2026 direkt im öffentlichen Garry's-Mod-Quellcode:

- [Radar auf dem Server](https://github.com/Facepunch/garrysmod/blob/master/garrysmod/gamemodes/terrortown/gamemode/radar.lua): 30 Sekunden Ladezeit, Positionsaufnahmen lebender Spieler, ausschließlich an den Besitzer gesendet. Eigene Rollen werden erkennbar gemacht. Die Umsetzung übernimmt dieses Scan-Prinzip; die Positionsaufnahme bleibt zwischen den Scans stehen.
- [Originale Ausrüstungsbeschreibungen](https://github.com/Facepunch/garrysmod/blob/master/garrysmod/gamemodes/terrortown/gamemode/lang/english.lua): automatischer Radarstart beim Kauf und schaltbarer Disguiser, der die Identitätsanzeige verbirgt. In Voxel Blitz verschwinden Name und Gesundheitsbalken über dem Charakter. Körper, Waffen und Scoreboard bleiben sichtbar.
- [Originaler Teleporter](https://github.com/Facepunch/garrysmod/blob/master/garrysmod/gamemodes/terrortown/entities/weapons/weapon_ttt_teleport.lua): Ziel merken, zurückkehren und Kollisionsprüfung. Für Voxel Blitz angepasst: drei sofortige Rücksprünge, 20 Sekunden Pause zwischen Sprüngen, keine Telefrags. Markieren und Zurückkehren erfordern festen Boden und aufrechte Haltung. Blockierte oder besetzte Ziele verbrauchen keine Ladung.

## Bedienung

B öffnet den Shop. Ein Artikel wird links ausgewählt und rechts gekauft. Erworbene Gadgets erscheinen unter „Deine Gadgets“.

- Radar: beginnt sofort automatisch. Kompakte Rundanzeige und Entfernungsmarkierungen durch Wände. Amber markiert sonstige Lebenszeichen, Rot Mit-Traitors. Die Karte dreht sich mit der Blickrichtung; Positionen ändern sich erst beim nächsten Scan. Pfeile am Bildschirmrand zeigen Kontakte außerhalb des Sichtfelds.
- Disguiser: nach Kauf aktiv, im Shop aus- und einschaltbar. Der aktive Zustand ist auch im Spiel ablesbar.
- Teleporter: „Punkt merken“, dann an einem anderen Ort „Zurück“. Verbleibende Ladungen und Wartezeit stehen an der Aktion. Gesundheit, Rüstung, Munition und Leben werden beim Sprung nicht aufgefüllt.

Rollenwechsel, Tod und Rundenende sperren Gadget-Aktionen und die Anzeige geheimer Daten. Beim nächsten Rundenstart wird die Ausrüstung verworfen. Radarscans, Inventar und Teleporter-Ziele verlassen den Server nur im privaten Zustand des Besitzers.

## Design und Belege

Mit dem eingebauten ImageGen-Werkzeug wurden auf Grundlage des bisherigen Shops zwei Alternativen erzeugt. Dateien: [Alternativen](alternatives.png), [vollständiger Prompt](prompt.txt). Gewählt wurde B: Katalog plus Detailansicht. Auf kleinen Displays stehen Katalog, Beschreibung und Steuerung untereinander. Eigene einfache SVG-Symbole ergänzen die vorhandenen Armory-Stile; die Referenzgrafik selbst wird nicht als UI ausgeliefert.

Der Vergleich mit den echten Browseraufnahmen bestätigt Katalog, ausgewählte Detailansicht, besitzabhängige Bedienelemente und Radar im Spiel. Randmarkierungen werden versetzt, damit mehrere Kontakte lesbar bleiben. Die mobile Radarbox sitzt unter dem Rollenpanel.

Prüfungen:

- `npm run ttt:test`: bestehende TTT-Regeln plus eingefrorene Scanpositionen, 30-Sekunden-Grenze, Kopien ohne Referenzen auf veränderlichen Serverzustand, Berechtigungen, doppelte Käufe, Verkleidung, Teleporter-Kollisionen, belegte Ziele, Bodenprüfung, Ladezeit, drei Ladungen, Erhalt von Gesundheit/Leben, private Übertragung und Positionsübernahme im Client.
- `npm run ttt:browser`: tatsächliche Lobby- und Kaufbefehle, Tarnung umschalten, Radar nach Kauf sichtbar, eingefrorene Kontakte bis zum nächsten Scan, neue Scananzeige, Rücksprung mit gemessener Client-Ankunft, Entzug bei Rollenwechsel, Desktop 1280×810 und Mobil 390×844. Die Prüfung kontrolliert zusätzlich Radar-/Kontrollabstand sowie Bildschirmgrenzen und Überschneidungen der Kontaktlabels.
- Die Equipment-Fixture hält Bots still, zieht Zeit für den Folgescan vor und richtet für den Teleporter einen separaten Testzustand mit frischem Budget ein. Die Käufe und Rücksprünge laufen über die unveränderten Produktionsbefehle.
- Zusätzlich bestanden Refactoring-, Zustands- und Medkit-Tests.
