import { describe, expect, it } from 'vitest';
import { FormulaError, lineCol } from '@shared/formula/ast';
import { calcInfo, checkFormula } from '@shared/formula/check';
import { parseFormula } from '@shared/formula/parser';
import type { Model } from '@shared/types';

const model: Model = {
  tables: [
    {
      id: 'o',
      name: 'Orders',
      source: { path: 'o.csv', format: 'csv' },
      rowCount: 10,
      columns: [
        { name: 'Sales', sourceType: 'DOUBLE', type: 'number' },
        { name: 'Region', sourceType: 'VARCHAR', type: 'string' },
        { name: 'Order Date', sourceType: 'DATE', type: 'date' },
        { name: 'Weird ]name', sourceType: 'VARCHAR', type: 'string' },
        { name: 'Id', sourceType: 'BIGINT', type: 'integer' }
      ]
    },
    {
      id: 'c',
      name: 'Customers',
      source: { path: 'c.csv', format: 'csv' },
      rowCount: 3,
      columns: [
        { name: 'Id', sourceType: 'BIGINT', type: 'integer' },
        { name: 'Segment', sourceType: 'VARCHAR', type: 'string' }
      ]
    }
  ],
  relationships: [],
  calcs: [
    { id: 'k1', name: 'Profit Ratio', formula: 'SUM([Sales]) / 2' },
    { id: 'k2', name: 'Loop A', formula: '[Loop B] + 1' },
    { id: 'k3', name: 'Loop B', formula: '[Loop A] + 1' },
    { id: 'k4', name: 'Net', formula: '[Sales] * 0.8' }
  ]
};

function err(text: string): FormulaError {
  try {
    checkFormula(text, model);
  } catch (e) {
    if (e instanceof FormulaError) return e;
    throw e;
  }
  throw new Error(`expected an error for: ${text}`);
}

describe('parser', () => {
  it('parses precedence correctly', () => {
    const n = parseFormula('1 + 2 * 3 > 4 AND NOT [Region] = "x" OR TRUE');
    expect(n.type).toBe('binary');
    if (n.type !== 'binary') return;
    expect(n.op).toBe('OR');
    const and = n.left;
    expect(and.type === 'binary' && and.op).toBe('AND');
  });

  it('parses field names with escaped brackets and table qualifiers', () => {
    expect(parseFormula('[Weird ]]name]')).toMatchObject({ type: 'field', name: 'Weird ]name' });
    expect(parseFormula('[Orders].[Sales]')).toMatchObject({ type: 'field', table: 'Orders', name: 'Sales' });
  });

  it('parses all three LOD forms and the shorthand', () => {
    expect(parseFormula('{FIXED [Region] : SUM([Sales])}')).toMatchObject({ type: 'lod', kind: 'FIXED' });
    expect(parseFormula('{ include [Region], [Id] : SUM([Sales]) }')).toMatchObject({ type: 'lod', kind: 'INCLUDE' });
    expect(parseFormula('{EXCLUDE [Region]: SUM([Sales])}')).toMatchObject({ type: 'lod', kind: 'EXCLUDE' });
    expect(parseFormula('{SUM([Sales])}')).toMatchObject({ type: 'lod', kind: 'FIXED', dims: [] });
  });

  it('parses IF/ELSEIF/ELSE/END, CASE, comments, strings and dates', () => {
    const n = parseFormula('// comment\nIF [Sales] > 1 THEN "a" ELSEIF [Sales] > 0 THEN \'b\'\'s\' ELSE "c" END');
    expect(n.type === 'if' && n.branches.length).toBe(2);
    expect(parseFormula("CASE [Region] WHEN 'a' THEN 1 ELSE 2 END").type).toBe('case');
    expect(parseFormula('#2024-02-29#')).toMatchObject({ type: 'date', value: '2024-02-29', datetime: false });
    expect(parseFormula('#2024-02-29 10:30#')).toMatchObject({ type: 'date', datetime: true });
  });

  it('reports positions for syntax errors', () => {
    const cases: [string, RegExp, number][] = [
      ['SUM([Sales]', /Expected '\)' to close SUM\(/, 11],
      ['IF [Sales] > 1 THEN 1', /Missing END for the IF/, 21],
      ['[Sales', /missing its closing \]/, 0],
      ['"abc', /missing its closing quote/, 0],
      ['1 +', /Unexpected end of formula/, 3],
      ['Sales + 1', /Put field names in square brackets/, 0],
      ['1 < 2 < 3', /cannot be chained/, 6],
      ['#2023-02-30#', /not a valid date/, 0],
      ['1 $ 2', /Unexpected character '\$'/, 2],
      ['{FIXED [Region] SUM([Sales])}', /Expected ':'/, 16],
      ['', /empty/, 0]
    ];
    for (const [text, re, pos] of cases) {
      let caught: FormulaError | undefined;
      try {
        parseFormula(text);
      } catch (e) {
        caught = e as FormulaError;
      }
      expect(caught, text).toBeInstanceOf(FormulaError);
      expect(caught!.message, text).toMatch(re);
      expect(caught!.start, text).toBe(pos);
    }
  });

  it('converts offsets to line and column', () => {
    expect(lineCol('a\nbc', 3)).toEqual({ line: 2, col: 2 });
  });
});

describe('type checker', () => {
  it('infers types and levels', () => {
    expect(checkFormula('[Sales] * 2', model)).toMatchObject({ vtype: 'number', level: 'row' });
    expect(checkFormula('SUM([Sales])', model)).toMatchObject({ vtype: 'number', level: 'agg' });
    expect(checkFormula('{FIXED [Region] : SUM([Sales])}', model)).toMatchObject({ level: 'row' });
    expect(checkFormula('{INCLUDE [Region] : SUM([Sales])}', model)).toMatchObject({ level: 'lod' });
    expect(checkFormula('AVG({INCLUDE [Region] : SUM([Sales])})', model)).toMatchObject({ level: 'agg' });
    expect(checkFormula('RUNNING_SUM(SUM([Sales]))', model)).toMatchObject({ level: 'tcalc' });
    expect(checkFormula('[Region] + "!"', model)).toMatchObject({ vtype: 'string' });
    expect(checkFormula('DATETRUNC("month", [Order Date])', model)).toMatchObject({ vtype: 'date' });
    expect(checkFormula('[Profit Ratio] * 2', model)).toMatchObject({ level: 'agg' });
    expect(checkFormula('sum([net])', model)).toMatchObject({ level: 'agg' });
  });

  it('classifies saved calculations as columns or measures', () => {
    expect(calcInfo(model, 'k4')).toMatchObject({ ok: true, level: 'row' });
    expect(calcInfo(model, 'k1')).toMatchObject({ ok: true, level: 'agg' });
    expect(calcInfo(model, 'k2')).toMatchObject({ ok: false });
    expect(calcInfo(model, 'k2').error!.message).toMatch(/refers to itself/);
  });

  it('gives plain-language errors with positions', () => {
    const cases: [string, RegExp, number][] = [
      ['SUM([Sales]) + [Sales]', /Cannot mix aggregate and row-level/, 0],
      ['SUM(SUM([Sales]))', /already aggregated/, 4],
      ['SUM([Region])', /must be number/, 4],
      ['[Salse] + 1', /Unknown field \[Salse\]. Did you mean \[Sales\]\?/, 0],
      ['[Id]', /more than one table. Write \[Orders\]\.\[Id\] or \[Customers\]\.\[Id\]/, 0],
      ['SUMM([Sales])', /Unknown function SUMM. Did you mean SUM\?/, 0],
      ['IF [Sales] THEN 1 END', /must be boolean/, 3],
      ['IF [Sales] > 1 THEN 1 ELSE "a" END', /same type/, 0],
      ['[Region] > 1', /Cannot compare string with number/, 0],
      ['{FIXED [Region] : [Sales]}', /must be an aggregate/, 18],
      ['{FIXED SUM([Sales]) : SUM([Sales])}', /must be row-level/, 7],
      ['{INCLUDE [Region] : SUM([Sales])} + [Sales]', /INCLUDE and EXCLUDE/, 0],
      ['AVG({INCLUDE [Region] : SUM([Sales])} - [Sales])', /only be combined with constants/, 4],
      ['RUNNING_SUM([Sales])', /works on aggregated values/, 12],
      ['RANK(RANK(SUM([Sales])))', /another table calculation/, 5],
      ['LAG(SUM([Sales]), 0)', /offset must be a whole number/, 18],
      ['DATEADD("fortnight", 1, [Order Date])', /not a date part/, 8],
      ['DATEADD([Region], 1, [Order Date])', /must be a date part in quotes/, 8],
      ['LEFT([Region])', /takes 2 arguments, but got 1/, 0],
      ['[Order Date] + 1', /Use DATEADD or DATEDIFF/, 0],
      ['[Orders].[Nope]', /has no field \[Nope\]/, 0],
      ['[Loop A]', /refers to itself/, 0],
      ['{FIXED [Region] : SUM({INCLUDE [Segment] : SUM([Sales])})}', /cannot be nested/, 18]
    ];
    for (const [text, re, pos] of cases) {
      const e = err(text);
      expect(e.message, text).toMatch(re);
      expect(e.start, text).toBe(pos);
    }
  });
});
