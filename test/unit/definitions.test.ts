import { describe, expect, it } from 'vitest';
import { resolveClassDefinition } from '../../src/analysis/definitions';
import type { SourceFile } from '../../src/analysis/source-file';

// 辅助：把单文件文本包装成 files 数组（当前文件 uri 固定为 test.R）
function singleFile(text: string): { files: SourceFile[]; uri: string } {
  return { files: [{ uri: 'test.R', text }], uri: 'test.R' };
}

describe('resolveClassDefinition 单文件光标定位类定义', () => {
  // 基础场景：定义在第 0 行，引用在第 1 行
  const text = 'Person <- R6Class("Person")\nPerson$new()';

  it('光标在类名中间 → 跳到定义处（带 uri = 当前文件）', () => {
    const { files, uri } = singleFile(text);
    const cursor = text.indexOf('Person$new()') + 4;
    expect(resolveClassDefinition(files, uri, cursor)).toEqual({
      name: 'Person',
      uri: 'test.R',
      line: 0,
      character: 0,
    });
  });

  it('光标在类名开头 → 命中（边界含等号）', () => {
    const { files, uri } = singleFile(text);
    const cursor = text.indexOf('Person$new()');
    expect(resolveClassDefinition(files, uri, cursor)).toEqual({
      name: 'Person',
      uri: 'test.R',
      line: 0,
      character: 0,
    });
  });

  it('光标在类名末尾边界（Person|$）→ 不命中（半开区间）', () => {
    const { files, uri } = singleFile(text);
    const cursor = text.indexOf('Person$new()') + 'Person'.length;
    expect(resolveClassDefinition(files, uri, cursor)).toBeNull();
  });

  it('光标在 new 上 → 不命中（new 不是类名）', () => {
    const { files, uri } = singleFile(text);
    const cursor = text.indexOf('new') + 1;
    expect(resolveClassDefinition(files, uri, cursor)).toBeNull();
  });

  it('光标在普通变量 x 上 → 不命中', () => {
    const text2 = 'x <- 1\nPerson <- R6Class("Person")';
    const { files, uri } = singleFile(text2);
    expect(resolveClassDefinition(files, uri, 0)).toBeNull();
  });

  it('光标在类定义行自身的类名上 → 返回自身位置（无害）', () => {
    const { files, uri } = singleFile(text);
    expect(resolveClassDefinition(files, uri, 0)).toEqual({
      name: 'Person',
      uri: 'test.R',
      line: 0,
      character: 0,
    });
  });

  it('多行多类：点第二个类的引用 → 跳到第二个类定义处', () => {
    const text3 = 'A <- R6Class("A")\nB <- R6Class("B")\nB$new()';
    const { files, uri } = singleFile(text3);
    const cursor = text3.indexOf('B$new()');
    expect(resolveClassDefinition(files, uri, cursor)).toEqual({
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
    // 光标在 person$Person 的 Person 上（在 analysis.R 里）
    const cursor = currentText.indexOf('person$Person') + 'person$'.length + 2;
    const result = resolveClassDefinition(files, 'analysis.R', cursor);
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
    const cursor = currentText.indexOf('Person$new()') + 2;
    const result = resolveClassDefinition(files, 'analysis.R', cursor);
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
    const cursor = currentText.indexOf('Missing') + 2;
    expect(resolveClassDefinition(files, 'analysis.R', cursor)).toBeNull();
  });
});
