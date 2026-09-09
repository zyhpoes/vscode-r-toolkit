import { describe, expect, it } from 'vitest';
import { resolveMemberDefinition } from '../../src/analysis/members';
import { createContext, type AnalysisContext } from '../../src/analysis/context';
import type { SourceFile } from '../../src/analysis/source-file';
import { TextLines } from '../../src/utils/text';

// 辅助：文本里定位成员定义名（如 "greet = function" 只命中定义处）的行列
function defPos(text: string, needle: string): { line: number; character: number } {
  const at = text.indexOf(needle);
  if (at === -1) {
    throw new Error(`测试文本里找不到 ${needle}`);
  }
  return new TextLines(text).positionAt(at);
}

// 辅助：定位第 2 次出现的成员定义名（同名遮蔽场景：父类与子类都定义 greet）
function defPosSecond(text: string, needle: string): { line: number; character: number } {
  const first = text.indexOf(needle);
  const at = text.indexOf(needle, first + 1);
  if (at === -1) {
    throw new Error(`测试文本里找不到第 2 个 ${needle}`);
  }
  return new TextLines(text).positionAt(at);
}

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

describe('resolveMemberDefinition 继承：父类成员 / super$ / private 不随继承', () => {
  it('self$ 引用父类成员 → 跳到父类定义（同文件继承）', () => {
    const text =
      'Base <- R6Class("Base",\n' + // 第 0 行：Base
      '  public = list(greet = function() "hi"))\n' + // 第 1 行：Base.greet
      'Child <- R6Class("Child", inherit = Base,\n' + // 第 2 行：Child
      '  public = list(f = function() self$greet))\n'; // 第 3 行：Child.f 里 self$greet
    const ctx = singleCtx(text);
    const cursor = text.indexOf('self$greet') + 'self$'.length + 1;
    expect(resolveMemberDefinition(ctx, cursor)).toEqual({
      name: 'greet',
      uri: 'test.R',
      ...defPos(text, 'greet = function'),
    });
  });

  it('类名$ 引用父类成员（Child$greet）→ 跳到父类定义', () => {
    const text =
      'Base <- R6Class("Base", public = list(greet = function() "hi"))\n' + // 第 0 行
      'Child <- R6Class("Child", inherit = Base)\n' + // 第 1 行
      'Child$greet'; // 第 2 行
    const ctx = singleCtx(text);
    const cursor = text.indexOf('Child$greet') + 'Child$'.length + 1;
    expect(resolveMemberDefinition(ctx, cursor)).toEqual({
      name: 'greet',
      uri: 'test.R',
      ...defPos(text, 'greet = function'),
    });
  });

  it('实例$ 引用父类成员（p <- Child$new() 后 p$greet）→ 跳到父类定义', () => {
    const text =
      'Base <- R6Class("Base", public = list(greet = function() "hi"))\n' + // 第 0 行
      'Child <- R6Class("Child", inherit = Base)\n' + // 第 1 行
      'p <- Child$new()\n' + // 第 2 行
      'p$greet'; // 第 3 行
    const ctx = singleCtx(text);
    const cursor = text.indexOf('p$greet') + 'p$'.length + 1;
    expect(resolveMemberDefinition(ctx, cursor)).toEqual({
      name: 'greet',
      uri: 'test.R',
      ...defPos(text, 'greet = function'),
    });
  });

  it('同名遮蔽：self$greet 在子类自己的方法体里 → 跳子类自己的 greet（最近祖先优先）', () => {
    const text =
      'Base <- R6Class("Base", public = list(greet = function() "hi"))\n' + // 第 0 行：Base.greet
      'Child <- R6Class("Child", inherit = Base,\n' + // 第 1 行：Child
      '  public = list(greet = function() self$greet))\n'; // 第 2 行：Child.greet 里 self$greet
    const ctx = singleCtx(text);
    const cursor = text.indexOf('self$greet') + 'self$'.length + 1;
    expect(resolveMemberDefinition(ctx, cursor)).toEqual({
      name: 'greet',
      uri: 'test.R',
      ...defPosSecond(text, 'greet = function'), // 命中第 2 个 greet = 子类的
    });
  });

  it('private 不随继承：子类里 private$age（age 只在父类 private）→ null', () => {
    const text =
      'Base <- R6Class("Base", private = list(age = NA))\n' + // 第 0 行
      'Child <- R6Class("Child", inherit = Base,\n' + // 第 1 行
      '  public = list(get = function() private$age))\n'; // 第 2 行：private$age
    const ctx = singleCtx(text);
    const cursor = text.indexOf('private$age') + 'private$'.length + 1;
    expect(resolveMemberDefinition(ctx, cursor)).toBeNull();
  });

  it('super$ 覆盖场景：子类方法里 super$greet → 跳父类 greet（不是子类自己的）', () => {
    const text =
      'Base <- R6Class("Base", public = list(greet = function() "hi"))\n' + // 第 0 行：Base.greet
      'Child <- R6Class("Child", inherit = Base,\n' + // 第 1 行：Child
      '  public = list(greet = function() super$greet()))\n'; // 第 2 行：Child.greet 里 super$greet
    const ctx = singleCtx(text);
    const cursor = text.indexOf('super$greet') + 'super$'.length + 1;
    expect(resolveMemberDefinition(ctx, cursor)).toEqual({
      name: 'greet',
      uri: 'test.R',
      ...defPos(text, 'greet = function'), // 第一个 greet = Base 的
    });
  });

  it('super$ 跳爷类成员：Leaf 里 super$f（只有 Grand 定义 f）→ 跳 Grand', () => {
    const text =
      'Grand <- R6Class("Grand", public = list(f = function() 1))\n' + // 第 0 行：Grand.f
      'Mid <- R6Class("Mid", inherit = Grand)\n' + // 第 1 行
      'Leaf <- R6Class("Leaf", inherit = Mid,\n' + // 第 2 行
      '  public = list(g = function() super$f))\n'; // 第 3 行：super$f
    const ctx = singleCtx(text);
    // 成员名 f 只有 1 个字符：光标落在 f 起点（+0），+1 会越过半开区间末尾
    const cursor = text.indexOf('super$f') + 'super$'.length;
    expect(resolveMemberDefinition(ctx, cursor)).toEqual({
      name: 'f',
      uri: 'test.R',
      ...defPos(text, 'f = function'),
    });
  });

  it('super$ 在类外（不在任何方法体里）→ null', () => {
    const text =
      'Base <- R6Class("Base", public = list(greet = function() "hi"))\n' + // 第 0 行
      'Child <- R6Class("Child", inherit = Base)\n' + // 第 1 行
      'super$greet'; // 第 2 行：顶层 super$greet，不在类里
    const ctx = singleCtx(text);
    const cursor = text.indexOf('super$greet') + 'super$'.length + 1;
    expect(resolveMemberDefinition(ctx, cursor)).toBeNull();
  });

  it('super$ 跨文件：analysis.R 子类方法 super$greet → 跳 person.R 父类 greet', () => {
    const currentText =
      'box::use(person)\n' +
      'Child <- R6Class("Child", inherit = person$Person,\n' +
      '  public = list(greet = function() super$greet))\n';
    const depText =
      'Person <- R6Class("Person",\n' +
      '  public = list(greet = function() "hi")\n' +
      ')';
    const files: SourceFile[] = [
      { uri: 'analysis.R', text: currentText },
      { uri: 'person.R', text: depText },
    ];
    const ctx = createContext(files, 'analysis.R');
    const cursor = currentText.indexOf('super$greet') + 'super$'.length + 1;
    expect(resolveMemberDefinition(ctx, cursor)).toEqual({
      name: 'greet',
      uri: 'person.R', // 父类在依赖文件！
      ...defPos(depText, 'greet = function'),
    });
  });
});
