import { describe, expect, it } from 'vitest';
import { parseBindings } from '../../src/analysis/bindings';

describe('parseBindings 扫描赋值', () => {
  it('R6 类定义：Person <- R6Class(...)', () => {
    const text = 'Person <- R6Class("Person", public = list())';
    expect(parseBindings(text)).toEqual([
      { varName: 'Person', rhs: { kind: 'r6-class-def' }, offset: 0 },
    ]);
  });

  it('命名空间类定义：Person <- R6::R6Class(...)', () => {
    const text = 'Person <- R6::R6Class("Person")';
    expect(parseBindings(text)).toEqual([
      { varName: 'Person', rhs: { kind: 'r6-class-def' }, offset: 0 },
    ]);
  });

  it('实例创建：p <- Person$new()', () => {
    const text = 'p <- Person$new()';
    expect(parseBindings(text)).toEqual([
      { varName: 'p', rhs: { kind: 'r6-class-new', sourceName: 'Person' }, offset: 0 },
    ]);
  });

  it('函数定义：func <- function(x) x', () => {
    const text = 'func <- function(x) x';
    expect(parseBindings(text)).toEqual([
      { varName: 'func', rhs: { kind: 'function' }, offset: 0 },
    ]);
  });

  it('表达式：c <- 1 + 1', () => {
    const text = 'c <- 1 + 1';
    expect(parseBindings(text)).toEqual([
      { varName: 'c', rhs: { kind: 'unknown' }, offset: 0 },
    ]);
  });

  it('别名：p <- q（右边只有标识符，语句结束）', () => {
    const text = 'q <- Person$new()\np <- q';
    expect(parseBindings(text)).toEqual([
      { varName: 'q', rhs: { kind: 'r6-class-new', sourceName: 'Person' }, offset: 0 },
      { varName: 'p', rhs: { kind: 'alias', sourceName: 'q' }, offset: 18 },
    ]);
  });

  it('右边是表达式不是别名：p <- q + 1', () => {
    const text = 'p <- q + 1';
    expect(parseBindings(text)).toEqual([
      { varName: 'p', rhs: { kind: 'unknown' }, offset: 0 },
    ]);
  });

  it('成员赋值 self$x <- 1 不记录（不是独立变量）', () => {
    const text = 'f <- function() self$x <- 1';
    // 只有 f <- function 一条记录；self$x <- 1 的 x 前面是 $，跳过
    expect(parseBindings(text)).toEqual([
      { varName: 'f', rhs: { kind: 'function' }, offset: 0 },
    ]);
  });

  it('纯数字赋值：x <- 5', () => {
    const text = 'x <- 5';
    expect(parseBindings(text)).toEqual([
      { varName: 'x', rhs: { kind: 'unknown' }, offset: 0 },
    ]);
  });

  it('多个绑定按代码顺序返回', () => {
    const text = 'Person <- R6Class("Person")\np <- Person$new()\np$name';
    expect(parseBindings(text)).toEqual([
      { varName: 'Person', rhs: { kind: 'r6-class-def' }, offset: 0 },
      { varName: 'p', rhs: { kind: 'r6-class-new', sourceName: 'Person' }, offset: 28 },
    ]);
  });
});
