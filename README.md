<div align="center">

# VOXEL BLITZ

Fast rounds. Destructible arenas. Straight into your browser.

[![Fast CI](https://github.com/LoggeL/voxel-blitz/actions/workflows/ci.yml/badge.svg)](https://github.com/LoggeL/voxel-blitz/actions/workflows/ci.yml)
![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933?logo=nodedotjs&logoColor=white)
![three.js](https://img.shields.io/badge/3D-three.js-111111?logo=threedotjs&logoColor=white)

[Get started](#get-started) · [Screenshots](#screenshots) · [Controls](#controls) · [Developer guide](docs/development.md)

</div>

![VOXEL BLITZ main menu with Quick Play, custom lobbies and the Killhouse practice range](docs/screenshots/main-menu.png)

A multiplayer voxel arena shooter with destructible cover, twelve weapons and bots that keep the action moving. Jump into Quick Play, invite friends to a custom lobby, or work on your aim in the Killhouse.

## Inside the arena

- **Break through cover.** Block destruction changes the arena as you fight.
- **Risk a supply run.** Armor, Medkits and Ammo appear on exposed ground in Fun, Team Deathmatch and Chaos Lab. Walk over one to collect it.
- **Find your weapon.** Rifles, a shotgun, a revolver, a sniper, an LMG, a minigun, a flamethrower, rockets, melee, ricocheting LONGARC bolts and the piercing VOLTLANCE. Add cookable frags, sticky charges and pulse shocks.
- **Play with friends or bots.** Up to eight human players per room, lobby discovery, invite links, QR codes and optional lobby passwords.
- **Feel every shot.** Procedural weapon models, recoil, aiming down sights, staged reloads, tracers, hit feedback and layered audio.
- **Play on desktop or touch.** Mouse and keyboard controls, a radial weapon wheel and mobile touch controls.

| Mode | What you play |
| --- | --- |
| Fun | Free-for-all with the full arsenal and fast respawns. Quick Play drops you into a live room. |
| Chaos Lab | Kills and hidden $300 cash bundles earn credits for 51 cumulative upgrades across all twelve weapons and five throwables. Open the lab with B; upgrades survive death. |
| Team Deathmatch | Two teams race to 40 kills. |
| Search and Destroy | Plant or defuse the bomb, buy your loadout and make each life count. |
| Gun Game | Every kill advances your weapon. Finish the ladder to win. |
| Bastion | Cooperative defense for 1–4 players on Reactor 9: eight waves, three enemy roles, a shared bank and reactor repairs. |
| Training | Respawning range targets and a timed four-stage Killhouse course. |

## Screenshots

Actual browser captures from the game. Arena shots use the built-in fixed-camera capture view, without the gameplay HUD.

| Solstice | Caldera |
| --- | --- |
| ![Solstice arena with a solar-observatory ring and glass structures](docs/screenshots/solstice.png) | ![Caldera arena with industrial cover and elevated walkways](docs/screenshots/caldera.png) |
| Solar observatory, biodome and turbine hall. | Obsidian Gate and Ember Refinery. |

![Killhouse covered firing line with target lanes and orange floor markings](docs/screenshots/killhouse.png)

The Killhouse firing line. Practice here, then head into the timed course.

Nine maps ship with the game: Foundry, Depot, Citadel, Solstice, Caldera, Nuketown, Dust 2, Killhouse and Reactor 9. [Bastion](docs/pve-bastion.md) uses Reactor 9 exclusively. Create a custom Bastion lobby, ready up and start; B opens supplies and E repairs the core between waves. [Dust 2](docs/maps/dust2.md) brings Long A, Short/Catwalk, Mid Doors and B Tunnels to the destructible voxel world. Select it in a custom lobby for Fun, Chaos Lab, Team Deathmatch, Search and Destroy or Gun Game. See the [map compatibility table](docs/development.md#map-compatibility) for supported modes.

## Get started

You need **Node.js 20+** and npm.

```bash
git clone https://github.com/LoggeL/voxel-blitz.git
cd voxel-blitz
npm ci
npm start
```

Open [localhost:8070](http://localhost:8070), enter a name and choose **Quick Play**. A fresh quick room starts with at least five bots, so you can play on your own immediately.

For a match with friends, choose **Create Lobby**, share the invite link or QR code, then have everyone ready up. The host starts the match. Remote players need access to the same running server.

To use a different port:

```bash
PORT=8080 npm start
```

## Controls

| Input | Action |
| --- | --- |
| `WASD` / mouse | Move / look |
| `Shift` / `Space` / `Ctrl` or `C` | Sprint / jump / crouch |
| `Space` again in midair | Grab a reachable ledge and pull up, even after releasing movement keys |
| Left / right mouse | Fire / aim down sights |
| `R` | Reload |
| `V` | Quick pickaxe hit for melee or block mining; returns to your weapon |
| `1–9`, `0` or scroll wheel | Switch weapons |
| Hold `Q`; hover a weapon and release, or move past the outer ring | Weapon wheel |
| Hold and release `G` / press `H` | Throw / change throwable |
| `E` / `B` | Objective interaction / S&D buy menu, Chaos Lab or Bastion supplies |
| `Tab` / `Escape` | Scoreboard / settings and pause menu |

See the [full controls](docs/development.md#controls) for charge weapons, sniper zoom, ladders and spectator controls.

## Run and develop

One Node.js process serves the client and runs an authoritative 20 Hz simulation over WebSockets. The client uses three.js and native JavaScript modules. There is no frontend build step.

```bash
npm test                  # Core contracts and gameplay/protocol checks
npm run browser:smoke     # Browser menu, lobby and gameplay flow
npm run maps:capture      # Deterministic map screenshots
npm run weapons:capture   # Weapon inspection renders
```

Browser checks and capture tools require a Chromium-based browser. Generated QA artifacts go into the ignored `.artifacts/` directory.

| Directory | Purpose |
| --- | --- |
| `public/` | Browser client, UI, rendering and assets |
| `server/` | HTTP/WebSocket server, rooms, simulation and bots |
| `shared/` | Map generation, movement, combat and mode rules |
| `tools/` | Tests, visual captures and audio checks |

For hosting, forward HTTP and WebSocket traffic to the same port. Match state lives in memory and resets when the server restarts. The [developer guide](docs/development.md) covers the protocol, weapon behavior, settings, testing and [container deployment](docs/development.md#container-deployment).

## Asset credits

Audio sources and usage terms are recorded in [audio credits](public/assets/audio/LICENSES.md). The bundled QR generator includes its [license notice](public/js/vendor/qrcode-generator-2.0.4.LICENSE.txt). Generated audio has separate usage terms from the CC0 recordings.
