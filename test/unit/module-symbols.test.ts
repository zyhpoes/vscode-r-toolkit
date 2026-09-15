import { describe, expect, it } from 'vitest';
import { tokenize } from '../../src/parser/tokenizer';
import {
  parseTopLevelSymbols,
  resolveModuleMemberDefinition,
} from '../../src/analysis/module-symbols';
import { createContext, type AnalysisContext } from '../../src/analysis/context';

/** 辅助：只要名字列表（大多数用例关心的是"抓到哪些名字"） */
function namesOf(text: string): string[] {
  return parseTopLevelSymbols(tokenize(text)).map((symbol) => symbol.name);
}

describe('parseTopLevelSymbols 取模块的顶层符号', () => {
  it('函数赋值与常量赋值都算，保序', () => {
    const text = ['SCHEMA_PATH <- "a.yaml"', 'get_label <- function(x) x', 'TABLE <- list()'].join(
      '\n',
    );
    expect(namesOf(text)).toEqual(['SCHEMA_PATH', 'get_label', 'TABLE']);
  });

  it('`=` 写法也算（顶层 `x = 1` 与 `x <- 1` 等价）', () => {
    expect(namesOf('x = 1')).toEqual(['x']);
  });

  it('R6 类算顶层符号（`Person <- R6::R6Class(...)` 的名字是 Person）', () => {
    const text = [
      'Person <- R6::R6Class(',
      '  "Person",',
      '  public = list(',
      '    name = NULL,',
      '    initialize = function(name) self$name <- name',
      '  )',
      ')',
    ].join('\n');
    expect(namesOf(text)).toEqual(['Person']);
  });

  it('函数体内部的局部变量不算（靠花括号深度，不看缩进）', () => {
    const text = ['outer <- function() {', '  inner <- 1', '  nested <- function() { deep <- 2 }', '}'].join(
      '\n',
    );
    expect(namesOf(text)).toEqual(['outer']);
  });

  it('调用里的具名参数不算（在圆括号里 → 深度不为 0）', () => {
    expect(namesOf('config <- list(a = 1, b = 2)')).toEqual(['config']);
  });

  it('if / for 块里的赋值不算顶层', () => {
    expect(namesOf(['if (TRUE) {', '  y <- 1', '}'].join('\n'))).toEqual([]);
  });

  it('以 . 开头的隐藏名不算（`.helper <- ...`）', () => {
    expect(namesOf(['.helper <- function() 1', 'public_fn <- function() 2'].join('\n'))).toEqual([
      'public_fn',
    ]);
  });

  it('`<<-` 不算（写的是全局变量，不是模块符号）', () => {
    expect(namesOf('x <<- 1')).toEqual([]);
  });

  it('赋值号换行也认（`x <-` 换行 `1`）', () => {
    expect(namesOf('x <-\n  1')).toEqual(['x']);
  });

  it('有 @export 标记时**不做过滤**：标记过的和没标记的一视同仁', () => {
    const text = [
      "#' @export",
      'exported_fn <- function() 1',
      '',
      'plain_fn <- function() 2',
      '',
      "#' @export",
      'ExportedClass <- R6::R6Class("ExportedClass")',
    ].join('\n');
    expect(namesOf(text)).toEqual(['exported_fn', 'plain_fn', 'ExportedClass']);
  });

  it('box::export() 也不做过滤（它本身不是名字，也不会让别的名字消失）', () => {
    expect(namesOf(['box::export()', 'fn <- function() 1'].join('\n'))).toEqual(['fn']);
  });

  it('同名多次赋值 → 都记下来（调用方取第一个作为跳转目标）', () => {
    expect(namesOf(['x <- 1', 'x <- 2'].join('\n'))).toEqual(['x', 'x']);
  });

  it('没有赋值 / 空文本 → 空数组', () => {
    expect(parseTopLevelSymbols(tokenize(''))).toEqual([]);
    expect(parseTopLevelSymbols(tokenize('# 只有注释'))).toEqual([]);
  });

  it('偏移指向名字本身（可用原文切片核对）', () => {
    const text = 'get_label <- function(x) x';
    const [symbol] = parseTopLevelSymbols(tokenize(text));
    expect(text.slice(symbol.offset, symbol.offset + symbol.name.length)).toBe('get_label');
  });
});

describe('resolveModuleMemberDefinition 模块$成员 跳转', () => {
  // 光标文件：导入了模块 schema，并用了 schema$get_label
  const cursorText = ['box::use(R/schema/schema)', 'x <- schema$get_label(1)'].join('\n');
  const moduleText = ['SCHEMA <- list()', 'get_label <- function(x) x'].join('\n');

  /** 组装一个"两文件"的 ctx（当前文件 test.R + 模块文件 schema.R） */
  function twoFileCtx(): AnalysisContext {
    return createContext(
      [
        { uri: 'test.R', text: cursorText },
        { uri: 'schema.R', text: moduleText },
      ],
      'test.R',
    );
  }

  /** 模块绑定名 → 模块文件 uri（正常接线时由 provider 层解析后给出） */
  function schemaBinding(): Map<string, string> {
    return new Map([['schema', 'schema.R']]);
  }

  it('光标踩在 $ 后面的成员名上 → 命中模块文件里的同名顶层符号', () => {
    const ctx = twoFileCtx();
    // 第二行 'x <- schema$get_label(1)'：get_label 的起点
    const offset = cursorText.indexOf('get_label');
    const site = resolveModuleMemberDefinition(ctx, offset + 1, schemaBinding());
    expect(site).not.toBeNull();
    expect(site?.uri).toBe('schema.R');
    expect(site?.line).toBe(1); // 模块文件第 2 行
    expect(site?.character).toBe(0);
    expect(site?.name).toBe('get_label');
  });

  it('光标踩在绑定名（schema）上 → 不命中（那属于模块跳转，不是成员跳转）', () => {
    const ctx = twoFileCtx();
    const offset = cursorText.indexOf('schema$get_label');
    expect(resolveModuleMemberDefinition(ctx, offset + 1, schemaBinding())).toBeNull();
  });

  it('绑定名不是本文件的 box 模块（如 R6 类名）→ null，交给别的分支', () => {
    const text = 'x <- Person$new()';
    const localCtx = createContext([{ uri: 'test.R', text }], 'test.R');
    expect(resolveModuleMemberDefinition(localCtx, text.indexOf('new') + 1, schemaBinding())).toBeNull();
  });

  it('模块文件里没有这个顶层名字 → null', () => {
    const text = 'x <- schema$no_such_thing(1)';
    const localCtx = createContext(
      [
        { uri: 'test.R', text },
        { uri: 'schema.R', text: moduleText },
      ],
      'test.R',
    );
    expect(
      resolveModuleMemberDefinition(localCtx, text.indexOf('no_such_thing') + 1, schemaBinding()),
    ).toBeNull();
  });

  it('模块文件没被加载（读不出来）→ null', () => {
    const text = 'x <- schema$get_label(1)';
    const ctx = createContext([{ uri: 'test.R', text }], 'test.R');
    expect(resolveModuleMemberDefinition(ctx, text.indexOf('get_label') + 1, schemaBinding())).toBeNull();
  });

  it('没有 $ 的形状（普通变量）→ null', () => {
    const ctx = twoFileCtx();
    const offset = cursorText.indexOf('schema'); // 第二行的 schema（不在 $ 后面）
    expect(resolveModuleMemberDefinition(ctx, offset + 1, schemaBinding())).toBeNull();
  });

  it('光标踩在模块里以 . 开头的隐藏名上 → null（宽松规则也排除隐藏名）', () => {
    const text = 'x <- schema$.hidden(1)';
    const ctx = createContext(
      [
        { uri: 'test.R', text },
        { uri: 'schema.R', text: '.hidden <- function() 1' },
      ],
      'test.R',
    );
    expect(resolveModuleMemberDefinition(ctx, text.indexOf('.hidden') + 2, schemaBinding())).toBeNull();
  });
});
