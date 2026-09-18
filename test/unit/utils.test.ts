import { describe, expect, it } from 'vitest';
import { nextNonComment, nextNonCommentIndex, splitTopLevel } from '../../src/parser/utils';
import { tokenize } from '../../src/parser/tokenizer';

/** 辅助：把切出来的区间还原成原文片段（比堆下标好读，也顺便验证区间是"下标"而非文本） */
function piecesOf(text: string): string[] {
  const tokens = tokenize(text);
  const openIndex = tokens.findIndex((t) => t.text === '(');
  const closeIndex = tokens.length - 1; // 文本末尾就是配对的 ')'
  return splitTopLevel(tokens, openIndex, closeIndex).map(([stIndex, enIndex]) =>
    tokens
      .slice(stIndex, enIndex)
      .map((t) => t.text)
      .join(' '),
  );
}

describe('nextNonComment / nextNonCommentIndex 跳过注释', () => {
  it('前面是注释 → 往后找到第一个非注释 token', () => {
    const tokens = tokenize('# 注释\nx <- 1');
    // token 顺序：注释(0) x(1) <-(2) 1(3)
    expect(nextNonCommentIndex(tokens, 0)).toBe(1);
    expect(nextNonComment(tokens, 0)?.text).toBe('x');
  });

  it('连续多条注释 → 一路跳过', () => {
    const tokens = tokenize('# a\n# b\nx');
    expect(nextNonComment(tokens, 0)?.text).toBe('x');
  });

  it('当前位置不是注释 → 原样返回自己', () => {
    const tokens = tokenize('x # 尾巴');
    expect(nextNonCommentIndex(tokens, 0)).toBe(0);
  });

  it('越界 / 到尾 → undefined（不是 -1 或 length 这种非法下标）', () => {
    const tokens = tokenize('x');
    expect(nextNonCommentIndex(tokens, 5)).toBeUndefined();
    expect(nextNonComment(tokens, 5)).toBeUndefined();
    expect(nextNonCommentIndex(tokenize('# 只有注释'), 0)).toBeUndefined();
  });
});

describe('splitTopLevel 按顶层逗号切块', () => {
  it('空括号 → 切出一个空区间', () => {
    expect(piecesOf('f()')).toEqual(['']);
  });

  it('没有逗号 → 一整块', () => {
    expect(piecesOf('f(a)')).toEqual(['a']);
  });

  it('多个顶层逗号 → 按书写顺序切块', () => {
    expect(piecesOf('f(a, b, c)')).toEqual(['a', 'b', 'c']);
  });

  it('嵌套括号里的逗号**不**切（圆括号 / 花括号 / 方括号都要挡住）', () => {
    expect(piecesOf('f(g(a, b), c)')).toEqual(['g ( a , b )', 'c']);
    expect(piecesOf('f({ a, b }, c)')).toEqual(['{ a , b }', 'c']);
    expect(piecesOf('f(x[a, b], c)')).toEqual(['x [ a , b ]', 'c']);
  });

  it('R6 真实写法：public/private 里的成员逗号都在括号内，不会被误切', () => {
    const text = 'R6Class("P", public = list(a = x, b = y), private = list(c = z))';
    // 注意两点：
    //   ① 块从开括号之后开始 → 第一块不含函数名 R6Class；
    //   ② 字符串 token 的 text **不含引号**（词法器约定）→ 这里是 P 而不是 "P"
    expect(piecesOf(text)).toEqual([
      'P',
      'public = list ( a = x , b = y )',
      'private = list ( c = z )',
    ]);
  });

  it('尾随逗号 → 多切出一个空区间（由调用方决定要不要）', () => {
    expect(piecesOf('f(a, )')).toEqual(['a', '']);
  });

  it('区间是"左闭右开"的 token 下标：首块从开括号的下一个开始，末块到闭括号前结束', () => {
    const tokens = tokenize('f(a, b)');
    // token 顺序：f(0) ((1) a(2) ,(3) b(4) )(5)
    expect(splitTopLevel(tokens, 1, 5)).toEqual([
      [2, 3],
      [4, 5],
    ]);
  });

  it('注释不参与切分判断（它不是运算符，既不加深度也不触发切块）', () => {
    const pieces = piecesOf('f(a, # 说明\n b)');
    expect(pieces).toHaveLength(2); // 注释没有多切出一块
    expect(pieces[0]).toBe('a');
    // 第二块里含注释 token（换行注释在原文里属于这一块）——"取名字时跳过注释"是调用方的事（nextNonComment）
    expect(pieces[1]).toContain('b');
  });
});
