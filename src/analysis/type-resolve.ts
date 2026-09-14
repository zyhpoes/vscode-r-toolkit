/**
 * 变量类型解析：查"变量 varName 此刻指向什么"（类 / 函数 / 追不到）。
 * 沿赋值链做 DFS：每一层看"这条赋值右侧是什么"——
 *   1. R6Class 调用（裸 R6Class 或 R6::R6Class）→ 变量本身是类，类名 = 左侧变量名
 *   2. 其他形状交给求值器（evaluateRhs）判断（类 / 函数）
 *   3. 求值器认不出、且右侧是单个变量名 → 是别名（p <- q），沿链继续 DFS 追 q
 * DFS 安全性：visited 防环 + 深度上限，杜绝死循环 / 栈溢出。
 * 纯逻辑：不依赖 vscode，可在纯 Node 中测试。
 */

import { r6CallTokenRange } from '../parser/r6-parser';
import { nextNonComment } from '../parser/token-utils';
import type { Token } from '../parser/tokenizer';
import type { TextLines } from '../utils/text';
import { findLatestBinding, type Binding } from './bindings';
import { evaluateRhs, type NameResolver } from './rhs-eval';
import type { AnalysisContext } from './context';

/** 别名链最大追踪深度（visited 已防环，这是第二道保险） */
const MAX_TRACE_DEPTH = 100;

/** 变量最终指向什么（追到源头的结果） */
export type ResolvedType =
  | { kind: 'class'; className: string } // 变量是某类的实例 / 类本身
  | { kind: 'function' } // 变量是函数
  | null; // 追不到（环 / 未知 / 该位置前没赋值）

/**
 * 查 varName 在 cursorOffset 位置指向的类型。
 * 原料（tokens/绑定/resolver/行索引）全部从 ctx 取 —— 一次查询只解析一次。
 * @param ctx          分析上下文（含光标文件的 tokens/绑定/名字查询）
 * @param varName      要查的变量名
 * @param cursorOffset 光标偏移量（找"之前最近一次赋值"用）
 */
export function resolveVarType(
  ctx: AnalysisContext,
  varName: string,
  cursorOffset: number,
): ResolvedType {
  // L1：只在光标所在文件里追踪变量（bindings 只记了光标文件的赋值）
  return resolveVarTypeDFS(
    ctx.bindings,
    ctx.cursorTokens,
    ctx.resolver,
    ctx.lines,
    varName,
    cursorOffset,
    new Set(),
    0,
  );
}

/**
 * 沿赋值链 DFS 追变量类型（单一递归函数，本文件的递归核心）。
 * 每层处理一条赋值：判断右侧 → 出结论，或发现是别名 → 递归下一层。
 *
 * 层间关系（以 p <- q 追 q 为例）：
 *   第 0 层 resolveVarTypeDFS(p)
 *     → 找到 p 的赋值（p <- q），右侧 q 是别名
 *     → 递归第 1 层 resolveVarTypeDFS(q)
 *         → 找到 q 的赋值（q <- Person$new()），右侧是类 → 返回 class Person
 *     → 第 0 层把第 1 层的结论原样返回
 *
 * @param visited 记录已追过的变量名（防环：重复出现说明成环，返回 null）
 * @param depth   当前递归深度（超限返回 null，防超长别名链）
 */
function resolveVarTypeDFS(
  bindings: Binding[],
  tokens: Token[],
  resolver: NameResolver,
  lines: TextLines,
  varName: string,
  cursorOffset: number,
  visited: Set<string>,
  depth: number,
): ResolvedType {
  // DFS 终止条件一：这个变量已经追过 → 环（如 a <- b; b <- a）→ 追不到
  if (visited.has(varName)) {
    return null;
  }
  // DFS 终止条件二：链超长 → 追不到（正常代码远到不了这个深度）
  if (depth > MAX_TRACE_DEPTH) {
    return null;
  }
  visited.add(varName);

  // 找 varName 在光标前"最近一次"赋值（逻辑在 bindings.ts，与变量跳转共用同一份）
  const binding = findLatestBinding(bindings, varName, cursorOffset);
  // DFS 终止条件三：光标位置前没有这条变量的赋值 → 追不到
  if (binding === undefined) {
    return null;
  }

  const stIndex = binding.stIndex; // 右侧第一个 token 的下标
  const first = tokens[stIndex];

  // 本层出结论：类定义 —— Person <- R6Class(...) / R6::R6Class(...)。
  // 调用名后跟 '(' 才是定义；裸 R6Class 不带括号 = 引用函数本身，不算。
  if (first?.kind === 'identifier') {
    const range = r6CallTokenRange(tokens, stIndex);
    if (range !== null && tokens[range.enIndex + 1]?.text === '(') {
      return { kind: 'class', className: binding.varName };
    }
  }

  // 本层出结论：交给求值器判断（Person / person$Person / Person$new() / function）
  const evalResult = evaluateRhs(tokens, stIndex, {
    names: resolver,
    cursorOffset,
  });
  if (evalResult.kind === 'class') {
    return { kind: 'class', className: evalResult.className };
  }
  if (evalResult.kind === 'function') {
    return { kind: 'function' };
  }

  // 本层判断不了（unknown）→ 若右侧是"单个变量名"（p <- q），可能是别名，
  // 沿链 DFS 递归追那个变量（visited/depth 已保证安全）
  if (isSingleNameRhs(tokens, lines, stIndex)) {
    const aliasName = tokens[stIndex].text;
    return resolveVarTypeDFS(bindings, tokens, resolver, lines, aliasName, cursorOffset, visited, depth + 1);
  }

  // 形状不明（表达式 / 字面量等）→ 追不到
  return null;
}

/**
 * 判断赋值右侧是否"单个标识符就结束"（p <- q 这种，可能是别名）。
 * 结束标志：文件尾 / 分号 / 换行（换行后是下一句，不是本句的延续）。
 * 用行号判断换行，而不是只看下一个 token —— 换行后还有代码时
 * 下一个 token 仍在（如 p <- q 后换行再 p$name），纯 token 判断会漏判。
 */
function isSingleNameRhs(tokens: Token[], lines: TextLines, stIndex: number): boolean {
  const first = tokens[stIndex];
  if (first === undefined || first.kind !== 'identifier') {
    return false;
  }
  // 下一个非注释 token（注释不参与语句结构）
  const next = nextNonComment(tokens, stIndex + 1);
  if (next === undefined) {
    return true; // 右边只有这个名字（文件尾）
  }
  if (next.text === ';') {
    return true; // 分号分隔的下一句
  }
  // 换行了 → 本句到此结束（即使下一行还有代码）
  return lines.positionAt(next.offset).line !== lines.positionAt(first.offset).line;
}
