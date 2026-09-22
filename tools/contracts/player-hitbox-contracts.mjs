import { rayPlayerHitboxes } from '../../shared/player-hitboxes.js';
import { nearestVictim } from '../../server/sim/combat.js';
import { sweepPlayers } from '../../server/sim/projectile-contact.js';
import { GameEngine } from '../../server/game.js';
import { NETWORK_PRESENTATION } from '../../shared/networking.js';

export function runPlayerHitboxContracts(ok) {
  const player = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, state: 'alive' };
  const shot = (x, y, target = player, radius = 0) =>
    rayPlayerHitboxes([x, y, -5], { x: 0, y: 0, z: 1 }, target, 10, { radius });
  ok(shot(0, 1.66)?.zone === 'head' && !shot(0.28, 1.75),
    'headshots hit the head, while empty air beside the helmet misses');
  ok(shot(0, 1.1)?.zone === 'torso' && shot(0.16, 0.3)?.zone === 'leg' && !shot(0, 0.3),
    'torso and individual legs register, but the gap between the legs does not');
  const crouched = { ...player, crouch: true };
  ok(!shot(0, 1.8, crouched) && shot(0, 1.32, crouched)?.zone === 'head',
    'crouching moves the head zone down and removes the standing head target');
  ok(!shot(0.25, 1.15, { ...player, yaw: Math.PI / 2, crouch: true }) ||
      shot(0.25, 1.15, { ...player, yaw: Math.PI / 2, crouch: true })?.zone !== 'head',
    'shoulder-height side hits are not classified as headshots');
  const shooter = { bot: false, input: { viewAge: 100 } };
  const victim = { ...crouched, hist: [{ ...player, t: 900 }] };
  const ctx = { now: 1000, entities: new Map([['v', victim]]), canDamage: () => true };
  ok(nearestVictim(shooter, [0, 1.8, -5], { x: 0, y: 0, z: 1 }, 10, ctx)?.zone === 'head' &&
    !nearestVictim({ bot: true }, [0, 1.8, -5], { x: 0, y: 0, z: 1 }, 10, ctx),
    'human rewind uses the historical stance while bots use the current stance');
  ok(!nearestVictim(shooter, [0, 1.8, -5], { x: 0, y: 0, z: 1 }, 4, ctx),
    'a wall-distance limit stops the shot before the player');

  // Lag compensation picks the newest sample at or before now - viewAge, with
  // viewAge clamped to the presentation window. Samples sit at distinct lateral
  // offsets so a torso ray at one x identifies exactly which pose was used.
  const rewindAt = (viewAge, hist, x) => {
    const target = { ...player, hist };
    const rewindCtx = { now: 1000, entities: new Map([['v', target]]), canDamage: () => true };
    return nearestVictim({ bot: false, input: { viewAge } }, [x, 1.1, -5], { x: 0, y: 0, z: 1 }, 10, rewindCtx)?.victim === target;
  };
  const trail = [500, 600, 700, 800, 900, 975].map((t, i) => ({ ...player, x: 2 + i * 2, t }));
  ok(rewindAt(100, trail, 10) && !rewindAt(100, trail, 0) && !rewindAt(100, trail, 12),
    'a 100 ms view age hits the pose sampled 100 ms ago, not the live or newest pose');
  ok(NETWORK_PRESENTATION.minViewAgeMs === 25 && rewindAt(0, trail, 12) && !rewindAt(0, trail, 0),
    'a zero view age is clamped to the minimum and reads the newest sample');
  ok(NETWORK_PRESENTATION.maxViewAgeMs === 450 && rewindAt(9999, trail, 2) && !rewindAt(9999, trail, 0),
    'an oversized view age is clamped to the maximum rewind instead of falling back to live');
  const stale = [{ ...player, x: 2, t: -100 }, { ...player, x: 4, t: 0 }];
  ok(rewindAt(100, stale, 0) && !rewindAt(100, stale, 4),
    'history older than the rewind window falls back to the live pose');
  const fresh = [{ ...player, x: 10, t: 950 }, { ...player, x: 12, t: 990 }];
  ok(rewindAt(100, fresh, 10) && !rewindAt(100, fresh, 12),
    'history newer than the rewind point uses its oldest sample');

  // A portal clears the trail, so a human shooter cannot hit the pre-teleport body.
  const engine = new GameEngine({ mode: 'fun' });
  try {
    engine.addClient('rewind-shooter', 'Shooter'); engine.addClient('rewind-victim', 'Victim');
    const human = engine.entities.get('rewind-shooter');
    const traveller = engine.entities.get('rewind-victim');
    Object.assign(traveller, { x: 20.5, y: 30, z: 20.5, spawnProtectedUntil: 0 });
    traveller.hist = [900, 950].map((t) => ({ x: 20.5, y: 30, z: 20.5, yaw: 0, pitch: 0, t: engine.now - 1000 + t }));
    human.input = { viewAge: 100 };
    const aimAt = (x, z) => nearestVictim(human, [x, 31.1, z - 5], { x: 0, y: 0, z: 1 }, 10, engine.contexts.combat)?.victim === traveller;
    const before = aimAt(20.5, 20.5);
    engine.mapMeta = { ...engine.mapMeta, portals: [{ id: 'rewind-portal', minX: 20, maxX: 21, minY: 29, maxY: 32,
      minZ: 20, maxZ: 21, x: 40.5, y: 30, z: 40.5, yaw: 0 }] };
    engine.applyMapVolumes(traveller, 0.05);
    ok(before && traveller.x === 40.5 && traveller.hist.length === 0 && !aimAt(20.5, 20.5) && aimAt(40.5, 40.5),
      'a portal resets rewind history so shots at the pre-teleport position miss');
  } finally { engine.stop(); }
  const near = { ...player, z: 2 }, far = { ...player, z: 5 };
  const entities = new Map([['far', far], ['near', near]]);
  const contact = sweepPlayers({ x: 0, y: 1.66, z: -2 }, { x: 0, y: 1.66, z: 8 }, 0.04, entities, () => true);
  ok(contact?.victim === near && contact.zone === 'head',
    'swept projectiles hit the nearest body zone regardless of insertion order');
  ok(!sweepPlayers({ x: 0.3, y: 1.8, z: -2 }, { x: 0.3, y: 1.8, z: 2 }, 0.04,
    new Map([['p', player]]), () => true), 'projectile radius does not recreate the old full-width head box');
  // RIVET's helmet is 0.36 m wide; the headset adds 0.03 m per side at ear height.
  const graze = shot(0.235, 1.66, player, 0.06);
  ok(graze && !graze.coreHit && graze.radialDistance > 0,
    'a genuine grazing radius contact is distinguished from a direct head hit');
  ok(!shot(0.24, 1.94, player, 0.06),
    'rounded projectile corners reject diagonal near misses beyond the radius');
}
