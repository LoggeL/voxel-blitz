# Weapon customization and carry limits

The main menu's **ARMORY** equips an optic and grip for each compatible weapon. The workshop shows the actual game model, four handling metrics and differences from the factory setup. Changes are saved per weapon, then applied on the next match or training admission. Factory setup resets that weapon without changing the others.

## Attachments

The catalogs and compatibility rules live in `shared/weapon-attachments.js`. Base weapon definitions are never mutated. Client prediction and server combat resolve the same definition; Chaos and Bastion modifiers apply afterwards.

| Optic | Magnification | Ergonomics change |
| --- | --- | --- |
| Factory | Original weapon value | 0 |
| Reflex | 1.15× | 0 |
| Tube sight | 2× | -1 |
| Combat scope | 4× | -2 |
| Precision scope, sniper only | 10× | -4 |

| Grip | Ergonomics | Sway amplitude | Sway rate | Vertical recoil | Horizontal recoil |
| --- | --- | --- | --- | --- | --- |
| Factory | 0 | ×1 | ×1 | ×1 | ×1 |
| Angled | +8 | ×1.08 | ×1 | ×1.06 | ×1.04 |
| Vertical | -4 | ×0.88 | ×0.94 | ×0.75 | ×0.95 |
| Precision | -7 | ×0.65 | ×0.75 | ×0.95 | ×0.72 |

All 12 weapons have a workshop entry. The pickaxe has fixed mounts; the revolver and heavy special weapons retain their factory grips. Minigun, flamethrower and launcher accept the reflex and 2× optics. Scopes support the existing alternate magnification input and scope/breath/reload visibility rules. Attachment models appear in the workshop, first person and remote players' hands.

Arrowhead's [customization release](https://arrowhead.zendesk.com/hc/en-us/articles/20039732796956--PATCH-01-003-000) describes sights and underbarrel parts. Its [Into the Unjust patch](https://arrowhead.zendesk.com/hc/en-us/articles/23973732653084--Into-the-Unjust-5-0-0) gives the -1/-2/-4 ergonomics costs for 2×/4×/10× optics. The grip tradeoffs above are Voxel Blitz balancing choices. Progression locks, attachment purchases, magazines and muzzle parts are outside this implementation.

## Player turning

`shared/weapon-look.js` limits the accepted combined yaw/pitch input using the weapon's ergonomics and its current orientation. The normal carry envelope ranges from 12° to 24°, reduced in ADS. A 35° hard cap covers render hitches. Excess input is discarded, so releasing the mouse never leaves a queued 180° turn. Walking speed is unchanged; the movement direction turns with the limited player view.

Weapon motion remains a separate fixed-step simulation. Its settling rate is increased for ergonomic weapons so the smaller carry envelope does not make light guns sluggish. Motion prediction within the current frame prevents low-frame-rate players from receiving an extra frame of turning delay.

A sustained maximum-speed input produces these **player-view** 180° times:

| Weapon | 30 FPS | 60 FPS | 144 FPS |
| --- | --- | --- | --- |
| SMG | 0.367 s | 0.367 s | 0.389 s |
| Rifle | 0.467 s | 0.467 s | 0.458 s |
| LMG | 1.500 s | 1.483 s | 1.479 s |
| Minigun | 2.900 s | 2.883 s | 2.882 s |

The live browser handling range measured 0.41 s for the SMG and 3.38 s for the minigun **including the weapon settling within 1°**. These are two different measurements. The range's 90°/180° buttons now drive the real constrained input path.

## Persistence and authority

`POST /api/career/attachments` requires the existing career identity and same-origin custom header, and validates both slots against the catalog. The setup is stored in `equipped.weaponAttachments`, using the existing JSON equipment field for file profiles and PostgreSQL row-locked transactions. No schema migration is required.

The server reads the profile at admission, freezes that match's setup and sends it in `welcome.weaponLoadout`. Current attachment choices are included in player snapshots and retained by the client. Lobby map replacement and respawn preserve the setup. Client-supplied admission loadouts are rejected. A career outage falls back to factory equipment on both peers without preventing guest gameplay. File-write failures roll back the attempted save.

## Validation

`npm run weapons:handling:test` covers every compatible model/configuration, immutable base definitions, client/server values, scope switching, HTTP rejection, player isolation, persistence/restart, rollback, frame-rate parity, hard carry limits and discarded flick input. The complete `npm test` suite covers existing combat, reload, conditions, accounts, modes, maps and networking.

Browser checks covered:

- ARMORY entry, all weapon model types, changing both slots, saving and reload persistence.
- 1280×720 desktop and 390×844 mobile layouts, with all four metrics, scrolling controls and accessible save/back actions.
- A saved rifle 4×/precision setup entering training with ergonomics 61, sway 0.104° at 0.18 Hz, vertical recoil 0.646° and horizontal recoil 0.2304°.
- Actual rifle scope activation at 4×, 21.718° camera FOV and the correct weapon/optic label.
- Returning from training to the menu and reopening the armory. This also exposed and fixed a null match access in the current scoreboard code.

Design prompts, both generated alternatives, selected layout rationale and browser screenshots are in [the design record](design/weapon-customization/design.md). Detailed test output and measurements are under `.artifacts/weapon-customization/`. File persistence was exercised end to end; the PostgreSQL path uses the existing persistence interface but was not run against a live database in this task.
