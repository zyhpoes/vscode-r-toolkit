import { describe, expect, it } from 'vitest';
import { definitionSiteAt, resolveClassDefinition, resolveVariableDefinition } from '../../src/analysis/definitions';
import { createContext, type AnalysisContext } from '../../src/analysis/context';
import { parseSourceFile, type SourceFile } from '../../src/analysis/source-file';

// 辅助：把单文件文本包装成 ctx（当前文件 uri 固定为 test.R）
function singleCtx(text: string): AnalysisContext {
  return createContext([{ uri: 'test.R', text }], 'test.R');
}

describe('resolveClassDefinition 单文件光标定位类定义', () => {
  // 基础场景：定义在第 0 行，引用在第 1 行
  const text = 'Person <- R6Class("Person")\nPerson$new()';

  it('光标在类名中间 → 跳到定义处（带 uri = 当前文件）', () => {
    const ctx = singleCtx(text);
    const cursor = text.indexOf('Person$new()') + 4;
    expect(resolveClassDefinition(ctx, cursor)).toEqual({
      name: 'Person',
      uri: 'test.R',
      line: 0,
      character: 0,
    });
  });

  it('光标在类名开头 → 命中（边界含等号）', () => {
    const ctx = singleCtx(text);
    const cursor = text.indexOf('Person$new()');
    expect(resolveClassDefinition(ctx, cursor)).toEqual({
      name: 'Person',
      uri: 'test.R',
      line: 0,
      character: 0,
    });
  });

  it('光标在类名末尾边界（Person|$）→ 不命中（半开区间）', () => {
    const ctx = singleCtx(text);
    const cursor = text.indexOf('Person$new()') + 'Person'.length;
    expect(resolveClassDefinition(ctx, cursor)).toBeNull();
  });

  it('光标在 new 上 → 不命中（new 不是类名）', () => {
    const ctx = singleCtx(text);
    const cursor = text.indexOf('new') + 1;
    expect(resolveClassDefinition(ctx, cursor)).toBeNull();
  });

  it('光标在普通变量 x 上 → 不命中', () => {
    const text2 = 'x <- 1\nPerson <- R6Class("Person")';
    const ctx = singleCtx(text2);
    expect(resolveClassDefinition(ctx, 0)).toBeNull();
  });

  it('光标在类定义行自身的类名上 → 返回自身位置（无害）', () => {
    const ctx = singleCtx(text);
    expect(resolveClassDefinition(ctx, 0)).toEqual({
      name: 'Person',
      uri: 'test.R',
      line: 0,
      character: 0,
    });
  });

  it('多行多类：点第二个类的引用 → 跳到第二个类定义处', () => {
    const text3 = 'A <- R6Class("A")\nB <- R6Class("B")\nB$new()';
    const ctx = singleCtx(text3);
    const cursor = text3.indexOf('B$new()');
    expect(resolveClassDefinition(ctx, cursor)).toEqual({
      name: 'B',
      uri: 'test.R',
      line: 1,
      character: 0,
    });
  });
});

describe('resolveClassDefinition 跨文件', () => {
  it('类在当前文件没找到，在依赖文件找到 → 返回依赖文件的 uri', () => {
    // 当前文件：只引用 Person，没定义
    const currentText = 'box::use(person)\np <- person$Person$new()';
    // 依赖文件 person.R：定义 Person
    const depText = 'Person <- R6Class("Person")\nEmployee <- R6Class("Employee")';
    const files: SourceFile[] = [
      { uri: 'analysis.R', text: currentText },
      { uri: 'person.R', text: depText },
    ];
    const ctx = createContext(files, 'analysis.R');
    // 光标在 person$Person 的 Person 上（在 analysis.R 里）
    const cursor = currentText.indexOf('person$Person') + 'person$'.length + 2;
    const result = resolveClassDefinition(ctx, cursor);
    expect(result).toEqual({
      name: 'Person',
      uri: 'person.R', // 目标在依赖文件！
      line: 0,
      character: 0,
    });
  });

  it('当前文件和依赖文件都有同名类 → 当前文件优先', () => {
    const currentText = 'Person <- R6Class("Person")\nPerson$new()';
    const depText = 'Person <- R6Class("Person")';
    const files: SourceFile[] = [
      { uri: 'analysis.R', text: currentText },
      { uri: 'person.R', text: depText },
    ];
    const ctx = createContext(files, 'analysis.R');
    const cursor = currentText.indexOf('Person$new()') + 2;
    const result = resolveClassDefinition(ctx, cursor);
    expect(result).toEqual({
      name: 'Person',
      uri: 'analysis.R', // 当前文件优先
      line: 0,
      character: 0,
    });
  });

  it('所有文件都没有这个类 → null', () => {
    const currentText = 'box::use(person)\nperson$Missing$new()';
    const depText = 'Person <- R6Class("Person")';
    const files: SourceFile[] = [
      { uri: 'analysis.R', text: currentText },
      { uri: 'person.R', text: depText },
    ];
    const ctx = createContext(files, 'analysis.R');
    const cursor = currentText.indexOf('Missing') + 2;
    expect(resolveClassDefinition(ctx, cursor)).toBeNull();
  });
});

describe('resolveVariableDefinition 变量跳转（点变量 → 赋值行）', () => {
  it('点 q（p <- q 右侧的别名引用）→ 跳 q 的赋值行', () => {
    // 用户场景：第三行 p <- q 里的 q，应跳到第二行 q <- Person$new()
    const text =
      'Person <- R6Class("Person")\n' + // 第 0 行
      'q <- Person$new()\n' + // 第 1 行：q 的赋值行
      'p <- q\n' + // 第 2 行：q 在这里被引用
      'p$name'; // 第 3 行
    const ctx = singleCtx(text);
    // 光标在第二行 p <- q 的 q 上
    const cursor = text.indexOf('p <- q') + 'p <- '.length;
    expect(resolveVariableDefinition(ctx, cursor)).toEqual({
      name: 'q',
      uri: 'test.R',
      line: 1,
      character: 0,
    });
  });

  it('点 p（实例变量引用）→ 跳 p 的赋值行', () => {
    const text =
      'Person <- R6Class("Person")\n' + // 第 0 行
      'p <- Person$new()\n' + // 第 1 行：p 的赋值行
      'p$name'; // 第 2 行：p 在这里被使用
    const ctx = singleCtx(text);
    // 光标在第二行 p$name 的 p 上（不是成员 name）
    const cursor = text.indexOf('p$name');
    expect(resolveVariableDefinition(ctx, cursor)).toEqual({
      name: 'p',
      uri: 'test.R',
      line: 1,
      character: 0,
    });
  });

  it('点类名 Person → 也算变量（跳到 Person 赋值行 = 类定义行）', () => {
    const text = 'Person <- R6Class("Person")\nPerson$new()';
    const ctx = singleCtx(text);
    // 注意：Provider 里类名跳转先命中（resolveClassDefinition），
    // 但变量跳转本身对类名也能找到赋值行 —— 两者目标一致
    const cursor = text.indexOf('Person$new()');
    expect(resolveVariableDefinition(ctx, cursor)).toEqual({
      name: 'Person',
      uri: 'test.R',
      line: 0,
      character: 0,
    });
  });

  it('光标前没有赋值（变量在光标之后才赋值）→ null', () => {
    const text = 'p$name\np <- Person$new()';
    const ctx = singleCtx(text);
    // 光标在第 0 行 p$name 的 p 上，此时 p 还没赋值
    expect(resolveVariableDefinition(ctx, 0)).toBeNull();
  });

  it('没有该变量的赋值记录 → null', () => {
    const text = 'x <- 1\ny <- x';
    const ctx = singleCtx(text);
    // 光标在第二行 y <- x 的 x 上，x 在第 0 行有赋值 → 应命中
    const cursor = text.indexOf('y <- x') + 'y <- '.length;
    expect(resolveVariableDefinition(ctx, cursor)).toEqual({
      name: 'x',
      uri: 'test.R',
      line: 0,
      character: 0,
    });
  });

  it('光标不在词上（数字上）→ null', () => {
    const text = 'x <- 1';
    const ctx = singleCtx(text);
    // 光标在数字 1 上（不是 identifier）
    expect(resolveVariableDefinition(ctx, text.indexOf('1'))).toBeNull();
  });

  // 顶层 `=` 与 `<-` 在 R 里等价，但 bindings 只记 `<-` —— 下面几条走 symbols 兜底
  it('顶层用 `=` 赋值的常量 → 兜底命中', () => {
    const text = 'config = list(a = 1)\nx <- config';
    const ctx = singleCtx(text);
    const cursor = text.indexOf('x <- config') + 'x <- '.length;
    expect(resolveVariableDefinition(ctx, cursor)).toEqual({
      name: 'config',
      uri: 'test.R',
      line: 0,
      character: 0,
    });
  });

  it('顶层用 `=` 赋值的函数 → 兜底命中（括号里的具名参数 `=` 不算赋值）', () => {
    const text = 'helper = function(x, y = 2) x\nz <- helper(1)';
    const ctx = singleCtx(text);
    const cursor = text.indexOf('z <- helper') + 'z <- '.length;
    expect(resolveVariableDefinition(ctx, cursor)).toEqual({
      name: 'helper',
      uri: 'test.R',
      line: 0,
      character: 0,
    });
    // `y = 2` 在括号里（深度 > 0）→ 不是顶层赋值，点 y 不跳
    expect(resolveVariableDefinition(ctx, text.indexOf('y = 2'))).toBeNull();
  });

  it('同名多次顶层 `=` 赋值 → 取**光标前最后一次**（与 bindings 语义一致）', () => {
    const text = 'dup = 1\ndup = 2\nx <- dup';
    const ctx = singleCtx(text);
    const cursor = text.indexOf('x <- dup') + 'x <- '.length;
    expect(resolveVariableDefinition(ctx, cursor)?.line).toBe(1); // 第二次赋值所在行
  });

  it('顶层 `=` 赋值但在**光标之后** → null（兜底也只看光标之前）', () => {
    const text = 'x <- config\nconfig = list(a = 1)';
    const ctx = singleCtx(text);
    // 光标在第 0 行的 config 上，此时它还没赋值
    expect(resolveVariableDefinition(ctx, text.indexOf('config'))).toBeNull();
  });

  it('既没有 `<-` 也没有顶层 `=` 的名字 → null', () => {
    const text = 'x <- something_undefined';
    const ctx = singleCtx(text);
    expect(resolveVariableDefinition(ctx, text.indexOf('something_undefined'))).toBeNull();
  });
});

describe('definitionSiteAt 把偏移量组装成跳转结果', () => {
  it('多行文本：偏移量换算成正确的行列，名字原样带上', () => {
    const text =
      'library(R6)\n' + // 第 0 行
      'x <- 1\n' + // 第 1 行
      'Person <- R6Class("Person")'; // 第 2 行：Person 在第 2 行第 0 列
    const file: SourceFile = { uri: 'test.R', text };
    expect(definitionSiteAt('Person', parseSourceFile(file), text.indexOf('Person'))).toEqual({
      name: 'Person',
      uri: 'test.R',
      line: 2,
      character: 0,
    });
  });

  it('uri 原样透传（跨文件时目标文件的 uri 不会被换成别的）', () => {
    const file: SourceFile = { uri: 'person.R', text: 'greet <- function() "hi"' };
    expect(definitionSiteAt('greet', parseSourceFile(file), 0)).toEqual({
      name: 'greet',
      uri: 'person.R',
      line: 0,
      character: 0,
    });
  });
});
