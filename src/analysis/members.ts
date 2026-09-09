/**
 * 成员定义解析：给定多个文件 + 光标位置，判断光标下的成员引用
 * （self$xxx / private$xxx / 类名$xxx / 实例$xxx）指向哪个成员定义。
 * 纯逻辑：不依赖 vscode，可在纯 Node 中测试。
 */

import { parseR6, type R6ClassDef, type R6Member, type R6Scope } from '../parser/r6-parser';
import { TextLines } from '../utils/text';
import type { SourceFile } from './source-file';
import type { AnalysisContext } from './context';
import { findClassAcrossFiles } from './definitions';
import { resolveVarType } from './type-resolve';

/** 命中结果：成员名 + 目标所在文件 + 定义位置（行列，0 起） */
export interface MemberDefinition {
  name: string;
  uri: string; // 目标所在文件（恒有值）
  line: number;
  character: number;
}

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

  // 看 '$' 前是什么，确定"查哪个类、哪个区"
  const before = tokens[wordIdx - 2];
  if (before?.kind !== 'identifier') {
    return null;
  }

  // ── 确定目标类 + 它所在文件 ────────────────────────────────────
  let targetClass: R6ClassDef | undefined;
  let targetFile: SourceFile;
  let scopes: R6Scope[];

  if (before.text === 'self' || before.text === 'private') {
    // self/private 出现在方法体里，方法体在类定义所在文件内 → 反查光标文件里的类
    const classes = parseR6(ctx.cursorFile.text);
    targetClass = classes.find((c) => c.stIndex <= wordIdx && wordIdx <= c.enIndex);
    targetFile = ctx.cursorFile;
    scopes = before.text === 'self' ? ['public', 'active'] : ['private'];
  } else {
    // 类名$ 或 实例变量$（p$xxx）：
    // 先看 before 是不是已知类名（当前文件或依赖文件），不是则查 p 的类型
    let className: string | undefined;
    if (findClassAcrossFiles(ctx.files, before.text) !== undefined) {
      className = before.text; // 已知类名
    } else {
      const type = resolveVarType(ctx, before.text, cursorOffset);
      if (type !== null && type.kind === 'class') {
        className = type.className;
      }
    }
    if (className === undefined) {
      return null;
    }
    const found = findClassAcrossFiles(ctx.files, className);
    if (found === undefined) {
      return null;
    }
    targetClass = found.classDef;
    targetFile = found.file;
    scopes = ['public', 'active'];
  }

  if (targetClass === undefined) {
    return null;
  }

  // ── 找跳转目标：先在用户定义成员里找 ──────────────────────────
  // 限定区：self$/类名$ 看 public+active，private$ 只看 private
  const member = targetClass.members.find(
    (m: R6Member) => m.name === word.text && scopes.includes(m.scope),
  );

  // 用户成员找到了 → 直接用它，跳转目标就是它的定义位置
  if (member !== undefined) {
    return buildResult(word.text, targetFile, member.nameOffset);
  }

  // ── 用户成员没找到 → 查合成成员（如 new）─────────────────────
  // 合成成员是 R6 自动生成的（new 指向 initialize 或类定义），不限区，按名字找
  const synthetic = targetClass.synthetic.find((s) => s.name === word.text);
  if (synthetic !== undefined) {
    return buildResult(word.text, targetFile, synthetic.nameOffset);
  }

  // 用户成员和合成成员都没有 → 无意义跳转
  return null;
}

/** 把成员偏移量换算成行列，组装成带目标文件 uri 的结果 */
function buildResult(name: string, file: SourceFile, nameOffset: number): MemberDefinition {
  const pos = new TextLines(file.text).positionAt(nameOffset);
  return { name, uri: file.uri, line: pos.line, character: pos.character };
}
