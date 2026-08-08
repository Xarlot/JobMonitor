/**
 * Resolving an `app://` request to a file in the bundled `dist`.
 *
 * Split out of main.cjs so it can be tested without Electron: this is the desktop app's
 * entire static file server, and the failure it guards against is silent. Every JS chunk
 * the build emits is fetched through here, so a change to how the bundle is split — new
 * chunk names, a new asset type — reaches the desktop app only along this path. Get it
 * wrong and the SPA fallback answers with `index.html` and a `text/html` content type,
 * which the browser refuses to execute as a module: a blank window and one console line.
 */

const fs = require('node:fs');
const path = require('node:path');

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json',
};

/**
 * What to serve for one `app://` pathname.
 *
 * Returns `{ status: 403 }` for a traversal attempt, or
 * `{ status: 200, filePath, contentType, fallback }` — where `fallback` marks the
 * SPA-fallback case, i.e. the request named nothing that exists. A caller cannot tell that
 * from the file path alone, and for anything but a navigation it means something is wrong.
 *
 * @param {string} pathname decoded URL pathname, e.g. `/assets/index-abc123.js`
 * @param {string} dist absolute path of the bundled dist directory
 */
function resolveAppAsset(pathname, dist) {
  let requested = pathname === '/' || pathname === '' ? '/index.html' : pathname;

  let filePath = path.normalize(path.join(dist, requested));
  // Block path traversal outside the bundled dist.
  if (filePath !== dist && !filePath.startsWith(dist + path.sep)) {
    return { status: 403 };
  }

  let fallback = false;
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    filePath = path.join(dist, 'index.html'); // SPA fallback
    fallback = true;
  }

  const ext = path.extname(filePath).toLowerCase();
  return {
    status: 200,
    filePath,
    contentType: MIME[ext] || 'application/octet-stream',
    fallback,
  };
}

module.exports = { resolveAppAsset, MIME };
