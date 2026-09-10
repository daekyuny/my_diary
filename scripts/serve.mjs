import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { bundle } from './bundle.mjs';
import { makeIcons } from './icons.mjs';
const root = path.resolve(process.argv[2] || '.');
if (root === process.cwd()) {
  await makeIcons();
  await bundle();
}
const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    const allowed =
      pathname === '/' ||
      /^\/(index\.html|legacy\.html|sw\.js|config\.json|manifest\.webmanifest)$/.test(pathname) ||
      /^\/(src|assets)\/[\w./-]+$/.test(pathname) ||
      ['/vendor/fflate.js', '/vendor/journal-app.js'].includes(pathname);
    if (!allowed || pathname.split('/').some((part) => part.startsWith('.'))) {
      response.writeHead(404);
      response.end('Not found');
      return;
    }
    let file = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!file.startsWith(`${root}${path.sep}`)) throw new Error('Invalid path');
    if (pathname === '/vendor/fflate.js' && root === process.cwd())
      file = path.resolve('node_modules/fflate/esm/browser.js');
    if (pathname === '/config.json' && root === process.cwd()) {
      try {
        const config = JSON.parse(await readFile('config.local.json', 'utf8'));
        response.setHeader('Content-Type', 'application/json');
        response.end(
          JSON.stringify({
            googleClientId: config.googleClientId || '',
            notificationServer: config.notificationServer || '',
          }),
        );
        return;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    if (pathname === '/vendor/journal-app.js' && root === process.cwd()) await bundle();
    if (!(await stat(file)).isFile()) throw new Error('Not a file');
    response.writeHead(200, {
      'Content-Type': mime[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(await readFile(file));
  } catch {
    response.writeHead(404);
    response.end('Not found');
  }
});
const port = Number(process.env.PORT || 4173);
server.listen(port, process.env.HOST || '127.0.0.1', () =>
  console.log(`My Diary: http://localhost:${port}`),
);
