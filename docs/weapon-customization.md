# Weapon customization and handling

The **WEAPONS** tab of the main menu's ARMORY dialog (`#career-shop`) equips a skin, an optic, a grip and an optional StatTrak kill counter for each compatible weapon. It opens from the tab bar, from a weapon row on the LOADOUT tab, from an attachment's **FIT ON** action and from a mastery ladder's **TUNE IN WEAPONS** button. There is no separate workshop dialog any more: `#workshop-open` and `dialog#weapon-customization` are gone.

The body is `WeaponBench` (`public/js/ui/armory/weapon-bench.js`, loaded lazily): a weapon rail (`#armory-weapon-rail`, arrow keys, Home and End) with each weapon's HUD icon and mastery tier pip, then SKIN, OPTIC, GRIP and KILL COUNTER groups and a **FACTORY SETUP** button. The inspector beside it shows the weapon in 3D with the focused option applied, the four handling meters with their change against the equipped setup (glyph, word and colour), the turn ceiling and zoom, and the weapon's mastery line with its next reward.

**Save on select.** There are no drafts and no SAVE button. Picking a part changes its pressed state at once; after a 250 ms quiet window the latest pick for that weapon is saved with `POST /api/career/attachments`. An older response can never overwrite a newer pick. A rejected save (4xx or 503) rolls back to the last confirmed `equipped.weaponAttachments[weapon]` and shows the server's error; success reads "<WEAPON NAME> setup saved". Skins equip through the career equip route, with a per-weapon standard reset. **FACTORY SETUP** saves factory parts for that weapon only. Setups apply when you join your next match or training.

The 3D viewer includes the equipped weapon skin and the current attachment choice. Drag sideways to rotate, scroll or pinch to zoom, or use the zoom and reset controls under the inspector. Arrow keys, plus/minus and Home work when the viewer is focused. **SHOW STANDARD** compares the unskinned weapon without changing the saved setup. See [the viewer design and checks](design/model-viewer/README.md).

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

Every weapon in `WEAPON_IDS` has a bench entry. The pickaxe has fixed mounts; the revolver and heavy special weapons retain their factory grips. Minigun, flamethrower and launcher accept the reflex and 2× optics. Scopes support the existing alternate magnification input and scope/breath/reload visibility rules. Attachment models appear in the ARMORY, first person and remote players' hands. A third slot fits a StatTrak LED counter that displays the weapon's confirmed human kills from career mastery; it changes handling nothing and rides the same save/transport path as optics and grips.

Arrowhead's [customization release](https://arrowhead.zendesk.com/hc/en-us/articles/20039732796956--PATCH-01-003-000) describes sights and underbarrel parts. Its [Into the Unjust patch](https://arrowhead.zendesk.com/hc/en-us/articles/23973732653084--Into-the-Unjust-5-0-0) gives the -1/-2/-4 ergonomics costs for 2×/4×/10× optics. The grip tradeoffs above are Voxel Blitz balancing choices. Magazines and muzzle parts are outside this implementation.

## Progression locks

Optics, grips and the StatTrak counter are nodes on the career unlock tree (see [progression](progression.md)). Factory parts are always available. A part opens by career level alone; the tree never gates an attachment behind weapon mastery.

Ownership is authorization and deliberately stays out of `shared/weapon-attachments.js`: `normalizeAttachments` and `weaponWithAttachments` remain profile-free so the server sim and client prediction keep deriving identical definitions from the same selection, and the finite catalog cache stays finite. The gate lives in `server/weapon-loadouts.js` instead -- `assertUnlockedAttachments` on the save path, and `allowedWeaponLoadout` once at admission. Because admission filters a single value that feeds both `welcome.weaponLoadout` and the server entity, authority and prediction can never disagree about a part.

A stored selection is never rewritten on read. A part that is locked is downgraded to factory only at delivery, so the saved setup returns intact once the node opens. `validateProfile` deliberately does not gate attachments: every profile written before this system existed names parts it does not own, and gating there would reject those careers outright.

The WEAPONS tab shows locked parts with a lock glyph and their required level (`LV 18`), marks them `data-locked` and `aria-disabled` rather than `disabled`, so they stay focusable and a screen reader can announce why they are closed. Choosing a locked part only explains the gate; it is never queued for saving.

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

`npm run armory:browser` and `npm run models:browser` (muted CDP captures) cover the WEAPONS tab: every weapon on the rail, save-on-select of a rifle optic surviving a reload, a debounced single POST for `scope4`, a locked rifle skin at level 100 without rifle mastery, standard comparison keeping the setup, and responsive framing at 1280, 390 and 360 px. `tools/armory-preview-test.mjs` pins the debounce, latest-wins, rollback and locked-part behaviour without a browser.

The original workshop's design record and handling measurements remain in [the design record](design/weapon-customization/design.md) and `.artifacts/weapon-customization/`; the ARMORY redesign is recorded in [design/armory-v2](design/armory-v2/README.md).
