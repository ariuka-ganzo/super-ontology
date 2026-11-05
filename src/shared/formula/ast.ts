export interface Span {
  start: number;
  end: number;
}

export type BinaryOp = '+' | '-' | '*' | '/' | '=' | '!=' | '<' | '<=' | '>' | '>=' | 'AND' | 'OR';

export type LodKind = 'FIXED' | 'INCLUDE' | 'EXCLUDE';

export type Node =
  | ({ type: 'num'; value: number } & Span)
  | ({ type: 'str'; value: string } & Span)
  | ({ type: 'bool'; value: boolean } & Span)
  | ({ type: 'null' } & Span)
  | ({ type: 'date'; value: string; datetime: boolean } & Span)
  | ({ type: 'field'; table?: string; name: string } & Span)
  | ({ type: 'unary'; op: '-' | 'NOT'; arg: Node } & Span)
  | ({ type: 'binary'; op: BinaryOp; left: Node; right: Node } & Span)
  | ({ type: 'call'; name: string; args: Node[] } & Span)
  | ({ type: 'if'; branches: { cond: Node; then: Node }[]; else?: Node } & Span)
  | ({ type: 'case'; subject: Node; whens: { match: Node; then: Node }[]; else?: Node } & Span)
  | ({ type: 'lod'; kind: LodKind; dims: Node[]; body: Node } & Span);

export class FormulaError extends Error {
  constructor(
    message: string,
    public readonly start: number,
    public readonly end: number
  ) {
    super(message);
    this.name = 'FormulaError';
  }
}

/** Turns a character offset into a 1-based line and column, for error messages. */
export function lineCol(text: string, offset: number): { line: number; col: number } {
  let line = 1;
  let col = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') {
      line++;
      col = 1;
    } else col++;
  }
  return { line, col };
}
