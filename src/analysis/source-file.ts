/**
 * 待查文件：跨文件查询时，把"当前文件 + 依赖文件"的 {uri, text} 列表传给查询函数。
 * uri 是文件身份（结果用它标注"目标在哪个文件"），text 是全文（切词的原料）。
 * 纯数据：不依赖 vscode。
 */

import { tokenize, type Token } from '../parser/tokenizer';
import { parseR6, type R6ClassDef } from '../parser/r6-parser';
import { TextLines } from '../utils/text';
import { parseBindings, type Binding } from './bindings';
import { parseTopLevelSymbols, type TopLevelSymbol } from './module-symbols';

export interface SourceFile {
  /** 文件身份（如 file:///C:/proj/person.R）—— 恒有值，目标在哪个文件用它标注 */
  uri: string;
  /** 文件全文（切词的原料） */
  text: string;
}

/**
 * 解析过的文件：文本 + 它的**全部**解析产物。
 * 分析层"每文件只解析一次"的缓存单元：解析在这里一次算好，查询只读，
 * 不再各自现切词 / 现解析（tokens/lines/symbols/bindings 都不重复计算）。
 */
export interface ParsedSourceFile {
  /** 原始文件（身份 + 全文） */
  file: SourceFile;
  /** 词法单元（切一次词的结果，下面所有解析都复用它） */
  tokens: Token[];
  /** 行索引（偏移量 ↔ 行列互转；跳转结果要用目标文件的那一份） */
  lines: TextLines;
  /** 该文件的类清单（parseR6 的结果） */
  classes: R6ClassDef[];
  /** 该文件的顶层符号（box 模块成员跳转用；对非模块文件也无害） */
  symbols: TopLevelSymbol[];
  /** 该文件的赋值记录（变量类型追踪用） */
  bindings: Binding[];
}

/**
 * 解析一个文件：**切一次词**，其余解析全部复用这份 token。
 * 这是全项目仅有的两处切词之一（另一处是 provider 切光标文件）。
 *
 * `tokens` 可选是**契约的一部分**，不是随手加的灵活性：
 *   - 不传 → 自己切（`createContext`、测试等"手上只有文本"的调用方）
 *   - 传   → 复用调用方那份。provider 必须**先**切光标文件才能解析 `box::use`、
 *            才知道要加载哪些依赖文件，所以它手上必然已有 token；不传就会白切一遍
 *
 * @param file   文件（身份 + 全文）
 * @param tokens 已切好的 token（= `tokenize(file.text)` 的结果）；不传则自己切
 */
export function parseSourceFile(file: SourceFile, tokens?: Token[]): ParsedSourceFile {
  const usedTokens = tokens ?? tokenize(file.text);
  return {
    file,
    tokens: usedTokens,
    lines: new TextLines(file.text),
    classes: parseR6(usedTokens),
    symbols: parseTopLevelSymbols(usedTokens),
    bindings: parseBindings(usedTokens),
  };
}

/**
 * 按 uri 去重（**保序**：先出现的那条留下）。
 *
 * 用途：同一份文件可能被两条导入指向（`./x` 与 `R/x` 落到同一个文件），
 * 不去重的话它会被解析两遍、下游还会看到重复的类。
 * ⚠️ 要在**解析之前**调用——解析完再去重已经白花了一次切词与解析。
 *
 * @param files 文件清单（通常第一项是光标文件）
 * @returns 去重后的新数组（不改动入参）
 */
export function dedupeFiles(files: SourceFile[]): SourceFile[] {
  const seen = new Set<string>();
  const unique: SourceFile[] = [];
  for (const file of files) {
    if (seen.has(file.uri)) {
      continue;
    }
    seen.add(file.uri);
    unique.push(file);
  }
  return unique;
}
