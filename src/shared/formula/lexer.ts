import { FormulaError } from './ast';

export type TokenKind =
  | 'num'
  | 'str'
  | 'field'
  | 'date'
  | 'ident'
  | 'op'
  | '('
  | ')'
  | ','
  | '{'
  | '}'
  | ':'
  | '.'
  | 'eof';

export interface Token {
  kind: TokenKind;
  value: string;
  start: number;
  end: number;
}

const OPS = ['<=', '>=', '!=', '<>', '==', '+', '-', '*', '/', '=', '<', '>'];

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    const start = i;
    if (ch === '[') {
      // Field reference. A literal ] inside a name is written as ]].
      let name = '';
      i++;
      for (;;) {
        if (i >= n) throw new FormulaError('This field name is missing its closing ]', start, n);
        if (text[i] === ']') {
          if (text[i + 1] === ']') {
            name += ']';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        name += text[i];
        i++;
      }
      if (name.trim() === '') throw new FormulaError('Empty field name []', start, i);
      tokens.push({ kind: 'field', value: name, start, end: i });
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let value = '';
      i++;
      for (;;) {
        if (i >= n) throw new FormulaError('This text is missing its closing quote', start, n);
        if (text[i] === quote) {
          if (text[i + 1] === quote) {
            value += quote;
            i += 2;
            continue;
          }
          i++;
          break;
        }
        value += text[i];
        i++;
      }
      tokens.push({ kind: 'str', value, start, end: i });
      continue;
    }
    if (ch === '#') {
      const close = text.indexOf('#', i + 1);
      if (close < 0) throw new FormulaError('This date is missing its closing #', start, n);
      tokens.push({ kind: 'date', value: text.slice(i + 1, close).trim(), start, end: close + 1 });
      i = close + 1;
      continue;
    }
    if (isDigit(ch) || (ch === '.' && isDigit(text[i + 1] ?? ''))) {
      while (i < n && isDigit(text[i])) i++;
      if (text[i] === '.') {
        i++;
        while (i < n && isDigit(text[i])) i++;
      }
      if (text[i] === 'e' || text[i] === 'E') {
        const save = i;
        i++;
        if (text[i] === '+' || text[i] === '-') i++;
        if (!isDigit(text[i] ?? '')) i = save;
        else while (i < n && isDigit(text[i])) i++;
      }
      tokens.push({ kind: 'num', value: text.slice(start, i), start, end: i });
      continue;
    }
    if (isIdentStart(ch)) {
      while (i < n && isIdentPart(text[i])) i++;
      tokens.push({ kind: 'ident', value: text.slice(start, i), start, end: i });
      continue;
    }
    if ('(),{}:.'.includes(ch)) {
      tokens.push({ kind: ch as TokenKind, value: ch, start, end: i + 1 });
      i++;
      continue;
    }
    const op = OPS.find((o) => text.startsWith(o, i));
    if (op) {
      tokens.push({ kind: 'op', value: op, start, end: i + op.length });
      i += op.length;
      continue;
    }
    throw new FormulaError(`Unexpected character '${ch}'`, start, start + 1);
  }
  tokens.push({ kind: 'eof', value: '', start: n, end: n });
  return tokens;
}

function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}
function isIdentStart(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
}
function isIdentPart(c: string): boolean {
  return isIdentStart(c) || isDigit(c);
}
