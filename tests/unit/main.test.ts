import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PendingOpen, projectFromArgv } from '../../src/main/open-file';
import { writeChunks } from '../../src/main/write';
import { compactParams } from '@shared/compiler/sql';

describe('writeChunks', () => {
  it('writes sync and async chunks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'facet-write-'));
    await writeChunks(join(dir, 'a.txt'), ['a', 'b']);
    async function* gen(): AsyncGenerator<string> {
      yield 'x'.repeat(100_000);
      yield 'y';
    }
    await writeChunks(join(dir, 'b.txt'), gen());
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('ab');
    expect(readFileSync(join(dir, 'b.txt'), 'utf8')).toHaveLength(100_001);
  });

  it('rejects instead of crashing when the file cannot be opened', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'facet-write-'));
    // A directory cannot be opened for writing, much like a file locked by another program.
    await expect(writeChunks(dir, ['a'])).rejects.toMatchObject({ code: expect.stringMatching(/^E/) });
    await expect(writeChunks(join(dir, 'missing', 'x.csv'), ['a'])).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects when the source of chunks fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'facet-write-'));
    async function* bad(): AsyncGenerator<string> {
      yield 'a';
      throw new Error('query failed');
    }
    await expect(writeChunks(join(dir, 'c.txt'), bad())).rejects.toThrow('query failed');
  });
});

describe('opening project files from the OS', () => {
  it('finds a .facet argument and resolves it against the working directory', () => {
    const cwd = resolve('/work');
    expect(projectFromArgv(['app.exe', '--flag', 'Sales.FACET'], cwd)).toBe(resolve(cwd, 'Sales.FACET'));
    expect(projectFromArgv(['app.exe', '.', '--smoke-test'], cwd)).toBeNull();
    expect(projectFromArgv(['app.exe'], cwd)).toBeNull();
  });

  it('holds paths until the renderer is ready, then delivers them directly', () => {
    const delivered: string[] = [];
    let canDeliver = true;
    const p = new PendingOpen((path) => {
      if (!canDeliver) return false;
      delivered.push(path);
      return true;
    });
    p.request('/a.facet');
    expect(delivered).toEqual([]);
    expect(p.take()).toBe('/a.facet');
    expect(p.take()).toBeNull();
    p.request('/b.facet');
    expect(delivered).toEqual(['/b.facet']);
    canDeliver = false;
    p.request('/c.facet');
    p.reset();
    expect(p.take()).toBe('/c.facet');
  });
});

describe('compactParams', () => {
  it('drops unused values and renumbers, leaving quoted identifiers alone', () => {
    const sql = 'SELECT CAST($3 AS INTEGER), "CAST($1 AS x)", CAST($3 AS INTEGER) + CAST($5 AS DOUBLE)';
    expect(compactParams(sql, ['a', 'b', 30, 'd', 5.5])).toEqual({
      sql: 'SELECT CAST($1 AS INTEGER), "CAST($1 AS x)", CAST($1 AS INTEGER) + CAST($2 AS DOUBLE)',
      params: [30, 5.5]
    });
  });
});
