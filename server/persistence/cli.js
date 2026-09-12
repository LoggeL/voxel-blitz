import { PostgresStore } from './postgres.js';
import { importLegacyDirectory } from './import-json.js';

const command = process.argv[2];
let store;
try {
  if (!['migrate', 'import-json'].includes(command)) throw new Error('Usage: node server/persistence/cli.js migrate | import-json [directory]');
  store = await PostgresStore.open();
  if (command === 'import-json') {
    const result = await importLegacyDirectory(store, process.argv[3] || process.env.VB_DATA_DIR || './data');
    console.log(`JSON import complete: ${result.imported} imported, ${result.skipped} unchanged; source files preserved.`);
  } else console.log('PostgreSQL schema is current.');
} catch (error) {
  console.error(`[persistence] ${error.code ? `Database/file operation failed (${error.code})` : error.message}`);
  process.exitCode = 1;
} finally { await store?.close(); }
