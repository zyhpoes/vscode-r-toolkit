/**
 * RHS 表达式类型求值（重构核心）：给定"赋值右边"的 token 起点，
 * 求值它指向什么（类 / 函数 / 未知）。支持：
 *   Person            → class Person（Person 在类清单）
 *   person$Person     → class Person（$ 链终点是类）
 *   Person$new()      → class Person（$new 构造，v1 不分实例/类）
 *   function(...)     → function
 *   其他 / 漏写右边   → unknown
 * 纯逻辑：不依赖 vscode。
 */

import type { Token } from '../parser/tokenizer';
import type { R6ClassDef } from '../parser/r6-parser';

/** 名字查询接口：求值器问"这个名字是类还是函数"，不感知背后实现（类表/函数表） */
export interface NameResolver {
  /** 名字是不是 R6 类（当前 + box 依赖文件的 parseR6 类名） */
  isClass(name: string): boolean;
  /** 名字是不是函数（当前 + box 依赖文件里定义的函数） */
  isFunction(name: string): boolean;
}

/**
 * NameResolver 的实现（当前唯一实现，与接口放一起，关系一目了然）。
 * 用类清单构造：isClass 查类名集合（O(1)）。
 * @param classes 所有已知类（当前文件 + box 依赖文件的 parseR6 合并结果）
 */
export function createNameResolver(classes: R6ClassDef[]): NameResolver {
  // 把类名收集成 Set，查询 O(1)
  const classNames = new Set(classes.map((c) => c.name));
  return {
    isClass: (name) => classNames.has(name),
    // 第一版没有函数表：所有名字都不当函数（isFunction 返回 false）。
    // 影响：`p <- someFunc` 会判 unknown（不误判成类即可），函数跳转将来做时再补。
    isFunction: () => false,
  };
}

/** 求值环境 */
export interface EvalEnv {
  names: NameResolver; // 查名字归类（类/函数）
  cursorOffset: number; // 找"最近赋值"用（预留，后续别名递归时用）
}

/** RHS 求值结果：指向什么 */
export type RhsType =
  | { kind: 'class'; className: string } // 指向某类（类本身或实例，v1 不分）
  | { kind: 'function' } // 指向函数
  | { kind: 'unknown' }; // 求不出（表达式/字面量/漏写）

/**
 * 对"赋值右边"求值。
 * @param tokens  整个文件 token
 * @param stRhs   右边第一个 token 的下标
 * @param env     求值环境（名字归类查询）
 */
export function evaluateRhs(tokens: Token[], stRhs: number, env: EvalEnv): RhsType {
  const first = tokens[stRhs];
  // 右边漏写（p <- 后面没内容，代码不完整）→ unknown
  if (first === undefined) {
    return { kind: 'unknown' };
  }

  // 函数定义：func <- function(...)
  if (first.kind === 'identifier' && first.text === 'function') {
    return { kind: 'function' };
  }

  // 单个标识符或 $ 链开头（Person / person$Person / Person$new()）
  if (first.kind === 'identifier') {
    // 后面跟 $ → 走 $ 链求值
    if (tokens[stRhs + 1]?.kind === 'operator' && tokens[stRhs + 1].text === '$') {
      return evaluateDollarChain(tokens, stRhs, env);
    }
    // 单名字：先查是不是类，再查是不是函数，都不是 → unknown
    if (env.names.isClass(first.text)) {
      return { kind: 'class', className: first.text };
    }
    if (env.names.isFunction(first.text)) {
      return { kind: 'function' };
    }
    return { kind: 'unknown' };
  }

  // 其他（表达式、字面量、调用等）→ unknown
  return { kind: 'unknown' };
}

/**
 * 求值 $ 链：person$Person / Person$new() / person$Person$new()。
 * 规则：链里发现 `new(` → 类名 = new 前一个名字；
 *       没有 new(      → 类名 = 链上最后一个名字（查它是不是类）。
 */
function evaluateDollarChain(tokens: Token[], stChain: number, env: EvalEnv): RhsType {
  // 沿链收集名字，并记录 new( 出现的位置
  const chainNames: string[] = [];
  let newNameIdx = -1; // new( 在 chainNames 里的下标（若出现）
  for (let j = stChain; j < tokens.length; j++) {
    const t = tokens[j];
    if (t.kind === 'identifier') {
      // 是 new 且后面跟 ( → 记录"这是 new(" 的位置（new 即将 push，下标 = 当前长度）
      if (t.text === 'new' && tokens[j + 1]?.kind === 'operator' && tokens[j + 1].text === '(') {
        newNameIdx = chainNames.length;
      }
      chainNames.push(t.text);
    } else if (t.kind === 'operator' && t.text === '$') {
      continue; // $ 分隔符，跳过
    } else {
      break; // 链结束（遇到 ( 等其他 token）
    }
  }

  // 定类名：有 new( 用 new 前一个名字，否则用最后一个名字
  const className =
    newNameIdx > 0 ? chainNames[newNameIdx - 1] : chainNames[chainNames.length - 1];

  // 类名必须是"真类"才返回 class，否则 unknown
  if (env.names.isClass(className)) {
    return { kind: 'class', className };
  }
  return { kind: 'unknown' };
}
