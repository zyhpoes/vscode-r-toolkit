/**
 * 文件大纲（Outline）数据：把解析出的 R6 类整理成"树"，供 VS Code 的大纲面板使用。
 * 纯逻辑：只产出纯数据（位置用偏移量表示），不依赖 vscode —— provider 负责换算成行列。
 *
 * 树形结构：类 → 区（public / private / active）→ 成员。
 * 空区（`list()` 里一个成员都没有）不生成节点，避免大纲里出现一堆空壳分组。
 * 位置约定：节点的 stOffset / enOffset 是"整块范围"（折叠与高亮用），
 * nameOffset 是名字起点（点击跳转与选中范围用）；两者都是偏移量，0 起。
 */

import type { R6ClassDef, R6Scope } from '../parser/r6-parser';
import type { Token } from '../parser/tokenizer';

/** 大纲节点种类：类 / 区（分组）/ 成员 */
export type OutlineKind = 'class' | 'scope' | 'member';

/** 大纲里的一项（纯数据） */
export interface OutlineNode {
  name: string;
  kind: OutlineKind;
  /** 所属区：成员与区节点有值，类节点为 undefined（provider 用它决定图标） */
  scope: R6Scope | undefined;
  /** 名字在原文中的偏移（选中范围 = nameOffset 起、名字长度个字符） */
  nameOffset: number;
  /** 整块范围的起始偏移（st = start） */
  stOffset: number;
  /** 整块范围的结束偏移（en = end，不含该位置本身） */
  enOffset: number;
  /** 子节点：类 → 区 → 成员 */
  children: OutlineNode[];
}

/** 区的展示顺序：public → private → active（跟常见 R6 写法一致，不按代码里的书写顺序） */
const SCOPE_ORDER: R6Scope[] = ['public', 'private', 'active'];

/**
 * 把类清单整理成大纲树。
 * @param classes 解析出的 R6 类（按代码顺序，当前只处理类；文件级函数/变量暂不列）
 * @param tokens  同一份文本的 token（类的整块范围要用 token 下标换算回偏移量）
 */
export function buildOutline(classes: R6ClassDef[], tokens: Token[]): OutlineNode[] {
  return classes.map((classDef) => buildClassNode(classDef, tokens));
}

/** 一个类 → 类节点（三个区的子节点挂在它下面） */
function buildClassNode(classDef: R6ClassDef, tokens: Token[]): OutlineNode {
  const scopeNodes = SCOPE_ORDER.map((scope) => buildScopeNode(classDef, scope, tokens)).filter(
    (node): node is OutlineNode => node !== undefined,
  );

  return {
    name: classDef.name,
    kind: 'class',
    scope: undefined,
    nameOffset: classDef.nameOffset,
    // 类的整块范围：从类名（`Person <- R6Class(...)` 的 Person）到最外层 ')' 之后
    stOffset: classDef.nameOffset,
    enOffset: r6CallEndOffset(classDef, tokens),
    children: scopeNodes,
  };
}

/** 一个区 → 区节点；该区没有成员时返回 undefined（不生成空节点） */
function buildScopeNode(classDef: R6ClassDef, scope: R6Scope, tokens: Token[]): OutlineNode | undefined {
  const members = classDef.members.filter((m) => m.scope === scope);
  if (members.length === 0) {
    return undefined;
  }

  const enMember = members[members.length - 1];
  const enMemberEnd = enMember.nameOffset + enMember.name.length;

  // 区关键字（`public = list(` 里的 public）在原文的位置：
  // 点区节点会跳到那一行，比跳到某个成员更合直觉
  const keywordOffset = findScopeKeywordOffset(classDef, scope, tokens);
  const nameOffset = keywordOffset ?? members[0].nameOffset;

  return {
    name: scope,
    kind: 'scope',
    scope,
    nameOffset,
    stOffset: nameOffset,
    // 结束位置取"最后一个成员末尾"与"名字末尾"的较大者：
    // 保证选区（名字）一定落在范围之内 —— VS Code 对 selectionRange ⊆ range 有硬校验，
    // 违反会让整个大纲请求失败（成员名比区名短时就会发生，如 `private = list(age = NA)`）
    enOffset: Math.max(enMemberEnd, nameOffset + scope.length),
    children: members.map((m) => ({
      name: m.name,
      kind: 'member',
      scope: m.scope,
      nameOffset: m.nameOffset,
      // 成员暂时只有"名字"这一段范围（成员值/方法体的范围 parser 还没记录）
      stOffset: m.nameOffset,
      enOffset: m.nameOffset + m.name.length,
      children: [],
    })),
  };
}

/**
 * 找区关键字 token 的偏移：判据是"标识符文本等于区名，且紧跟 `=`、`list`、`(`"。
 * 只在类的调用范围内找，且取第一个命中的 —— 真正的区参数排在方法体之前，
 * 所以不会被方法体里写的同名调用抢走。
 * 写法不常规（如 `base::list(`）时找不到 → 返回 undefined，调用方退回成员位置。
 */
function findScopeKeywordOffset(
  classDef: R6ClassDef,
  scope: R6Scope,
  tokens: Token[],
): number | undefined {
  for (let i = classDef.stIndex; i <= classDef.enIndex; i++) {
    const t = tokens[i];
    if (t?.kind !== 'identifier' || t.text !== scope) {
      continue;
    }
    const isAssignment = tokens[i + 1]?.kind === 'operator' && tokens[i + 1].text === '=';
    const isListCall =
      tokens[i + 2]?.kind === 'identifier' &&
      tokens[i + 2].text === 'list' &&
      tokens[i + 3]?.kind === 'operator' &&
      tokens[i + 3].text === '(';
    if (isAssignment && isListCall) {
      return t.offset;
    }
  }
  return undefined;
}

/**
 * 类定义的结束偏移：最外层配对 ')' 之后的位置。
 * 取不到 token（理论上不会发生）时退回类名偏移，保证范围合法。
 */
function r6CallEndOffset(classDef: R6ClassDef, tokens: Token[]): number {
  const closeToken = tokens[classDef.enIndex];
  if (closeToken === undefined) {
    return classDef.nameOffset;
  }
  return closeToken.offset + closeToken.text.length;
}
