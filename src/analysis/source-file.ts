/**
 * 待查文件：跨文件查询时，把"当前文件 + 依赖文件"的 {uri, text} 列表传给查询函数。
 * uri 是文件身份（结果用它标注"目标在哪个文件"），text 是全文（解析原料）。
 * 纯数据：不依赖 vscode。
 */

import type { R6ClassDef } from '../parser/r6-parser';

export interface SourceFile {
  /** 文件身份（如 file:///C:/proj/person.R）—— 恒有值，目标在哪个文件用它标注 */
  uri: string;
  /** 文件全文（parseR6 等解析函数吃它） */
  text: string;
}

/**
 * 解析过的文件：文本 + 它的类清单（parseR6 结果）。
 * 分析层"每文件只解析一次"的缓存单元：context 组装时算好，查询遍历它，
 * 不再各自现解析现配对。
 */
export interface ParsedSourceFile {
  /** 原始文件（身份 + 全文） */
  file: SourceFile;
  /** 该文件的类清单（= parseR6(file.text) 的结果） */
  classes: R6ClassDef[];
}
