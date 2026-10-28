/**
 * R 的表达式解析器（递归下降）：tokens → CST。
 *
 * 结构就是"一档一个函数"的紧凑写法：`parseLevel(n)` 负责第 n 档运算符，
 * 操作数交给更紧的一档（n + 1）。最紧一档负责"值"：名字 / 字面量 / 括号 / 一元。
 * 档位数字来自 evidence/demo3.R 的实测（数字越大越紧）。
 *
 * 本文件当前只做"能解析"：控制流（if / for / while / function）、命名空间（::）、
 * 错误恢复还没做，遇到就先用 CstError 兜住。
 */

import type { Token } from './tokenizer';
import type {
  CstArgument,
  CstComment,
  CstExpr,
  CstOperator,
  CstParameter,
  CstProgram,
  Span,
} from './cst';

/** 各运算符的优先级：数字越大越紧（0 = 最松）。来自 evidence/demo3.R 的实测档位。 */
const PREC: Record<string, number> = {
  '<-': 1, '<<-': 1, '=': 1, '->': 1, '->>': 1,
  '~': 2,
  '|': 3, '||': 3,
  '&': 4, '&&': 4,
  '<': 5, '>': 5, '<=': 5, '>=': 5, '==': 5, '!=': 5,
  '+': 6, '-': 6,
  '*': 7, '/': 7,
  '%': 8,          // 占位：%op% 统一给 8
  '|>': 8,
  ':': 9,
  '^': 10,
};

/** 右结合的运算符（其余左结合）。实测见 evidence/demo3.R。 */
const RIGHT_ASSOC = new Set(['^', '<-', '<<-', '=', '->', '->>']);

/** 一元运算符（前缀） */
const UNARY = new Set(['-', '+', '!', '~', '?']);

/** 前缀运算符的优先级：夹在 ^ 之下、* 之上（见 evidence/demo3.R 第 5 节） */
const UNARY_PREC = 8;

/** 判断某个 token 是不是二元运算符，并给出优先级 */
function binaryPrec(token: Token | undefined): number | null {
  if (token === undefined || token.kind !== 'operator') return null;
  const t = token.text;
  if (t.startsWith('%') && t.endsWith('%')) return PREC['%'] ?? null;
  if (t in PREC) return PREC[t] ?? null;
  return null;
}

export function parseCst(
  tokens: Token[],
  /** 判断两个偏移是否在同一行。不传就认为注释都独占一行（parser 不依赖 analysis 层的 TextLines）。 */
  isSameLine?: (a: number, b: number) => boolean,
): CstProgram {
  let pos = 0;

  const peek = (offset = 0): Token | undefined => tokens[pos + offset];
  const eof = (): boolean => pos >= tokens.length;

  const spanOf = (stIndex: number, enIndex: number): Span => ({
    stIndex,
    enIndex,
    stOffset: tokens[stIndex]?.stOffset ?? 0,
    enOffset: tokens[enIndex]?.enOffset ?? tokens[stIndex]?.stOffset ?? 0,
  });

  const operatorOf = (token: Token): CstOperator => ({
    ...spanOf(pos - 1, pos - 1),
    text: token.text,
  });

  // 跳过注释（收集到外面两个数组里）与换行
  const ownLineComments: CstComment[] = [];
  const trailingComments: CstComment[] = [];
  const skipBlanks = (): void => {
    while (!eof()) {
      const t = peek();
      if (t === undefined) return;
      if (t.kind !== 'comment') return;
      const comment: CstComment = { kind: 'Comment', text: t.text, ...spanOf(pos, pos) };
      // 注释前面同一行有代码 → 尾注释；否则算独占一行
      const prev = tokens[pos - 1];
      if (prev !== undefined && isSameLine !== undefined && isSameLine(prev.stOffset, t.stOffset)) {
        trailingComments.push(comment);
      } else {
        ownLineComments.push(comment);
      }
      pos += 1;
    }
  };

  // ---------------------------------------------------------------- 最紧一档：值

  /** 141 ≡ 值：名字 / 字面量 / 括号 / 一元运算符 */
  const parseAtom = (): CstExpr | null => {
    skipBlanks();
    const t = peek();
    if (t === undefined) return null;

    // 括号
    if (t.kind === 'operator' && t.text === '(') {
      const openIndex = pos;
      pos += 1;
      const inner = parseExpr(0);
      skipBlanks();
      let closeIndex = pos;
      if (peek()?.text === ')') pos += 1;
      else closeIndex = Math.max(openIndex, pos - 1);
      return {
        kind: 'Paren',
        openSpan: spanOf(openIndex, openIndex),
        expr: inner ?? { kind: 'Comma', ...spanOf(openIndex, openIndex) },
        closeSpan: spanOf(closeIndex, closeIndex),
        ...spanOf(openIndex, closeIndex),
      };
    }

    // 一元运算符
    if (t.kind === 'operator' && UNARY.has(t.text)) {
      pos += 1;
      const operator: CstOperator = { ...spanOf(pos - 1, pos - 1), text: t.text };
      const operand = parseExpr(UNARY_PREC);
      if (operand === null) return { kind: 'UnaryOp', operator, operand: { kind: 'Comma', ...operator }, ...spanOf(pos - 1, pos - 1) };
      return { kind: 'UnaryOp', operator, operand, ...spanOf(operator.stIndex, operand.enIndex) };
    }

    // 字面量
    if (t.kind === 'number' || t.kind === 'string') {
      pos += 1;
      const literalKind = t.kind === 'number' ? 'number' : 'string';
      return { kind: 'Literal', literalKind, text: t.text, ...spanOf(pos - 1, pos - 1) };
    }

    // 名字（TRUE / FALSE / NULL / NA 这几个按实测是常量，不是名字）
    if (t.kind === 'identifier') {
      pos += 1;
      const upper = t.text.toUpperCase();
      const literal = (literalKind: 'logical' | 'null' | 'na'): CstExpr => ({
        kind: 'Literal',
        literalKind,
        text: t.text,
        ...spanOf(pos - 1, pos - 1),
      });
      if (upper === 'TRUE' || upper === 'FALSE') return literal('logical');
      if (upper === 'NULL') return literal('null');
      if (upper === 'NA' || upper.startsWith('NA_')) return literal('na');
      return { kind: 'Identifier', text: t.text, ...spanOf(pos - 1, pos - 1) };
    }

    // 认不出的东西：兜成 Error，保证树覆盖全文
    pos += 1;
    return { kind: 'Error', tokens: [pos - 1], ...spanOf(pos - 1, pos - 1) };
  };

  // ---------------------------------------------------------------- 后缀：调用 / 取子集 / 取成员

  const parsePostfix = (): CstExpr | null => {
    // 先窄化成非空，后面反复赋值就不用每次断言
    const atom = parseAtom();
    if (atom === null) return null;
    let node: CstExpr = atom;
    if (node === null) return null;
    for (;;) {
      skipBlanks();
      const t = peek();
      if (t === undefined) return node;

      // f(...)
      if (t.kind === 'operator' && t.text === '(') {
        const openIndex = pos;
        pos += 1;
        const args = parseArguments(')');
        let closeIndex = pos;
        if (peek()?.text === ')') pos += 1;
        else closeIndex = Math.max(openIndex, pos - 1);
        node = {
          kind: 'Call',
          callee: node,
          openSpan: spanOf(openIndex, openIndex),
          arguments: args,
          closeSpan: spanOf(closeIndex, closeIndex),
          ...spanOf(node.stIndex, closeIndex),
        };
        continue;
      }

      // x[...] / x[[...]]
      if (t.kind === 'operator' && (t.text === '[' || t.text === '[[')) {
        const isDouble = t.text === '[[';
        const openIndex = pos;
        pos += 1;
        const args = parseArguments(isDouble ? ']]' : ']');
        // 收尾括号；用户还在打字（没写）时，退化成"到最后一个 token 为止"
        let closeIndex = Math.max(openIndex, pos - 1);
        if (peek()?.text === (isDouble ? ']]' : ']')) {
          closeIndex = pos;
          pos += 1;
        }
        node = {
          kind: isDouble ? 'Subset2' : 'Subset',
          target: node,
          openSpan: spanOf(openIndex, openIndex),
          arguments: args,
          closeSpan: spanOf(closeIndex, closeIndex),
          ...spanOf(node.stIndex, closeIndex),
        };
        continue;
      }

      // p$name / p@name
      if (t.kind === 'operator' && (t.text === '$' || t.text === '@')) {
        const opIndex = pos;
        pos += 1;
        skipBlanks();
        const nameToken = peek();
        if (nameToken === undefined || nameToken.kind !== 'identifier') return node;
        pos += 1;
        node = {
          kind: 'Extract',
          target: node,
          operator: { ...spanOf(opIndex, opIndex), text: t.text },
          member: { kind: 'Identifier', text: nameToken.text, ...spanOf(pos - 1, pos - 1) },
          ...spanOf(node.stIndex, pos - 1),
        };
        continue;
      }

      return node;
    }
  };

  /** 参数 / 下标列表：认 `,` 分隔、`name = value` 具名、空位（`f(a, )` 合法） */
  const parseArguments = (closeText: string): CstArgument[] => {
    const args: CstArgument[] = [];
    // 当前位置还没有值（初始 true：`f(` 之后第一个位置就是"待填"）
    let waitingValue = true;
    const pushEmpty = (at: number): void => {
      args.push({ kind: 'Argument', ...spanOf(at, at) });
    };

    for (;;) {
      skipBlanks();
      const t = peek();
      const isClose =
        t === undefined ||
        (t.kind === 'operator' && (t.text === closeText || t.text === ')' || t.text === ']'));
      if (isClose) {
        // `f(a, )` 的最后一个空参：有过逗号且还在等值
        if (waitingValue && args.length > 0) pushEmpty(Math.max(0, pos - 1));
        return args;
      }

      if (t.kind === 'operator' && t.text === ',') {
        // `f(, a)` 的第一个空参：还没读到任何值就遇到逗号
        if (waitingValue) pushEmpty(pos);
        waitingValue = true;
        pos += 1;
        continue;
      }

      const stIndex = pos;
      let name: CstArgument['name'];
      const maybeName = peek();
      const maybeEq = peek(1);
      if (maybeName?.kind === 'identifier' && maybeEq?.kind === 'operator' && maybeEq.text === '=') {
        name = { kind: 'Identifier', text: maybeName.text, ...spanOf(pos, pos) };
        pos += 2;
      }
      const value = parseExpr(0);
      if (value === null && name === undefined) return args;
      waitingValue = false;
      args.push({
        kind: 'Argument',
        ...(name !== undefined ? { name } : {}),
        ...(value !== null ? { value } : {}),
        ...spanOf(stIndex, value === null ? stIndex : value.enIndex),
      });
    }
  };

  // ---------------------------------------------------------------- 中缀：按档位

  const parseExpr = (minPrec: number): CstExpr | null => {
    // 先窄化成非空，后面反复赋值就不用每次断言
    const first = parsePostfix();
    if (first === null) return null;
    let left: CstExpr = first;
    for (;;) {
      skipBlanks();
      const t = peek();
      const prec = binaryPrec(t);
      if (prec === null || prec < minPrec) return left;
      if (t === undefined) return left;

      pos += 1;
      const operator = operatorOf(t);
      const nextMin = RIGHT_ASSOC.has(t.text) ? prec : prec + 1;
      const right = parseExpr(nextMin);
      if (right === null) return left;

      const isAssign = t.text === '<-' || t.text === '<<-' || t.text === '=' || t.text === '->' || t.text === '->>';
      left = {
        kind: isAssign ? 'Assign' : 'BinaryOp',
        operator,
        lhs: left,
        rhs: right,
        ...spanOf(left.stIndex, right.enIndex),
      };
    }
  };

  // ---------------------------------------------------------------- 顶层

  const body: CstExpr[] = [];
  const separators: Span[] = [];
  skipBlanks();
  while (!eof()) {
    const before = pos;
    const node = parseExpr(0);
    skipBlanks();
    if (node === null) {
      // 认不出的 token：吞掉，避免死循环
      if (peek() !== undefined) pos += 1;
      if (pos === before) break;
      continue;
    }
    body.push(node);
    const t = peek();
    if (t?.kind === 'operator' && t.text === ';') {
      separators.push(spanOf(pos, pos));
      pos += 1;
    }
    skipBlanks();
  }

  const stIndex = 0;
  const enIndex = Math.max(0, tokens.length - 1);
  return {
    kind: 'Program',
    body,
    separators,
    ownLineComments,
    trailingComments,
    ...spanOf(stIndex, enIndex),
  };
}

/** 只为让 `CstParameter` 类型被使用（后面做 function 时用），避免 lint 报未使用 */
export type { CstParameter };
