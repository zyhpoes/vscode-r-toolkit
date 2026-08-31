import { describe, expect, it } from 'vitest';
import { parseR6 } from '../../src/parser/r6-parser';

describe('parseR6 识别 R6 类定义', () => {
  it('基础写法：字符串给类名，类名在 <- 左侧', () => {
    const text = 'Person <- R6Class("Person", public = list())';
    expect(parseR6(text)).toEqual([{ name: 'Person', nameOffset: 0 }]);
  });

  it('无字符串：类名取自 <- 左侧', () => {
    const text = 'Person <- R6Class(public = list())';
    expect(parseR6(text)).toEqual([{ name: 'Person', nameOffset: 0 }]);
  });

  it('命名空间写法 R6::R6Class，类名仍取 <- 左侧', () => {
    // 极端例子：左侧 Person1 与字符串 "Persion"（拼写还不一致）——
    // 跳转/补全匹配的是引用名 Person1，所以必须以左侧为准
    const text = 'Person1 <- R6::R6Class("Persion", public = list())';
    expect(parseR6(text)).toEqual([{ name: 'Person1', nameOffset: 0 }]);
  });

  it('<- 左右不在同一行也能识别（跨行赋值）', () => {
    const text = 'Person <-\n  R6Class("Person", public = list())';
    expect(parseR6(text)).toEqual([{ name: 'Person', nameOffset: 0 }]);
  });

  it('注释/字符串里的假 R6Class 不算数', () => {
    const text = '# R6Class("Fake")\nx <- "R6Class(\'Fake\')"';
    expect(parseR6(text)).toEqual([]);
  });

  it('找不到类名则跳过', () => {
    const text = 'R6Class(public = list(a = 1))';
    expect(parseR6(text)).toEqual([]);
  });

  it('嵌套在其它调用内部的 R6Class 被跳过', () => {
    const text =
      'Outer <- R6Class("Outer", public = list(make = function() {\n' +
      '  Inner <- R6Class("Inner")\n' +
      '  Inner\n' +
      '}))';
    expect(parseR6(text)).toEqual([{ name: 'Outer', nameOffset: 0 }]);
  });

  it('多个类都识别，nameOffset 指向各自类名', () => {
    const text = 'A <- R6Class("A")\nB <- R6Class("B", inherit = A)';
    expect(parseR6(text)).toEqual([
      { name: 'A', nameOffset: 0 },
      { name: 'B', nameOffset: 18 },
    ]);
  });
});
