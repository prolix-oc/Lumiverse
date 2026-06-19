// Workaround for npm optional-dependency bug (https://github.com/npm/cli/issues/4828).
// On Termux (Android), npm silently skips platform-specific native bindings.
// This script detects the platform after install and fetches any missing ones.

const { execSync } = require('child_process');
const { readFileSync } = require('fs');
const { resolve } = require('path');

const PLATFORM_BINDINGS = {
  'android-arm64': [
    '@rolldown/binding-android-arm64',
    'lightningcss-android-arm64',
  ],
};

const key = `${process.platform}-${process.arch}`;
const bindings = PLATFORM_BINDINGS[key];
if (!bindings) process.exit(0);

const root = resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8'));
const versions = pkg.optionalDependencies || {};

let installed = 0;
for (const name of bindings) {
  try {
    require.resolve(name, { paths: [root] });
    continue;
  } catch {}

  const version = versions[name];
  if (!version) {
    console.warn(`[postinstall] No version pinned for ${name} in optionalDependencies, skipping`);
    continue;
  }

  const spec = `${name}@${version}`;
  console.log(`[postinstall] npm optional-dep bug workaround — installing ${spec}`);
  try {
    execSync(`npm install --no-save ${spec}`, {
      cwd: root,
      stdio: 'inherit',
      timeout: 120000,
    });
    installed++;
  } catch (err) {
    console.error(`[postinstall] Failed to install ${spec}:`, err.message);
  }
}

if (installed > 0) {
  console.log(`[postinstall] Installed ${installed} missing platform binding(s)`);
}
