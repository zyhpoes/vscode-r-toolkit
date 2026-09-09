/**
 * 分析上下文：一次"跳转查询"共享的环境。
 * 一次 Ctrl+点击 = 一次查询，Provider 组装好 ctx 传给 analysis 各查询函数，
 * 避免层层传参、避免重复计算（token/绑定只解析一次）。
 * 只覆盖 analysis 层查询链；parser/utils 是纯函数，在查询前被调用、产出放进 ctx。
 */

import { tokenize, type Token } from '../parser/tokenizer';
import { parseR6 } from '../parser/r6-parser';
import { TextLines } from '../utils/text';
import { parseBindings, type Binding } from './bindings';
import { createNameResolver, type NameResolver } from './rhs-eval';
import type { SourceFile } from './source-file';

/** 分析上下文：一次跳转查询的环境 */
export interface AnalysisContext {
  files: SourceFile[]; // 所有相关文件（当前文件在前，依赖文件在后）
  cursorFile: SourceFile; // 光标所在文件（files 中 uri 匹配的那份）
  cursorTokens: Token[]; // 光标文件的 token（预计算一次）
  lines: TextLines; // 光标文件的行索引（判断"换行 = 语句结束"用）
  resolver: NameResolver; // 名字归类查询（类/函数）
  bindings: Binding[]; // 光标文件的赋值记录（预计算一次）
}

/**
 * 组装一次查询的上下文。
 * @param files         所有相关文件（当前文件 + box 依赖文件）
 * @param cursorFileUri 光标在哪个文件
 */
export function createContext(files: SourceFile[], cursorFileUri: string): AnalysisContext {
  // 契约保护：uri 必须真的在 files 里，否则是调用方组装错了
  const cursorFile = files.find((f) => f.uri === cursorFileUri);
  if (cursorFile === undefined) {
    throw new Error(`createContext: cursorFileUri 不在 files 里: ${cursorFileUri}`);
  }

  // 类名集合：所有文件的类合并 —— resolver 用它在 O(1) 里判断"是不是类"
  // （每个文件只解析这一次，供跨文件识别类名用）
  const allClasses = files.flatMap((f) => parseR6(f.text));

  return {
    files,
    cursorFile,
    cursorTokens: tokenize(cursorFile.text),
    lines: new TextLines(cursorFile.text),
    resolver: createNameResolver(allClasses),
    bindings: parseBindings(cursorFile.text),
  };
}
