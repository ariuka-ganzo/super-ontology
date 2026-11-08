import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadProject, saveProject, toAbsolutePath, toStoredPath } from '../../src/main/project/project';
import { FORMAT_VERSION, type Project } from '@shared/types';

function sample(dataPath: string): Project {
  return {
    formatVersion: FORMAT_VERSION,
    name: 'Test',
    model: {
      tables: [
        { id: 't1', name: 'Sales', source: { path: dataPath, format: 'csv' }, rowCount: 2, columns: [{ name: 'a', sourceType: 'BIGINT', type: 'integer' }] }
      ],
      relationships: [],
      calcs: [{ id: 'c1', name: 'Double', formula: '[a] * 2' }]
    },
    worksheets: [
      {
        id: 'w1',
        name: 'Sheet 1',
        spec: {
          chartType: 'bar',
          columns: [],
          rows: [{ id: 'i1', field: { kind: 'column', table: 't1', column: 'a' }, role: 'measure', agg: 'SUM' }],
          tooltip: [],
          filters: []
        }
      }
    ],
    dashboards: [
      {
        id: 'd1',
        name: 'Dash',
        pages: [{ id: 'p1', name: 'Page 1', tiles: [{ id: 'x', kind: 'worksheet', worksheetId: 'w1', layout: { x: 0, y: 0, w: 6, h: 4 } }] }]
      }
    ]
  };
}

describe('project files', () => {
  it('saves pretty-printed JSON with relative paths and loads it back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ontology-proj-'));
    const file = join(dir, 'p.ontology');
    const data = join(dir, 'data', 'sales.csv');
    await saveProject(sample(data), file);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('\n  "formatVersion": 2,');
    expect(JSON.parse(text).model.tables[0].source.path).toBe('data/sales.csv');
    const loaded = await loadProject(file);
    expect(loaded.model.tables[0].source.path).toBe(data);
    expect(loaded.worksheets[0].spec.rows[0].agg).toBe('SUM');
    // No temporary files left behind.
    expect(readdirSync(dir).filter((f) => f.endsWith('.ontology-tmp'))).toEqual([]);
  });

  it('refuses newer format versions and never overwrites them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ontology-proj-'));
    const file = join(dir, 'future.ontology');
    const future = JSON.stringify({ formatVersion: FORMAT_VERSION + 1, something: 'new' });
    writeFileSync(file, future);
    await expect(loadProject(file)).rejects.toMatchObject({ code: 'newer' });
    await expect(saveProject(sample(join(dir, 'x.csv')), file)).rejects.toMatchObject({ code: 'newer' });
    expect(readFileSync(file, 'utf8')).toBe(future);
  });

  it('rejects files that are not valid projects', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ontology-proj-'));
    writeFileSync(join(dir, 'a.ontology'), 'not json');
    await expect(loadProject(join(dir, 'a.ontology'))).rejects.toThrow(/not JSON/);
    writeFileSync(join(dir, 'b.ontology'), JSON.stringify({ formatVersion: 1, name: 'x' }));
    await expect(loadProject(join(dir, 'b.ontology'))).rejects.toThrow(/not a valid Super Ontology project/);
  });

  it('keeps paths absolute when they cannot be made relative', () => {
    if (process.platform === 'win32') {
      expect(toStoredPath('C:\\p\\x.ontology', 'D:\\data\\a.csv')).toBe('D:\\data\\a.csv');
    }
    expect(toAbsolutePath('/p/x.ontology', '/abs/a.csv')).toBe('/abs/a.csv');
    expect(toStoredPath(join(tmpdir(), 'x.ontology'), join(tmpdir(), 'a', 'b.csv'))).toBe('a/b.csv');
  });
});
