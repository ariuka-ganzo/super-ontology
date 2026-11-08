import { app } from 'electron';
import { join } from 'node:path';

/** Folder with DuckDB's database connectors for this platform (see scripts/fetch-duckdb-extensions.mjs). */
export function extensionsDir(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'duckdb-extensions');
  const os = { win32: 'win', darwin: 'mac', linux: 'linux' }[process.platform as string] ?? process.platform;
  return join(app.getAppPath(), 'build', 'duckdb-extensions', `${os}-${process.arch}`);
}

/** Folder with the bundled sample data and starter project. */
export function samplesDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'samples') : join(app.getAppPath(), 'samples');
}
