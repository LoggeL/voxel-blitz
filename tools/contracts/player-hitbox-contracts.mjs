import { playerHitboxes, rayPlayerHitboxes, pointPlayerDistance } from '../../shared/player-hitboxes.js';
import { nearestVictim } from '../../server/sim/combat.js';
import { sweepPlayers } from '../../server/sim/projectile-contact.js';

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
  for (const yaw of [0, Math.PI / 2, 2.3]) {
    const target = { ...player, x: 7, y: 3, z: -4, yaw, pitch: 0.5 };
    const box = playerHitboxes(target).find(b => b.zone === 'head');
    const direction = { x: Math.sin(yaw), y: 0, z: Math.cos(yaw) };
    const origin = box.center.map((v, i) => v - [direction.x, 0, direction.z][i] * 5);
    ok(rayPlayerHitboxes(origin, direction, target, 10)?.zone === 'head',
      `translated and rotated head zone registers at yaw ${yaw}`);
  }
  const arm = playerHitboxes(player).find(b => b.zone === 'arm');
  ok(pointPlayerDistance(arm.center, player) === 0,
    'arm volumes outside the movement collider accept direct contacts');
  const shooter = { bot: false, input: { viewAge: 100 } };
  const victim = { ...crouched, hist: [{ ...player, t: 900 }] };
  const ctx = { now: 1000, entities: new Map([['v', victim]]), canDamage: () => true };
  ok(nearestVictim(shooter, [0, 1.8, -5], { x: 0, y: 0, z: 1 }, 10, ctx)?.zone === 'head' &&
    !nearestVictim({ bot: true }, [0, 1.8, -5], { x: 0, y: 0, z: 1 }, 10, ctx),
    'human rewind uses the historical stance while bots use the current stance');
  ok(!nearestVictim(shooter, [0, 1.8, -5], { x: 0, y: 0, z: 1 }, 4, ctx),
    'a wall-distance limit stops the shot before the player');
  const near = { ...player, z: 2 }, far = { ...player, z: 5 };
  const entities = new Map([['far', far], ['near', near]]);
  const contact = sweepPlayers({ x: 0, y: 1.66, z: -2 }, { x: 0, y: 1.66, z: 8 }, 0.04, entities, () => true);
  ok(contact?.victim === near && contact.zone === 'head',
    'swept projectiles hit the nearest body zone regardless of insertion order');
  ok(!sweepPlayers({ x: 0.3, y: 1.8, z: -2 }, { x: 0.3, y: 1.8, z: 2 }, 0.04,
    new Map([['p', player]]), () => true), 'projectile radius does not recreate the old full-width head box');
  const graze = shot(0.24, 1.8, player, 0.06);
  ok(graze && !graze.coreHit && graze.radialDistance > 0,
    'a genuine grazing radius contact is distinguished from a direct head hit');
  ok(!shot(0.24, 1.94, player, 0.06),
    'rounded projectile corners reject diagonal near misses beyond the radius');
}
