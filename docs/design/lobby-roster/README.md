# Map capacity and operator views

The built-in ImageGen tool generated two alternatives from the existing
`.artifacts/feedback/large-lobby-32.png` screenshot. The overview reference is the
primary layout: compact mission controls on the left and a wide operator roster
on the right. The teams reference supplies the second presentation. Generated
labels and player values are illustrative; implemented values come from the
authoritative lobby state.

- [Overview reference](overview-reference.png), [exact prompt](overview.prompt.txt)
- [Teams reference](teams-reference.png), [exact prompt](teams.prompt.txt)
- Actual desktop: [overview](overview-desktop.png), [teams](teams-desktop.png), [list](list-desktop.png)
- Actual mobile: [overview](overview-mobile.png), [teams](teams-mobile.png), [list](list-mobile.png)

## Behavior

| Arena | Maximum humans and friendly bots combined |
| --- | ---: |
| Depot | 8 |
| Nuketown, Solstice, Caldera | 12 |
| Foundry, Dust II | 16 |
| Citadel | 20 |
| Harbor, Canyon | 32 |
| Reactor 9, Killhouse | 4 |

These are initial population choices for the authored arena sizes, not results
of comparative playtesting. Duels retain their two-player limit. Bastion
retains four defenders and separate enemy waves. Training dummies are not
friendly lobby slots. Teams retain the existing ceiling of 16 members within
the selected map's total capacity, including deliberately uneven teams.

Creation caps requested bots to fit the map. A smaller-map change preserves
humans and trims bots, retaining surviving bots' difficulty and team choices.
If humans alone exceed the requested map limit, the server rejects the change
without replacing the arena or roster. Joining humans replace bots when full.
Quick Play admission and bot replenishment use the same map limits. The room
directory and map selector display those limits.

Overview uses four columns on wide desktops and two columns on phones. List
offers full controls; Teams groups the same roster by authoritative team.
Search and All/Humans/Bots/Waiting filters affect only presentation. Waiting
counts unready humans, not automatically ready bots. Clicking an overview card
opens and focuses its detail row. View preference persists locally. Ping-only
updates preserve roster elements, open selects and scroll position.

Both the full background and mission thumbnail load and decode their next
image before a 650 ms opacity blend with a slight zoom. The old base remains
opaque, including during the decoded image handoff. Repeated state updates
do not restart a blend. Rapid map changes finish the active blend and skip
superseded pending images. Failed images leave the last good image visible.
Reduced motion swaps decoded images directly. Reactor has its own background.

## Validation

- `node tools/map-capacity-test.mjs`: every compatible mode/map, directory
  limits, bot trimming, preserved difficulty, human admission, atomic rejection
  of a smaller map, Quick Play and bot replenishment.
- `npm run lobby:large:test`: all map caps plus real 32-socket admission and
  launch on Harbor, rejected 33rd socket, team limits, bot takeover, S&D bomb
  ownership and preserved assignments.
- `npm run teams:test`: host permissions, readiness, map persistence, spawn and
  bomb ownership.
- `npm run lobby`: 397 passing checks.
- `npm run modes:lobby`: 354 passing checks.
- `npm run maps:test`: passing map, navigation, lighting and full-size lobby checks.
- `node tools/large-lobby-browser-test.mjs`: all views, filters, search, difficulty
  changes, card-to-detail focus, 32 visible overview cards, decoded intermediate
  crossfade frames, rapid map selection, reduced motion, 32-player launch and
  reachable roster at 1440, 800, 390 and 320 pixel widths. Screenshots above are
  produced by this test, with additional in-app browser inspection.
- `git diff --check` and syntax checks pass.

The exact publication snapshot was validated in an isolated checkout based on
`cbb2036`, containing only this feature's changes. The complete `npm test`
suite and `npm run lobby:large:browser` both pass there. The screenshots above
were regenerated from that same isolated snapshot. This verifies the committed
source and local browser behavior; it does not establish a live deployment.
