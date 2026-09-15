import { describe, expect, it } from 'vitest';
import { tokenize } from '../../src/parser/tokenizer';
import { findLatestBinding, parseBindings } from '../../src/analysis/bindings';

describe('parseBindings 扫描赋值（只记录，不分类）', () => {
  it('记录类定义：Person <- R6Class(...)', () => {
    const text = 'Person <- R6Class("Person", public = list())';
    expect(parseBindings(tokenize(text))).toEqual([
      { varName: 'Person', stIndex: 2, offset: 0 },
    ]);
  });

  it('记录实例创建：p <- Person$new()', () => {
    const text = 'p <- Person$new()';
    expect(parseBindings(tokenize(text))).toEqual([
      { varName: 'p', stIndex: 2, offset: 0 },
    ]);
  });

  it('记录函数定义：func <- function(x) x', () => {
    const text = 'func <- function(x) x';
    expect(parseBindings(tokenize(text))).toEqual([
      { varName: 'func', stIndex: 2, offset: 0 },
    ]);
  });

  it('记录表达式：c <- 1 + 1', () => {
    const text = 'c <- 1 + 1';
    expect(parseBindings(tokenize(text))).toEqual([
      { varName: 'c', stIndex: 2, offset: 0 },
    ]);
  });

  it('记录别名：p <- q', () => {
    const text = 'q <- Person$new()\np <- q';
    // q <- Person$new()：q(0) <-(1) Person(2) → q 的 stIndex=2
    // p <- q：p(7) <-(8) q(9) → p 的 stIndex=9
    expect(parseBindings(tokenize(text))).toEqual([
      { varName: 'q', stIndex: 2, offset: 0 },
      { varName: 'p', stIndex: 9, offset: 18 },
    ]);
  });

  it('成员赋值 self$x <- 1 不记录（不是独立变量）', () => {
    const text = 'f <- function() self$x <- 1';
    // 只有 f <- function 一条记录；self$x <- 1 的 x 前面是 $，跳过
    expect(parseBindings(tokenize(text))).toEqual([
      { varName: 'f', stIndex: 2, offset: 0 },
    ]);
  });

  it('多个绑定按代码顺序返回', () => {
    const text = 'Person <- R6Class("Person")\np <- Person$new()\np$name';
    // Person <- ...：Person(0) <-(1) R6Class(2) → stIndex=2
    // p <- ...：p(6) <-(7) Person(8) → stIndex=8
    expect(parseBindings(tokenize(text))).toEqual([
      { varName: 'Person', stIndex: 2, offset: 0 },
      { varName: 'p', stIndex: 8, offset: 28 },
    ]);
  });
});

describe('findLatestBinding 找光标前最近一次赋值', () => {
  it('命中：查 q 返回 q 那条赋值（带 stIndex / offset）', () => {
    const text =
      'q <- Person$new()\n' + // q 的赋值：q(0) <-(1) Person(2) → stIndex=2、offset=0
      'p <- q';
    const bindings = parseBindings(tokenize(text));
    // 光标在文件末尾：两条赋值都在光标之前，查 q 应命中 q 那条
    expect(findLatestBinding(bindings, 'q', text.length)).toEqual({
      varName: 'q',
      stIndex: 2,
      offset: 0,
    });
  });

  it('同一变量赋值两次 → 返回后面那一次（守住"从尾往前扫"的方向）', () => {
    const text =
      'x <- 1\n' + // 第 0 行：第一次赋值
      'x <- 2'; // 第 1 行：第二次赋值（光标前最近的一次是它）
    const bindings = parseBindings(tokenize(text));
    const hit = findLatestBinding(bindings, 'x', text.length);
    expect(hit?.offset).toBe(text.indexOf('x', 1)); // 第二次 x 的位置，而不是第 0 行那个
  });

  it('光标之前没有该变量的赋值 → undefined（之后的赋值不算）', () => {
    const text =
      'p$name\n' + // 第 0 行：光标在这里，此时 p 还没被赋值
      'p <- Person$new()'; // 第 1 行：赋值在光标之后
    const bindings = parseBindings(tokenize(text));
    expect(findLatestBinding(bindings, 'p', 'p$name'.length)).toBeUndefined();
  });

  it('光标正好落在赋值处 → 也算命中（守住 <= 边界）', () => {
    const text = 'q <- Person$new()';
    const bindings = parseBindings(tokenize(text));
    // 光标落在变量名 q 的偏移 0 上：边界含等号，应命中
    expect(findLatestBinding(bindings, 'q', 0)).toEqual({
      varName: 'q',
      stIndex: 2,
      offset: 0,
    });
  });
});
