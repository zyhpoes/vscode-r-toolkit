/**
 * 成员定义解析：光标在 `xxx$成员` 上时，判断成员定义在哪。
 * 支持：self$ / private$ / super$ / 类名$ / 实例变量$。
 * 纯逻辑：不依赖 vscode，可在纯 Node 中测试。
 *
 * 一句话规则（R6 portable 语义，各分支注释里还会再讲"为什么"）：
 *   self$     本类 + 继承来的 public/active
 *   private$  只本类自己的 private（private 不随继承可见）
 *   super$    父类链上的 public/active（不含本类，指"父类的同名成员"）
 *   类名$ / 实例变量$   按名字或类型定位类，查 public/active（含继承来的）
 */

import type { R6Member, R6Scope } from '../parser/r6-parser';
import { enclosingBlock } from '../parser/blocks';
import type { AnalysisContext } from './context';
import { definitionSiteAt, findClassAcrossFiles, type ClassWithFile, type DefinitionSite } from './definitions';
import { findHierarchyMember } from './inheritance';
import { resolveVarType, memberValueType } from './type-resolve';
import { findWordIndexAt } from './cursor';

/** 对外可见的区：self$/类名$/实例$/super$ 都只能看到这两类（private 外面看不见）。补全共用 */
export const PUBLIC_VISIBLE: R6Scope[] = ['public', 'active'];

/**
 * 类生成器自带的槽（`类名$` 的候选集；**不含 `new`** —— 它由 parser 的 synthetic 提供，
 * 因为 `new` 还带"跳到 initialize"这层身份，放在一处定义才不会漂；万一将来有人把这行
 * 补进表里，generatorSlotCandidates 有去重兜住）。
 *
 * 实测（R6 2.6.1）：名单取自 `ls(R6Class(...))`，按 `ls()` 原样顺序（字母序）；
 * 行尾注的类型/签名也是实测的（函数用 `deparse(args(f))` 打印）。
 * 口径：以 `ls()` 默认输出为准 —— 点开头的名字（`.__enclos_env__` 等）不算。
 * 有几个槽的类型会随内容变：没写 `inherit` 时它是 `NULL`，没有私有方法时 `private_methods` 是 `NULL`。
 * 复测方法（R6 升级后照此核对）：
 *   Model <- R6Class("Model", public = list(greet = function() 1, v = 1))
 *   ls(Model)                 # 应当就是下面这 24 个 + new
 *   is.function(Model$greet)  # 实测 FALSE：生成器上取不到用户成员
 */
export const R6_GENERATOR_SLOTS: string[] = [
  'active',           // 本类 active 绑定的清单（列表）
  'class',            // R6Class 的 class 参数：是否给实例加 class 属性（逻辑值）
  'classname',        // 类名（字符串）
  'clone_method',     // clone 的实现 function (deep = FALSE)；实例上的 clone 就是它
  'cloneable',        // R6Class 的 cloneable 参数：能否 clone（逻辑值）
  'debug',            // 打开某个方法的调试 function (name)
  'debug_names',      // 当前处于调试的方法名（字符向量）
  'get_inherit',      // 取父类生成器 function ()
  'has_private',      // 本类有没有 private 区 function ()
  'inherit',          // 父类生成器（本类没写 inherit 时是 NULL）
  'is_locked',        // 实例是否已被 lock function ()
  'lock',             // 锁住实例，之后不能再加成员 function ()
  'lock_class',       // R6Class 的 lock_class 参数（逻辑值）
  'lock_objects',     // R6Class 的 lock_objects 参数：实例能否新增成员（逻辑值）
  'parent_env',       // 生成器的父环境（environment）
  'portable',         // R6Class 的 portable 参数（逻辑值）
  'private_fields',   // 私有字段清单（列表）
  'private_methods',  // 私有方法清单（没有私有方法时是 NULL）
  'public_fields',    // 公开字段清单（列表）
  'public_methods',   // 公开方法清单（列表）
  'self',             // 指向生成器自己（R6ClassGenerator）
  'set',              // 动态加成员 function (which = NULL, name = NULL, value, overwrite = FALSE)
  'undebug',          // 关掉某个方法的调试 function (name)
  'unlock',           // 解锁 function ()
];

/**
 * 解析光标处的成员定义。
 * @param ctx          分析上下文（含光标文件 tokens/文件清单）
 * @param cursorOffset 光标偏移量
 * @returns 命中返回成员定义位置（带目标文件 uri）；未命中返回 null
 */
export function resolveMemberDefinition(
  ctx: AnalysisContext,
  cursorOffset: number,
): DefinitionSite | null {
  // 找光标下的 identifier（返回下标，后面要靠它回看前两个 token）
  const tokens = ctx.cursorFile.tokens;
  const wordIdx = findWordIndexAt(ctx, cursorOffset);
  if (wordIdx === -1) return null;
  const word = tokens[wordIdx];

  // 向前找紧邻的 '$'（wordIdx-1 必须是 '$'，否则不是成员引用）
  const dollar = tokens[wordIdx - 1];
  if (dollar?.kind !== 'operator' || dollar.text !== '$') return null;

  // 看 '$' 前是什么 → 决定"去哪找成员"
  const before = tokens[wordIdx - 2];
  if (before?.kind !== 'identifier') return null;

  // ── super$：父类链上的成员（不含本类）──────────────────────────
  if (before.text === 'super') {
    // super 只能写在类方法体里：先反查"光标在哪个类中"，那个类就是"我"
    const holder = containingClass(ctx, wordIdx);
    if (holder === undefined) return null;
    // super$xxx = 父类的 xxx：从 holder 的父类起向上找（isSuper=true：跳过本类）
    const hit = findHierarchyMember(ctx.parsedFiles, holder, word.text, PUBLIC_VISIBLE, true);
    if (hit === null) return null;
    return definitionSiteAt(word.text, hit.node.parsed, hit.member.nameOffset);
  }

  // ── private$：只查本类自己的 private ──────────────────────────
  if (before.text === 'private') {
    // private 只能写在类方法体里：反查光标所在类
    const holder = containingClass(ctx, wordIdx);
    if (holder === undefined) return null;
    // R6：private 不随继承 —— 子类看不到父类的 private，所以只在本类找、不往上走
    const member = holder.classDef.members.find(
      (m) => m.name === word.text && m.scope === 'private',
    );
    if (member !== undefined) return definitionSiteAt(word.text, holder.parsed, member.nameOffset);
    // 本类没有这个 private → 兜底查合成成员（new）
    return resolveSynthetic(holder, word.text);
  }

  // ── self$：本类 + 父类链的 public/active ───────────────────────
  if (before.text === 'self') {
    // self 也只能写在类方法体里：反查光标所在类
    const holder = containingClass(ctx, wordIdx);
    if (holder === undefined) return null;
    // 继承来的方法 self 也能调：先本类后父类（isSuper=false：含本类，最近祖先优先）
    const hit = findHierarchyMember(ctx.parsedFiles, holder, word.text, PUBLIC_VISIBLE, false);
    if (hit !== null) return definitionSiteAt(word.text, hit.node.parsed, hit.member.nameOffset);
    // 本类和父类都没有 → 兜底查合成成员（new）
    return resolveSynthetic(holder, word.text);
  }

  // ── 类名$ / 实例变量$（Person$greet / p$greet）─────────────────
  // 类外的访问只能看到 public/active（含继承来的），private 一律看不见
  const target = resolveNamedTarget(ctx, before.text, cursorOffset);
  if (target === undefined) return null;
  const hit = findHierarchyMember(ctx.parsedFiles, target, word.text, PUBLIC_VISIBLE, false);
  if (hit !== null) return definitionSiteAt(word.text, hit.node.parsed, hit.member.nameOffset);
  return resolveSynthetic(target, word.text);
}

/**
 * 反查"光标所在类"：self/private/super 写在方法体里，
 * 方法体在类的 R6Class 调用范围内 → 光标落在哪个类范围里，就是哪个类。
 * （跳转与补全共用；补全传的是容器名那个 token 的下标）
 *
 * 用块结构回答"我在哪个类里"，再按【起点】配对类定义：
 * 类块的起点已对齐到 parseR6 的 R6ClassDef.stIndex（R6::R6Class 也取 `R6`），所以直接比起点。
 */
export function containingClass(ctx: AnalysisContext, wordIdx: number): ClassWithFile | undefined {
  const block = enclosingBlock(ctx.cursorFile.blocks, wordIdx, 'r6-class');
  if (block === undefined) return undefined;
  const classDef = ctx.cursorFile.classes.find((c) => c.stIndex === block.stIndex);
  if (classDef === undefined) return undefined;
  return { classDef, parsed: ctx.cursorFile };
}

/** 容器的"可点范围"：目标类 + 哪些区可见 + 是不是 `super$` 访问 + 是不是 `private$` 访问 */
export interface ContainerScope {
  target: ClassWithFile;
  scopes: R6Scope[];
  /** 是 `super$` 访问：从父类起算、不含本类（原样传给 collectHierarchy / findHierarchyMember） */
  isSuper: boolean;
  /** 是 `private$` 访问：只看本类、不沿继承链（R6 里 private 不随继承可见） */
  isPrivate: boolean;
}

/** 容器类型：生成器（`类名$` 出槽）还是实例（`实例$` 出成员）—— 两者能点的名字不同 */
export interface ContainerType extends ContainerScope {
  kind: 'generator' | 'instance';
}

/** `a$b$c$` 的链：段名（含容器那一段）+ 链头那个 token 的下标（关键字链头要用它反查所在类） */
export interface MemberChain {
  names: string[];
  headIndex: number;
}

/**
 * 名字 → 目标类 + 它是生成器还是实例。
 *   Person$greet  → Person 本身是类名 → 生成器
 *   P <- Person   → 变量值是类生成器 → 生成器
 *   p <- Person$new() → 变量值是实例 → 实例
 */
function classTargetOfName(
  ctx: AnalysisContext,
  name: string,
  cursorOffset: number,
): { kind: 'generator' | 'instance'; target: ClassWithFile } | undefined {

  // 解析到name就是类名，直接返回即可。比如: Person <- R6Class(...)
  const asClass = findClassAcrossFiles(ctx.parsedFiles, name);
  if (asClass !== undefined) return { kind: 'generator', target: asClass };

  // 解析到name是类名的赋值或者是类的实例:
  // 类名赋值，比如: Person <- R6Class(...); P <- Person
  // 类的实例，比如: Person <- R6Class(...); person <- Person$new()
  const type = resolveVarType(ctx, name, cursorOffset);
  if (type === null || (type.kind !== 'generator' && type.kind !== 'instance')) return undefined;
  
  // 把类名定位到"类定义 + 所在文件"（下游要用它的 lines 换算行列、tokens 求值）
  const target = findClassAcrossFiles(ctx.parsedFiles, type.className);
  if (target === undefined) return undefined;
  
  return { kind: type.kind, target };
}

/**
 * 类名$ / 实例变量$ 的目标类定位（跳转用 —— 它不看 kind，补全走 resolveContainerType）。
 */
export function resolveNamedTarget(
  ctx: AnalysisContext,
  name: string,
  cursorOffset: number,
): ClassWithFile | undefined {
  return classTargetOfName(ctx, name, cursorOffset)?.target;
}

/**
 * 容器（单段名字）→ 类型 + 可点范围。关键字容器靠"光标在哪个类里"解析，名字容器靠查类表/赋值链。
 */
export function resolveContainerType(
  ctx: AnalysisContext,
  container: string,
  containerIndex: number,
  cursorOffset: number,
): ContainerType | undefined {
  // self / private / super 不是名字：只能写在方法体里 → 反查光标所在类
  if (container === 'self' || container === 'private' || container === 'super') {
    const holder = containingClass(ctx, containerIndex);
    if (holder === undefined) return undefined;
    return {
      kind: 'instance',
      target: holder,
      scopes: container === 'private' ? ['private'] : PUBLIC_VISIBLE,
      isSuper: container === 'super',
      isPrivate: container === 'private',
    };
  }

  const hit = classTargetOfName(ctx, container, cursorOffset);
  if (hit === undefined) return undefined;
  return { ...hit, scopes: PUBLIC_VISIBLE, isSuper: false, isPrivate: false };
}

/**
 * 链式容器 `a$b$c$` → 终点类型。
 * 链是"一条线"、每段只吃一个 token，不需要防环 / 深度上限（与别名链的 DFS 不同），所以用循环。
 * 任何一层解析不出来 → undefined（调用方退回"只解析最后一段"）。
 */
export function resolveChainType(
  ctx: AnalysisContext,
  chain: MemberChain,
  cursorOffset: number,
): ContainerType | undefined {
  const head = resolveContainerType(ctx, chain.names[0], chain.headIndex, cursorOffset);
  if (head === undefined) return undefined;

  let current = head;
  // 链头那套可见性（private 只看本类 / super 从父类起算）只作用于**链头这一次**查找；
  // 往后的每段都由上一段的类型决定，一律按实例默认可见性。
  for (let i = 1; i < chain.names.length; i++) {
    const name = chain.names[i];
    const hit = current.isPrivate
      ? ownMember(current.target, name, current.scopes)
      : findHierarchyMember(ctx.parsedFiles, current.target, name, current.scopes, current.isSuper);
    if (hit === null) return undefined;

    const type = memberValueType(ctx, hit.node, hit.member, cursorOffset);
    // 函数（或推不出类型）没有可点的成员 → 断链
    if (type === null || type.kind === 'function') return undefined;

    const target = findClassAcrossFiles(ctx.parsedFiles, type.className);
    if (target === undefined) return undefined;

    current = {
      kind: type.kind,
      target,
      scopes: PUBLIC_VISIBLE,
      isSuper: false,
      isPrivate: false,
    };
  }

  return current;
}

/** 只在本类里找成员（不沿继承链）—— private$ 那一支用 */
function ownMember(
  target: ClassWithFile,
  name: string,
  scopes: R6Scope[],
): { node: ClassWithFile; member: R6Member } | null {
  const member = target.classDef.members.find((m) => m.name === name && scopes.includes(m.scope));
  return member === undefined ? null : { node: target, member };
}

/** 合成成员兜底：new 是 R6 自动生成的，每个类有自己的一份（指向本类 initialize 或类定义） */
function resolveSynthetic(target: ClassWithFile, name: string): DefinitionSite | null {
  const synthetic = target.classDef.synthetic.find((s) => s.name === name);
  if (synthetic === undefined) return null;
  return definitionSiteAt(name, target.parsed, synthetic.nameOffset);
}
