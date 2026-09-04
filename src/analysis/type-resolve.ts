/**
 * 变量类型解析：查"变量 varName 此刻指向什么"（类 / 函数 / 追不到）。
 * 沿赋值链递归追到源头；bindings 预分类不足以判断时（unknown），
 * 用求值器（evaluateRhs）对赋值右边重新求值。
 * 纯逻辑：不依赖 vscode，可在纯 Node 中测试。
 */

import { tokenize } from '../parser/tokenizer';
import { parseR6 } from '../parser/r6-parser';
import type { SourceFile } from './source-file';
import { parseBindings, type Binding, type BindingRhs } from './bindings';
import { createNameResolver, evaluateRhs } from './rhs-eval';

/** 变量最终指向什么（追到源头的结果） */
export type ResolvedType =
  | { kind: 'class'; className: string } // 变量是某类的实例 / 类本身
  | { kind: 'function' } // 变量是函数
  | null; // 追不到（环 / 未知 / 该位置前没赋值）

/**
 * 查 varName 在 cursorOffset 位置指向的类型。
 * @param files         所有相关文件（当前文件 + 依赖文件）
 * @param varName       要查的变量名
 * @param cursorFileUri 光标在哪个文件（在该文件里扫赋值、找最近赋值）
 * @param cursorOffset  光标偏移量（找"之前最近一次赋值"用）
 */
export function resolveVarType(
  files: SourceFile[],
  varName: string,
  cursorFileUri: string,
  cursorOffset: number,
): ResolvedType {
  // 只在光标所在文件里分析（L1：同文件的变量追踪）
  const cursorFile = files.find((f) => f.uri === cursorFileUri);
  if (cursorFile === undefined) {
    return null;
  }

  const tokens = tokenize(cursorFile.text);
  const bindings = parseBindings(cursorFile.text);
  // 类清单：所有文件（当前 + 依赖）的类 —— 让 isClass 能认出跨文件类
  const allClasses = files.flatMap((f) => parseR6(f.text));
  const resolver = createNameResolver(allClasses);

  return resolveRec(bindings, tokens, resolver, varName, cursorOffset, new Set<string>());
}

/**
 * 递归核心。
 * @param visited 记录已追过的变量（防环：遇到重复说明成环，返回 null）
 */
function resolveRec(
  bindings: Binding[],
  tokens: ReturnType<typeof tokenize>,
  resolver: ReturnType<typeof createNameResolver>,
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

  return classifyBinding(bindings, tokens, resolver, binding, cursorOffset, visited);
}

/**
 * 根据一条赋值的 rhs 形态决定：返回结论、继续追 alias、还是用求值器补查。
 */
function classifyBinding(
  bindings: Binding[],
  tokens: ReturnType<typeof tokenize>,
  resolver: ReturnType<typeof createNameResolver>,
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
    return resolveRec(bindings, tokens, resolver, rhs.sourceName, cursorOffset, visited);
  }

  // unknown（bindings 预分类没覆盖，如 p <- person$Person）：
  // 用求值器对赋值右边重新求值，看能不能识别成类/函数
  const env = { names: resolver, cursorOffset };
  const evalResult = evaluateRhs(tokens, binding.rhsStIndex, env);
  if (evalResult.kind === 'class') {
    return { kind: 'class', className: evalResult.className };
  }
  if (evalResult.kind === 'function') {
    return { kind: 'function' };
  }
  return null;
}
