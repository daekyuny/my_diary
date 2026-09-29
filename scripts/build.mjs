import { bundle } from './bundle.mjs';
import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { makeIcons } from './icons.mjs';
await makeIcons();
await rm('dist', { recursive: true, force: true });
await mkdir('dist/vendor', { recursive: true });
await bundle('dist/vendor');
for (const path of [
  'index.html',
  'src/journal/styles.css',
  'assets',
  'manifest.webmanifest',
  'config.json',
])
  await cp(path, `dist/${path}`, { recursive: true });
let config;
try {
  config = JSON.parse(await readFile('config.local.json', 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (config)
  await writeFile(
    'dist/config.json',
    JSON.stringify(
      {
        googleClientId: config.googleClientId || '',
        authServer: Boolean(config.authServer),
      },
      null,
      2,
    ),
  );
const hash = createHash('sha256');
for (const file of [
  'index.html',
  'src/journal/styles.css',
  'dist/vendor/journal-app.js',
  'sw.js',
  'manifest.webmanifest',
  'assets/icon.svg',
  'assets/icon-192.png',
  'assets/icon-512.png',
])
  hash.update(await readFile(file));
hash.update(await readFile('dist/config.json'));
const version = hash.digest('hex').slice(0, 12);
await writeFile('dist/version.json', JSON.stringify({ version }));
await writeFile(
  'dist/index.html',
  (await readFile('dist/index.html', 'utf8')).replace('__DIARY_BUILD__', version),
);
const sw = (await readFile('sw.js', 'utf8')).replace(
  'my-diary-shell-v1',
  `my-diary-shell-${version}`,
);
await writeFile('dist/sw.js', sw);
console.log('Built dist/ for Firebase Hosting or any static HTTPS host. No secrets are copied.');
