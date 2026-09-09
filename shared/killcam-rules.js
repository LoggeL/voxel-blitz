export const KILLCAM = Object.freeze({ historyMs: 3000, respawnMs: 3800, maxFrames: 100 });
export function supportsKillcam(mode) {
  return ['fun', 'duel', 'chaos', 'tdm', 'gungame'].includes(mode);
}
