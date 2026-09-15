# Weapon customization and handling

The main menu's **ARMORY** equips an optic, a grip and an optional StatTrak kill counter for each compatible weapon. The workshop shows the actual game model, four handling metrics and differences from the factory setup. Changes are saved per weapon, then applied on the next match or training admission. Factory setup resets that weapon without changing the others.

The 3D viewer includes the equipped weapon skin and current attachment choices. Drag to rotate in both axes, scroll or pinch to zoom, or use the on-screen zoom and reset controls. Arrow keys, plus/minus and Home work when the viewer is focused. **SHOW STANDARD** compares the unskinned weapon without changing the attachment draft or saved equipment. The collection uses this same viewer for weapon and character skins, including locked items. See [the viewer design and checks](design/model-viewer/README.md).

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

All 12 weapons have a workshop entry. The pickaxe has fixed mounts; the revolver and heavy special weapons retain their factory grips. Minigun, flamethrower and launcher accept the reflex and 2× optics. Scopes support the existing alternate magnification input and scope/breath/reload visibility rules. Attachment models appear in the workshop, first person and remote players' hands. A third slot fits a StatTrak LED counter that displays the weapon's confirmed human kills from career mastery; it changes handling nothing and rides the same save/transport path as optics and grips.

Arrowhead's [customization release](https://arrowhead.zendesk.com/hc/en-us/articles/20039732796956--PATCH-01-003-000) describes sights and underbarrel parts. Its [Into the Unjust patch](https://arrowhead.zendesk.com/hc/en-us/articles/23973732653084--Into-the-Unjust-5-0-0) gives the -1/-2/-4 ergonomics costs for 2×/4×/10× optics. The grip tradeoffs above are Voxel Blitz balancing choices. Magazines and muzzle parts are outside this implementation.

## Progression locks

Optics, grips and the StatTrak counter are nodes on the career unlock tree (see [progression](progression.md)). Factory parts are always available. A part opens by career level alone; the tree never gates an attachment behind weapon mastery.

Ownership is authorization and deliberately stays out of `shared/weapon-attachments.js`: `normalizeAttachments` and `weaponWithAttachments` remain profile-free so the server sim and client prediction keep deriving identical definitions from the same selection, and the finite catalog cache stays finite. The gate lives in `server/weapon-loadouts.js` instead -- `assertUnlockedAttachments` on the save path, and `allowedWeaponLoadout` once at admission. Because admission filters a single value that feeds both `welcome.weaponLoadout` and the server entity, authority and prediction can never disagree about a part.

A stored selection is never rewritten on read. A part that is locked is downgraded to factory only at delivery, so the saved setup returns intact once the node opens. `validateProfile` deliberately does not gate attachments: every profile written before this system existed names parts it does not own, and gating there would reject those careers outright.

The armory shows locked parts with their required level and marks them `aria-disabled` rather than `disabled`, so they stay focusable and a screen reader can announce why they are closed. Drafts containing a locked part are sanitized to factory before they can be saved.

## Player turning

`LocalPlayer` applies the full mouse, touch or controller look delta to the player view, with the configured sensitivity and ADS zoom scale. Weapon ergonomics never limit camera speed or the accepted turn angle. Forward and strafe directions use this view immediately in both local prediction and server movement (`viewYaw`). Pitch retains its normal vertical limit.

`shared/weapon-turn.js` independently moves the weapon toward the view using the weapon's ergonomics, angular acceleration and speed limits. A fast 180° flick can leave a heavy weapon pointing outside the screen until it catches up. Releasing the mouse leaves the player view where it was aimed. Weapon motion does not pull it back or queue more player rotation.

The rendered muzzle, aiming marker, predicted shot and network shot all use the delayed weapon direction. Scoped ADS also keeps the camera free; the scope reticle follows the projected shot ray within the scope aperture. ADS sensitivity, recoil, weapon sway and weapon-specific settling remain active.

The handling range's 90°/180° buttons feed the same player input path. Its completion time measures weapon settling within 1°, rather than player turning speed.

## Persistence and authority

`POST /api/career/attachments` requires the existing career identity and same-origin custom header, validates all three slots against the catalog and rejects any part the profile has not unlocked. The setup is stored in `equipped.weaponAttachments`, using the existing JSON equipment field for file profiles and PostgreSQL row-locked transactions. No schema migration is required. Payloads saved before the counter slot existed omit it and still validate as a factory-counter setup.

The server reads the profile at admission, freezes that match's setup and sends it in `welcome.weaponLoadout`, plus the per-weapon kill counts in `welcome.mastery`. Current attachment choices are included in player snapshots and retained by the client. The first-person rig renders the LED from the admission-time counts and bumps them from its own counted kill events (same bot/team/training filter as the server); the next admission refreshes authority. Remote players' mastery never crosses the snapshot wire, so their plates stay off rather than showing a wrong number. Lobby map replacement and respawn preserve the setup. Client-supplied admission loadouts are rejected. A career outage falls back to factory equipment on both peers without preventing guest gameplay. File-write failures roll back the attempted save.

## Validation

`npm run weapons:handling:test` covers every compatible model/configuration, immutable base definitions, client/server values, scope switching, HTTP rejection, player isolation, persistence/restart, rollback, frame-rate parity, immediate full flick input, independent movement and weapon settling. The complete `npm test` suite covers existing combat, reload, conditions, accounts, modes, maps and networking.

Browser checks covered:

- ARMORY entry, all weapon model types, changing both slots, saving and reload persistence.
- 1280×720 desktop and 390×844 mobile layouts, with all four metrics, scrolling controls and accessible save/back actions.
- A saved rifle 4×/precision setup entering training with ergonomics 61, sway 0.104° at 0.18 Hz, vertical recoil 0.646° and horizontal recoil 0.2304°.
- Actual rifle scope activation at 4×, 21.718° camera FOV and the correct weapon/optic label.
- Returning from training to the menu and reopening the armory. This also exposed and fixed a null match access in the current scoreboard code.

Design prompts, both generated alternatives, selected layout rationale and browser screenshots are in [the design record](design/weapon-customization/design.md). Detailed test output and measurements are under `.artifacts/weapon-customization/`. File persistence was exercised end to end; the PostgreSQL path uses the existing persistence interface but was not run against a live database in this task.
