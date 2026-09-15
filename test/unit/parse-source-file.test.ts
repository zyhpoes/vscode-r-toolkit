import { describe, expect, it } from 'vitest';
import { dedupeFiles, parseSourceFile, type SourceFile } from '../../src/analysis/source-file';
import { tokenize, type Token } from '../../src/parser/tokenizer';

// 夹具：一行导入 + 一个类 + 一个函数 + 一个实例（覆盖全部解析产物）
const TEXT = [
  'box::use(R/schema/schema)',
  'Person <- R6::R6Class("Person", public = list(name = NULL))',
  'helper <- function(x) x',
  'p <- Person$new()',
].join('\n');

describe('parseSourceFile 一个文件只解析一次', () => {
  it('六样产物全部就位：file / tokens / lines / classes / symbols / bindings', () => {
    const file: SourceFile = { uri: 'test.R', text: TEXT };
    const parsed = parseSourceFile(file);

    expect(parsed.file).toBe(file); // 原样持有，不复制
    expect(parsed.tokens.length).toBeGreaterThan(0);
    expect(parsed.classes.map((c) => c.name)).toEqual(['Person']);
    // 顶层符号与赋值记录都按代码顺序抓到同样的三个名字（类也算顶层符号）
    expect(parsed.symbols.map((s) => s.name)).toEqual(['Person', 'helper', 'p']);
    expect(parsed.bindings.map((b) => b.varName)).toEqual(['Person', 'helper', 'p']);
    // lines 能正确换算：helper 在第 2 行
    expect(parsed.lines.positionAt(TEXT.indexOf('helper')).line).toBe(2);
  });

  it('传入已切好的 token → 原样复用那一份（不重新切词）', () => {
    const tokens = tokenize(TEXT);
    const parsed = parseSourceFile({ uri: 'test.R', text: TEXT }, tokens);
    expect(parsed.tokens).toBe(tokens);
  });

  it('不传 token 时自己切一份，结果与传 token 完全一致', () => {
    const byText = parseSourceFile({ uri: 'test.R', text: TEXT });
    const byTokens = parseSourceFile({ uri: 'test.R', text: TEXT }, tokenize(TEXT));

    expect(byText.classes).toEqual(byTokens.classes);
    expect(byText.symbols).toEqual(byTokens.symbols);
    expect(byText.bindings).toEqual(byTokens.bindings);
  });

  it('传空数组也算"传了"（?? 只认 null/undefined，不认假值）', () => {
    const empty: Token[] = [];
    const parsed = parseSourceFile({ uri: 'empty.R', text: '' }, empty);

    expect(parsed.tokens).toBe(empty); // 复用的就是传进来那个空数组
    expect(parsed.classes).toEqual([]);
    expect(parsed.symbols).toEqual([]);
    expect(parsed.bindings).toEqual([]);
  });

  it('空文本、不传 token → 各项为空且不报错（空文本也算 1 行）', () => {
    const parsed = parseSourceFile({ uri: 'empty.R', text: '' });

    expect(parsed.tokens).toEqual([]);
    expect(parsed.classes).toEqual([]);
    expect(parsed.lines.lineCount).toBe(1);
  });
});

describe('dedupeFiles 按 uri 去重（须在解析之前调用）', () => {
  it('同一 uri 只留第一条，保序', () => {
    const files: SourceFile[] = [
      { uri: 'a.R', text: 'a <- 1' },
      { uri: 'b.R', text: 'b <- 1' },
      { uri: 'a.R', text: '重复：不该覆盖第一条' },
    ];

    expect(dedupeFiles(files)).toEqual([
      { uri: 'a.R', text: 'a <- 1' },
      { uri: 'b.R', text: 'b <- 1' },
    ]);
  });

  it('不改动入参，且留下的是原对象（不是副本）', () => {
    const files: SourceFile[] = [
      { uri: 'a.R', text: 'a <- 1' },
      { uri: 'a.R', text: 'a <- 2' },
    ];

    const result = dedupeFiles(files);
    expect(files.length).toBe(2); // 入参未被改动
    expect(result[0]).toBe(files[0]);
  });

  it('没有重复 → 内容不变；空清单 → 空清单', () => {
    const files: SourceFile[] = [{ uri: 'a.R', text: 'a <- 1' }];
    expect(dedupeFiles(files)).toEqual(files);
    expect(dedupeFiles([])).toEqual([]);
  });
});
