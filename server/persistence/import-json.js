import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { validateAccountRecord } from '../accounts.js';
import { validateProfile } from './career-profile.js';

/** Parse the entire source before touching any account data. The source is
 * read-only, and a changed previously imported file is an explicit conflict. */
export async function readLegacyDirectory(directory) {
  directory = await realpath(directory);
  const files = [];
  async function scan(folder, pattern, kind) {
    const location = path.join(directory, folder);
    try {
      if (!(await lstat(location)).isDirectory()) throw new Error(`Invalid legacy directory: ${folder || '.'}`);
    } catch (error) { if (error.code === 'ENOENT' && folder) return; throw error; }
    for (const name of (await readdir(location)).sort()) {
      if (!name.endsWith('.json')) continue;
      const relative = folder ? `${folder}/${name}` : name;
      if (!pattern.test(name)) throw new Error(`Unexpected legacy JSON filename: ${relative}`);
      const file = path.join(location, name), info = await lstat(file);
      if (!info.isFile() || info.size > (kind === 'account' ? 65536 : 16384)) throw new Error(`Invalid legacy file: ${relative}`);
      const bytes = await readFile(file);
      let value;
      try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new Error(`Invalid JSON file: ${relative}`); }
      const entry = { path: relative, checksum: createHash('sha256').update(bytes).digest('hex'), kind, value };
      if (kind === 'account') validateAccountRecord(value, name);
      else if (kind === 'claim') {
        if (!/^account:[a-f0-9]{32}$/.test(value?.account || '')) throw new Error(`Invalid transfer identity: ${relative}`);
        entry.guest = name.slice(0, -5);
        entry.value = { account: value.account, profile: validateProfile(value.profile) };
      } else {
        entry.id = kind === 'account-career' ? `account:${name.slice(0, -5)}` : name.slice(0, -5);
        entry.value = validateProfile(value);
      }
      files.push(entry);
    }
  }
  await scan('accounts', /^[a-z0-9_-]{3,20}\.json$/, 'account');
  await scan('', /^[a-f0-9]{64}\.json$/, 'guest-career');
  await scan('account-careers', /^[a-f0-9]{32}\.json$/, 'account-career');
  await scan('career-claims', /^[a-f0-9]{64}\.json$/, 'claim');
  return files;
}

export async function importLegacyDirectory(store, directory) {
  const files = await readLegacyDirectory(directory);
  return store.transaction(async client => {
    let imported = 0, skipped = 0;
    for (const file of files) {
      const previous = await client.query('SELECT checksum FROM vb_json_imports WHERE source_path=$1', [file.path]);
      if (previous.rowCount) {
        if (previous.rows[0].checksum !== file.checksum) throw new Error(`Previously imported source changed: ${file.path}`);
        skipped++;
        continue;
      }
      if (file.kind === 'account') await store.writeAccount(client, file.value, true);
      else if (file.kind === 'claim') {
        await client.query('INSERT INTO vb_career_claims(guest_id, account_id, profile) VALUES ($1,$2,$3)',
          [file.guest, file.value.account.slice(8), JSON.stringify(file.value.profile)]);
        // A published legacy claim may precede its first profile write.
        const profile = await client.query('SELECT id FROM vb_careers WHERE id=$1', [file.value.account]);
        if (!profile.rowCount) await store.writeProfile(client, file.value.account, file.value.profile);
      } else {
        const profile = await client.query('SELECT id FROM vb_careers WHERE id=$1', [file.id]);
        if (profile.rowCount) throw new Error(`Import would overwrite an existing career: ${file.path}`);
        await store.writeProfile(client, file.id, file.value);
      }
      await client.query('INSERT INTO vb_json_imports(source_path, checksum) VALUES ($1,$2)', [file.path, file.checksum]);
      imported++;
    }
    return { imported, skipped };
  });
}
