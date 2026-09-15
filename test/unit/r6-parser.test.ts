import { describe, expect, it } from 'vitest';
import { tokenize } from '../../src/parser/tokenizer';
import { parseR6 } from '../../src/parser/r6-parser';

describe('parseR6 识别 R6 类定义', () => {
  // 约定：类定义断言用 toMatchObject（部分匹配）—— 只检查关心的字段
  // （name/nameOffset/members），不关心将来新增的字段（如调用范围），避免连环改测试

  it('基础写法：字符串给类名，类名在 <- 左侧', () => {
    const text = 'Person <- R6Class("Person", public = list())';
    expect(parseR6(tokenize(text))).toMatchObject([{ name: 'Person', nameOffset: 0, members: [] }]);
  });

  it('无字符串：类名取自 <- 左侧', () => {
    const text = 'Person <- R6Class(public = list())';
    expect(parseR6(tokenize(text))).toMatchObject([{ name: 'Person', nameOffset: 0, members: [] }]);
  });

  it('命名空间写法 R6::R6Class，类名仍取 <- 左侧', () => {
    // 极端例子：左侧 Person1 与字符串 "Persion"（拼写还不一致）——
    // 跳转/补全匹配的是引用名 Person1，所以必须以左侧为准
    const text = 'Person1 <- R6::R6Class("Persion", public = list())';
    expect(parseR6(tokenize(text))).toMatchObject([{ name: 'Person1', nameOffset: 0, members: [] }]);
  });

  it('<- 左右不在同一行也能识别（跨行赋值）', () => {
    const text = 'Person <-\n  R6Class("Person", public = list())';
    expect(parseR6(tokenize(text))).toMatchObject([{ name: 'Person', nameOffset: 0, members: [] }]);
  });

  it('注释/字符串里的假 R6Class 不算数', () => {
    const text = '# R6Class("Fake")\nx <- "R6Class(\'Fake\')"';
    expect(parseR6(tokenize(text))).toEqual([]);
  });

  it('找不到类名则跳过', () => {
    const text = 'R6Class(public = list(a = 1))';
    expect(parseR6(tokenize(text))).toEqual([]);
  });

  it('嵌套在其它调用内部的 R6Class 被跳过', () => {
    const text =
      'Outer <- R6Class("Outer", public = list(make = function() {\n' +
      '  Inner <- R6Class("Inner")\n' +
      '  Inner\n' +
      '}))';
    // 只查类名：只应识别出 Outer（方法体里的 Inner 被跳过）
    // 不查 members —— 本用例只关心"嵌套类被跳过"，不关心 Outer 的成员
    const result = parseR6(tokenize(text));
    expect(result.map((c) => c.name)).toEqual(['Outer']);
  });

  it('多个类都识别，nameOffset 指向各自类名', () => {
    const text = 'A <- R6Class("A")\nB <- R6Class("B", inherit = A)';
    expect(parseR6(tokenize(text))).toMatchObject([
      { name: 'A', nameOffset: 0, members: [] },
      { name: 'B', nameOffset: 18, members: [] },
    ]);
  });
});

describe('parseR6 提取成员', () => {
  it('三个区都提取，scope 正确', () => {
    const text =
      'Person <- R6Class("Person",\n' +
      '  public = list(greet = function() "hi", name = NULL),\n' +
      '  private = list(age = NA),\n' +
      '  active = list(age = function(value) private$age)\n' +
      ')';
    const result = parseR6(tokenize(text));
    expect(result).toHaveLength(1);
    const members = result[0].members;
    // 只看名字和区，忽略偏移量
    expect(
      members.map((m) => ({ name: m.name, scope: m.scope })),
    ).toEqual([
      { name: 'greet', scope: 'public' },
      { name: 'name', scope: 'public' },
      { name: 'age', scope: 'private' },
      { name: 'age', scope: 'active' },
    ]);
  });

  it('成员项的 [ ] 索引里的逗号不会被误切（matrix(...)[1, ]）', () => {
    const text =
      'Person <- R6Class("Person",\n' +
      '  public = list(\n' +
      '    m = matrix(1:4, 2)[1, ],\n' +
      '    n = 5\n' +
      '  )\n' +
      ')';
    const result = parseR6(tokenize(text));
    const members = result[0].members;
    expect(members.map((m) => m.name)).toEqual(['m', 'n']);
  });

  it('{ } 表达式块内的 public 不会被误认为区', () => {
    const text =
      'Person <- R6Class("Person",\n' +
      '  public = list(greet = function() "hi"),\n' +
      '  lock_objects = { public = list(x = 1); public }\n' +
      ')';
    const result = parseR6(tokenize(text));
    expect(result[0].members.map((m) => m.name)).toEqual(['greet']);
  });

  it('方法体内的 public 局部变量不会被误认为区', () => {
    const text =
      'Person <- R6Class("Person",\n' +
      '  public = list(\n' +
      '    foo = function() {\n' +
      '      public <- 1\n' +
      '      public\n' +
      '    }\n' +
      '  )\n' +
      ')';
    const result = parseR6(tokenize(text));
    expect(result[0].members.map((m) => m.name)).toEqual(['foo']);
  });

  it('没有任何区时 members 为空数组', () => {
    const text = 'Person <- R6Class("Person")';
    expect(parseR6(tokenize(text))).toMatchObject([{ name: 'Person', nameOffset: 0, members: [] }]);
  });
});

describe('parseR6 提取 inherit（父类引用）', () => {
  it('裸类名写法：inherit = Parent → kind name，className = Parent', () => {
    const text =
      'Parent <- R6Class("Parent")\n' +
      'Child <- R6Class("Child", inherit = Parent, public = list())';
    const result = parseR6(tokenize(text));
    // 偏移量：第二行 inherit 后面的 Parent token 起点
    const inheritOffset = text.indexOf('Parent', text.indexOf('inherit'));
    expect(result[1].inherit).toEqual({
      kind: 'name',
      className: 'Parent',
      offset: inheritOffset,
    });
  });

  it('$ 链写法（模块限定）：inherit = person$Parent → kind chain，className = 链尾名', () => {
    const text = 'Child <- R6Class("Child", inherit = person$Parent)';
    const result = parseR6(tokenize(text));
    expect(result[0].inherit).toEqual({
      kind: 'chain',
      className: 'Parent',
      offset: text.indexOf('Parent'),
    });
  });

  it('引号字符串写法：inherit = "Parent" → kind string，className = 字符串内容', () => {
    const text = 'Child <- R6Class("Child", inherit = "Parent")';
    const result = parseR6(tokenize(text));
    // 字符串 token 的偏移指向开引号位置（比 Parent 文本早 1 个字符）
    expect(result[0].inherit).toEqual({
      kind: 'string',
      className: 'Parent',
      offset: text.indexOf('Parent') - 1,
    });
  });

  it('没写 inherit → inherit 为 undefined', () => {
    const text = 'Person <- R6Class("Person", public = list())';
    const result = parseR6(tokenize(text));
    expect(result[0].inherit).toBeUndefined();
  });

  it('inherit 参数在 public 之后也能识别（参数位置不固定）', () => {
    const text =
      'Parent <- R6Class("Parent")\n' +
      'Child <- R6Class(\n' +
      '  "Child",\n' +
      '  public = list(foo = function() 1),\n' +
      '  inherit = Parent\n' +
      ')';
    const result = parseR6(tokenize(text));
    expect(result[1].inherit).toEqual({
      kind: 'name',
      className: 'Parent',
      offset: text.indexOf('Parent', text.indexOf('inherit')),
    });
  });

  it('同时有 inherit 和成员区：两者都提取，互不干扰', () => {
    const text =
      'Parent <- R6Class("Parent")\n' +
      'Child <- R6Class("Child", inherit = Parent,\n' +
      '  public = list(foo = function() 1))';
    const result = parseR6(tokenize(text));
    const child = result[1];
    expect(child.inherit).toEqual({
      kind: 'name',
      className: 'Parent',
      offset: text.indexOf('Parent', text.indexOf('inherit')),
    });
    expect(child.members.map((m) => m.name)).toEqual(['foo']);
  });

  it('inherit 后是函数调用形状（写法不认）→ inherit 为 undefined', () => {
    const text = 'Child <- R6Class("Child", inherit = build_parent())';
    const result = parseR6(tokenize(text));
    expect(result[0].inherit).toBeUndefined();
  });

  it('inherit 链尾是 new 调用（非法用法）→ 父类名取 new 前一个名字', () => {
    const text = 'Child <- R6Class("Child", inherit = pkg$Parent$new())';
    const result = parseR6(tokenize(text));
    expect(result[0].inherit).toEqual({
      kind: 'chain',
      className: 'Parent',
      offset: text.indexOf('Parent'),
    });
  });
});
