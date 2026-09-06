import { sfx as SFX } from '../audio/sfx.js';
import { BUILTIN_SAMPLE_MANIFEST } from '../audio/samples.js';

const status = document.getElementById('status');
let loading;
for (const button of document.querySelectorAll('button[data-weapon]')) {
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      if (!await SFX.unlock()) throw new Error('Audio konnte nicht gestartet werden.');
      loading ||= SFX.loadSamples(BUILTIN_SAMPLE_MANIFEST);
      const result = await loading;
      if (result.failed) {
        loading = null;
        throw new Error(`${result.failed} Audiodateien konnten nicht geladen werden.`);
      }
      for (const audio of document.querySelectorAll('audio')) audio.pause();
      SFX.fire(button.dataset.weapon, { charge: Number(button.dataset.charge) });
      status.textContent = `${button.closest('section').querySelector('h2').textContent}: ${button.textContent}`;
    } catch (error) {
      status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
}
