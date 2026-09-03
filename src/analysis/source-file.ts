/**
 * 待查文件：跨文件查询时，把"当前文件 + 依赖文件"的 {uri, text} 列表传给查询函数。
 * uri 是文件身份（结果用它标注"目标在哪个文件"），text 是全文（解析原料）。
 * 纯数据：不依赖 vscode。
 */

export interface SourceFile {
  /** 文件身份（如 file:///C:/proj/person.R）—— 恒有值，目标在哪个文件用它标注 */
  uri: string;
  /** 文件全文（parseR6 等解析函数吃它） */
  text: string;
}
