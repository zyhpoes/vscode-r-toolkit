import { describe, expect, it } from 'vitest';
import { parseBindings } from '../../src/analysis/bindings';

describe('parseBindings 扫描赋值（只记录，不分类）', () => {
  it('记录类定义：Person <- R6Class(...)', () => {
    const text = 'Person <- R6Class("Person", public = list())';
    expect(parseBindings(text)).toEqual([
      { varName: 'Person', stIndex: 2, offset: 0 },
    ]);
  });

  it('记录实例创建：p <- Person$new()', () => {
    const text = 'p <- Person$new()';
    expect(parseBindings(text)).toEqual([
      { varName: 'p', stIndex: 2, offset: 0 },
    ]);
  });

  it('记录函数定义：func <- function(x) x', () => {
    const text = 'func <- function(x) x';
    expect(parseBindings(text)).toEqual([
      { varName: 'func', stIndex: 2, offset: 0 },
    ]);
  });

  it('记录表达式：c <- 1 + 1', () => {
    const text = 'c <- 1 + 1';
    expect(parseBindings(text)).toEqual([
      { varName: 'c', stIndex: 2, offset: 0 },
    ]);
  });

  it('记录别名：p <- q', () => {
    const text = 'q <- Person$new()\np <- q';
    // q <- Person$new()：q(0) <-(1) Person(2) → q 的 stIndex=2
    // p <- q：p(7) <-(8) q(9) → p 的 stIndex=9
    expect(parseBindings(text)).toEqual([
      { varName: 'q', stIndex: 2, offset: 0 },
      { varName: 'p', stIndex: 9, offset: 18 },
    ]);
  });

  it('成员赋值 self$x <- 1 不记录（不是独立变量）', () => {
    const text = 'f <- function() self$x <- 1';
    // 只有 f <- function 一条记录；self$x <- 1 的 x 前面是 $，跳过
    expect(parseBindings(text)).toEqual([
      { varName: 'f', stIndex: 2, offset: 0 },
    ]);
  });

  it('多个绑定按代码顺序返回', () => {
    const text = 'Person <- R6Class("Person")\np <- Person$new()\np$name';
    // Person <- ...：Person(0) <-(1) R6Class(2) → stIndex=2
    // p <- ...：p(6) <-(7) Person(8) → stIndex=8
    expect(parseBindings(text)).toEqual([
      { varName: 'Person', stIndex: 2, offset: 0 },
      { varName: 'p', stIndex: 8, offset: 28 },
    ]);
  });
});
