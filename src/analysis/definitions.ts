/**
 * 类定义解析：给定多个文件 + 光标位置，判断光标下是否是 R6 类名，
 * 是则返回类定义的位置（文件 + 行列）。
 * 纯逻辑：不依赖 vscode，可在纯 Node 中测试。
 */

import { tokenize } from '../parser/tokenizer';
import { parseR6, type R6ClassDef } from '../parser/r6-parser';
import { TextLines } from '../utils/text';
import type { SourceFile } from './source-file';

/** 命中结果：类名 + 目标所在文件 + 定义位置（行列，0 起） */
export interface ClassDefinition {
  name: string; // 类名
  uri: string; // 目标所在文件（恒有值：单文件时是当前文件，跨文件时是依赖文件）
  line: number; // 行号
  character: number; // 列号（用 character 而非 columns，因 VS Code 官方就叫 character）
}

/**
 * 解析光标处的类定义。
 * 查找范围：光标所在文件优先，找不到再去依赖文件（按 files 顺序）。
 * @param files         所有相关文件（当前文件 + 依赖文件）
 * @param cursorFileUri 光标在哪个文件（找"光标下的词"只在该文件里找）
 * @param cursorOffset  光标偏移量
 * @returns 命中返回定义位置（带目标文件 uri）；未命中返回 null
 */
export function resolveClassDefinition(
  files: SourceFile[],
  cursorFileUri: string,
  cursorOffset: number,
): ClassDefinition | null {
  // 找光标下的词：只在光标所在文件里找（tokenize 那份文本）
  const cursorFile = files.find((f) => f.uri === cursorFileUri);
  if (cursorFile === undefined) {
    return null;
  }
  const tokens = tokenize(cursorFile.text);
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
  const cls = findClassAcrossFiles(files, word.text);
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
