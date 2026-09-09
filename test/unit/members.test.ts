import { describe, expect, it } from 'vitest';
import { resolveMemberDefinition } from '../../src/analysis/members';
import { createContext, type AnalysisContext } from '../../src/analysis/context';
import type { SourceFile } from '../../src/analysis/source-file';

// 辅助：把单文件文本包装成 ctx（当前文件 uri 固定为 test.R）
function singleCtx(text: string): AnalysisContext {
  return createContext([{ uri: 'test.R', text }], 'test.R');
}

describe('resolveMemberDefinition 单文件光标定位成员定义', () => {
  it('self$greet → 跳到 public 区 greet 定义处', () => {
    // greet 方法体内引用 self$greet（自引用）
    const text = 'Person <- R6Class("Person", public = list(greet = function() self$greet))';
    const ctx = singleCtx(text);
    const cursor = text.indexOf('self$greet') + 'self$'.length + 2;
    expect(resolveMemberDefinition(ctx, cursor)).toEqual({
      name: 'greet',
      uri: 'test.R',
      line: 0,
      character: 42,
    });
  });

  it('private$age → 跳到 private 区 age 定义处', () => {
    const text =
      'Person <- R6Class("Person",\n' + // 第 0 行
      '  private = list(age = NA),\n' + // 第 1 行：age 在 "  private = list(" 之后，character 17
      '  public = list(get_age = function() private$age)\n' +
      ')';
    const ctx = singleCtx(text);
    const cursor = text.indexOf('private$age') + 'private$'.length + 1;
    expect(resolveMemberDefinition(ctx, cursor)).toEqual({
      name: 'age',
      uri: 'test.R',
      line: 1,
      character: 17,
    });
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
    const ctx = singleCtx(text);
    const cursor = text.indexOf('Person$greet') + 'Person$'.length + 2;
    expect(resolveMemberDefinition(ctx, cursor)).toEqual({
      name: 'greet',
      uri: 'test.R',
      line: 2,
      character: 4,
    });
  });

  it('两个类都有 self$name → 各自跳到自己类的 name（位置反查）', () => {
    const text =
      'A <- R6Class("A", public = list(name = NULL, f = function() self$name))\n' + // 第 0 行
      'B <- R6Class("B", public = list(name = NULL, f = function() self$name))'; // 第 1 行
    const ctx = singleCtx(text);
    const cursor1 = text.indexOf('self$name') + 'self$'.length + 2;
    expect(resolveMemberDefinition(ctx, cursor1)).toEqual({
      name: 'name',
      uri: 'test.R',
      line: 0,
      character: 32,
    });

    const cursor2 = text.indexOf('self$name', cursor1 + 1) + 'self$'.length + 2;
    expect(resolveMemberDefinition(ctx, cursor2)).toEqual({
      name: 'name',
      uri: 'test.R',
      line: 1,
      character: 32,
    });
  });

  it('self$ 能访问 active 区的成员（跳到 active 而非 private 的同名 age）', () => {
    const text =
      'Person <- R6Class("Person",\n' +
      '  active = list(age = function(value) private$age),\n' + // 第 1 行：active 的 age，character 16
      '  private = list(age = NA),\n' + // 第 2 行：private 的 age（self 不应跳到这）
      '  public = list(f = function() self$age)\n' +
      ')';
    const ctx = singleCtx(text);
    const cursor = text.indexOf('self$age') + 'self$'.length + 2;
    expect(resolveMemberDefinition(ctx, cursor)).toEqual({
      name: 'age',
      uri: 'test.R',
      line: 1,
      character: 16,
    });
  });

  it('普通变量（前面没有 $）→ null', () => {
    const text =
      'Person <- R6Class("Person", public = list(greet = function() "hi"))\n' +
      'x <- greet';
    const ctx = singleCtx(text);
    const cursor = text.indexOf('x <- greet') + 'x <- '.length + 2;
    expect(resolveMemberDefinition(ctx, cursor)).toBeNull();
  });

  it('类里没有这个成员 → null', () => {
    const text =
      'Person <- R6Class("Person", public = list(greet = function() "hi"))\n' +
      'Person$missing';
    const ctx = singleCtx(text);
    const cursor = text.indexOf('Person$missing') + 'Person$'.length + 2;
    expect(resolveMemberDefinition(ctx, cursor)).toBeNull();
  });
});

describe('resolveMemberDefinition 跨文件成员跳转', () => {
  it('类在依赖文件，实例成员 → 跳到依赖文件的成员定义', () => {
    // 当前文件：p <- Person$new() + p$greet（让 bindings 能解析 p → Person）
    const fullCurrent = 'p <- Person$new()\np$greet';
    // 依赖文件 person.R：定义 Person 类（含 greet 方法）
    const depText =
      'Person <- R6Class("Person",\n' +
      '  public = list(\n' +
      '    greet = function() self$greet\n' + // 第 2 行 greet 定义
      '  )\n' +
      ')';
    const files: SourceFile[] = [
      { uri: 'analysis.R', text: fullCurrent },
      { uri: 'person.R', text: depText },
    ];
    const ctx = createContext(files, 'analysis.R');
    const cursor = fullCurrent.indexOf('p$greet') + 'p$'.length + 2;
    const result = resolveMemberDefinition(ctx, cursor);
    expect(result).toEqual({
      name: 'greet',
      uri: 'person.R', // 目标在依赖文件！
      line: 2,
      character: 4, // 第 2 行 "    greet = ..."：greet 在 4 个空格后
    });
  });
});
