// Downloads DuckDB's official database connectors (SQLite, PostgreSQL, MySQL) for packaging.
// The app never downloads extensions itself: they ship inside the installer, and DuckDB checks
// their signatures when they are loaded, so a tampered file is refused.
//
// Usage: node scripts/fetch-duckdb-extensions.mjs [target ...]
//   target: win-x64, mac-arm64, mac-x64 or linux-x64 (electron-builder's ${os}-${arch}).
//   With no target, fetches for this machine.
// Files go to build/duckdb-extensions/<target>/, which electron-builder copies into the app.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

export const EXTENSIONS = ['sqlite_scanner', 'postgres_scanner', 'mysql_scanner'];

const PLATFORMS = {
  'win-x64': 'windows_amd64',
  'mac-arm64': 'osx_arm64',
  'mac-x64': 'osx_amd64',
  'linux-x64': 'linux_amd64'
};

function currentTarget() {
  const os = { win32: 'win', darwin: 'mac', linux: 'linux' }[process.platform];
  return `${os}-${process.arch}`;
}

// The extension build must match the DuckDB library exactly, so take the version from the installed binding.
const binding = JSON.parse(readFileSync('node_modules/@duckdb/node-bindings/package.json', 'utf8'));
const version = `v${binding.version.replace(/-.*$/, '')}`;

const targets = process.argv.slice(2).length ? process.argv.slice(2) : [currentTarget()];
for (const target of targets) {
  const platform = PLATFORMS[target];
  if (!platform) {
    console.error(`Unknown target ${target}. Use one of: ${Object.keys(PLATFORMS).join(', ')}`);
    process.exit(1);
  }
  const dir = join('build', 'duckdb-extensions', target);
  mkdirSync(dir, { recursive: true });
  for (const name of EXTENSIONS) {
    const url = `https://extensions.duckdb.org/${version}/${platform}/${name}.duckdb_extension.gz`;
    const r = await fetch(url);
    if (!r.ok) {
      console.error(`Could not download ${url}: HTTP ${r.status}`);
      process.exit(1);
    }
    const file = join(dir, `${name}.duckdb_extension`);
    writeFileSync(`${file}.part`, gunzipSync(Buffer.from(await r.arrayBuffer())));
    renameSync(`${file}.part`, file);
    console.log(`${target}: ${name} ${version}`);
  }
}
