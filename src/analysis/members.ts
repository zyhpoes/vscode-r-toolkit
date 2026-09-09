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

import type { R6Scope } from '../parser/r6-parser';
import { TextLines } from '../utils/text';
import type { SourceFile } from './source-file';
import type { AnalysisContext } from './context';
import { findClassAcrossFiles, type ClassWithFile } from './definitions';
import { findHierarchyMember } from './inheritance';
import { resolveVarType } from './type-resolve';

/** 命中结果：成员名 + 目标所在文件 + 定义位置（行列，0 起） */
export interface MemberDefinition {
  name: string;
  uri: string; // 目标所在文件（恒有值）
  line: number;
  character: number;
}

/** 对外可见的区：self$/类名$/实例$/super$ 都只能看到这两类（private 外面看不见） */
const PUBLIC_VISIBLE: R6Scope[] = ['public', 'active'];

/**
 * 解析光标处的成员定义。
 * @param ctx          分析上下文（含光标文件 tokens/文件清单）
 * @param cursorOffset 光标偏移量
 * @returns 命中返回成员定义位置（带目标文件 uri）；未命中返回 null
 */
export function resolveMemberDefinition(
  ctx: AnalysisContext,
  cursorOffset: number,
): MemberDefinition | null {
  const tokens = ctx.cursorTokens;

  // 找光标下的 identifier（findIndex 返回下标）
  const wordIdx = tokens.findIndex(
    (t) =>
      t.kind === 'identifier' &&
      t.offset <= cursorOffset &&
      cursorOffset < t.offset + t.text.length,
  );
  if (wordIdx === -1) {
    return null;
  }
  const word = tokens[wordIdx];

  // 向前找紧邻的 '$'（wordIdx-1 必须是 '$'，否则不是成员引用）
  const dollar = tokens[wordIdx - 1];
  if (dollar?.kind !== 'operator' || dollar.text !== '$') {
    return null;
  }

  // 看 '$' 前是什么 → 决定"去哪找成员"
  const before = tokens[wordIdx - 2];
  if (before?.kind !== 'identifier') {
    return null;
  }

  // ── super$：父类链上的成员（不含本类）──────────────────────────
  if (before.text === 'super') {
    // super 只能写在类方法体里：先反查"光标在哪个类中"，那个类就是"我"
    const holder = containingClass(ctx, wordIdx);
    if (holder === undefined) {
      return null;
    }
    // super$xxx = 父类的 xxx：从 holder 的父类起向上找（includeStart=false 跳过本类）
    const hit = findHierarchyMember(ctx.parsed, holder, word.text, PUBLIC_VISIBLE, false);
    if (hit === null) {
      return null;
    }
    return buildResult(word.text, hit.node.file, hit.member.nameOffset);
  }

  // ── private$：只查本类自己的 private ──────────────────────────
  if (before.text === 'private') {
    // private 只能写在类方法体里：反查光标所在类
    const holder = containingClass(ctx, wordIdx);
    if (holder === undefined) {
      return null;
    }
    // R6：private 不随继承 —— 子类看不到父类的 private，所以只在本类找、不往上走
    const member = holder.classDef.members.find(
      (m) => m.name === word.text && m.scope === 'private',
    );
    if (member !== undefined) {
      return buildResult(word.text, holder.file, member.nameOffset);
    }
    // 本类没有这个 private → 兜底查合成成员（new）
    return resolveSynthetic(holder, word.text);
  }

  // ── self$：本类 + 父类链的 public/active ───────────────────────
  if (before.text === 'self') {
    // self 也只能写在类方法体里：反查光标所在类
    const holder = containingClass(ctx, wordIdx);
    if (holder === undefined) {
      return null;
    }
    // 继承来的方法 self 也能调：先本类后父类（includeStart=true，最近祖先优先）
    const hit = findHierarchyMember(ctx.parsed, holder, word.text, PUBLIC_VISIBLE, true);
    if (hit !== null) {
      return buildResult(word.text, hit.node.file, hit.member.nameOffset);
    }
    // 本类和父类都没有 → 兜底查合成成员（new）
    return resolveSynthetic(holder, word.text);
  }

  // ── 类名$ / 实例变量$（Person$greet / p$greet）─────────────────
  // 类外的访问只能看到 public/active（含继承来的），private 一律看不见
  const target = resolveNamedTarget(ctx, before.text, cursorOffset);
  if (target === undefined) {
    return null;
  }
  const hit = findHierarchyMember(ctx.parsed, target, word.text, PUBLIC_VISIBLE, true);
  if (hit !== null) {
    return buildResult(word.text, hit.node.file, hit.member.nameOffset);
  }
  return resolveSynthetic(target, word.text);
}

/**
 * 反查"光标所在类"：self/private/super 写在方法体里，
 * 方法体在类的 R6Class 调用范围内 → 光标落在哪个类范围里，就是哪个类。
 */
function containingClass(ctx: AnalysisContext, wordIdx: number): ClassWithFile | undefined {
  const classDef = ctx.cursorParsed.classes.find(
    (c) => c.stIndex <= wordIdx && wordIdx <= c.enIndex,
  );
  if (classDef === undefined) {
    return undefined;
  }
  return { classDef, file: ctx.cursorParsed.file };
}

/**
 * 类名$ / 实例变量$ 的目标类定位，分两步：
 *   Person$greet → Person 本身就是已知类名，直接命中；
 *   p$greet       → p 不是类名，沿赋值链推断类型（p <- Person$new() → Person）。
 */
function resolveNamedTarget(
  ctx: AnalysisContext,
  name: string,
  cursorOffset: number,
): ClassWithFile | undefined {
  const asClass = findClassAcrossFiles(ctx.parsed, name);
  if (asClass !== undefined) {
    return asClass;
  }
  const type = resolveVarType(ctx, name, cursorOffset);
  if (type !== null && type.kind === 'class') {
    return findClassAcrossFiles(ctx.parsed, type.className);
  }
  return undefined;
}

/** 合成成员兜底：new 是 R6 自动生成的，每个类有自己的一份（指向本类 initialize 或类定义） */
function resolveSynthetic(target: ClassWithFile, name: string): MemberDefinition | null {
  const synthetic = target.classDef.synthetic.find((s) => s.name === name);
  if (synthetic === undefined) {
    return null;
  }
  return buildResult(name, target.file, synthetic.nameOffset);
}

/** 把成员偏移量换算成行列，组装成带目标文件 uri 的结果 */
function buildResult(name: string, file: SourceFile, nameOffset: number): MemberDefinition {
  const pos = new TextLines(file.text).positionAt(nameOffset);
  return { name, uri: file.uri, line: pos.line, character: pos.character };
}
