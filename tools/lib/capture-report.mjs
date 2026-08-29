import { writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Write the shared image-grid report and machine-readable manifest for a capture flow. */
export async function writeCaptureReport({
  outDir,
  title,
  rows,
  primaryKey,
  secondaryKey,
}) {
  const cards = rows.map((row) => `
    <figure>
      <img src="./${row.file}" alt="${row[primaryKey]} ${row[secondaryKey]}">
      <figcaption><strong>${row[primaryKey]}</strong><span>${row[secondaryKey]}</span><small>${row.bytes} bytes</small></figcaption>
    </figure>`).join('');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${title}</title><style>
body{margin:0;padding:24px;background:#111923;color:#e8f0f8;font:14px system-ui,sans-serif}
h1{margin:0 0 20px;font-size:22px}.grid{display:grid;grid-template-columns:repeat(3,minmax(260px,1fr));gap:16px}
figure{margin:0;background:#1b2733;border:1px solid #34495b;border-radius:8px;overflow:hidden}
img{display:block;width:100%;height:auto}figcaption{display:flex;gap:10px;align-items:baseline;padding:10px 12px;text-transform:uppercase}
figcaption span{color:#ff9f32}small{margin-left:auto;color:#8496a7;text-transform:none}@media(max-width:900px){.grid{grid-template-columns:1fr}}
</style></head><body><h1>${title}</h1><main class="grid">${cards}
</main></body></html>`;
  const reportPath = path.join(outDir, 'index.html');
  await Promise.all([
    writeFile(reportPath, html),
    writeFile(path.join(outDir, 'manifest.json'), `${JSON.stringify(rows, null, 2)}\n`),
  ]);
  return reportPath;
}
