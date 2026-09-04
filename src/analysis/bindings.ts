/**
 * 变量绑定解析（第 1 层）：扫描所有赋值语句，记录"变量 ← 什么"。
 * 纯逻辑：不依赖 vscode，可在纯 Node 中测试。
 *
 * 用途：支撑实例成员跳转（p$xxx）—— 点 p 的成员时，先查 p 被赋成了什么。
 */

import { tokenize, type Token } from '../parser/tokenizer';
import { TextLines } from '../utils/text';
import { r6CallTokenRange } from '../parser/r6-parser';
import { nextNonComment } from '../parser/token-utils';

/**
 * 赋值右侧的形态（这个赋值把变量变成了什么）。
 * 可辨识联合：用 kind 区分，各形态只声明自己需要的字段。
 */
export type BindingRhs =
  | { kind: 'r6-class-def' }                        // Person <- R6Class(...)：变量是一个 R6 类（追踪终点）
  | { kind: 'r6-class-new'; sourceName: string }    // p <- Person$new()：变量是某类的实例，值来自 sourceName
  | { kind: 'alias'; sourceName: string }           // p <- q：变量是另一个变量的别名，继续追 sourceName
  | { kind: 'function' }                            // func <- function(...)：变量是一个函数（追踪终点）
  | { kind: 'unknown' };                            // c <- 1+1 等：无追踪价值

/** 一条赋值记录 */
export interface Binding {
  varName: string; // 被赋值的变量名（赋值左侧）
  rhs: BindingRhs; // 右侧形态（这个变量变成了什么）
  rhsStIndex: number; // 右侧第一个 token 的下标（供求值器 evaluateRhs 定位右边用）
  offset: number; // varName 的位置（用于"最近赋值"判断）
}

/** 扫描全文所有赋值（一次性、不递归），按代码顺序返回 */
export function parseBindings(text: string): Binding[] {
  const tokens = tokenize(text);
  const lines = new TextLines(text);
  const bindings: Binding[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    // 只找赋值运算符 <-（不考虑 =）
    if (t.kind !== 'operator' || t.text !== '<-') {
      continue;
    }

    // 左边必须是"独立变量"：前一个 token 是标识符，
    // 且再前一个不是 '$'（排除 self$x <- 这类成员赋值）
    const lhs = tokens[i - 1];
    if (lhs?.kind !== 'identifier') {
      continue;
    }
    if (tokens[i - 2]?.text === '$') {
      continue;
    }

    // 分类右边形态
    const rhs = classifyRhs(tokens, i + 1, lines);
    bindings.push({ varName: lhs.text, rhs, rhsStIndex: i + 1, offset: lhs.offset });
  }

  return bindings;
}

/** 分类赋值右边的形态（从 stIndex 下标开始看） */
function classifyRhs(tokens: Token[], stIndex: number, lines: TextLines): BindingRhs {
  const first = tokens[stIndex];
  // 如果 <- 的右边没有值则表示用户代码不完整：<- 后面什么都没写
  if (first === undefined) {
    return { kind: 'unknown' };
  }

  // r6 类定义：Person <- R6Class(...) 或 R6::R6Class(...)
  if (first.kind === 'identifier') {
    const range = r6CallTokenRange(tokens, stIndex);
    // 还需确认后面是 '('（是调用，而非把 R6Class 函数本身赋给变量）
    if (range !== null && tokens[range.enIndex + 1]?.text === '(') {
      return { kind: 'r6-class-def' };
    }
  }

  // 实例创建：p <- Person$new( ... )
  const second = tokens[stIndex + 1];
  const third = tokens[stIndex + 2];
  const fourth = tokens[stIndex + 3];
  if (
    first.kind === 'identifier' &&
    second?.kind === 'operator' && second.text === '$' &&
    third?.kind === 'identifier' && third.text === 'new' &&
    fourth?.kind === 'operator' && fourth.text === '('
  ) {
    return { kind: 'r6-class-new', sourceName: first.text };
  }

  // 函数定义：func <- function(...)
  if (first.kind === 'identifier' && first.text === 'function') {
    return { kind: 'function' };
  }

  // 别名：p <- q（右边只有一个标识符，语句到这就结束）
  if (first.kind === 'identifier') {
    const nxt = nextNonComment(tokens, stIndex + 1); // 跳过注释
    const endsHere =
      nxt === undefined ||
      nxt.text === ';' || // 分号分隔的下一句
      lines.positionAt(nxt.offset).line !== lines.positionAt(first.offset).line; // 换行了
    if (endsHere) {
      return { kind: 'alias', sourceName: first.text };
    }
  }

  // 其他（表达式、字面量、函数调用等）—— 无追踪价值
  return { kind: 'unknown' };
}
