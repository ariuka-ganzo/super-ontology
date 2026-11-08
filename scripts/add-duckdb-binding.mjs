// Adds DuckDB's native binding for another CPU architecture to node_modules, so electron-builder
// can package that architecture too. npm only installs the binding for the machine it runs on;
// an Apple silicon build machine needs this to also build the Intel (x64) app.
//
// Usage: node scripts/add-duckdb-binding.mjs darwin-x64
//
// The version and the sha512 checksum come from package-lock.json, and the downloaded package
// is rejected if its checksum does not match.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const target = process.argv[2];
if (!/^(darwin|linux|win32)-(x64|arm64)$/.test(target ?? '')) {
  console.error('Usage: node scripts/add-duckdb-binding.mjs <platform-arch>, for example darwin-x64');
  process.exit(1);
}

const name = `@duckdb/node-bindings-${target}`;
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const entry = lock.packages[`node_modules/${name}`];
if (!entry?.version || !entry.integrity?.startsWith('sha512-')) {
  console.error(`${name} with a sha512 checksum is not in package-lock.json`);
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), 'duckdb-binding-'));
try {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const file = execFileSync(npm, ['pack', `${name}@${entry.version}`, '--silent', '--pack-destination', work], {
    encoding: 'utf8',
    shell: process.platform === 'win32'
  })
    .trim()
    .split('\n')
    .pop();
  const tgz = join(work, file);
  const actual = 'sha512-' + createHash('sha512').update(readFileSync(tgz)).digest('base64');
  if (actual !== entry.integrity) {
    console.error(`Checksum mismatch for ${name}@${entry.version}\n  expected ${entry.integrity}\n  got      ${actual}`);
    process.exit(1);
  }
  const dest = join('node_modules', name);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  execFileSync('tar', ['-xzf', tgz, '-C', dest, '--strip-components=1']);
  console.log(`Added ${name}@${entry.version} (checksum verified)`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
