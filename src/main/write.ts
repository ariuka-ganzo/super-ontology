import { createWriteStream } from 'node:fs';
import { once } from 'node:events';

/**
 * Writes text chunks to a file with backpressure. Every stream error, including failing to open the
 * file (for example because another program has it locked), rejects the returned promise. A write
 * stream without an 'error' listener would instead crash the main process.
 */
export async function writeChunks(path: string, chunks: Iterable<string> | AsyncIterable<string>): Promise<void> {
  const out = createWriteStream(path, { encoding: 'utf8' });
  let failed: Error | undefined;
  out.on('error', (e) => {
    failed ??= e;
  });
  try {
    await once(out, 'open');
    for await (const chunk of chunks) {
      if (failed) throw failed;
      if (!out.write(chunk)) await once(out, 'drain');
    }
    if (failed) throw failed;
    out.end();
    await once(out, 'finish');
    if (failed) throw failed;
  } catch (e) {
    out.destroy();
    throw failed ?? e;
  }
}
