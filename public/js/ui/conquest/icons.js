/**
 * Vector glyphs for the Conquest UI (kill feed, minimap, deploy screen and
 * vehicle panel). 24x24 view boxes, filled with currentColor, so every icon
 * takes the team-relative colour of its container. No external assets.
 */
import { MAP_EVENT_KILL_KEYS } from '../../../../shared/conquest-map-events.js';
import { MAP_EVENT_GLYPHS } from './map-events/glyphs.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

const BASE_PATHS = {
  // Mounted weapons.
  shell: 'M2 10.5h11l3-2h4.5a1.5 1.5 0 0 1 0 3V12.5a1.5 1.5 0 0 1 0 3H16l-3-2H2zM5 9h2v6H5z',
  mg: 'M2 11h14v2H2zM16 9.5h3l3 1.5-3 1.5h-3zM4 13h3l-1 4H4zM9 13h2v2H9zM3 8h5v3H3z',
  bomb: 'M12 6.5a3.5 3.5 0 0 1 3.5 3.5v6a3.5 4.5 0 0 1-7 0v-6A3.5 3.5 0 0 1 12 6.5zM8.5 2h7l-1.5 3.5h-4z',
  rocket: 'M3 11h11l4-2.5h1.5L22 12l-2.5 3.5H18L14 13H3zM3 9l3 2H3zM3 15l3-2H3z',
  missile: 'M2 11.2h14l3.5-1.2L22 12l-2.5 2-3.5-1.2H2zM5 8.5l3 2.7H5zM5 15.5l3-2.7H5zM13 9.5l2 1.7h-2zM13 14.5l2-1.7h-2z',
  autocannon: 'M2 10h9v4H2zM11 11h9v2h-9zM20 10.3h2v3.4h-2zM4 14h3v3H4z',
  roadkill: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 3.2a5.8 5.8 0 1 1 0 11.6 5.8 5.8 0 0 1 0-11.6zm0 3.3a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
  restricted: 'M3 9h18v6H3zM6 9l-3 6h3l3-6zM12 9l-3 6h3l3-6zM18 9l-3 6h3l3-6zM5 15h2v5H5zM17 15h2v5h-2z',
  // A figure dropping onto a ledge line (fall damage).
  fall: 'M13 2a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM9 7h6l2 4-1.6.8L14 9.6V13l2 4h-2.2L12 13.6 10.4 17H8.2l2-4V9.6l-1.4 2.2L7.2 11zM2 19h20v2H2zM19 4h2v7h2l-3 3-3-3h2z',
  // A burst over a ground line (hull crash).
  crash: 'M12 2l1.8 4.6 4.7-2-2 4.7L21 11l-4.5 1.8 2 4.7-4.7-2L12 20l-1.8-4.5-4.7 2 2-4.7L3 11l4.5-1.7-2-4.7 4.7 2zM2 21h20v2H2z',
  // Blocks tumbling from a broken slab onto a ground line (structural collapse, docs/structural-physics.md).
  collapse: 'M2 3h9v3H2zM13 3h9v3h-5l-1 2.2-2.2-.9zM11.5 9.5l3.6 1.4-1.4 3.6-3.6-1.4zM5 10h3.6v3.6H5zM16.4 13.6l3.1.8-.8 3.1-3.1-.8zM7.4 15.6h3.8v3.4H7.4zM2 20h20v2H2z',
  // Two chasing arrows round a figure (in-game menu RESPAWN / redeploy).
  redeploy: 'M12 3a9 9 0 0 1 8.3 5.5H23l-3.5 4-3.5-4h2.1A6.5 6.5 0 0 0 5.8 10.1L3.4 9.4A9 9 0 0 1 12 3zM12 21a9 9 0 0 1-8.3-5.5H1l3.5-4 3.5 4H5.9A6.5 6.5 0 0 0 18.2 13.9l2.4.7A9 9 0 0 1 12 21zM12 8.4a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 0 1 0-3.6zM9.4 15.8c0-1.6 1.2-2.8 2.6-2.8s2.6 1.2 2.6 2.8z',
  // Parachute canopy over a load (HUD prompt).
  chute: 'M12 3C6.5 3 2.5 6.6 2 11h20c-.5-4.4-4.5-8-10-8zM3 12l8 7v2h2v-2l8-7h-2.4L13 17.2V12h-2v5.2L5.4 12z',
  // Hulls (side profiles, facing right).
  jeep: 'M3 11l2-4h8l2 4h5a1 1 0 0 1 1 1v3h-2.2a2.5 2.5 0 0 0-4.6 0H9.8a2.5 2.5 0 0 0-4.6 0H3zM7 8.2L5.9 11H9V8.2zM10.5 8.2V11h3l-1.2-2.8zM7.5 14.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM16.5 14.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z',
  // AT jeep: the jeep with the TOW tube over the bed.
  jeep_at: 'M3 11l2-4h8l2 4h5a1 1 0 0 1 1 1v3h-2.2a2.5 2.5 0 0 0-4.6 0H9.8a2.5 2.5 0 0 0-4.6 0H3zM7 8.2L5.9 11H9V8.2zM10.5 8.2V11h3l-1.2-2.8zM7.5 14.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM16.5 14.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM8 3.6h11v2.2H8zM12.3 5.8h1.4V7h-1.4z',
  tank: 'M7 8h7l1 2h7v1.6h-7.2L14 13H6zM2 13h19l-2 4.5H4zM5 14.6a1 1 0 1 0 0 .1zM8.5 14.5h1v1h-1zM12 14.5h1v1h-1zM15.5 14.5h1v1h-1z',
  // Mobile AA: tracked hull, boxy turret, twin guns raised, the search radar on its mast.
  aa: 'M7 8h8v5H7zM2 13h19l-2 4.5H4zM5 14.6a1 1 0 1 0 0 .1zM8.5 14.5h1v1h-1zM12 14.5h1v1h-1zM15.5 14.5h1v1h-1zM14.6 8.4l6-4.6.9 1.1-6 4.6zM14.6 11l6-4.6.9 1.1-6 4.6zM6.6 3.4h4.8v1.6H6.6zM8.3 5h1.4v3H8.3z',
  helicopter: 'M2 5h20v1.4H2zM11.3 6.4h1.4v2H11.3zM6 9h10a4 4 0 0 1 0 8H9l-2-2H4l-2-3h4zM17 10.5h2.2a2.6 2.6 0 0 1 0 3.5H17zM8 17.5h9v1.3H8z',
  transport: 'M1 5h11v1.3H1zM12 5h11v1.3H12zM5.5 6.3h1.2v2H5.5zM17.3 6.3h1.2v2h-1.2zM3 8.5h16l3 3.5v3.5H5L2 12zM6 10h2.5v2H6zM10 10h2.5v2H10zM5 15.5h14v1.4H5z',
  plane: 'M2 11.2l4-.2 3-5h2.2l-1.4 5H17l2.5-3H21l-1 3.4L22 12l-2 .6 1 3.4h-1.5L17 13H9.8l1.4 5H9l-3-5-4-.2z',
  // Patrol boat: raised bow, gun on the foredeck, helm roof amidships, outboard at the stern, on a wave line.
  boat: 'M2 12h17.5v-2H21v2h1l-2.4 4H5.2zM5.5 9.8h3.2v2.2H5.5zM2.6 10.2h4v1H2.6zM10 7h5.2v1.2h-.8l.6 3.8H10zM11 8.2V10h2.8l-.3-1.8zM14 4.5h1v2.5h-1zM2 18.4c1.5 0 1.5-1 3-1s1.5 1 3 1 1.5-1 3-1 1.5 1 3 1 1.5-1 3-1 1.5 1 3 1 1.5-1 3-1v1.6c-1.5 0-1.5 1-3 1s-1.5-1-3-1-1.5 1-3 1-1.5-1-3-1-1.5 1-3 1-1.5-1-3-1-1.5 1-3 1z',
  // Kits.
  assault: 'M10.5 3h3v5h5v3h-5v10h-3V11h-5V8h5z',
  engineer: 'M14.5 3a4.5 4.5 0 0 0-4.3 5.9L3 16.1 5.9 19l7.2-7.2A4.5 4.5 0 0 0 19 6.5l-2.7 2.7-2.4-.6-.6-2.4L16 3.5a4.5 4.5 0 0 0-1.5-.5z',
  support: 'M4 7h16v12H4zM8 4h8v3h-2V6h-4v1H8zM11 9.5h2V12h2.5v2H13v2.5h-2V14H8.5v-2H11z',
  recon: 'M12 5C6.5 5 3 12 3 12s3.5 7 9 7 9-7 9-7-3.5-7-9-7zm0 2.8a4.2 4.2 0 1 1 0 8.4 4.2 4.2 0 0 1 0-8.4zm0 2.2a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  // Medic: the revive cross inside a rounded plate.
  medic: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm5 3.5v3.5H6.5v4H10v3.5h4V14h3.5v-4H14V6.5z',
  // Pyro: a twin-tongued flame.
  pyro: 'M12 2c1.2 3.2 4.6 5.4 5.6 9 1 3.7-1.2 8-5.6 9-4.6-.6-7-4.4-6.1-8 .5-2.1 1.8-3.4 2.9-4.6.1 1.7.7 3 1.9 3.6C10.3 7.8 11 4.6 12 2zm.3 10.2c-.9 1.3-2.3 2.4-2.3 4.2a2.3 2.3 0 0 0 4.6 0c0-1.6-1.2-2.6-2.3-4.2z',
  // Grenadier: a lobbed shell and the dots of its arc.
  grenadier: 'M10 8.5a5.5 5.5 0 1 1 11 0a5.5 5.5 0 1 1-11 0zM12.5 7a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0zM1.4 20a1.6 1.6 0 1 1 3.2 0a1.6 1.6 0 1 1-3.2 0zM3.6 15.6a1.6 1.6 0 1 1 3.2 0a1.6 1.6 0 1 1-3.2 0zM6.6 11.8a1.6 1.6 0 1 1 3.2 0a1.6 1.6 0 1 1-3.2 0z',
  // Raider: the RIPTIDE disc in flight (ring, hub, speed streaks).
  raider: 'M4 12a9 4.5 0 1 1 18 0a9 4.5 0 1 1-18 0zM9 12a4 2 0 1 0 8 0a4 2 0 1 0-8 0zM11.5 12a1.5 .8 0 1 1 3 0a1.5 .8 0 1 1-3 0zM0 8.6h4.6v1.6H0zM.8 13.8h3.4v1.6H.8z',
  // Marksman: a charged bolt.
  marksman: 'M14 2L5 13.5h5.5L9 22l10-12.5h-5.7z',
  // Padlock (locked deploy cards).
  padlock: 'M7 10V7.5a5 5 0 0 1 10 0V10h1.5a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1V11a1 1 0 0 1 1-1zm2.5 0h5V7.5a2.5 2.5 0 0 0-5 0zM11 14v4h2v-4z',
  // Markers.
  hq: 'M4 20V9l8-5 8 5v11h-5v-6H9v6z',
  squad: 'M12 3l2.6 5.6 6.1.6-4.6 4.1 1.3 6L12 16.2 6.6 19.3l1.3-6-4.6-4.1 6.1-.6z',
  revive: 'M9.5 3h5v6.5H21v5h-6.5V21h-5v-6.5H3v-5h6.5z',
  repair: 'M14.5 3a4.5 4.5 0 0 0-4.3 5.9L3 16.1 5.9 19l7.2-7.2A4.5 4.5 0 0 0 19 6.5l-2.7 2.7-2.4-.6-.6-2.4L16 3.5a4.5 4.5 0 0 0-1.5-.5z',
  lock: 'M12 2l2.5 5H20l-4.3 3.7L17.5 17 12 13.5 6.5 17l1.8-6.3L4 7h5.5z',
  flares: 'M12 2c2 4 5 6 5 10a5 5 0 0 1-10 0c0-2 1-3.5 2-4.5.3 1.8 1.2 2.8 2.2 3.2C10.8 8 11 5 12 2z',
  smoke: 'M7 18a4 4 0 0 1-.6-7.96A5.5 5.5 0 0 1 17 8.5a4.75 4.75 0 0 1 .5 9.5z',
  // Comm rose (docs/design/conquest/orders/): requests, callouts and squad orders.
  ammo: 'M3 8h18v12H3zM5 5h5v3H5zM14 5h5v3h-5zM6 12h12v2.2H6z',
  yes: 'M9 16.2 4.8 12l-1.9 1.9L9 20 21.1 7.9l-1.9-1.9z',
  no: 'M6.3 4.4 12 10.1l5.7-5.7 1.9 1.9-5.7 5.7 5.7 5.7-1.9 1.9-5.7-5.7-5.7 5.7-1.9-1.9 5.7-5.7-5.7-5.7z',
  attack: 'M3 3h3.5l9.8 9.8-2 2L4.5 5.1zM21 3h-3.5l-9.8 9.8 2 2 9.8-9.7zM5.6 14.3l4.1 4.1-1.5 1.5-1.1-1.1L4.5 21 3 19.5l2.2-2.6-1.1-1.1zM18.4 14.3l1.5 1.5-1.1 1.1 2.2 2.6-1.5 1.5-2.6-2.2-1.1 1.1-1.5-1.5z',
  defend: 'M12 2 20 5v6.2c0 5-3.4 9.3-8 10.8-4.6-1.5-8-5.8-8-10.8V5zm0 3.1-5 1.9v4.2c0 3.3 2 6.3 5 7.6z',
  comms: 'M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm3 5v2h2V9zm4 0v2h2V9zm4 0v2h2V9z',
  // Recon SPAWN BEACON: a case with a mast and two radio arcs each side (docs/design/conquest/recon).
  beacon: 'M8 15h8v6H8zM11.2 9.2h1.6V15h-1.6zM12 5.6a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2zM8.75 3.95A4.6 4.6 0 0 0 8.75 10.45L9.6 9.6A3.4 3.4 0 0 1 9.6 4.8zM7.33 2.53A6.6 6.6 0 0 0 7.33 11.87L8.18 11.02A5.4 5.4 0 0 1 8.18 3.38zM15.25 3.95A4.6 4.6 0 0 1 15.25 10.45L14.4 9.6A3.4 3.4 0 0 0 14.4 4.8zM16.67 2.53A6.6 6.6 0 0 1 16.67 11.87L15.82 11.02A5.4 5.4 0 0 0 15.82 3.38z',
  // Recon MOTION SENSOR: a puck with its lens.
  sensor: 'M12 7c4.4 0 8 1.6 8 3.5v3c0 1.9-3.6 3.5-8 3.5s-8-1.6-8-3.5v-3C4 8.6 7.6 7 12 7zm0 2c-3.3 0-5.6 .9-5.6 1.5S8.7 12 12 12s5.6-.9 5.6-1.5S15.3 9 12 9z',
  // Support mortar: the tube raised over its baseplate, the bipod leg forward.
  mortar: 'M6.2 15.6L15.6 3.4l2.3 1.8-9.4 12.2zM3 18.2h10.5v2.3H3zM13.6 9.6l1.3-.8 4.6 9.4h-1.6zM12.2 11.8h1.5l-.6 6.4h-1.4z',
  // Engineer FPV drone: the quad from above, four rotor discs on an X frame round the body.
  fpv: 'M9.5 9.5h5v5h-5zM5.6 7 7 5.6 18.4 17 17 18.4zM17 5.6 18.4 7 7 18.4 5.6 17zM6 2.8a3.2 3.2 0 1 1 0 6.4a3.2 3.2 0 1 1 0-6.4zM18 2.8a3.2 3.2 0 1 1 0 6.4a3.2 3.2 0 1 1 0-6.4zM6 14.8a3.2 3.2 0 1 1 0 6.4a3.2 3.2 0 1 1 0-6.4zM18 14.8a3.2 3.2 0 1 1 0 6.4a3.2 3.2 0 1 1 0-6.4z',
  // Ribbons and medals (ribbons.js): a reticle, a flag on its pole and a shield.
  target: 'M11 2h2v3.1A7 7 0 0 1 18.9 11H22v2h-3.1A7 7 0 0 1 13 18.9V22h-2v-3.1A7 7 0 0 1 5.1 13H2v-2h3.1A7 7 0 0 1 11 5.1zm1 5a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0 3a2 2 0 1 1 0 4 2 2 0 0 1 0-4z',
  flag: 'M5 2h2v20H5zM8 3h11l-3 4 3 4H8z',
  shield: 'M12 2l8 3v6c0 5-3.4 9.3-8 11-4.6-1.7-8-6-8-11V5zm0 4.2L7 8v3.2c0 3.2 2 6 5 7.4z',
  // Weather states (the HUD weather tab, docs/conquest.md *Weather*).
  'wx-golden': 'M12 7.5a4.5 4.5 0 1 1 0 9a4.5 4.5 0 1 1 0-9zM11 1.5h2V5h-2zM11 19h2v3.5h-2zM1.5 11H5v2H1.5zM19 11h3.5v2H19zM4.2 5.6l1.4-1.4 2.5 2.5-1.4 1.4zM15.9 17.3l1.4-1.4 2.5 2.5-1.4 1.4zM4.2 18.4l2.5-2.5 1.4 1.4-2.5 2.5zM15.9 6.7l2.5-2.5 1.4 1.4-2.5 2.5z',
  'wx-overcast': 'M7 18a4 4 0 0 1-.6-7.96A5.5 5.5 0 0 1 17 8.5a4.75 4.75 0 0 1 .5 9.5z',
  'wx-mist': 'M3 6h13v2H3zM6 10h15v2H6zM2 14h14v2H2zM8 18h12v2H8z',
  'wx-storm': 'M7 14a4 4 0 0 1-.6-7.96A5.5 5.5 0 0 1 17 4.5a4.75 4.75 0 0 1 .5 9.5h-2.6l1.1-2.4h-5.2L8.9 14zM11.4 12.6h4.1l-2 3.6h2.8L10 23l1.6-5.4H9z',

  // Map events (docs/conquest.md "Map events"): the hexagon event badge, a relay mast, a supply crate under its
  // canopy, flood waves and a demolition charge with its timer.
  event: 'M12 1.5l9.1 5.25v10.5L12 22.5l-9.1-5.25V6.75zM12 4.4L4.9 8.2v7.6l7.1 3.8 7.1-3.8V8.2zM10.8 7.5h2.4V14h-2.4zM10.8 15.3h2.4v2.4h-2.4z',
  'event-relay': 'M7.4 1.9A6.5 6.5 0 0 0 7.4 11.1L8.82 9.68A4.5 4.5 0 0 1 8.82 3.32zM16.6 1.9A6.5 6.5 0 0 1 16.6 11.1L15.18 9.68A4.5 4.5 0 0 0 15.18 3.32zM12 4.8a1.7 1.7 0 1 1 0 3.4a1.7 1.7 0 1 1 0-3.4zM11.2 8.6h1.6V22h-1.6zM7.4 22l3.8-8.6v3.4L9.2 22zM16.6 22l-3.8-8.6v3.4l2 5.2z',
  'event-crate': 'M4 8.2C4 4.8 7.6 2 12 2s8 2.8 8 6.2zM5 8.6h1.3l4.3 4.4H9.3zM19 8.6h-1.3l-4.3 4.4h1.3zM6 13h12v9H6zM8 15v5h8v-5z',
  flood: 'M2 5q2.5-2 5 0t5 0t5 0t5 0v2.6q-2.5-2-5 0t-5 0t-5 0t-5 0zM2 11q2.5-2 5 0t5 0t5 0t5 0v2.6q-2.5-2-5 0t-5 0t-5 0t-5 0zM2 17q2.5-2 5 0t5 0t5 0t5 0v2.6q-2.5-2-5 0t-5 0t-5 0t-5 0z',
  charge: 'M3 8h3.6v12H3zM7.2 8h3.6v12H7.2zM11.4 8H15v12h-3.6zM2.4 12h13.2v2H2.4zM16 10h5.5v6H16zM17.2 11.4v3.2h3.1v-3.2zM8.4 4.5h1.2V8H8.4z',
};
/** Glyph path data by name: the base set, `fire` (burning ground, as the Pyro flame) and the map events' own. */
export const ICON_PATHS = Object.freeze({ ...BASE_PATHS, fire: BASE_PATHS.pyro, ...MAP_EVENT_GLYPHS });

/** Kill-feed glyph per kill key; unknown keys return null (caller decides). */
export const KILL_KEY_ICONS = Object.freeze({
  tankAP: 'shell', tankHE: 'shell', coaxMG: 'mg', hmg: 'mg', doorMinigun: 'mg', planeCannon: 'autocannon',
  chinCannon: 'autocannon', helicopterRocket: 'rocket', aaMissile: 'missile', guidedMissile: 'missile', towMissile: 'missile', jetBomb: 'bomb', mortarHE: 'mortar', fpv: 'fpv', flak35: 'autocannon', vehicle: 'roadkill', restricted: 'restricted',
  fall: 'fall', crash: 'crash', redeploy: 'redeploy', collapse: 'collapse',
  // Titanfall kill keys (docs/titanfall.md §2.3) on existing glyphs; WP5 may add titan glyphs later.
  splitter: 'mg', predatorClose: 'mg', predatorLong: 'mg', railgun: 'autocannon', t203: 'shell', leadwall: 'shell',
  titanfall: 'crash', titanMelee: 'crash', titan_doom: 'crash', titan_crush: 'roadkill', rodeo: 'crash',
  electricSmoke: 'rocket', laserShot: 'rocket', laserCore: 'rocket', tripwire: 'rocket', thermalShield: 'rocket',
  incendiaryTrap: 'rocket', firewall: 'rocket', flameCore: 'rocket', tether: 'rocket', cluster: 'rocket',
  flightCore: 'rocket', arcWave: 'rocket', powerShot: 'rocket', thermite: 'rocket',
  // Map event hazards (shared/map-events/<id>.js killKeys): each definition names its glyph.
  ...Object.fromEntries(Object.entries(MAP_EVENT_KILL_KEYS).map(([key, meta]) => [key, meta.icon])),
});

/** A fresh inline SVG element for one glyph (DOM only). */
export function svgIcon(documentRef, name, className = 'vb-cq-icon') {
  const d = ICON_PATHS[name];
  if (!d || !documentRef?.createElementNS) return null;
  const svg = documentRef.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = documentRef.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', 'currentColor');
  svg.appendChild(path);
  return svg;
}

const pathCache = new Map();
/** Canvas Path2D for a glyph (browser only); cached per name. */
export function iconPath2D(name) {
  if (typeof Path2D !== 'function' || !ICON_PATHS[name]) return null;
  let path = pathCache.get(name);
  if (!path) { path = new Path2D(ICON_PATHS[name]); pathCache.set(name, path); }
  return path;
}

/** Draw a glyph centred at (x, y) with the given pixel size on a 2D context. */
export function drawIcon(context, name, x, y, size, fill) {
  const path = iconPath2D(name);
  if (!path || !context) return false;
  context.save();
  context.translate(x - size / 2, y - size / 2);
  context.scale(size / 24, size / 24);
  context.fillStyle = fill;
  context.fill(path);
  context.restore();
  return true;
}
