// The large Conquest battlefields (768 x 80 x 768, airspace apron, lazy
// templates, far terrain and the distant voxel shell): Frontier, the default,
// and Redrock Canyon (docs/maps/redrock.md). Dependency-free, so the client,
// the server and the tests can branch on it without building any terrain.

export const BATTLEFIELD_MAP_IDS = Object.freeze(['frontier', 'redrock']);

/** True for a map built like Frontier (lazy 768 m template, airspace, far terrain). */
export const isBattlefieldMap = mapId => BATTLEFIELD_MAP_IDS.includes(mapId);

/** Display names and the lobby hint's one-line identity. */
export const BATTLEFIELD_INFO = Object.freeze({
  frontier: Object.freeze({ name: 'Frontier', tagline: 'river valley · iron bridge · woods and farms' }),
  redrock: Object.freeze({ name: 'Redrock Canyon', tagline: 'desert canyon · dam crossing · mesas and rail' }),
});
