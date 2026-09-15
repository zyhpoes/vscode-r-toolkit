/**
 * 继承链解析：在"已加载文件"里把 inherit 引用解析成父类（带文件），
 * 并提供"沿继承链找成员（最近祖先优先）"的查询。
 * 纯逻辑：不依赖 vscode，可在纯 Node 中测试。
 *
 * 边界（本轮确认）：父类只在 context 已解析的文件（当前文件 + box 直接依赖）里找；
 * 祖父类在更外层文件（递归依赖）属于将来"工作区索引"阶段的事。
 * inherit 的三种写法（裸类名 / $ 链 / 引号字符串）最终都收敛成一个类名，
 * 按名字在"预解析清单"里找；模块限定（person$Parent）的"只在 person 模块里找"
 * 留给将来模块索引。
 *
 * 入参是 context 预解析好的 ParsedSourceFile[]（每个文件只解析过一次），
 * 本模块只遍历，不再 parseR6。"类 + 文件"配对用 definitions 的 ClassWithFile（单一出处）。
 */

import type { R6Member, R6Scope } from '../parser/r6-parser';
import type { ParsedSourceFile } from './source-file';
import { findClassAcrossFiles, type ClassWithFile } from './definitions';

/**
 * 解析一个类的父类：把 inherit 引用解析成父类（带文件）。
 * 没写 inherit / 父类不在已解析清单里 → null。
 */
export function resolveParentNode(
  parsed: ParsedSourceFile[],
  node: ClassWithFile,
): ClassWithFile | null {
  const inherit = node.classDef.inherit;
  if (inherit === undefined) {
    return null;
  }
  // ?? null：findClassAcrossFiles 找不到返回 undefined，对外统一返回 null
  return findClassAcrossFiles(parsed, inherit.className) ?? null;
}

/** 类身份（防环用）：文件 uri + 类名（同名不同文件是不同类） */
function nodeKey(node: ClassWithFile): string {
  return `${node.parsed.file.uri}::${node.classDef.name}`;
}

/**
 * 从 start 沿继承链向上收集节点（先近后远）。
 * @param includeStart 是否包含起点本身（self$/类名$/实例$ 含，super$ 不含）
 * 防环：visited 记已走过的节点，成环时截断 —— 不会死循环
 */
export function collectHierarchy(
  parsed: ParsedSourceFile[],
  start: ClassWithFile,
  includeStart: boolean,
): ClassWithFile[] {
  const chain: ClassWithFile[] = [];
  const visited = new Set<string>();
  let cur: ClassWithFile | null = includeStart ? start : resolveParentNode(parsed, start);
  while (cur !== null && !visited.has(nodeKey(cur))) {
    visited.add(nodeKey(cur));
    chain.push(cur);
    cur = resolveParentNode(parsed, cur);
  }
  return chain;
}

/**
 * 沿继承链找成员：返回"链上第一个定义了 memberName（且区在 scopes 内）"的节点。
 * 链上都没有 → null。
 */
export function findHierarchyMember(
  parsed: ParsedSourceFile[],
  start: ClassWithFile,
  memberName: string,
  scopes: R6Scope[],
  includeStart: boolean,
): { node: ClassWithFile; member: R6Member } | null {
  for (const node of collectHierarchy(parsed, start, includeStart)) {
    const member = node.classDef.members.find(
      (m) => m.name === memberName && scopes.includes(m.scope),
    );
    if (member !== undefined) {
      return { node, member };
    }
  }
  return null;
}
