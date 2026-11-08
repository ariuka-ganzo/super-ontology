import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Engine } from '../../src/main/engine/engine';
import { compilePrep, describeStep } from '@shared/prep/prep';
import type { PrepStep, Scalar, TableDef } from '@shared/types';

let engine: Engine;
let dir: string;
let n = 0;

const people =
  'id,name,city,joined,score\n' +
  '1,  Ann Lee ,Oslo,2024-01-05,10\n' +
  '2,bob ray,lima,2024-02-10,\n' +
  '3,Cy Dee,Oslo,2024-03-15,30\n' +
  '3,Cy Dee,Oslo,2024-03-15,30\n' +
  ',,,,\n' +
  '5,Eve,,2024-05-20,50\n';

beforeAll(async () => {
  engine = await Engine.create();
  dir = mkdtempSync(join(tmpdir(), 'ontology-prep-'));
  writeFileSync(join(dir, 'people.csv'), people);
  writeFileSync(join(dir, 'more.csv'), 'id,name,country\n9,Zed,Norway\n');
});
afterAll(() => engine.close());

const step = (s: Omit<PrepStep, 'id'> & Record<string, unknown>): PrepStep => ({ id: `s${++n}`, ...s }) as PrepStep;

/** Imports people.csv with the given steps and returns the column names, rows and any step error. */
async function run(steps: PrepStep[], file = 'people.csv', id = `t${++n}`): Promise<{ cols: string[]; rows: Scalar[][]; error?: string; id: string }> {
  const r = await engine.importTable(id, { path: join(dir, file), format: 'csv' }, steps);
  const table: TableDef = { id, name: id, source: { path: join(dir, file), format: 'csv' }, columns: r.columns, rowCount: r.rowCount, steps };
  const p = await engine.preview(table, 100, 0);
  return { cols: p.columns, rows: p.rows, error: r.stepError?.message, id };
}

describe('data cleaning steps', () => {
  it('leaves the data unchanged with no steps', async () => {
    const r = await run([]);
    expect(r.cols).toEqual(['id', 'name', 'city', 'joined', 'score']);
    expect(r.rows).toHaveLength(6);
  });

  it('renames, removes, keeps and reorders columns', async () => {
    const r = await run([
      step({ kind: 'rename', column: 'city', to: 'Town' }),
      step({ kind: 'remove', columns: ['joined'] }),
      step({ kind: 'keep', columns: ['Town', 'id'] })
    ]);
    expect(r.cols).toEqual(['Town', 'id']);
    expect(r.rows[0]).toEqual(['Oslo', 1]);
  });

  it('trims, changes case, replaces and fills blanks in text', async () => {
    const r = await run([
      step({ kind: 'text', column: 'name', op: 'trim' }),
      step({ kind: 'text', column: 'city', op: 'upper' }),
      step({ kind: 'replace', column: 'name', find: 'Dee', with: 'D.' }),
      step({ kind: 'replace', column: 'city', find: 'LIMA', with: 'Lima, Peru', whole: true }),
      step({ kind: 'fillBlank', column: 'city', value: 'Unknown' }),
      step({ kind: 'fillBlank', column: 'score', value: 0 })
    ]);
    expect(r.error).toBeUndefined();
    expect(r.rows.map((x) => x[1])).toEqual(['Ann Lee', 'bob ray', 'Cy D.', 'Cy D.', null, 'Eve']);
    expect(r.rows.map((x) => x[2])).toEqual(['OSLO', 'Lima, Peru', 'OSLO', 'OSLO', 'Unknown', 'Unknown']);
    expect(r.rows.map((x) => x[4])).toEqual([10, 0, 30, 30, 0, 50]);
  });

  it('filters rows with each kind of condition', async () => {
    const ids = async (s: Omit<PrepStep, 'id'> & Record<string, unknown>): Promise<Scalar[]> => (await run([step(s)])).rows.map((x) => x[0]);
    expect(await ids({ kind: 'filter', column: 'score', op: '>=', value: '30' })).toEqual([3, 3, 5]);
    expect(await ids({ kind: 'filter', column: 'city', op: '=', value: 'Oslo' })).toEqual([1, 3, 3]);
    // "Does not equal" keeps rows where the value is empty.
    expect(await ids({ kind: 'filter', column: 'city', op: '!=', value: 'Oslo' })).toEqual([2, null, 5]);
    expect(await ids({ kind: 'filter', column: 'name', op: 'contains', value: 'DEE' })).toEqual([3, 3]);
    expect(await ids({ kind: 'filter', column: 'name', op: 'notContains', value: 'dee' })).toEqual([1, 2, null, 5]);
    expect(await ids({ kind: 'filter', column: 'name', op: 'startsWith', value: 'B' })).toEqual([2]);
    expect(await ids({ kind: 'filter', column: 'city', op: 'blank' })).toEqual([null, 5]);
    expect(await ids({ kind: 'filter', column: 'joined', op: '<', value: '2024-03-01' })).toEqual([1, 2]);
  });

  it('splits and merges columns', async () => {
    const r = await run([
      step({ kind: 'text', column: 'name', op: 'trim' }),
      step({ kind: 'split', column: 'name', separator: ' ', into: ['first', 'last'] }),
      step({ kind: 'merge', columns: ['last', 'city'], separator: ' / ', to: 'where' })
    ]);
    expect(r.cols).toEqual(['id', 'first', 'where', 'joined', 'score']);
    expect(r.rows[0]).toEqual([1, 'Ann', 'Lee / Oslo', '2024-01-05', 10]);
    // Eve has no last name or city: merge skips empty parts.
    expect(r.rows[5].slice(0, 3)).toEqual([5, 'Eve', '']);
  });

  it('removes duplicates and blank rows, and keeps the first rows', async () => {
    expect((await run([step({ kind: 'dedupe' })])).rows).toHaveLength(5);
    expect((await run([step({ kind: 'dedupe', columns: ['city'] })])).rows).toHaveLength(3);
    expect((await run([step({ kind: 'removeBlankRows' })])).rows.map((x) => x[0])).toEqual([1, 2, 3, 3, 5]);
    expect((await run([step({ kind: 'keepTop', n: 2 })])).rows.map((x) => x[0])).toEqual([1, 2]);
  });

  it('changes types, turning values that do not convert into nulls', async () => {
    const r = await run([step({ kind: 'changeType', column: 'name', to: 'integer' }), step({ kind: 'changeType', column: 'score', to: 'string' })]);
    expect(r.rows.map((x) => x[1])).toEqual([null, null, null, null, null, null]);
    expect(r.rows[0][4]).toBe('10');
  });

  it('appends another table, matching columns by name', async () => {
    const other = await run([], 'more.csv');
    const r = await run([step({ kind: 'removeBlankRows' }), step({ kind: 'append', tableId: other.id })]);
    expect(r.cols).toEqual(['id', 'name', 'city', 'joined', 'score', 'country']);
    expect(r.rows.at(-1)).toEqual([9, 'Zed', null, null, null, 'Norway']);
    expect(r.rows).toHaveLength(6);
  });

  it('stops at a step that does not fit and reports it, keeping the steps before it', async () => {
    const bad = step({ kind: 'rename', column: 'nope', to: 'x' });
    const r = await run([step({ kind: 'rename', column: 'city', to: 'town' }), bad, step({ kind: 'remove', columns: ['id'] })]);
    expect(r.error).toMatch(/no column named "nope"/);
    expect(r.cols).toEqual(['id', 'name', 'town', 'joined', 'score']);
  });

  it('refuses unclear values and name clashes with a plain message', () => {
    const base = {
      ref: '"x"',
      columns: [
        { name: 'a', type: 'integer' as const },
        { name: 'B', type: 'string' as const }
      ]
    };
    const err = (s: Omit<PrepStep, 'id'> & Record<string, unknown>): string | undefined => compilePrep(base, [step(s)], () => undefined, 'self').error?.message;
    expect(err({ kind: 'filter', column: 'a', op: '>', value: 'ten' })).toBe('"ten" is not a number');
    expect(err({ kind: 'rename', column: 'a', to: 'b' })).toBe('There is already a column named "b"');
    expect(err({ kind: 'text', column: 'a', op: 'trim' })).toMatch(/^Trim works on text columns/);
    expect(err({ kind: 'remove', columns: ['a', 'B'] })).toBe('This would remove every column');
    expect(err({ kind: 'append', tableId: 'self' })).toBe('A table cannot be appended to itself');
  });

  it('never puts values in the SQL text', () => {
    const base = { ref: '"x"', columns: [{ name: 'a', type: 'string' as const }] };
    const evil = "x'); DROP TABLE y; --";
    const c = compilePrep(
      base,
      [step({ kind: 'filter', column: 'a', op: 'contains', value: evil }), step({ kind: 'replace', column: 'a', find: evil, with: evil })],
      () => undefined,
      'self'
    );
    expect(c.sql).not.toContain('DROP');
    expect(c.params).toEqual([evil, evil, evil]);
  });

  it('shows the data right after a chosen step', async () => {
    const steps = [step({ kind: 'removeBlankRows' }), step({ kind: 'keepTop', n: 1 })];
    const r = await run(steps);
    const table: TableDef = { id: r.id, name: 'p', source: { path: join(dir, 'people.csv'), format: 'csv' }, columns: [], rowCount: 1, steps };
    expect((await engine.preview(table, 100, 0, steps[0].id)).total).toBe(5);
    expect((await engine.preview(table, 100, 0)).total).toBe(1);
  });

  it('describes steps in plain language', () => {
    expect(describeStep(step({ kind: 'filter', column: 'city', op: 'notBlank' }), [])).toBe('Remove rows where city is blank');
    expect(describeStep(step({ kind: 'append', tableId: 'm' }), [{ id: 'm', name: 'More' }])).toBe('Append rows from More');
    expect(describeStep(step({ kind: 'replace', column: 'c', find: 'a', with: 'b' }), [])).toBe('Replace "a" with "b" in c');
  });
});
