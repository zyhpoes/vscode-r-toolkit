/**
 * 分析上下文：一次"跳转查询"共享的环境。
 * 一次 Ctrl+点击 = 一次查询，Provider 组装好 ctx 传给 analysis 各查询函数，
 * 避免层层传参、避免重复计算。
 *
 * 职责边界：**ctx 只持有，不解析**。每个文件的解析产物由 parseSourceFile 一次算好（parsed），
 * 下游查询只读这份清单（要光标文件的 token/行索引/绑定，就去 cursorFile 上取）。
 * 唯一无法下放到单个文件上的是 resolver（跨文件聚合索引），所以它留在这里。
 *
 * 只覆盖 analysis 层查询链；parser/utils 是纯函数，在查询前被调用、产出放进 ctx。
 */

import { createNameResolver, type NameResolver } from './rhs-eval';
import { parseSourceFile, type ParsedSourceFile, type SourceFile } from './source-file';

/** 分析上下文：一次跳转查询的环境 */
export interface AnalysisContext {
  /** 每个文件的解析结果（当前文件在前，依赖文件在后）—— 全部解析产物都在这 */
  parsed: ParsedSourceFile[];
  /** 光标所在文件的那一份（= parsed 里 file.uri 匹配的那项；派生指针，不是副本） */
  cursorFile: ParsedSourceFile;
  /**
   * 名字归类查询（类/函数）—— 唯一无法下放到单个文件上的"聚合索引"：
   * 它由**所有文件**的类合并而成（`FieldInfo$new()` 里的 FieldInfo 可能定义在依赖文件里）。
   * 每次组装现算（遍历 + 建 Set，微秒级），所以它自己不需要也不该被缓存。
   */
  resolver: NameResolver;
}

/**
 * 便利入口：给"文件文本"清单，内部逐文件解析。
 * 适合测试等"手上只有文本"的场合；provider 走 `createContextFromParsed`
 * （它已经为光标文件切好词，不该再切一遍）。
 * @param files         所有相关文件（当前文件 + box 依赖文件），**不要有重复 uri**
 * @param cursorFileUri 光标在哪个文件
 */
export function createContext(files: SourceFile[], cursorFileUri: string): AnalysisContext {
  return createContextFromParsed(
    files.map((file) => parseSourceFile(file)),
    cursorFileUri,
  );
}

/**
 * 纯组装入口：给**已经解析好**的文件清单（provider 用）。
 * 这样 provider 就能把"光标文件那份已切好词的解析结果"直接传进来复用。
 * @param parsed        所有相关文件的解析结果（当前文件在前）
 * @param cursorFileUri 光标在哪个文件
 */
export function createContextFromParsed(
  parsed: ParsedSourceFile[],
  cursorFileUri: string,
): AnalysisContext {
  // 契约保护：uri 必须真的在 parsed 里，否则是调用方组装错了
  const cursorFile = parsed.find((p) => p.file.uri === cursorFileUri);
  if (cursorFile === undefined) {
    throw new Error(`createContext: cursorFileUri 不在 files 里: ${cursorFileUri}`);
  }

  // 类名集合：所有文件的类合并 —— resolver 用它在 O(1) 里判断"是不是类"
  const allClasses = parsed.flatMap((p) => p.classes);

  return {
    parsed,
    cursorFile,
    resolver: createNameResolver(allClasses),
  };
}
