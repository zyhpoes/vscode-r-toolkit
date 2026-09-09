/**
 * 分析上下文：一次"跳转查询"共享的环境。
 * 一次 Ctrl+点击 = 一次查询，Provider 组装好 ctx 传给 analysis 各查询函数，
 * 避免层层传参、避免重复计算。
 * 封装重点：每个文件的"文本 + 解析出的类清单"在这里一次性算好（parsed），
 * 下游查询只遍历这份缓存，不再各自 parseR6 —— 从根上消除重复解析与手工配对。
 * 只覆盖 analysis 层查询链；parser/utils 是纯函数，在查询前被调用、产出放进 ctx。
 */

import { tokenize, type Token } from '../parser/tokenizer';
import { parseR6 } from '../parser/r6-parser';
import { TextLines } from '../utils/text';
import { parseBindings, type Binding } from './bindings';
import { createNameResolver, type NameResolver } from './rhs-eval';
import type { ParsedSourceFile, SourceFile } from './source-file';

/** 分析上下文：一次跳转查询的环境 */
export interface AnalysisContext {
  /** 每个文件的解析结果（当前文件在前，依赖文件在后）—— 类清单只在这里解析一次 */
  parsed: ParsedSourceFile[];
  /** 光标所在文件的解析结果（parsed 中 uri 匹配那份） */
  cursorParsed: ParsedSourceFile;
  /** 光标文件的 token（预计算一次） */
  cursorTokens: Token[];
  /** 光标文件的行索引（判断"换行 = 语句结束"用） */
  lines: TextLines;
  /** 名字归类查询（类/函数） */
  resolver: NameResolver;
  /** 光标文件的赋值记录（预计算一次） */
  bindings: Binding[];
}

/**
 * 组装一次查询的上下文。
 * @param files         所有相关文件（当前文件 + box 依赖文件）
 * @param cursorFileUri 光标在哪个文件
 */
export function createContext(files: SourceFile[], cursorFileUri: string): AnalysisContext {
  // 每个文件解析一次：文本与它的类清单打包存好，供所有查询共享
  const parsed: ParsedSourceFile[] = files.map((file) => ({
    file,
    classes: parseR6(file.text),
  }));

  // 契约保护：uri 必须真的在 files 里，否则是调用方组装错了
  const cursorParsed = parsed.find((p) => p.file.uri === cursorFileUri);
  if (cursorParsed === undefined) {
    throw new Error(`createContext: cursorFileUri 不在 files 里: ${cursorFileUri}`);
  }

  // 类名集合：所有文件的类合并 —— resolver 用它在 O(1) 里判断"是不是类"
  const allClasses = parsed.flatMap((p) => p.classes);

  return {
    parsed,
    cursorParsed,
    cursorTokens: tokenize(cursorParsed.file.text),
    lines: new TextLines(cursorParsed.file.text),
    resolver: createNameResolver(allClasses),
    bindings: parseBindings(cursorParsed.file.text),
  };
}
