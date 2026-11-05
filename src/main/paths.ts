import { app } from 'electron';
import { join } from 'node:path';

/** Folder with the bundled sample data and starter project. */
export function samplesDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'samples') : join(app.getAppPath(), 'samples');
}
