/**
 * 补全：判断"光标此刻该补什么"（触发上下文），供上层据此枚举候选项。
 * 纯逻辑：不依赖 vscode，可在纯 Node 中测试。
 *
 * 与跳转的光标模型不同：补全常发生在**词尾**（`self$gr|`）甚至没有词（`self$|`），
 * 而跳转的 findWordIndexAt 要求光标落在 token 区间**内**（贴词尾会返回 -1）。
 * 所以这里找的是"结束于光标处（或含光标）"的那个 token。
 */

import type { R6Member, R6Scope } from '../parser/r6-parser';
import type { AnalysisContext } from './context';
import { memberChainSegments, resolveChainContainer } from './chain';
import type { R6ClassWithFile } from './definitions';
import { R6_GENERATOR_SLOTS, membersOf, type R6Container } from './members';
import { memberValueType } from './type-resolve';

/**
 * 补全触发上下文（单形状 + kind 判别，与 InheritRef 同风格）：
 *   member    = `容器$` —— containerName 是 self / private / super / 类名 / 实例 / 模块名 / 别名 / 包名
 *   namespace = `包名::` —— containerName 就是那个包名
 * 其它位置（裸名字、注释、字符串、`box::use(...)` 内部…）→ 返回 null（不补）。
 */
export interface CompletionTrigger {
  kind: 'member' | 'namespace';
  /** 运算符左边的名字文本：`$` 左边（容器，性质待判定）或 `::` 左边（必然是包名） */
  containerName: string;
  /** 那个名字在 tokens 里的下标（枚举候选时反查"光标在哪个类里"要用） */
  containerIndex: number;
}

/**
 * 判断光标处的补全触发上下文。
 *
 * v1 只在 `容器$` 与 `包名::` 两处给候选；裸名字补全不做（它要判断作用域，
 * 而 bindings 目前不区分深度，会把别的函数里的局部变量也列出来）。
 *
 * 注释 / 字符串 / `box::use(...)` 内部**天然**不会触发：那里凑不出"以 `$` 或 `::` 结尾"的形状
 * （注释不进 token 流；字符串整体是一个 token）—— 行为由 test/unit/completion.test.ts 锁住。
 *
 * @returns 触发上下文；不补的位置 → null（与其它查询函数一致）
 */
export function completionTriggerAt(
  ctx: AnalysisContext,
  cursorOffset: number,
): CompletionTrigger | null {
  const tokens = ctx.cursorFile.tokens;

  // 结束于光标处（或含光标）的 token：`self$gr|` → `gr`；`self$|` → `$`
  // 用半开区间 `stOffset < 光标 <= enOffset`：右侧紧贴另一个 token 时（如 `f(m$)` 里
  // `$` 与 `)` 相接），光标同时落在两者的边界上，不能让后面那个把 `$` 顶掉。
  const endIndex = tokens.findLastIndex(
    (t) => t.stOffset < cursorOffset && cursorOffset <= t.enOffset,
  );
  if (endIndex === -1) return null;

  // 光标所在词是标识符 → 运算符在它左边一格；光标紧跟在运算符后 → 就是那一格
  const endToken = tokens[endIndex];
  const opIndex = endToken.kind === 'identifier' ? endIndex - 1 : endIndex;
  const op = tokens[opIndex];
  const name = tokens[opIndex - 1];
  if (op?.kind !== 'operator' || name?.kind !== 'identifier') return null;

  if (op.text === '$') return { kind: 'member', containerName: name.text, containerIndex: opIndex - 1 };
  if (op.text === '::') return { kind: 'namespace', containerName: name.text, containerIndex: opIndex - 1 };
  return null; // `:::` 等写法：v1 不做
}

/** 补全候选项：analysis 层只出数据，图标与排序权重交给 provider */
export interface Candidate {
  label: string;
  /** 候选类别（provider 据此映射图标）；目前只产出成员，模块 / 包在 2b / 2c 落地时再扩 */
  kind: 'member';
  /** 右侧说明：`public 成员` / `继承自 BaseModel` / `合成成员（R6 自动生成）` */
  detail: string;
}

/**
 * R6 容器的成员候选：`self$` / `private$` / `super$` / `类名$` / `实例$`。
 * 可见性规则与跳转**完全一致**（同一份 members.ts / inheritance.ts），只有 `类名$` 例外：
 *   self      本类 + 继承来的 public/active
 *   private   只本类自己的 private（R6：private 不随继承可见）
 *   super     父类链上的 public/active（不含本类）
 *   实例       public/active（含继承来的）
 *   类名       生成器自带槽（R 里生成器上取不到用户成员 —— 见 generatorSlotCandidates）
 * 继承链上同名只留**最近的**（子类遮蔽父类）；不列 R6 自动生成的成员 —— `new` 只在类生成器上
 * （见 generatorSlotCandidates），`clone` 只在实例上（实测，暂不列，见 docs/技术债.md 的 A 组）。
 *
 * @param containerIndex 紧挨光标那个 `$` 的左边那段名字的下标（收链 + 兜底都要它）
 * @returns 候选列表；容器不是 R6 类/实例（模块名、包名、类型推不出）→ null（交给别的来源）
 */
export function r6MemberCandidates(
  ctx: AnalysisContext,
  containerIndex: number,
  cursorOffset: number,
): Candidate[] | null {
  // 从"容器"往回收成整条链：containerIndex 指向紧挨光标那个 `$` 的左边（即最后一段）。
  // 例 `model$key_id$lab|`（光标在 lab 后）：容器 = `key_id`，被补的词 = `lab`（**不在链里**），
  // 链 = ['model', 'key_id']；`lines` 只给收链时判"连接符与名字同一行"用。
  const chain = memberChainSegments(ctx.cursorFile.tokens, ctx.cursorFile.lines, containerIndex);

  // 链 → 终点容器（折叠 + 兜底）；跳转调的是同一个函数，所以两边对 a$b$c 的解析完全一致
  const container = resolveChainContainer(ctx, chain, cursorOffset);
  return container === undefined ? null : candidatesFor(ctx, container, cursorOffset);
}

/** 按容器类型出候选：生成器 → 自带槽；实例 → public/active 成员 */
function candidatesFor(
  ctx: AnalysisContext,
  container: R6Container,
  cursorOffset: number,
): Candidate[] {
  return container.kind === 'generator'
    ? generatorSlotCandidates(container)
    : memberCandidates(ctx, container, cursorOffset);
}

/**
 * 列成员：可见性规则不在这里 —— 全部交给 membersOf（补全与跳转共用的唯一一处）。
 * 实测实例 / self / private / super 上**都没有 new**（它只长在类生成器上）；
 * 实例上真有的 clone 暂不列，见 docs/技术债.md 的 A 组。
 */
function memberCandidates(
  ctx: AnalysisContext,
  container: R6Container,
  cursorOffset: number,
): Candidate[] {
  return membersOf(ctx, container).map((entry) => ({
    label: entry.member.name,
    kind: 'member',
    detail: memberDetail(ctx, entry.node, entry.member, cursorOffset),
  }));
}

/**
 * `类名$` 的候选：类生成器自带的槽。
 * 实测（R6 2.6.1）：生成器上取不到用户成员 —— `Model$greet` 不是函数、`Model$v` 为 NULL；
 * 用户在 `ls(实例)` 里才看得见（`Model$new()$greet`）。所以这里**不列**用户成员，也不走继承链
 * （所有生成器的槽都一样）。
 * `new` 从 synthetic 取（它与跳转目标同一处定义），其余 24 个见 members.ts 的 R6_GENERATOR_SLOTS。
 */
function generatorSlotCandidates(target: R6ClassWithFile): Candidate[] {
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  for (const synthetic of target.classDef.synthetic) {
    seen.add(synthetic.name);
    candidates.push({ label: synthetic.name, kind: 'member', detail: '合成成员（R6 自动生成）' });
  }
  for (const slot of R6_GENERATOR_SLOTS) {
    // 去重兜底：槽表本该不含 `new`（它由上面的 synthetic 提供），万一被补进去也不出两条
    if (seen.has(slot)) continue;
    seen.add(slot);
    candidates.push({ label: slot, kind: 'member', detail: 'R6 自带槽' });
  }
  return candidates;
}

/**
 * 成员说明：能算出类型就给类型（`FieldInfo类` / `FieldInfo实例` / `函数`），算不出退回所在区。
 * 用成员**所在文件**的 token 求值 —— 继承来的成员一样算得出。
 */
function memberDetail(
  ctx: AnalysisContext,
  node: R6ClassWithFile,
  member: R6Member,
  cursorOffset: number,
): string {
  const type = memberValueType(ctx, node, member, cursorOffset);
  if (type.kind === 'r6-generator') return `${type.className}类`;
  if (type.kind === 'r6-instance') return `${type.className}实例`;
  if (type.kind === 'function') return '函数';
  return scopeDetail(member.scope);
}

/** 区的说明文字 */
function scopeDetail(scope: R6Scope): string {
  return scope === 'active' ? 'active 绑定' : `${scope} 成员`;
}
