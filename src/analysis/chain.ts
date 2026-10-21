/**
 * 成员链（`a$b$c`）的解析：收链 → 逐段折叠 → 失败兜底。
 * 补全与跳转**都只是消费者** —— 它们解析 a / b / c 的方式完全相同，所以只写这一份。
 * 纯逻辑：不依赖 vscode，可在纯 Node 中测试。
 *
 * 依赖方向（单向，无环）：chain → members（resolveContainerType）
 *   chain → type-resolve（memberValueType）→ inheritance（findHierarchyMember）/ definitions（findClassAcrossFiles）
 */

import type { Token } from '../parser/tokenizer';
import type { TextLines } from '../utils/text';
import type { AnalysisContext } from './context';
import { findClassAcrossFiles } from './definitions';
import { findVisibleMember, resolveContainerType, type R6Container } from './members';
import { memberValueType } from './type-resolve';

/** `a$b$c$` 的链：段名（含容器那一段）+ 链头那个 token 的下标（关键字链头要用它反查所在类） */
export interface MemberChain {
  names: string[];
  headIndex: number;
}

/**
 * 从一个 token 往回收集链：`model$key_id$` → `{ names: ['model','key_id'], headIndex: 0 }`。
 * 只认"名字 $ 名字 $ …"：碰到 `::`、`)`、语句开头就停。
 * 补全时传"光标左边那段的名字"，跳转时传"成员名前两个 token 那个名字" —— 两者共用同一套收链。
 */
export function memberChainSegments(
  tokens: Token[],
  lines: TextLines,
  containerIndex: number,
): MemberChain {
  const names: string[] = [tokens[containerIndex].text];
  let headIndex = containerIndex;
  while (isChainJoint(tokens, lines, headIndex)) {
    headIndex -= 2;
    // 在数组【开头】插入一个元素 → 返回【新的长度】
    names.unshift(tokens[headIndex].text);
  }
  return { names, headIndex };
}

/**
 * 确保连接符在同一行（也是这个函数最主要的存在意义）。比如:
 * model$key_id$label 在同一行时会触发补全
 * model$key_id$\nlabel 不会触发补全
 */
function isChainJoint(tokens: Token[], lines: TextLines, headIndex: number): boolean {
  const dollar = tokens[headIndex - 1];
  const left = tokens[headIndex - 2];
  if (dollar?.text !== '$' || left?.kind !== 'identifier') return false;
  const dollarLine = lines.positionAt(dollar.stOffset).line;
  return dollarLine === lines.positionAt(tokens[headIndex].stOffset).line;
}

/**
 * 链式容器 `a$b$c$` → 终点容器（**纯折叠**，失败即 undefined）。
 * 链是"一条线"、每段只吃一个 token，不需要防环 / 深度上限（与别名链的 DFS 不同），所以用循环。
 */
export function resolveChainType(
  ctx: AnalysisContext,
  chain: MemberChain,
  cursorOffset: number,
): R6Container | undefined {
  const head = resolveContainerType(ctx, chain.names[0], chain.headIndex, cursorOffset);
  if (head === undefined) return undefined;

  let current = head;
  // 链头那套可见性（super 从父类起算 / private 只看 private 区）只作用于**链头这一次**查找；
  // 往后的每段都由上一段的类型决定，一律按实例默认可见性。
  for (let i = 1; i < chain.names.length; i++) {
    const name = chain.names[i];
    const hit = findVisibleMember(ctx, current, name);
    if (hit === null) return undefined;

    const type = memberValueType(ctx, hit.node, hit.member, cursorOffset);
    // 只有"类/实例"才有可点的成员；函数与 unknown 一律断链
    if (type.kind !== 'r6-generator' && type.kind !== 'r6-instance') return undefined;

    const target = findClassAcrossFiles(ctx.parsedFiles, type.className);
    if (target === undefined) return undefined;

    current = { ...target, kind: type.kind === 'r6-generator' ? 'generator' : 'instance' };
  }

  return current;
}

/**
 * 链 → 终点容器（**折叠 + 兜底**）：补全与跳转都调这一个，所以两边对 a$b$c 的解析完全一致。
 * 兜底语义 = "折叠失败就只看最后一段"，与没做链式之前的行为一致：
 *   · 单段（a$）→ 折叠失败没有"上一段"可退，直接 undefined
 *   · 多段（a$b$c$）→ 退成"把 c 当容器"再解析一次（`person$Person$` 走这里）
 */
export function resolveChainContainer(
  ctx: AnalysisContext,
  chain: MemberChain,
  cursorOffset: number,
): R6Container | undefined {
  const chained = resolveChainType(ctx, chain, cursorOffset);
  if (chained !== undefined) return chained;
  if (chain.names.length === 1) return undefined;

  const lastIndex = chain.headIndex + (chain.names.length - 1) * 2;
  const lastName = chain.names[chain.names.length - 1];
  return resolveContainerType(ctx, lastName, lastIndex, cursorOffset);
}
