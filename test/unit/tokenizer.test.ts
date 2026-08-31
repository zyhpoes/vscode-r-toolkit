import { describe, expect, it } from 'vitest';
import { tokenize, type Token } from '../../src/parser/tokenizer';

// 辅助：只取 token 的种类，忽略位置，让断言简洁
function kinds(tokens: Token[]): string[] {
  return tokens.map((t) => t.kind);
}

// 辅助：只取 token 的文本
function texts(tokens: Token[]): string[] {
  return tokens.map((t) => t.text);
}

// 辅助：取成对的 [种类, 文本] —— 一行同时看到两种信息，可读性更高
function pairs(tokens: Token[]): Array<[string, string]> {
  return tokens.map((t): [string, string] => [t.kind, t.text]);
}

describe('tokenize 基本切分', () => {
  it('真实 R6 代码：完整切分', () => {
    const text = 'Person <- R6Class("Person", public = list(initialize = function(name) {}))';
    const tokens = tokenize(text);
    expect(pairs(tokens)).toEqual([
      ['identifier', 'Person'],
      ['operator', '<-'],
      ['identifier', 'R6Class'],
      ['operator', '('],
      ['string', 'Person'],
      ['operator', ','],
      ['identifier', 'public'],
      ['operator', '='],
      ['identifier', 'list'],
      ['operator', '('],
      ['identifier', 'initialize'],
      ['operator', '='],
      ['identifier', 'function'],
      ['operator', '('],
      ['identifier', 'name'],
      ['operator', ')'],
      ['operator', '{'],
      ['operator', '}'],
      ['operator', ')'],
      ['operator', ')'],
    ]);
  });

  it('注释里的 R6Class 不算数', () => {
    const tokens = tokenize('# R6Class("假的")');
    // 关键断言 1：整行只产生 1 个 token 且是注释 —— 里面的 R6Class 没有被切出来
    expect(tokens).toHaveLength(1);
    expect(tokens[0].kind).toBe('comment');
    // 关键断言 2：注释内容被完整保留（原文照存，没被截断）
    expect(tokens[0].text).toBe('# R6Class("假的")');
  });

  it('字符串里的 R6Class 不算数', () => {
    const tokens = tokenize('x <- "R6Class(\'假的\')"');
    // 只有 x <- 和字符串，字符串里不产生 R6Class token
    expect(texts(tokens)).toEqual(['x', '<-', "R6Class('假的')"]);
    expect(kinds(tokens)).toEqual(['identifier', 'operator', 'string']);
  });

  it('self$name 被切为三个 token（$ 是关键分隔）', () => {
    const tokens = tokenize('self$name');
    expect(texts(tokens)).toEqual(['self', '$', 'name']);
    expect(kinds(tokens)).toEqual(['identifier', 'operator', 'identifier']);
  });

  it('反引号标识符', () => {
    const tokens = tokenize('`weird name` <- 1');
    expect(texts(tokens)).toEqual(['weird name', '<-', '1']);
    expect(kinds(tokens)).toEqual(['identifier', 'operator', 'number']);
  });

  it('运算符最长匹配：<-、<<-、->>、%>%', () => {
    expect(texts(tokenize('a <<- b'))).toEqual(['a', '<<-', 'b']);
    expect(texts(tokenize('a ->> b'))).toEqual(['a', '->>', 'b']);
    expect(texts(tokenize('a %>% b'))).toEqual(['a', '%>%', 'b']);
    expect(texts(tokenize('a <- b'))).toEqual(['a', '<-', 'b']);
  });

  it('命名空间运算符 :: 和 :::', () => {
    expect(texts(tokenize('R6::R6Class'))).toEqual(['R6', '::', 'R6Class']);
    expect(texts(tokenize('R6:::R6Class'))).toEqual(['R6', ':::', 'R6Class']);
  });

  it('数字：整数、小数、.5', () => {
    expect(texts(tokenize('123'))).toEqual(['123']);
    expect(texts(tokenize('1.5'))).toEqual(['1.5']);
    expect(texts(tokenize('.5'))).toEqual(['.5']);
    expect(kinds(tokenize('1.5'))).toEqual(['number']);
  });

  it('单引号字符串', () => {
    const tokens = tokenize("'abc'");
    expect(texts(tokens)).toEqual(['abc']);
    expect(kinds(tokens)).toEqual(['string']);
  });
});

describe('tokenize 位置与边界', () => {
  it('token 的 offset 指向原文中的起始位置', () => {
    const tokens = tokenize('Person <- R6Class');
    expect(tokens.map((t) => t.offset)).toEqual([0, 7, 10]);
  });

  it('空文本 → 空数组', () => {
    expect(tokenize('')).toEqual([]);
  });

  it('纯空白 → 空数组', () => {
    expect(tokenize('  \t\n  ')).toEqual([]);
  });
});
