import { describe, expect, it } from 'vitest';
import { tokenize } from '../../src/parser/tokenizer';
import { parseCst } from '../../src/parser/cst-parser';
import type { CstExpr, CstProgram } from '../../src/parser/cst';

/** 解析一段代码（带注释），返回 Program */
function parse(code: string): CstProgram {
  return parseCst(tokenize(code, true), (a, b) => !code.slice(a, b).includes('\n'));
}

/**
 * 把 CST 压成"骨架字符串"，规则和 scripts/cst-check.mjs 一致 ——
 * 这样同一套期望值既能喂单测，也能和 R 的输出直接比。
 * 字面量统一写成 NUM，括号在骨架里不体现。
 */
function sexp(node: CstExpr | null | undefined): string {
  if (node === null || node === undefined) return '?';
  switch (node.kind) {
    case 'Identifier':
      return node.text;
    case 'Literal':
      return 'NUM';
    case 'Paren':
      return sexp(node.expr);
    case 'BinaryOp':
    case 'Assign':
    case 'NamespaceOp':
      return `(${node.operator.text} ${sexp(node.lhs)} ${sexp(node.rhs)})`;
    case 'UnaryOp':
      return `(${node.operator.text} ${sexp(node.operand)})`;
    case 'Extract':
      return `(${node.operator.text} ${sexp(node.target)} ${sexp(node.member)})`;
    case 'Call': {
      const args = node.arguments.map(sexp).filter((s) => s !== '');
      return `(${sexp(node.callee)}${args.length ? ` ${args.join(' ')}` : ''})`;
    }
    case 'Argument':
      // 空参（f(a, ) / x[1, ]）在骨架里跳过，和 R 的 parse 输出对齐
      if (node.value === undefined) return '';
      return node.name === undefined ? sexp(node.value) : `(= ${node.name.text} ${sexp(node.value)})`;
    case 'Subset': {
      const args = node.arguments.map(sexp).filter((s) => s !== '');
      return `([ ${sexp(node.target)}${args.length ? ` ${args.join(' ')}` : ''})`;
    }
    case 'Subset2': {
      const args = node.arguments.map(sexp).filter((s) => s !== '');
      return `([[ ${sexp(node.target)}${args.length ? ` ${args.join(' ')}` : ''})`;
    }
    default:
      return node.kind;
  }
}

/** 只取第一句的骨架 */
function first(code: string): string {
  return sexp(parse(code).body[0]);
}

describe('parseCst 表达式骨架（期望值都能和 R 的 parse 对上，见 scripts/cst-check.mjs）', () => {
  it('取成员：$ 是左结合，a$b$c 解析成 (a$b)$c', () => {
    expect(first('p$name')).toBe('($ p name)');
    expect(first('a$b$c')).toBe('($ ($ a b) c)');
  });

  it('取成员：@ 与 $ 形状相同', () => {
    expect(first('p@name')).toBe('(@ p name)');
  });

  it('优先级：* 比 + 紧', () => {
    expect(first('1 + 2 * 3')).toBe('(+ NUM (* NUM NUM))');
    expect(first('1 * 2 + 3')).toBe('(+ (* NUM NUM) NUM)');
  });

  it('优先级：同档左结合（a + b - c）', () => {
    expect(first('a + b - c')).toBe('(- (+ a b) c)');
  });

  it('优先级：^ 比一元 - 紧（-2^2 = -(2^2)）', () => {
    expect(first('-2^2')).toBe('(- (^ NUM NUM))');
  });

  it('^ 的右边可以是一元（2^-2 合法）', () => {
    expect(first('2^-2')).toBe('(^ NUM (- NUM))');
  });

  it('一元 ! 比 & 紧，但比 + 松（实测结论）', () => {
    expect(first('!a & b')).toBe('(& (! a) b)');
  });

  it('括号是节点，但骨架里拆掉：语义不变', () => {
    const program = parse('(1 + 2) * 3');
    expect(program.body).toHaveLength(1);
    const top = program.body[0];
    expect(top.kind).toBe('BinaryOp');
    expect(sexp(top)).toBe('(* (+ NUM NUM) NUM)');
    // 括号确实建了节点（甲方案：照 tree-sitter 保留）
    if (top.kind === 'BinaryOp') expect(top.lhs.kind).toBe('Paren');
  });

  it('调用：具名参数与普通参数分开表示', () => {
    expect(first('f(a)')).toBe('(f a)');
    expect(first('f(a, b = 2)')).toBe('(f a (= b NUM))');
  });

  it('调用：空实参也保留（f(a, ) 合法）', () => {
    const program = parse('f(a, )');
    const call = program.body[0];
    expect(call.kind).toBe('Call');
    if (call.kind === 'Call') {
      expect(call.arguments).toHaveLength(2);
      expect(call.arguments[1]?.value).toBeUndefined();
    }
  });

  it('取子集：x[1] 与 x[[1]]', () => {
    expect(first('x[1]')).toBe('([ x NUM)');
    expect(first('x[[1]]')).toBe('([[ x NUM)');
  });

  it('赋值是右结合（x <- y <- 5）', () => {
    expect(first('x <- y <- 5')).toBe('(<- x (<- y NUM))');
  });

  it('赋值方向记在 operator.text 里', () => {
    const program = parse('1 -> x');
    expect(program.body[0]?.kind).toBe('Assign');
    if (program.body[0]?.kind === 'Assign') {
      expect(program.body[0].operator.text).toBe('->');
    }
  });

  it('多个运算符混用：a %in% b（SPECIAL 运算符）', () => {
    expect(first('a %in% b')).toBe('(%in% a b)');
  });
});

describe('parseCst 顶层与注释', () => {
  it('多条语句按顺序进 body', () => {
    const program = parse('a <- 1\nb <- 2');
    expect(program.body).toHaveLength(2);
    expect(program.body.map((n) => n.kind)).toEqual(['Assign', 'Assign']);
  });

  it('尾注释进 trailingComments，独占一行的进 ownLineComments', () => {
    const program = parse('a + b # 尾巴\n# 独行\nc');
    expect(program.trailingComments.map((c) => c.text)).toEqual(['# 尾巴']);
    expect(program.ownLineComments.map((c) => c.text)).toEqual(['# 独行']);
    expect(program.body).toHaveLength(2); // `a + b` 和 `c`
  });

  it('TRUE / FALSE / NULL / NA 是字面量，不是名字', () => {
    expect(parse('TRUE').body[0]?.kind).toBe('Literal');
    expect(parse('NULL').body[0]?.kind).toBe('Literal');
    expect(parse('NA').body[0]?.kind).toBe('Literal');
    expect(parse('abc').body[0]?.kind).toBe('Identifier');
  });

  it('字面量存着原文（值本身是语义）', () => {
    const literal = parse('1 + 2 * 3').body[0];
    expect(literal?.kind).toBe('BinaryOp');
    if (literal?.kind !== 'BinaryOp') return;
    expect(literal.lhs).toMatchObject({ kind: 'Literal', literalKind: 'number', text: '1' });
    if (literal.rhs.kind !== 'BinaryOp') return;
    expect(literal.rhs.lhs).toMatchObject({ kind: 'Literal', text: '2' });
    expect(literal.rhs.rhs).toMatchObject({ kind: 'Literal', text: '3' });
    expect(parse('TRUE').body[0]).toMatchObject({ kind: 'Literal', literalKind: 'logical', text: 'TRUE' });
    // 字符串的 text 是"去掉引号"的内容（tokenizer 就是这么存的）
    expect(parse('"hi"').body[0]).toMatchObject({ kind: 'Literal', literalKind: 'string', text: 'hi' });
  });

  it('空文件 → 空的 Program，不抛异常', () => {
    const program = parse('');
    expect(program.kind).toBe('Program');
    expect(program.body).toEqual([]);
  });
});

describe('parseCst 位置字段', () => {
  it('每个节点都带 4 个位置字段，且区间合理', () => {
    const code = 'p$name';
    const program = parse(code);
    const top = program.body[0];
    expect(top).toBeDefined();
    if (top === undefined) return;
    expect(top.stIndex).toBe(0);
    expect(top.enIndex).toBe(2); // p $ name
    expect(top.stOffset).toBe(0);
    expect(top.enOffset).toBe(code.length);
  });
});
