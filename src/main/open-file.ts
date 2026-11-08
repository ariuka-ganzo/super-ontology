import { resolve } from 'node:path';

/**
 * Finds a project file among command-line arguments. Windows and Linux pass the file the user
 * double-clicked as an argument, both on first launch and to `second-instance`. Flags are skipped.
 */
export function projectFromArgv(argv: readonly string[], cwd: string): string | null {
  for (const a of argv.slice(1)) {
    if (a.startsWith('-') || !a.toLowerCase().endsWith('.ontology')) continue;
    return resolve(cwd, a);
  }
  return null;
}

/**
 * Holds a project path until the renderer can open it. A path that arrives before the renderer
 * has asked for startup info waits here; after that it is delivered straight away.
 */
export class PendingOpen {
  private path: string | null = null;
  private ready = false;

  constructor(private readonly deliver: (path: string) => boolean) {}

  /** A file was opened from the OS (argv, second instance, or macOS open-file). */
  request(path: string): void {
    if (this.ready && this.deliver(path)) return;
    this.path = path;
  }

  /** The renderer asked for startup info: hand over any waiting path. */
  take(): string | null {
    this.ready = true;
    const p = this.path;
    this.path = null;
    return p;
  }

  /** A new window is loading, so paths must wait for its renderer again. */
  reset(): void {
    this.ready = false;
  }
}
