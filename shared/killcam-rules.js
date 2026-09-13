export const KILLCAM = Object.freeze({ historyMs: 3000, postKillMs: 1000, respawnMs: 4800, maxFrames: 100 });
export function supportsKillcam(mode) {
  return ['fun', 'duel', 'chaos', 'tdm', 'gungame'].includes(mode);
}
