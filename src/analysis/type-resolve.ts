/**
 * 变量类型解析（第 2 层）：给定绑定记录（第 1 层的产物）+ 变量名 + 位置，
 * 沿赋值链递归追到"源头"，返回这个变量此刻指向什么。
 * 纯逻辑：不依赖 vscode，可在纯 Node 中测试。
 */

import type { Binding, BindingRhs } from './bindings';

/** 变量最终指向什么（追到源头的结果） */
export type ResolvedType =
  | { kind: 'class'; className: string } // 变量是某类的实例 / 类本身
  | { kind: 'function' } // 变量是函数
  | null; // 追不到（环 / 未知 / 该位置前没赋值）

/**
 * 查 varName 在 cursorOffset 位置指向的类型。
 * @param bindings     第 1 层扫描出的全部赋值记录（按代码顺序）
 * @param varName      要查的变量名
 * @param cursorOffset 光标位置（找"之前最近一次赋值"用）
 */
export function resolveVarType(
  bindings: Binding[],
  varName: string,
  cursorOffset: number,
): ResolvedType {
  return resolveRec(bindings, varName, cursorOffset, new Set<string>());
}

/**
 * 递归核心。
 * @param visited 记录已追过的变量（防环：遇到重复说明成环，返回 null）
 */
function resolveRec(
  bindings: Binding[],
  varName: string,
  cursorOffset: number,
  visited: Set<string>,
): ResolvedType {
  // 防环：这个变量已经追过 → 环（如 a <- b; b <- a）→ 追不到
  if (visited.has(varName)) {
    return null;
  }
  visited.add(varName);

  // 找 varName 在 cursorOffset 前"最近一次"赋值（bindings 按顺序存，取最后一条 ≤ cursorOffset 的）
  let binding: Binding | undefined;
  for (let i = bindings.length - 1; i >= 0; i--) {
    const b = bindings[i];
    if (b.varName === varName && b.offset <= cursorOffset) {
      binding = b;
      break;
    }
  }
  if (binding === undefined) {
    return null; // 该位置前没有赋值
  }

  return classifyBinding(bindings, binding, cursorOffset, visited);
}

/** 根据一条赋值的 rhs 形态决定：返回结论，还是继续追 alias */
function classifyBinding(
  bindings: Binding[],
  binding: Binding,
  cursorOffset: number,
  visited: Set<string>,
): ResolvedType {
  const rhs: BindingRhs = binding.rhs;

  // 追踪终点：变量是某类的实例，值来自 sourceName（类名）
  if (rhs.kind === 'r6-class-new') {
    return { kind: 'class', className: rhs.sourceName };
  }

  // 追踪终点：变量本身就是一个类（Person <- R6Class(...)），类名 = 变量名
  if (rhs.kind === 'r6-class-def') {
    return { kind: 'class', className: binding.varName };
  }

  // 追踪终点：变量是函数
  if (rhs.kind === 'function') {
    return { kind: 'function' };
  }

  // 中间态：别名，继续追 sourceName
  if (rhs.kind === 'alias') {
    return resolveRec(bindings, rhs.sourceName, cursorOffset, visited);
  }

  // unknown（表达式/字面量等）→ 无追踪价值
  return null;
}
