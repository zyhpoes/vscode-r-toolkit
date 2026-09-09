/**
 * 定义位置解析：给定分析上下文 + 光标位置，判断光标下是什么、它定义在哪。
 * 纯逻辑：不依赖 vscode，可在纯 Node 中测试。
 *
 * 两种查询（判定顺序由 Provider 编排）：
 *   类名跳转   —— 光标词是已知类名 → 类定义行（Person <- R6Class(...)）
 *   变量跳转   —— 光标词是普通变量 → 它最近一次赋值行（q <- Person$new()）
 */

import { parseR6, type R6ClassDef } from '../parser/r6-parser';
import { TextLines } from '../utils/text';
import type { SourceFile } from './source-file';
import type { AnalysisContext } from './context';

/** 命中结果：名字 + 目标所在文件 + 定义位置（行列，0 起） */
export interface DefinitionSite {
  name: string; // 类名 / 变量名
  uri: string; // 目标所在文件（恒有值：单文件时是当前文件，跨文件时是依赖文件）
  line: number; // 行号
  character: number; // 列号（用 character 而非 columns，因 VS Code 官方就叫 character）
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
  // 找光标下的词：只在光标所在文件里找（ctx.cursorTokens 那份文本）
  const tokens = ctx.cursorTokens;
  // 边界用半开区间 [offset, offset+长度)：光标在词开头算命中，在词末尾不算
  const word = tokens.find(
    (t) =>
      t.kind === 'identifier' &&
      t.offset <= cursorOffset &&
      cursorOffset < t.offset + t.text.length,
  );
  if (word === undefined) {
    return null;
  }

  // 在所有文件里找同名类：当前文件优先（先出现先匹配），找不到再去依赖文件
  const cls = findClassAcrossFiles(ctx.files, word.text);
  if (cls === undefined) {
    return null;
  }

  // 把类名的偏移量换算成行列（VS Code 跳转需要的格式）
  const pos = new TextLines(cls.file.text).positionAt(cls.classDef.nameOffset);
  return {
    name: cls.classDef.name,
    uri: cls.file.uri,
    line: pos.line,
    character: pos.character,
  };
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
  // 找光标下的词（半开区间：光标在词开头算命中，在词末尾不算）
  const word = ctx.cursorTokens.find(
    (t) =>
      t.kind === 'identifier' &&
      t.offset <= cursorOffset &&
      cursorOffset < t.offset + t.text.length,
  );
  if (word === undefined) {
    return null;
  }

  // 在 bindings 里找该变量"光标前最近一次"赋值（bindings 按顺序存，从后往前扫）
  let targetOffset: number | undefined;
  for (let i = ctx.bindings.length - 1; i >= 0; i--) {
    const b = ctx.bindings[i];
    if (b.varName === word.text && b.offset <= cursorOffset) {
      targetOffset = b.offset;
      break;
    }
  }
  if (targetOffset === undefined) {
    return null; // 光标前没有赋值（可能还没赋值，或根本不是变量）
  }

  // 把变量名的偏移量换算成行列
  const pos = new TextLines(ctx.cursorFile.text).positionAt(targetOffset);
  return {
    name: word.text,
    uri: ctx.cursorFile.uri,
    line: pos.line,
    character: pos.character,
  };
}

/** 跨文件找类的结果：类定义 + 它所在文件 */
interface ClassWithFile {
  classDef: R6ClassDef;
  file: SourceFile;
}

/**
 * 在所有文件里找名为 className 的类。
 * 按 files 顺序（当前文件在前，依赖文件在后）—— 先出现先匹配。
 */
export function findClassAcrossFiles(
  files: SourceFile[],
  className: string,
): ClassWithFile | undefined {
  for (const file of files) {
    const cls = parseR6(file.text).find((c) => c.name === className);
    if (cls !== undefined) {
      return { classDef: cls, file };
    }
  }
  return undefined;
}
