import { describe, expect, it } from 'vitest';
import { blockAt, buildBlockTree, enclosingBlock, type Block } from '../../src/parser/blocks';
import { parseR6 } from '../../src/parser/r6-parser';
import { tokenize } from '../../src/parser/tokenizer';

// 辅助：把源码切成块（所有夹具都走它，保证 token 只切一次）
function blocksOf(text: string): Block[] {
  return buildBlockTree(tokenize(text));
}

// 辅助：找某个文本第 n 次出现的 token 下标（模拟"光标落在哪个 token 上"）
function indexOf(text: string, word: string, nth = 1): number {
  const tokens = tokenize(text);
  let seen = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].text === word && ++seen === nth) return i;
  }
  throw new Error(`夹具里找不到第 ${nth} 个 "${word}"`);
}

// 辅助：只看块的种类序列，便于一眼看出"多建/少建了什么块"
function kinds(blocks: Block[]): string[] {
  return blocks.map((b) => b.kind);
}

describe('buildBlockTree 收集范围', () => {
  it('空文件 → 没有任何块', () => {
    expect(blocksOf('')).toEqual([]);
  });

  it('只有类：file + r6-class，类块有头（圆括号）且没有体', () => {
    const blocks = blocksOf('Person <- R6Class("Person")');
    expect(kinds(blocks)).toEqual(['file', 'r6-class']);
    const cls = blocks[1];
    expect(cls.kind).toBe('r6-class');
    expect(cls.headStIndex).toBeDefined();
    expect(cls.headEnIndex).toBeDefined();
    expect(cls.bodyStIndex).toBeUndefined();
  });

  it('函数带花括号体：整体从 function 关键字起，头和体都在', () => {
    const text = 'f <- function(a) { a }';
    const blocks = blocksOf(text);
    const tokens = tokenize(text);
    expect(kinds(blocks)).toEqual(['file', 'function']);

    const fn = blocks[1];
    expect(tokens[fn.stIndex].text).toBe('function'); // 整体起点是关键字
    expect(tokens[fn.headStIndex ?? -1].text).toBe('('); // 头起点是左圆括号
    expect(tokens[fn.bodyStIndex ?? -1].text).toBe('{'); // 体起点是左花括号
    expect(tokens[fn.enIndex].text).toBe('}'); // 整体终点是右花括号
    expect(fn.bodyEnIndex).toBe(fn.enIndex); // 体终点 = 整体终点
  });

  it('函数没有花括号体 → 不建块（有意让位）', () => {
    expect(kinds(blocksOf('oneLine <- function() 1 + 1'))).toEqual(['file']);
    expect(kinds(blocksOf('newlineBody <- function()\n  1 + 1'))).toEqual(['file']);
  });

  it('半成品（只有 function 和参数表）→ 不建块', () => {
    expect(kinds(blocksOf('half <- function(x, y)'))).toEqual(['file']);
  });

  it('未闭合的函数体 → 终点兜到文件尾', () => {
    const text = 'unclosed <- function() {\n  z <- 1';
    const blocks = blocksOf(text);
    const tokens = tokenize(text);
    expect(kinds(blocks)).toEqual(['file', 'function']);
    expect(blocks[1].enIndex).toBe(tokens.length - 1);
  });

  it('类里的方法：父块是类块', () => {
    const text = 'Person <- R6Class("Person", public = list(run = function() { 1 }))';
    const blocks = blocksOf(text);
    const method = blocks.find((b) => b.kind === 'function');
    expect(method?.parent?.kind).toBe('r6-class');
  });

  it('嵌套函数：内层函数的父块是外层函数', () => {
    const text = 'a <- function() {\n  b <- function() { 1 }\n}';
    const blocks = blocksOf(text);
    const functions = blocks.filter((b) => b.kind === 'function');
    expect(functions).toHaveLength(2);
    expect(functions[1].parent).toBe(functions[0]);
  });

  it('R6::R6Class 写法也能识别出类块', () => {
    expect(kinds(blocksOf('B <- R6::R6Class("B")'))).toEqual(['file', 'r6-class']);
  });

  it('一个文件两个类：各一块，不重复', () => {
    const text = 'A <- R6Class("A")\nB <- R6Class("B")';
    const blocks = blocksOf(text);
    expect(kinds(blocks).filter((k) => k === 'r6-class')).toHaveLength(2);
    expect(blocks[1].enIndex).not.toBe(blocks[2].enIndex);
  });

  it('if / for / {} 不产生块（它们不建作用域）', () => {
    const text = 'f <- function() {\n  if (TRUE) { 1 }\n  for (i in 1:3) { 2 }\n  { 3 }\n}';
    expect(kinds(blocksOf(text))).toEqual(['file', 'function']);
  });
});

describe('blockAt 找最内层块', () => {
  const text = 'Person <- R6Class("Person", public = list(run = function() { self$ }))';

  it('方法体内 → 函数块（不是类块）', () => {
    const blocks = blocksOf(text);
    expect(blockAt(blocks, indexOf(text, 'self'))?.kind).toBe('function');
  });

  it('类顶层（不在方法里）→ 类块', () => {
    const blocks = blocksOf(text);
    expect(blockAt(blocks, indexOf(text, 'public'))?.kind).toBe('r6-class');
  });

  it('文件层（类之外）→ file 块', () => {
    const blocks = blocksOf(text);
    expect(blockAt(blocks, indexOf(text, 'Person'))?.kind).toBe('file');
  });

  it('越界下标 → undefined', () => {
    const blocks = blocksOf(text);
    expect(blockAt(blocks, tokenize(text).length + 5)).toBeUndefined();
  });

  it('结果与 blocks 的数组顺序无关', () => {
    const blocks = blocksOf(text);
    const idx = indexOf(text, 'self');
    const reversed = [...blocks].reverse();
    expect(blockAt(reversed, idx)?.kind).toBe(blockAt(blocks, idx)?.kind);
    expect(blockAt(reversed, idx)?.stIndex).toBe(blockAt(blocks, idx)?.stIndex);
  });
});

describe('enclosingBlock 从光标往外找最近的指定种类', () => {
  const text = 'Person <- R6Class("Person", public = list(run = function() { self$ }))';

  it('方法体内 → 最近的 function 就是那个方法', () => {
    const blocks = blocksOf(text);
    const fn = enclosingBlock(blocks, indexOf(text, 'self'), 'function');
    expect(fn?.kind).toBe('function');
    expect(fn?.parent?.kind).toBe('r6-class');
  });

  it('同一个位置找 r6-class → 跨过函数层拿到类块', () => {
    const blocks = blocksOf(text);
    expect(enclosingBlock(blocks, indexOf(text, 'self'), 'r6-class')?.kind).toBe('r6-class');
  });

  it('类顶层找 function → undefined（不在任何方法里）', () => {
    const blocks = blocksOf(text);
    expect(enclosingBlock(blocks, indexOf(text, 'public'), 'function')).toBeUndefined();
  });

  it('文件层找 r6-class → undefined（不在类里）', () => {
    const blocks = blocksOf(text);
    expect(enclosingBlock(blocks, indexOf(text, 'Person'), 'r6-class')).toBeUndefined();
  });

  it('越界下标 → undefined', () => {
    const blocks = blocksOf(text);
    expect(enclosingBlock(blocks, tokenize(text).length + 5, 'r6-class')).toBeUndefined();
  });

  it('三层嵌套（函数 → 类 → 函数）：各取最近的', () => {
    const nested = [
      'factory <- function() {',
      '  Inner <- R6Class("Inner", public = list(run = function() { self$ }))',
      '}',
    ].join('\n');
    const blocks = blocksOf(nested);
    const idx = indexOf(nested, 'self');

    const fn = enclosingBlock(blocks, idx, 'function');
    expect(fn?.kind).toBe('function');
    // 最近的函数是方法（它的父是类块），不是外层 factory
    expect(fn?.parent?.kind).toBe('r6-class');

    const cls = enclosingBlock(blocks, idx, 'r6-class');
    expect(cls?.kind).toBe('r6-class');
    // 最近的类是 Inner（它的父是外层 factory）
    expect(cls?.parent?.kind).toBe('function');
  });
});

describe('边界情况', () => {
  it('R6::R6Class 的类块起点与 parseR6 的类定义起点对齐（可以直接用启动配对）', () => {
    // 裸写法：两边都指向 R6Class
    const bare = 'A <- R6Class("A")';
    const bareClasses = parseR6(tokenize(bare));
    expect(blocksOf(bare)[1].stIndex).toBe(bareClasses[0].stIndex);

    // 命名空间写法：两边都必须指向 R6（不是 R6Class）
    const ns = 'B <- R6::R6Class("B")';
    const nsTokens = tokenize(ns);
    const nsClasses = parseR6(nsTokens);
    const nsBlock = blocksOf(ns)[1];
    expect(nsBlock.stIndex).toBe(nsClasses[0].stIndex);
    expect(nsTokens[nsBlock.stIndex].text).toBe('R6');
  });

  it('字符串 / 注释里出现 function、R6Class 字样 → 不建块（只认 identifier）', () => {
    const text = [
      'msg <- "function() { } R6Class("',
      '# function() { } R6Class(',
    ].join('\n');
    expect(kinds(blocksOf(text))).toEqual(['file']);
  });

  it('R6Class 被当变量名用（后面不是左圆括号）→ 不建块', () => {
    expect(kinds(blocksOf('R6Class <- 1'))).toEqual(['file']);
    expect(kinds(blocksOf('x <- R6Class'))).toEqual(['file']);
  });

  it('类调用没闭合（括号不配对）→ 不建类块', () => {
    const text = 'A <- R6Class("A", public = list(';
    expect(kinds(blocksOf(text))).toEqual(['file']);
  });

  it('函数参数表没闭合 → 不建函数块', () => {
    expect(kinds(blocksOf('f <- function(a, b'))).toEqual(['file']);
  });

  it('类里再定义类（在方法体内）：内层的父块是方法，不是外层类', () => {
    const text = [
      'Outer <- R6Class("Outer", public = list(',
      '  make = function() {',
      '    Inner <- R6Class("Inner", public = list(run = function() { self$ }))',
      '  }',
      '))',
    ].join('\n');
    const blocks = blocksOf(text);
    const inner = blocks.find((b) => b.kind === 'r6-class' && b.stIndex !== blocks[1].stIndex);
    expect(inner).toBeDefined();
    expect(inner?.parent?.kind).toBe('function');
    // 光标在内层方法里：最近的类必须是 Inner（不是 Outer）
    const idx = indexOf(text, 'self');
    const nearest = enclosingBlock(blocks, idx, 'r6-class');
    expect(nearest?.stIndex).toBe(inner?.stIndex);
  });

  it('外层和内层都没闭合：块仍能建出来，且终点都兜到文件尾', () => {
    const text = 'f <- function() {\n  g <- function() {\n    1';
    const blocks = blocksOf(text);
    const tokens = tokenize(text);
    const fns = blocks.filter((b) => b.kind === 'function');
    expect(fns).toHaveLength(2);
    expect(fns[0].enIndex).toBe(tokens.length - 1);
    expect(fns[1].enIndex).toBe(tokens.length - 1);
    expect(fns[1].parent).toBe(fns[0]);
  });

  it('边界下标：左花括号 / 左圆括号本身也算在块内（含两端）', () => {
    const text = 'f <- function(a) { a }';
    const blocks = blocksOf(text);
    expect(blockAt(blocks, indexOf(text, '{'))?.kind).toBe('function');
    expect(blockAt(blocks, indexOf(text, '('))?.kind).toBe('function');
  });

  it('空块数组：两个查询都返回 undefined', () => {
    expect(blockAt([], 0)).toBeUndefined();
    expect(enclosingBlock([], 0, 'r6-class')).toBeUndefined();
  });

  it('kind 为 file 时会命中根块（记录这个行为，避免以后误判为 bug）', () => {
    const blocks = blocksOf('f <- function() { 1 }');
    const hit = enclosingBlock(blocks, indexOf('f <- function() { 1 }', '1'), 'file');
    expect(hit?.kind).toBe('file');
    expect(hit?.parent).toBeUndefined();
  });
});
