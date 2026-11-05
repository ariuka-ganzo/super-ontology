import { FormulaError, type BinaryOp, type LodKind, type Node } from './ast';
import { tokenize, type Token } from './lexer';

const KEYWORDS = new Set(['IF', 'THEN', 'ELSEIF', 'ELSE', 'END', 'CASE', 'WHEN', 'AND', 'OR', 'NOT', 'TRUE', 'FALSE', 'NULL', 'FIXED', 'INCLUDE', 'EXCLUDE']);

/** Parses formula text into an AST. Throws FormulaError with a position on bad input. */
export function parseFormula(text: string): Node {
  if (text.trim() === '') throw new FormulaError('The formula is empty', 0, 0);
  const p = new Parser(tokenize(text));
  const node = p.expression();
  const t = p.peek();
  if (t.kind !== 'eof') throw new FormulaError(`Unexpected ${describe(t)} after the end of the formula`, t.start, t.end);
  return node;
}

function describe(t: Token): string {
  if (t.kind === 'eof') return 'end of formula';
  if (t.kind === 'field') return `field [${t.value}]`;
  if (t.kind === 'str') return 'text';
  return `'${t.value}'`;
}

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }
  private next(): Token {
    const t = this.peek();
    if (t.kind !== 'eof') this.pos++;
    return t;
  }
  private isKw(word: string, t = this.peek()): boolean {
    return t.kind === 'ident' && t.value.toUpperCase() === word;
  }
  private isOp(op: string, t = this.peek()): boolean {
    return t.kind === 'op' && t.value === op;
  }
  private expectKw(word: string, context: string): Token {
    const t = this.peek();
    if (!this.isKw(word)) throw new FormulaError(`Expected ${word} ${context}, found ${describe(t)}`, t.start, t.end);
    return this.next();
  }
  private expect(kind: Token['kind'], context: string): Token {
    const t = this.peek();
    if (t.kind !== kind) throw new FormulaError(`Expected '${kind}' ${context}, found ${describe(t)}`, t.start, t.end);
    return this.next();
  }

  expression(): Node {
    return this.or();
  }

  private or(): Node {
    let left = this.and();
    while (this.isKw('OR')) {
      this.next();
      const right = this.and();
      left = bin('OR', left, right);
    }
    return left;
  }

  private and(): Node {
    let left = this.not();
    while (this.isKw('AND')) {
      this.next();
      const right = this.not();
      left = bin('AND', left, right);
    }
    return left;
  }

  private not(): Node {
    if (this.isKw('NOT')) {
      const t = this.next();
      const arg = this.not();
      return { type: 'unary', op: 'NOT', arg, start: t.start, end: arg.end };
    }
    return this.comparison();
  }

  private comparison(): Node {
    const left = this.additive();
    const t = this.peek();
    if (t.kind === 'op' && ['=', '==', '!=', '<>', '<', '<=', '>', '>='].includes(t.value)) {
      this.next();
      const right = this.additive();
      const op: BinaryOp = t.value === '==' ? '=' : t.value === '<>' ? '!=' : (t.value as BinaryOp);
      const node = bin(op, left, right);
      const after = this.peek();
      if (after.kind === 'op' && ['=', '==', '!=', '<>', '<', '<=', '>', '>='].includes(after.value))
        throw new FormulaError('Comparisons cannot be chained. Use AND to combine them', after.start, after.end);
      return node;
    }
    return left;
  }

  private additive(): Node {
    let left = this.multiplicative();
    while (this.isOp('+') || this.isOp('-')) {
      const op = this.next().value as BinaryOp;
      const right = this.multiplicative();
      left = bin(op, left, right);
    }
    return left;
  }

  private multiplicative(): Node {
    let left = this.unary();
    while (this.isOp('*') || this.isOp('/')) {
      const op = this.next().value as BinaryOp;
      const right = this.unary();
      left = bin(op, left, right);
    }
    return left;
  }

  private unary(): Node {
    if (this.isOp('-')) {
      const t = this.next();
      const arg = this.unary();
      if (arg.type === 'num') return { ...arg, value: -arg.value, start: t.start };
      return { type: 'unary', op: '-', arg, start: t.start, end: arg.end };
    }
    if (this.isOp('+')) {
      this.next();
      return this.unary();
    }
    return this.primary();
  }

  private primary(): Node {
    const t = this.peek();
    switch (t.kind) {
      case 'num': {
        this.next();
        const value = Number(t.value);
        if (!Number.isFinite(value)) throw new FormulaError(`'${t.value}' is not a valid number`, t.start, t.end);
        return { type: 'num', value, start: t.start, end: t.end };
      }
      case 'str':
        this.next();
        return { type: 'str', value: t.value, start: t.start, end: t.end };
      case 'date': {
        this.next();
        const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(t.value);
        if (!m || !validDate(+m[1], +m[2], +m[3])) throw new FormulaError(`#${t.value}# is not a valid date. Write dates as #YYYY-MM-DD#`, t.start, t.end);
        return { type: 'date', value: t.value.replace(' ', 'T'), datetime: m[4] !== undefined, start: t.start, end: t.end };
      }
      case 'field': {
        this.next();
        if (this.peek().kind === '.' && this.peek(1).kind === 'field') {
          this.next();
          const col = this.next();
          return { type: 'field', table: t.value, name: col.value, start: t.start, end: col.end };
        }
        return { type: 'field', name: t.value, start: t.start, end: t.end };
      }
      case '(': {
        this.next();
        const inner = this.expression();
        const close = this.peek();
        if (close.kind !== ')') throw new FormulaError(`Expected ')' to close the bracket opened at position ${t.start + 1}`, close.start, close.end);
        this.next();
        return { ...inner, start: t.start, end: close.end };
      }
      case '{':
        return this.lod();
      case 'ident':
        return this.identifier();
      default:
        throw new FormulaError(`Unexpected ${describe(t)}`, t.start, t.end);
    }
  }

  private identifier(): Node {
    const t = this.peek();
    const upper = t.value.toUpperCase();
    if (upper === 'TRUE' || upper === 'FALSE') {
      this.next();
      return { type: 'bool', value: upper === 'TRUE', start: t.start, end: t.end };
    }
    if (upper === 'NULL') {
      this.next();
      return { type: 'null', start: t.start, end: t.end };
    }
    if (upper === 'IF') return this.ifExpr();
    if (upper === 'CASE') return this.caseExpr();
    if (KEYWORDS.has(upper)) throw new FormulaError(`Unexpected keyword ${upper}`, t.start, t.end);
    this.next();
    if (this.peek().kind !== '(') throw new FormulaError(`Unknown name '${t.value}'. Put field names in square brackets, like [${t.value}]`, t.start, t.end);
    this.next();
    const args: Node[] = [];
    if (this.peek().kind !== ')') {
      for (;;) {
        args.push(this.expression());
        if (this.peek().kind === ',') {
          this.next();
          continue;
        }
        break;
      }
    }
    const close = this.peek();
    if (close.kind !== ')') throw new FormulaError(`Expected ')' to close ${upper}( started at position ${t.start + 1}`, close.start, close.end);
    this.next();
    return { type: 'call', name: upper, args, start: t.start, end: close.end };
  }

  private ifExpr(): Node {
    const start = this.next();
    const branches: { cond: Node; then: Node }[] = [];
    const cond = this.expression();
    this.expectKw('THEN', 'after the IF condition');
    branches.push({ cond, then: this.expression() });
    let elseNode: Node | undefined;
    for (;;) {
      if (this.isKw('ELSEIF')) {
        this.next();
        const c = this.expression();
        this.expectKw('THEN', 'after the ELSEIF condition');
        branches.push({ cond: c, then: this.expression() });
        continue;
      }
      if (this.isKw('ELSE')) {
        this.next();
        if (this.isKw('IF')) throw new FormulaError('Write ELSEIF as one word', this.peek().start, this.peek().end);
        elseNode = this.expression();
      }
      break;
    }
    const end = this.peek();
    if (!this.isKw('END')) throw new FormulaError(`Missing END for the IF started at position ${start.start + 1}`, end.start, end.end);
    this.next();
    return { type: 'if', branches, else: elseNode, start: start.start, end: end.end };
  }

  private caseExpr(): Node {
    const start = this.next();
    const subject = this.expression();
    const whens: { match: Node; then: Node }[] = [];
    while (this.isKw('WHEN')) {
      this.next();
      const match = this.expression();
      this.expectKw('THEN', 'after the WHEN value');
      whens.push({ match, then: this.expression() });
    }
    if (whens.length === 0) {
      const t = this.peek();
      throw new FormulaError('CASE needs at least one WHEN', t.start, t.end);
    }
    let elseNode: Node | undefined;
    if (this.isKw('ELSE')) {
      this.next();
      elseNode = this.expression();
    }
    const end = this.peek();
    if (!this.isKw('END')) throw new FormulaError(`Missing END for the CASE started at position ${start.start + 1}`, end.start, end.end);
    this.next();
    return { type: 'case', subject, whens, else: elseNode, start: start.start, end: end.end };
  }

  private lod(): Node {
    const open = this.expect('{', 'to start a level of detail expression');
    let kind: LodKind = 'FIXED';
    const dims: Node[] = [];
    const t = this.peek();
    const upper = t.kind === 'ident' ? t.value.toUpperCase() : '';
    if (upper === 'FIXED' || upper === 'INCLUDE' || upper === 'EXCLUDE') {
      this.next();
      kind = upper;
      if (this.peek().kind !== ':') {
        for (;;) {
          dims.push(this.expression());
          if (this.peek().kind === ',') {
            this.next();
            continue;
          }
          break;
        }
      }
      this.expect(':', `after the ${kind} dimensions`);
    }
    const body = this.expression();
    const close = this.peek();
    if (close.kind !== '}') throw new FormulaError(`Expected '}' to close the expression started at position ${open.start + 1}`, close.start, close.end);
    this.next();
    return { type: 'lod', kind, dims, body, start: open.start, end: close.end };
  }
}

function bin(op: BinaryOp, left: Node, right: Node): Node {
  return { type: 'binary', op, left, right, start: left.start, end: right.end };
}

function validDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= days;
}
