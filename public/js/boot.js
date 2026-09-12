import { loadingScreen } from './ui/loading-screen.js';

loadingScreen?.show('boot', { status: 'Loading game systems…' });
try {
  await import('./main.js');
  loadingScreen?.hide();
} catch (error) {
  console.error('[vb] startup failed:', error);
  loadingScreen?.fail('The game could not start. Check your connection and reload.');
}
