/**
 * 成员定义解析：光标在 `xxx$成员` 上时，判断成员定义在哪。
 * 支持：self$ / private$ / super$ / 类名$ / 实例变量$。
 * 纯逻辑：不依赖 vscode，可在纯 Node 中测试。
 *
 * 一句话规则（R6 portable 语义；规则只由 resolveContainerType 定义，补全与跳转共用同一套）：
 *   self$     本类 + 继承来的 public/active
 *   private$  本类 + 父类的 private（实测：R6 把父类的 private 成员复制进子类的 private 环境）
 *   super$    父类链上的 public/active（不含本类，指"父类的同名成员"）
 *   类名$ / 实例变量$   按名字或类型定位类，查 public/active（含继承来的）
 */

import type { R6ClassDef, R6Member } from '../parser/r6-parser';
import { enclosingBlock } from '../parser/blocks';
import type { AnalysisContext } from './context';
import type { ParsedSourceFile } from './source-file';
import { memberChainSegments, resolveChainContainer } from './chain';
import { definitionSiteAt, findClassAcrossFiles, type R6ClassWithFile, type DefinitionSite } from './definitions';
import { collectHierarchy } from './inheritance';
import { resolveVarType } from './type-resolve';
import { findWordIndexAt } from './cursor';

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

  // 看 '$' 前是什么 → 容器。链式（a$b$c）在 chain.ts 里统一处理：补全与跳转同一套
  const before = tokens[wordIdx - 2];
  if (before?.kind !== 'identifier') return null;

  const chain = memberChainSegments(tokens, ctx.cursorFile.lines, wordIdx - 2);
  const container = resolveChainContainer(ctx, chain, cursorOffset);
  if (container === undefined) return null;

  const hit = findVisibleMember(ctx, container, word.text);
  if (hit !== null) return definitionSiteAt(word.text, hit.node.parsed, hit.member.nameOffset);

  // 合成成员（new）只长在生成器上：实例 / self / private / super 上都没有
  return container.kind === 'generator' ? resolveSynthetic(container, word.text) : null;
}

/**
 * 反查"光标所在类"：self/private/super 写在方法体里，
 * 方法体在类的 R6Class 调用范围内 → 光标落在哪个类范围里，就是哪个类。
 * （跳转与补全共用；补全传的是容器名那个 token 的下标）
 *
 * 用块结构回答"我在哪个类里"，再按【起点】配对类定义：
 * 类块的起点已对齐到 parseR6 的 R6ClassDef.stIndex（R6::R6Class 也取 `R6`），所以直接比起点。
 */
export function containingClass(ctx: AnalysisContext, wordIdx: number): R6ClassWithFile | undefined {
  const block = enclosingBlock(ctx.cursorFile.blocks, wordIdx, 'r6-class');
  if (block === undefined) return undefined;
  const classDef = ctx.cursorFile.classes.find((c) => c.stIndex === block.stIndex);
  if (classDef === undefined) return undefined;
  return { classDef, parsed: ctx.cursorFile };
}

/**
 * 一个 R6 容器：目标 R6 类 + 视角（能看哪些成员由视角现算，见 membersOf）。
 * 视角是 R6 专属概念 —— 模块 / data.frame 等其它来源没有"区"和"视角"，将来各自有自己的容器类型：
 *   self      方法体里的 self$：本类 + 父类的 public/active
 *   private   private$：本类 + 父类的 private（实测：R6 把父类 private 复制进子类环境）
 *   super     super$：从父类起算，目前按 public/active 看（A2 要做成"三个区 + 只给函数"）
 *   instance  类外的实例变量 p$：同 self
 *   generator 类名$：出 R6 自带的槽，不查成员
 */
export interface R6Container {
  // 目标 R6 类的定义，和它所在文件的解析产物（tokens / lines 等）
  classDef: R6ClassDef;
  parsed: ParsedSourceFile;
  kind: 'self' | 'instance' | 'private' | 'super' | 'generator';
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
): R6Container | undefined {

  // 解析到name就是类名，直接返回即可。比如: Person <- R6Class(...)
  const asClass = findClassAcrossFiles(ctx.parsedFiles, name);
  if (asClass !== undefined) return { ...asClass, kind: 'generator' };

  // 解析到name是类名的赋值或者是类的实例:
  // 类名赋值，比如: Person <- R6Class(...); P <- Person
  // 类的实例，比如: Person <- R6Class(...); person <- Person$new()
  const type = resolveVarType(ctx, name, cursorOffset);
  if (type.kind !== 'r6-generator' && type.kind !== 'r6-instance') return undefined;

  // 把类名定位到"类定义 + 所在文件"（下游要用它的 lines 换算行列、tokens 求值）
  const target = findClassAcrossFiles(ctx.parsedFiles, type.className);
  if (target === undefined) return undefined;

  return { ...target, kind: type.kind === 'r6-generator' ? 'generator' : 'instance' };
}

/**
 * 容器（单段名字）→ 目标类 + 种类。关键字容器靠"光标在哪个类里"解析，名字容器靠查类表/赋值链。
 * 这里**只判身份**；"能看哪些成员"全部交给 membersOf（规则只写那一处）。
 */
export function resolveContainerType(
  ctx: AnalysisContext,
  containerName: string,
  containerIndex: number,
  cursorOffset: number,
): R6Container | undefined {
  // self / private / super 不是名字：只能写在方法体里 → 反查光标所在类
  if (containerName === 'self' || containerName === 'private' || containerName === 'super') {
    const holder = containingClass(ctx, containerIndex);
    if (holder === undefined) return undefined;
    return { ...holder, kind: containerName }; // 窄化后正好是 'self' | 'private' | 'super'
  }

  return classTargetOfName(ctx, containerName, cursorOffset);
}

/**
 * 容器里能看见的成员（沿继承链走一遍，同名只留最近的 = 子类遮蔽父类）。
 *
 * **R6 的成员可见性规则只写在这一处** —— 补全（要列表）与跳转（要单个）都从它出发，
 * 所以两边不可能再对"哪些成员可见"给出不同答案：
 *   self / instance   本类 + 父类的 public/active
 *   private           本类 + 父类的 private
 *   super             从父类起算，三个区都要
 *   generator         不出成员（走 R6 自带槽，由补全那边的 generatorSlotCandidates 负责）
 */
export function membersOf(
  ctx: AnalysisContext,
  container: R6Container,
): { node: R6ClassWithFile; member: R6Member }[] {
  // 每项记"这个成员 + 它在哪个类里"，而不是只记成员
  const visible: { node: R6ClassWithFile; member: R6Member }[] = [];
  // 去重 + 就近优先
  const seen = new Set<string>();

  const isSuper = container.kind === 'super';
  for (const node of collectHierarchy(ctx.parsedFiles, container, isSuper)) {
    // R6类只有两种可见性: 一是private，另外一种是public(active当成public来看)
    const side = container.kind === 'private' ? node.classDef.privateMembers : node.classDef.publicMembers;
    for (const member of side) {
      if (seen.has(member.name)) continue;
      seen.add(member.name);
      visible.push({ node, member });
    }
  }
  return visible;
}

/** 在容器的可见成员里按名字找一个（跳转与链式共用）；找不到 → null */
export function findVisibleMember(
  ctx: AnalysisContext,
  container: R6Container,
  name: string,
): { node: R6ClassWithFile; member: R6Member } | null {
  return membersOf(ctx, container).find((entry) => entry.member.name === name) ?? null;
}

/** 合成成员兜底：new 是 R6 自动生成的，每个类有自己的一份（指向本类 initialize 或类定义） */
function resolveSynthetic(target: R6ClassWithFile, name: string): DefinitionSite | null {
  const synthetic = target.classDef.synthetic.find((s) => s.name === name);
  if (synthetic === undefined) return null;
  return definitionSiteAt(name, target.parsed, synthetic.nameOffset);
}
