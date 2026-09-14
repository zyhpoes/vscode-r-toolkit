/**
 * 定义位置解析：给定分析上下文 + 光标位置，判断光标下是什么、它定义在哪。
 * 纯逻辑：不依赖 vscode，可在纯 Node 中测试。
 *
 * 两种查询（判定顺序由 Provider 编排）：
 *   类名跳转   —— 光标词是已知类名 → 类定义行（Person <- R6Class(...)）
 *   变量跳转   —— 光标词是普通变量 → 它最近一次赋值行（q <- Person$new()）
 */

import type { R6ClassDef } from '../parser/r6-parser';
import { TextLines } from '../utils/text';
import type { ParsedSourceFile, SourceFile } from './source-file';
import type { AnalysisContext } from './context';
import { findLatestBinding } from './bindings';
import { findWordIndexAt } from './cursor';

/**
 * 跳转命中结果：命中的名字 + 目标所在文件 + 定义位置（行列，0 起）。
 * 类名跳转 / 变量跳转 / 成员跳转共用这一种形状
 * （单一出处，成员跳转不再自造同形状的 MemberDefinition）。
 */
export interface DefinitionSite {
  name: string; // 命中的名字：类名 / 变量名 / 成员名
  uri: string; // 目标所在文件（恒有值：单文件时是当前文件，跨文件时是依赖文件）
  line: number; // 行号
  character: number; // 列号（用 character 而非 columns，因 VS Code 官方就叫 character）
}

/**
 * 把"名字 + 目标文件 + 偏移量"组装成跳转结果（偏移量 → 行列）。
 * 三种跳转（类名 / 变量 / 成员）共用这一处换算，避免各写一份走偏。
 */
export function definitionSiteAt(name: string, file: SourceFile, offset: number): DefinitionSite {
  const pos = new TextLines(file.text).positionAt(offset);
  return { name, uri: file.uri, line: pos.line, character: pos.character };
}

/**
 * 解析光标处的类定义。
 * 查找范围：光标所在文件优先，找不到再去依赖文件（按 files 顺序）。
 * @param ctx          分析上下文（含光标文件 tokens/文件清单）
 * @param cursorOffset 光标偏移量
 * @returns 命中返回类定义位置（带目标文件 uri）；未命中返回 null
 */
export function resolveClassDefinition(
  ctx: AnalysisContext,
  cursorOffset: number,
): DefinitionSite | null {
  // 找光标下的词（只在光标所在文件里找：ctx.cursorTokens 那份文本）
  const wordIdx = findWordIndexAt(ctx, cursorOffset);
  if (wordIdx === -1) {
    return null;
  }
  const word = ctx.cursorTokens[wordIdx];

  // 在所有文件里找同名类：当前文件优先（先出现先匹配），找不到再去依赖文件
  const cls = findClassAcrossFiles(ctx.parsed, word.text);
  if (cls === undefined) {
    return null;
  }

  return definitionSiteAt(cls.classDef.name, cls.file, cls.classDef.nameOffset);
}

/**
 * 解析光标处的变量定义（纯变量跳转：点 q → 跳 q 最近一次赋值行）。
 * 只查光标所在文件（L1：同文件变量追踪），不做类型判断 —— 是"浅"跳转。
 * @param ctx          分析上下文（含光标文件 tokens/绑定记录）
 * @param cursorOffset 光标偏移量
 * @returns 命中返回赋值位置（当前文件）；该变量在光标前没赋值 → null
 */
export function resolveVariableDefinition(
  ctx: AnalysisContext,
  cursorOffset: number,
): DefinitionSite | null {
  // 找光标下的词
  const wordIdx = findWordIndexAt(ctx, cursorOffset);
  if (wordIdx === -1) {
    return null;
  }
  const word = ctx.cursorTokens[wordIdx];

  // 找该变量"光标前最近一次"赋值（逻辑在 bindings.ts，与类型推断共用同一份）
  const binding = findLatestBinding(ctx.bindings, word.text, cursorOffset);
  if (binding === undefined) {
    return null; // 光标前没有赋值（可能还没赋值，或根本不是变量）
  }

  return definitionSiteAt(word.text, ctx.cursorParsed.file, binding.offset);
}

/** 跨文件找类的结果：类定义 + 它所在文件。analysis 层通用的"带户口的类"配对，
 *  类名跳转 / 成员跳转 / 继承链都用它（单一出处，避免各模块自造同名结构） */
export interface ClassWithFile {
  classDef: R6ClassDef;
  file: SourceFile;
}

/**
 * 在所有文件里找名为 className 的类。
 * 遍历"已解析清单"（context 已把每个文件解析过一次，这里零重复解析）。
 * 按清单顺序（当前文件在前，依赖文件在后）—— 先出现先匹配。
 */
export function findClassAcrossFiles(
  parsed: ParsedSourceFile[],
  className: string,
): ClassWithFile | undefined {
  for (const entry of parsed) {
    const cls = entry.classes.find((c) => c.name === className);
    if (cls !== undefined) {
      return { classDef: cls, file: entry.file };
    }
  }
  return undefined;
}
