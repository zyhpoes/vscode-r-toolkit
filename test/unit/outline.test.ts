import { describe, expect, it } from 'vitest';
import { tokenize } from '../../src/parser/tokenizer';
import { parseR6 } from '../../src/parser/r6-parser';
import { buildOutline, type OutlineNode } from '../../src/analysis/outline';

// 辅助：文本 → 大纲树（buildOutline 的输入契约：token + 类清单，同一份文本）
function outlineOf(text: string) {
  return buildOutline(parseR6(tokenize(text)), tokenize(text));
}

describe('buildOutline 把 R6 类整理成大纲树', () => {
  const threeScopes =
    'Person <- R6Class("Person",\n' +
    '  public = list(greet = function() "hi", name = NULL),\n' +
    '  private = list(age = NA),\n' +
    '  active = list(info = function(value) private$age)\n' +
    ')';

  it('类 → 区 → 成员 三层结构，区按 public / private / active 顺序', () => {
    const tree = outlineOf(threeScopes);
    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe('Person');
    expect(tree[0].kind).toBe('class');
    expect(tree[0].children.map((n) => n.name)).toEqual(['public', 'private', 'active']);
    // 成员挂在自己的区下面
    expect(tree[0].children[0].children.map((n) => n.name)).toEqual(['greet', 'name']);
    expect(tree[0].children[1].children.map((n) => n.name)).toEqual(['age']);
    expect(tree[0].children[2].children.map((n) => n.name)).toEqual(['info']);
  });

  it('成员节点带所属区（provider 靠它决定图标）', () => {
    const tree = outlineOf(threeScopes);
    expect(tree[0].children[0].children[0].scope).toBe('public');
    expect(tree[0].children[1].children[0].scope).toBe('private');
    expect(tree[0].children[2].children[0].scope).toBe('active');
    expect(tree[0].scope).toBeUndefined(); // 类节点没有区
  });

  it('空区不生成节点（private = list() 不出现在大纲里）', () => {
    const text =
      'Person <- R6Class("Person",\n' +
      '  public = list(greet = function() 1),\n' +
      '  private = list()\n' +
      ')';
    expect(outlineOf(text)[0].children.map((n) => n.name)).toEqual(['public']);
  });

  it('没有任何区的类 → 类节点无子节点', () => {
    const text = 'Person <- R6Class("Person")';
    const tree = outlineOf(text);
    expect(tree).toHaveLength(1);
    expect(tree[0].children).toEqual([]);
  });

  it('多个类 → 多个顶层节点，按代码顺序', () => {
    const text =
      'A <- R6Class("A", public = list(x = 1))\n' +
      'B <- R6Class("B", public = list(y = 2))';
    const tree = outlineOf(text);
    expect(tree.map((n) => n.name)).toEqual(['A', 'B']);
    expect(tree[1].children[0].children.map((n) => n.name)).toEqual(['y']);
  });

  it('偏移量：成员的范围指向原文里的成员名；类的范围覆盖整个 R6Class 调用', () => {
    const text = 'Person <- R6Class("Person", public = list(greet = function() 1))';
    const tree = outlineOf(text);
    const greet = tree[0].children[0].children[0];

    expect(greet.nameOffset).toBe(text.indexOf('greet'));
    expect(greet.stOffset).toBe(text.indexOf('greet'));
    expect(greet.enOffset).toBe(text.indexOf('greet') + 'greet'.length);

    // 类的范围：从类名开始（含 `Person <-`），到最外层 ')' 之后
    expect(tree[0].stOffset).toBe(0);
    expect(tree[0].enOffset).toBe(text.length);
  });

  it('v1 边界：文件级函数/变量不进大纲（只列 R6 类）', () => {
    const text =
      'helper <- function() 1\n' + // 普通函数，不是 R6 类
      'Person <- R6Class("Person", public = list(greet = function() 1))';
    expect(outlineOf(text).map((n) => n.name)).toEqual(['Person']);
  });
});

describe('buildOutline 范围不变量（VS Code 硬校验：选区必须落在范围内）', () => {
  // 违反这条会让整个大纲请求失败（表现为大纲空白），所以单独钉住
  function expectSelectionInsideRange(nodes: OutlineNode[]): void {
    for (const node of nodes) {
      expect(node.nameOffset).toBeGreaterThanOrEqual(node.stOffset);
      expect(node.nameOffset + node.name.length).toBeLessThanOrEqual(node.enOffset);
      expectSelectionInsideRange(node.children);
    }
  }

  it('每个节点的选区都落在自己的范围之内（含 public / private / active 三个区）', () => {
    const text =
      'Person <- R6Class("Person",\n' +
      '  public = list(x = 1, greet = function() "hi"),\n' +
      '  private = list(age = NA),\n' +
      '  active = list(info = function(value) 1)\n' +
      ')';
    expectSelectionInsideRange(outlineOf(text));
  });

  it('回归：成员名比区名短（private = list(age = NA)）也不越界', () => {
    const text = 'Person <- R6Class("Person", private = list(age = NA))';
    const scopeNode = outlineOf(text)[0].children[0];
    // 区名 private 有 7 个字符，成员名 age 只有 3 个 —— 曾经就是这里越界
    expect(scopeNode.name).toBe('private');
    expect(scopeNode.nameOffset + scopeNode.name.length).toBeLessThanOrEqual(scopeNode.enOffset);
  });

  it('区节点的位置指向区关键字（public = list( 的 public），范围覆盖到该区最后一个成员结束', () => {
    const text = 'Person <- R6Class("Person", public = list(greet = function() 1))';
    const scopeNode = outlineOf(text)[0].children[0];
    expect(scopeNode.nameOffset).toBe(text.indexOf('public'));
    expect(scopeNode.enOffset).toBe(text.indexOf('greet') + 'greet'.length);
  });
});
