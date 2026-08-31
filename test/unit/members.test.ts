import { describe, expect, it } from 'vitest';
import { resolveMemberDefinition } from '../../src/analysis/members';

describe('resolveMemberDefinition 光标定位成员定义', () => {
  it('self$greet → 跳到 public 区 greet 定义处', () => {
    // greet 方法体内引用 self$greet（自引用）
    const text = 'Person <- R6Class("Person", public = list(greet = function() self$greet))';
    // 定义处 greet 在 "list(" 之后：character 42（数过：list( 结束于 41）
    const cursor = text.indexOf('self$greet') + 'self$'.length + 2;
    expect(resolveMemberDefinition(text, cursor)).toEqual({ name: 'greet', line: 0, character: 42 });
  });

  it('private$age → 跳到 private 区 age 定义处', () => {
    const text =
      'Person <- R6Class("Person",\n' + // 第 0 行
      '  private = list(age = NA),\n' + // 第 1 行：age 在 "  private = list(" 之后，character 17
      '  public = list(get_age = function() private$age)\n' +
      ')';
    const cursor = text.indexOf('private$age') + 'private$'.length + 1;
    expect(resolveMemberDefinition(text, cursor)).toEqual({ name: 'age', line: 1, character: 17 });
  });

  it('类名$成员 → 跳到该类 public 区成员定义处', () => {
    const text =
      'Person <- R6Class("Person",\n' +
      '  public = list(\n' +
      '    greet = function() "hi",\n' + // 第 2 行：greet 在 4 个空格后，character 4
      '    name = NULL\n' +
      '  )\n' +
      ')\n' +
      'Person$greet';
    const cursor = text.indexOf('Person$greet') + 'Person$'.length + 2;
    expect(resolveMemberDefinition(text, cursor)).toEqual({ name: 'greet', line: 2, character: 4 });
  });

  it('两个类都有 self$name → 各自跳到自己类的 name（位置反查）', () => {
    const text =
      'A <- R6Class("A", public = list(name = NULL, f = function() self$name))\n' + // 第 0 行
      'B <- R6Class("B", public = list(name = NULL, f = function() self$name))'; // 第 1 行
    // 两个类的 name 定义位置相同（结构一样）：在 "list(" 之后，character 32
    const cursor1 = text.indexOf('self$name') + 'self$'.length + 2;
    expect(resolveMemberDefinition(text, cursor1)).toEqual({ name: 'name', line: 0, character: 32 });

    const cursor2 = text.indexOf('self$name', cursor1 + 1) + 'self$'.length + 2;
    expect(resolveMemberDefinition(text, cursor2)).toEqual({ name: 'name', line: 1, character: 32 });
  });

  it('self$ 能访问 active 区的成员（跳到 active 而非 private 的同名 age）', () => {
    const text =
      'Person <- R6Class("Person",\n' +
      '  active = list(age = function(value) private$age),\n' + // 第 1 行：active 的 age，character 16
      '  private = list(age = NA),\n' + // 第 2 行：private 的 age（self 不应跳到这）
      '  public = list(f = function() self$age)\n' +
      ')';
    const cursor = text.indexOf('self$age') + 'self$'.length + 2;
    expect(resolveMemberDefinition(text, cursor)).toEqual({ name: 'age', line: 1, character: 16 });
  });

  it('普通变量（前面没有 $）→ null', () => {
    const text =
      'Person <- R6Class("Person", public = list(greet = function() "hi"))\n' +
      'x <- greet';
    // 光标在普通变量 greet 上（前面是空格不是 $）
    const cursor = text.indexOf('x <- greet') + 'x <- '.length + 2;
    expect(resolveMemberDefinition(text, cursor)).toBeNull();
  });

  it('类里没有这个成员 → null', () => {
    const text =
      'Person <- R6Class("Person", public = list(greet = function() "hi"))\n' +
      'Person$missing';
    const cursor = text.indexOf('Person$missing') + 'Person$'.length + 2;
    expect(resolveMemberDefinition(text, cursor)).toBeNull();
  });
});
