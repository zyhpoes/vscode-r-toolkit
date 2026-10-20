/**
 * 块结构：把文件的 token 切成"有范围的块"，回答"光标属于哪一块"。
 * 纯逻辑：只吃 token，不读文件、不依赖 vscode。
 *
 * 块种类（只有这三种：能承载"名字/成员"的构造）：
 *   file      整个文件
 *   r6-class  R6Class(...) 的调用范围（这里直接算圆括号的范围；成员仍归 parseR6）
 *   function  function(...) 的函数体
 *
 * 为什么没有 if / for / {}：
 *   实测（R 是函数级作用域）证明它们不建作用域、不引入名字（`for` 的循环变量落在当前函数里），
 *   对"最近的函数 / 最近的类"这两个判定【零贡献】——把它们建进来只会让归属查询返回无用的层。
 *
 * 收集方式：递归（按"块内部的 token 区间"往下走）。
 *   父块在进入子区间时直接传下去，所以父子关系当场确定，不需要事后按范围推断；
 *   顺序天然是"先序"（父在子前、兄弟按位置），也天然按起点升序，不需要再排序。
 *
 * 坐标与命名（都是 **token 下标、含两端**，与 R6ClassDef.stIndex/enIndex 同一套语义）：
 *   stIndex / enIndex        整体范围：function 块的 stIndex 是 `function` 关键字，enIndex 是体结束
 *   headStIndex / headEnIndex 头：参数表 / 类调用的圆括号（含括号）
 *   bodyStIndex / bodyEnIndex 体：**含花括号**（只有 function 块有）
 *   没有头/体时**不写对应属性**（exactOptionalPropertyTypes 下不能显式赋 undefined）
 *
 * 已知近似（有意为之，不是疏漏）：
 *   - 函数体**只认花括号**：`function(x) x + 1` 与 `function(x)` 换行后再写体，一律按"没有体"处理
 *     （精确识别单表达式体需要表达式结构，这里有意让位：少给归属，不猜）
 *   - 括号不配对（用户正在打字）时终点兜到文件尾
 *   - R 4.1 的简写函数 `\(x) x + 1` 不识别（只认 `function` 关键字）
 *   - `local({ ... })` 实际会开新作用域（`local` 是函数），这里按普通语句处理 → 里面的赋值会被
 *     算成外层（让位）。将来若要支持，把它识别成 function 块即可（与 function 同形），不必加新种类
 */

import type { Token } from './tokenizer';
import { matchBracket } from './brackets';

/** 块种类 */
export type BlockKind = 'file' | 'r6-class' | 'function';

/** 一个块：范围用 token 下标表示（含两端） */
export interface Block {
  kind: BlockKind;
  /** 父块（最内层包含它的那个块）；file 块没有父 */
  parent?: Block;
  /** 整体起点：function 是关键字下标；r6-class 是 `R6Class`；file 是 0 */
  stIndex: number;
  /** 整体终点：体结束或配对括号；半成品兜到文件尾 */
  enIndex: number;
  /** 头（参数表，含括号）起点；没有头时不写这个属性 */
  headStIndex?: number;
  /** 头终点 */
  headEnIndex?: number;
  /** 体起点（含花括号） */
  bodyStIndex?: number;
  /** 体终点（含花括号） */
  bodyEnIndex?: number;
}

/** 一个文件的全部块（空文件没有任何块） */
export function buildBlockTree(tokens: Token[]): Block[] {
  // 空文件没有块结构的概念，直接返回
  if (tokens.length === 0) return [];

  // 块结构的根节点就是整个文件
  const blocks: Block[] = [{ kind: 'file', stIndex: 0, enIndex: tokens.length - 1 }];
  // 递归查找全部的块结构
  collectBlocks(tokens, 0, tokens.length - 1, blocks[0], blocks);
  return blocks;
}

/**
 * 在 `[stIndex, enIndex]` 这段 token 里找块，`parent` 是这一层的父块。
 * 找到块就把它挂到 parent 下，然后**进它的内部**继续找（递归）。
 */
function collectBlocks(
  tokens: Token[],
  stIndex: number,
  enIndex: number,
  parent: Block,
  blocks: Block[],
): void {
  for (let i = stIndex; i <= enIndex; i++) {
    const token = tokens[i];
    if (token.kind !== 'identifier') continue;

    let block: Block | undefined;
    switch (token.text) {
      // 处理函数的块结构
      case 'function': block = functionBlockAt(tokens, i); break;
      // 处理R6类的块结构
      case 'R6Class': block = r6ClassBlockAt(tokens, i); break;
    }
    if (block === undefined) continue;

    // 父在这里就定了（不用事后推断）；parent 参数恒有值，所以不用判 undefined
    block.parent = parent;
    blocks.push(block);
    i = block.enIndex; // 跳过这一块，它的内部交给下面的递归

    // 递归进入园括号内部查找
    if (block.headStIndex !== undefined && block.headEnIndex !== undefined) {
      collectBlocks(tokens, block.headStIndex + 1, block.headEnIndex - 1, block, blocks);
    }
    // 递归进入花括号内部查找
    if (block.bodyStIndex !== undefined && block.bodyEnIndex !== undefined) {
      collectBlocks(tokens, block.bodyStIndex + 1, block.bodyEnIndex - 1, block, blocks);
    }
  }
}

/**
 * 从一个 `function` 关键字算出一个函数块。
 * 参数表不完整（只有 `function` 还没写 `(`、或括号不配对）→ undefined（这个函数不可信，跳过它）。
 */
function functionBlockAt(tokens: Token[], index: number): Block | undefined {
  // 确定函数的参数部分
  const headStIndex = index + 1;
  // 半成品：只有 function，还没写参数表
  if (tokens[headStIndex]?.text !== '(') return undefined;
  const headEnIndex = matchBracket(tokens, headStIndex, '(');
  // 参数表括号不配对 → 这个函数的范围不可信
  if (headEnIndex === -1) return undefined;

  // 体只认花括号：`function(x) x + 1`、`function(x)` 换行再写体，都按"没有体"处理
  const bodyStIndex = headEnIndex + 1;
  // 这里为了简洁不考虑function(x) y <- x + 1; 这种没有函数体的情况
  if (tokens[bodyStIndex]?.text !== '{') return undefined;

  // 体的终点在遇到 function 这一刻就能算出来（matchBracket 不依赖扫描进度），所以不需要暂存
  const bodyCloseIndex = matchBracket(tokens, bodyStIndex, '{');
  // 未闭合（用户正在打字）→ 体到文件尾：R 的解析器也把后面都算在这个函数里
  const enIndex = bodyCloseIndex === -1 ? tokens.length - 1 : bodyCloseIndex;

  return {
    kind: 'function',
    // parent 该怎么填？
    stIndex: index,
    enIndex,
    headStIndex,
    headEnIndex,
    bodyStIndex,
    bodyEnIndex: enIndex,
  };
}

/**
 * 从一个 `R6Class` 关键字算出一个类块。
 * R6 类的范围就是那对圆括号，没有独立的花括号"体"；括号不配对 → undefined。
 * `R6::R6Class(...)` 时起点对齐到 `R6`（与 parseR6 的 R6ClassDef.stIndex 一致），
 * 这样"块 ↔ 类定义"可以用**起点相等**来配对。
 */
function r6ClassBlockAt(tokens: Token[], index: number): Block | undefined {
  const headStIndex = index + 1;
  if (tokens[headStIndex]?.text !== '(') return undefined;
  const headEnIndex = matchBracket(tokens, headStIndex, '(');
  if (headEnIndex === -1) return undefined;

  // 默认起点就是 `R6Class` 这个 token 自己
  let stIndex = index;
  // `R6::R6Class(...)` 时往前挪到 `R6`
  if (tokens[index - 1]?.text === '::' && tokens[index - 2]?.text === 'R6') stIndex = index - 2;

  return { kind: 'r6-class', stIndex, enIndex: headEnIndex, headStIndex, headEnIndex };
}

/** 最内层包含 index 的块（含 index 的那些块里起点最大者）；越界 → undefined */
export function blockAt(blocks: Block[], index: number): Block | undefined {
  let best: Block | undefined;
  for (const b of blocks) {
    if (index < b.stIndex || index > b.enIndex) continue;
    if (
      best === undefined ||       // 初始值
      b.stIndex > best.stIndex    // 起点越晚说明越内层
    ) {
      best = b;
    }
  }
  return best;
}

/** 从光标往外找最近的【指定种类】的块（如 'r6-class' / 'function'）；越过 file → undefined */
export function enclosingBlock(blocks: Block[], index: number, kind: BlockKind): Block | undefined {
  let cur = blockAt(blocks, index);
  while (cur !== undefined) {
    if (cur.kind === kind) return cur;
    cur = cur.parent;
  }
  return undefined;
}
