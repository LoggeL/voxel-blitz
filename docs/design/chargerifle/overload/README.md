# CR-6: sichtbare Überladung

Die CR-6 soll beim Aufladen aussehen, als könne sie die gespeicherte Energie kaum noch halten. Die Zellkerne werden gelbweiß, während rote und orange Halos über ihre Konturen hinausstrahlen. Leitungen auf dem Gehäuse, die äußeren Sammelschienen, acht Lüftungsschlitze, die inneren Emitterschienen und die Fokussierringe glühen ebenfalls. Das Gehäuse erhält eine schwache warme Emission. Im letzten Viertel der Ladung steigen Helligkeit und Halo-Größe stark an; ein überlagerter, kleiner Helligkeitspuls macht die volle Ladung unruhig.

Die beiden Konzepte wurden mit dem eingebauten Imagegen-Werkzeug aus `../after/desktop-chargerifle-charged.jpg` erzeugt:

- [A, gewählter Reaktor-Look](concept-a.png)
- [B, elektrische Entladung](concept-b.png)
- [Vollständige Prompts](prompts.txt)

Übernommen wurden die gelbweißen Kerne, orange Aura und durchgehenden heißen Leitungen aus A. Die tatsächliche Umsetzung folgt der vorhandenen Waffenform. Die Waffe verwendet weiterhin den echten Ladewert für alle Effekte. Der Helligkeitspuls setzt erst oberhalb von 75 Prozent ein. Bei reduzierter Bewegung bleibt die Glut konstant. Entladung, Ladungsabbau und Waffenwechsel kühlen die Flächen und schalten die Halos ab.

Die Emission wirkt auch mit dem HDR-Bloom des Spiels. Elf weiche, additive Halos sorgen zusätzlich für sichtbaren Glow in Low und auf der Capture-Seite ohne Bloom. Sie teilen sich eine 32 x 32 große, pro Waffenmodell erzeugte radiale Textur und eine eigene Quad-Geometrie. Materialien bleiben pro Waffe getrennt; die Halos prüfen Tiefe und leuchten bei anderen Spielern nicht durch Wände. Globale Beleuchtung und Bloom-Einstellungen werden nicht verändert.

Geprüft am 13.10.2026:

- Modelltest: Ladestufen, Überladungshelligkeit, Puls, reduzierte Bewegung, Verdeckung, getrennte Ressourcen, Rücksetzen und Freigabe bestanden.
- 3274 Ladungsprüfungen, 726 AT-Waffenprüfungen und 204 Displayprüfungen bestanden.
- Modul-Preload-Prüfung und Diff-Whitespace-Prüfung bestanden.
- 13 Browseraufnahmen ohne Fehler: Desktop 1920 x 1080, Mobil 844 x 390 und 390 x 844; leerer Ladestand, Teilladung, volle Ladung sowie Zielen auf Desktop und im Hochformat.

[Desktop, volle Ladung](captures/desktop-chargerifle-charged.jpg), [Mobil, volle Ladung](captures/portrait-chargerifle-charged.jpg), [Mobil, Zielen](ads/portrait-chargerifle-charged-ads.jpg). Diese Aufnahmen verwenden das echte Viewmodel mit definierten Zuständen. Sie wurden gegen Referenz A verglichen: die zusätzlichen Energiepfade und die orange Aura sind auch ohne Bloom sichtbar, Visier und Display bleiben lesbar.
