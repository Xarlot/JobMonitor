// Fails fast when the active Node is too old to install/run Electron.
//
// Electron's installer pulls in @electron/get, which is ESM-only, and Electron's
// CommonJS install.js `require()`s it. `require()` of an ES module is only allowed
// on Node >= 22.12 (and the 20.19+ backport). On older Node it throws
// ERR_REQUIRE_ESM and the Electron binary never downloads. The repo pins Node 24
// in .nvmrc, so steer toward that.

const MIN_MAJOR = 22;
const MIN_MINOR = 12;

const [major, minor] = process.versions.node.split('.').map(Number);
const ok = major > MIN_MAJOR || (major === MIN_MAJOR && minor >= MIN_MINOR);

if (!ok) {
  console.error(
    `\n✖ Job Monitor needs Node >= ${MIN_MAJOR}.${MIN_MINOR} (you are on ${process.versions.node}).` +
      `\n  Electron's installer can't load its ESM dependency on older Node (ERR_REQUIRE_ESM).` +
      `\n  This repo pins Node 24 in .nvmrc. With nvm:\n` +
      `\n      nvm install 24 && nvm use\n` +
      `\n  (a plain \`nvm use\` reads .nvmrc), then re-run the command.\n`,
  );
  process.exit(1);
}
