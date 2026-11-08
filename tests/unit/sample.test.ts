import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Engine } from '../../src/main/engine/engine';
import { loadProject } from '../../src/main/project/project';
import { calcInfo } from '@shared/formula/check';
import type { Project } from '@shared/types';

let engine: Engine;
let project: Project;

beforeAll(async () => {
  engine = await Engine.create();
  project = await loadProject(join(__dirname, '..', '..', 'samples', 'sample.ontology'));
  for (const t of project.model.tables) {
    const r = await engine.importTable(t.id, t.source);
    // The column definitions written by the generator match what the engine imports.
    expect(r.columns).toEqual(t.columns);
    expect(r.rowCount).toBe(t.rowCount);
  }
});

afterAll(() => engine.close());

describe('bundled sample project', () => {
  it('has valid calculations', () => {
    for (const c of project.model.calcs) expect(calcInfo(project.model, c.id), c.name).toMatchObject({ ok: true });
  });

  it('runs every worksheet without errors or warnings', async () => {
    for (const ws of project.worksheets) {
      const r = await engine.query({ requestId: ws.id, model: project.model, spec: ws.spec });
      expect(r.rows.length, ws.name).toBeGreaterThan(0);
      expect(r.warnings, ws.name).toEqual([]);
      expect(r.truncated, ws.name).toBe(false);
    }
  });

  it('dashboard tiles reference existing worksheets', () => {
    const ids = new Set(project.worksheets.map((w) => w.id));
    for (const d of project.dashboards) for (const p of d.pages) for (const t of p.tiles) if (t.kind === 'worksheet') expect(ids.has(t.worksheetId)).toBe(true);
  });

  it('the top 10 table has exactly 10 customers', async () => {
    const ws = project.worksheets.find((w) => w.id === 'top')!;
    const r = await engine.query({ requestId: 'top', model: project.model, spec: ws.spec });
    expect(r.rows).toHaveLength(10);
  });
});
